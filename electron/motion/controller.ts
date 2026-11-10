import { EventEmitter } from 'events';
import { PortManager } from '../serial/portManager';
import {
  MoveFlags,
  PresetId,
  absoluteTilt,
  approachSpeed,
  callPreset,
  clearPreset,
  moveCommand,
  queryPan,
  queryTilt,
  setPreset,
  stopCommand,
  toSigned180,
} from '../protocol/pelcoD';

export type SoftLimits = {
  enabled: boolean;
  panMin: number;
  panMax: number;
  tiltMin: number;
  tiltMax: number;
};

export type ApproachConfig = {
  speedFast: number;
  speedSlow: number;
  rampDistance: number;
  deadband: number;
  pollMs: number;
};

export type ControllerSettings = {
  address: number;
  panSpeed: number;
  tiltSpeed: number;
  limits: SoftLimits;
  approach: ApproachConfig;
};

export type Pose = {
  pan: number | null;
  tilt: number | null;
  panRaw: number | null;
  tiltRaw: number | null;
  /** Unwrapped travel used for no-revolution lock (−180…+180). */
  panTravel: number | null;
  updatedAt: number | null;
};

export type MoveSnapshot = {
  before: Pose;
  after: Pose | null;
  label: string;
};

type GotoAxis = 'pan' | 'tilt' | 'both';

/** Hard internal pan travel window — not exposed as cluttered UI. */
const PAN_TRAVEL_MIN = -180;
const PAN_TRAVEL_MAX = 180;
const PAN_STOP_MARGIN = 0.8;

export class MotionController extends EventEmitter {
  private settings: ControllerSettings;
  private pose: Pose = {
    pan: null,
    tilt: null,
    panRaw: null,
    tiltRaw: null,
    panTravel: null,
    updatedAt: null,
  };
  private lastDevicePan: number | null = null;
  private panTravel: number | null = null;
  private jogging = false;
  private jogFlags: MoveFlags = {};
  private gotoTimer: NodeJS.Timeout | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private jogKeepaliveTimer: NodeJS.Timeout | null = null;
  private jogTick = 0;
  private lastMove: MoveSnapshot | null = null;
  private busy = false;
  private moving = false;

  constructor(
    private port: PortManager,
    settings?: Partial<ControllerSettings>,
  ) {
    super();
    this.settings = {
      address: 1,
      panSpeed: 32,
      tiltSpeed: 24,
      limits: {
        enabled: true,
        panMin: PAN_TRAVEL_MIN,
        panMax: PAN_TRAVEL_MAX,
        tiltMin: -50,
        tiltMax: 50,
      },
      approach: {
        speedFast: 48,
        speedSlow: 8,
        rampDistance: 15,
        deadband: 0.4,
        pollMs: 120,
      },
      ...settings,
    };

    this.port.on('position', (pos: { kind: 'pan' | 'tilt'; raw: number; degrees: number }) => {
      if (pos.kind === 'pan') {
        this.ingestDevicePan(pos.degrees, pos.raw);
      } else {
        this.pose.tilt = pos.degrees;
        this.pose.tiltRaw = pos.raw;
      }
      this.pose.updatedAt = Date.now();
      this.emit('pose', { ...this.pose });
    });
  }

  /**
   * Track continuous pan travel so we can stop at ±180 even if the device
   * angle wraps 0..360. Display stays as device degrees.
   */
  private ingestDevicePan(deviceDeg: number, raw: number): void {
    const device = ((deviceDeg % 360) + 360) % 360;
    if (this.lastDevicePan == null || this.panTravel == null) {
      this.panTravel = toSigned180(device);
    } else {
      let delta = device - this.lastDevicePan;
      if (delta > 180) delta -= 360;
      if (delta < -180) delta += 360;
      this.panTravel += delta;
    }
    this.lastDevicePan = device;
    this.pose.pan = device;
    this.pose.panRaw = raw;
    this.pose.panTravel = this.panTravel;
  }

  getSettings(): ControllerSettings {
    return structuredClone(this.settings);
  }

  updateSettings(patch: Partial<ControllerSettings>): ControllerSettings {
    this.settings = {
      ...this.settings,
      ...patch,
      limits: { ...this.settings.limits, ...(patch.limits || {}) },
      approach: { ...this.settings.approach, ...(patch.approach || {}) },
    };
    // Pan revolution lock stays hard-coded internally.
    this.settings.limits.panMin = PAN_TRAVEL_MIN;
    this.settings.limits.panMax = PAN_TRAVEL_MAX;
    this.emit('settings', this.getSettings());
    return this.getSettings();
  }

  getPose(): Pose {
    return { ...this.pose };
  }

  getLastMove(): MoveSnapshot | null {
    return this.lastMove ? structuredClone(this.lastMove) : null;
  }

  startPolling(intervalMs = 400): void {
    this.stopPolling();
    this.pollTimer = setInterval(() => {
      if (this.jogging || this.busy) return;
      void this.refreshEncoders().catch(() => undefined);
    }, intervalMs);
  }

  stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  async refreshEncoders(): Promise<Pose> {
    const before = { ...this.pose };
    await this.port.write(queryPan(this.settings.address));
    await delay(40);
    await this.port.write(queryTilt(this.settings.address));
    await delay(80);
    this.lastMove = {
      before,
      after: { ...this.pose },
      label: 'encoder-poll',
    };
    this.emit('moveSnapshot', this.lastMove);
    return this.getPose();
  }

  async stop(): Promise<void> {
    this.clearGoto();
    this.clearJogKeepalive();
    this.jogging = false;
    this.moving = false;
    this.busy = false;
    this.jogFlags = {};
    this.jogTick = 0;
    await this.port.write(stopCommand(this.settings.address));
    this.emit('state', { mode: 'idle' });
  }

  async jog(flags: MoveFlags): Promise<void> {
    // Fresh encoder sample before starting so end-stops are current.
    try {
      await this.port.write(queryPan(this.settings.address));
      await delay(50);
    } catch {
      /* continue */
    }
    if (!this.withinLimitsForFlags(flags)) {
      await this.stop();
      this.emit('limitHit', {
        reason: 'pan-revolution-lock',
        panTravel: this.panTravel,
        flags,
      });
      return;
    }
    this.clearGoto();
    this.jogging = true;
    this.moving = true;
    this.jogFlags = { ...flags };
    this.jogTick = 0;
    await this.sendJogCommand();
    this.startJogKeepalive();
    this.emit('state', { mode: 'jogging', flags });
  }

  private async sendJogCommand(): Promise<void> {
    if (!this.jogging) return;
    if (!this.withinLimitsForFlags(this.jogFlags)) {
      await this.stop();
      this.emit('limitHit', {
        reason: 'pan-revolution-lock',
        panTravel: this.panTravel,
        flags: this.jogFlags,
      });
      return;
    }
    await this.port.write(
      moveCommand(
        this.settings.address,
        this.jogFlags,
        this.settings.panSpeed,
        this.settings.tiltSpeed,
      ),
    );
  }

  private startJogKeepalive(): void {
    this.clearJogKeepalive();
    this.jogKeepaliveTimer = setInterval(() => {
      if (!this.jogging) {
        this.clearJogKeepalive();
        return;
      }
      void this.jogKeepaliveTick().catch((err) => this.emit('error', err));
    }, 200);
  }

  /**
   * Re-assert move AND sample pan often enough that ±180 end-stops fire
   * while the operator is still holding the button.
   */
  private async jogKeepaliveTick(): Promise<void> {
    if (!this.jogging) return;
    this.jogTick += 1;

    // Every other tick: quick pan query, then immediately re-assert jog.
    if (this.jogTick % 2 === 0) {
      await this.port.write(queryPan(this.settings.address));
      await delay(35);
      if (!this.jogging) return;
      if (!this.withinLimitsForFlags(this.jogFlags)) {
        await this.stop();
        this.emit('limitHit', {
          reason: 'pan-revolution-lock',
          panTravel: this.panTravel,
          flags: this.jogFlags,
        });
        return;
      }
    }

    await this.sendJogCommand();
  }

  private clearJogKeepalive(): void {
    if (this.jogKeepaliveTimer) {
      clearInterval(this.jogKeepaliveTimer);
      this.jogKeepaliveTimer = null;
    }
  }

  async setPreset(id: PresetId): Promise<void> {
    await this.refreshEncoders();
    await this.port.write(setPreset(this.settings.address, id));
    this.emit('preset', { action: 'set', id, pose: this.getPose() });
  }

  async clearPresetCmd(id: PresetId): Promise<void> {
    await this.port.write(clearPreset(this.settings.address, id));
    this.emit('preset', { action: 'clear', id });
  }

  /**
   * Call preset. Prefer closed-loop drive to stored pose — device preset +
   * encoder polling was aborting mid-move on Chinese Pelco-D heads.
   */
  async callPreset(
    id: PresetId,
    stored?: { panTravel?: number | null; pan?: number | null; tilt?: number | null },
  ): Promise<void> {
    const travel =
      stored?.panTravel != null && Number.isFinite(stored.panTravel)
        ? stored.panTravel
        : stored?.pan != null
          ? toSigned180(stored.pan)
          : null;
    const tilt = stored?.tilt != null && Number.isFinite(stored.tilt) ? stored.tilt : null;

    if (travel != null || tilt != null) {
      this.emit('state', { mode: 'preset', id, drive: 'closed-loop' });
      await this.gotoTravel(travel, tilt, `preset-${id}`);
      this.emit('preset', { action: 'call', id, pose: this.getPose() });
      return;
    }

    // No local pose yet — fire device preset and wait WITHOUT querying/stopping
    // (queries replace the in-progress preset move on these heads).
    this.moving = true;
    try {
      const before = await this.refreshEncoders();
      this.lastMove = { before, after: null, label: `preset-${id}` };
      await this.port.write(callPreset(this.settings.address, id));
      this.emit('state', { mode: 'preset', id, drive: 'device' });
      await delay(10000);
      await this.refreshEncoders();
      this.lastMove.after = this.getPose();
      this.emit('moveSnapshot', this.lastMove);
      this.emit('preset', { action: 'call', id, pose: this.getPose() });
      this.emit('state', { mode: 'idle' });
    } finally {
      this.moving = false;
    }
  }

  /** Home = absolute pan 0° / tilt 0°. */
  async home(): Promise<void> {
    await this.gotoAbsolute(0, 0);
  }

  async gotoAbsolute(pan?: number, tilt?: number): Promise<void> {
    let travelTarget: number | null = null;
    if (pan != null) {
      travelTarget = clamp(toSigned180(pan), PAN_TRAVEL_MIN, PAN_TRAVEL_MAX);
    }
    await this.gotoTravel(travelTarget, tilt ?? null, `goto pan=${pan ?? '-'} tilt=${tilt ?? '-'}`);
  }

  async gotoTravel(
    panTravel: number | null,
    tilt: number | null,
    label = 'goto',
  ): Promise<void> {
    if (this.busy) await this.stop();
    this.busy = true;
    this.moving = true;
    try {
      const before = await this.refreshEncoders();
      this.lastMove = { before, after: null, label };

      let travelTarget = panTravel;
      if (travelTarget != null) {
        travelTarget = clamp(travelTarget, PAN_TRAVEL_MIN, PAN_TRAVEL_MAX);
      }
      if (tilt != null && this.settings.limits.enabled) {
        tilt = clamp(tilt, this.settings.limits.tiltMin, this.settings.limits.tiltMax);
      }

      await this.runApproachLoop({
        panTravel: travelTarget,
        tilt,
        axis:
          travelTarget != null && tilt != null
            ? 'both'
            : travelTarget != null
              ? 'pan'
              : 'tilt',
      });

      this.lastMove.after = this.getPose();
      this.emit('moveSnapshot', this.lastMove);
      this.emit('state', { mode: 'idle' });
    } finally {
      this.busy = false;
      this.moving = false;
    }
  }

  private async runApproachLoop(target: {
    panTravel: number | null;
    tilt: number | null;
    axis: GotoAxis;
  }): Promise<void> {
    this.emit('state', { mode: 'goto', target });
    const { approach } = this.settings;

    await new Promise<void>((resolve) => {
      const startedAt = Date.now();
      const maxMs = 45000;
      const tick = async () => {
        try {
          if (Date.now() - startedAt > maxMs) {
            await this.port.write(stopCommand(this.settings.address));
            this.clearGoto();
            this.emit('error', new Error('Goto timeout'));
            resolve();
            return;
          }

          await this.port.write(queryPan(this.settings.address));
          await delay(30);
          await this.port.write(queryTilt(this.settings.address));
          await delay(50);

          const travel = this.panTravel;
          const tilt = this.pose.tilt;
          if (travel == null || (target.tilt != null && tilt == null)) {
            this.gotoTimer = setTimeout(() => void tick(), approach.pollMs);
            return;
          }

          let panErr = 0;
          let tiltErr = 0;
          const flags: MoveFlags = {};

          if (target.panTravel != null) {
            // Linear travel error — never cross the ±180 seam.
            panErr = target.panTravel - travel;
            if (Math.abs(panErr) > approach.deadband) {
              if (panErr > 0) flags.right = true;
              else flags.left = true;
            }
          }
          if (target.tilt != null && tilt != null) {
            tiltErr = target.tilt - tilt;
            if (Math.abs(tiltErr) > approach.deadband) {
              if (tiltErr > 0) flags.up = true;
              else flags.down = true;
            }
          }

          const needPan = !!(flags.left || flags.right);
          const needTilt = !!(flags.up || flags.down);
          if (!needPan && !needTilt) {
            await this.port.write(stopCommand(this.settings.address));
            this.clearGoto();
            resolve();
            return;
          }

          if (!this.withinLimitsForFlags(flags)) {
            await this.port.write(stopCommand(this.settings.address));
            this.emit('limitHit', {
              reason: 'pan-revolution-lock',
              panTravel: this.panTravel,
              flags,
            });
            this.clearGoto();
            resolve();
            return;
          }

          const panSpd = needPan
            ? approachSpeed(
                Math.abs(panErr),
                approach.rampDistance,
                approach.speedFast,
                approach.speedSlow,
              )
            : 0;
          const tiltSpd = needTilt
            ? approachSpeed(
                Math.abs(tiltErr),
                approach.rampDistance,
                approach.speedFast,
                approach.speedSlow,
              )
            : 0;

          await this.port.write(moveCommand(this.settings.address, flags, panSpd, tiltSpd));
          this.gotoTimer = setTimeout(() => void tick(), approach.pollMs);
        } catch (err) {
          this.emit('error', err);
          this.clearGoto();
          resolve();
        }
      };
      void tick();
    });
  }

  private withinLimitsForFlags(flags: MoveFlags): boolean {
    const travel = this.panTravel;
    if (travel != null) {
      if (flags.right && travel >= PAN_TRAVEL_MAX - PAN_STOP_MARGIN) return false;
      if (flags.left && travel <= PAN_TRAVEL_MIN + PAN_STOP_MARGIN) return false;
    }

    const { limits } = this.settings;
    if (!limits.enabled) return true;
    const tilt = this.pose.tilt;
    if (tilt != null) {
      if (flags.down && tilt <= limits.tiltMin) return false;
      if (flags.up && tilt >= limits.tiltMax) return false;
    }
    return true;
  }

  private clearGoto(): void {
    if (this.gotoTimer) {
      clearTimeout(this.gotoTimer);
      this.gotoTimer = null;
    }
  }

  async shutdown(): Promise<void> {
    this.stopPolling();
    this.clearGoto();
    this.clearJogKeepalive();
    this.jogging = false;
    this.moving = false;
    try {
      if (this.port.getStatus().connected) {
        await this.port.write(stopCommand(this.settings.address));
      }
    } catch {
      /* ignore */
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}
