import { EventEmitter } from 'events';
import { PortManager } from './portManager';
import {
  MoveFlags,
  PresetId,
  approachSpeed,
  callPreset,
  clearPreset,
  moveCommand,
  queryPan,
  queryTilt,
  setPreset,
  stopCommand,
  toSigned180,
} from './pelcoD';

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
  /** Set by service when a newer goto supersedes the in-flight one. */
  private abortGoto = false;
  /**
   * When true, swap logical up/down before TX. Only latched by an explicit
   * calibrate — not during normal goto (encoding transitions near 0° looked
   * like wrong-way motion and caused runaway dives).
   */
  private tiltPolarityFlipped = false;

  constructor(
    private port: PortManager,
    settings?: Partial<ControllerSettings>,
  ) {
    super();
    this.settings = {
      address: 1,
      // Spec: pan ≤60°/s, tilt ≤30°/s, positioning ±0.2°, tilt travel ±60°.
      panSpeed: 48,
      tiltSpeed: 32,
      limits: {
        enabled: true,
        panMin: PAN_TRAVEL_MIN,
        panMax: PAN_TRAVEL_MAX,
        tiltMin: -50,
        tiltMax: 50,
      },
      approach: {
        speedFast: 42,
        speedSlow: 5,
        rampDistance: 18,
        deadband: 1,
        pollMs: 80,
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
    // Tilt soft-limits hardcoded ±50° for this deployment.
    this.settings.limits.tiltMin = -50;
    this.settings.limits.tiltMax = 50;
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

  /** Apply optional tilt bit-map flip without mutating caller flags. */
  private wireFlags(flags: MoveFlags): MoveFlags {
    if (!this.tiltPolarityFlipped) return { ...flags };
    return {
      ...flags,
      up: flags.down,
      down: flags.up,
    };
  }

  private async writeMove(flags: MoveFlags, panSpeed: number, tiltSpeed: number): Promise<void> {
    await this.port.write(
      moveCommand(this.settings.address, this.wireFlags(flags), panSpeed, tiltSpeed),
    );
  }

  /** Abort in-flight closed-loop goto so a newer target can run. */
  requestAbortGoto(): void {
    this.abortGoto = true;
  }

  isBusy(): boolean {
    return this.busy || this.jogging || this.moving;
  }

  async stop(): Promise<void> {
    this.abortGoto = true;
    this.clearGoto();
    this.clearJogKeepalive();
    this.jogging = false;
    this.moving = false;
    this.busy = false;
    this.jogFlags = {};
    this.jogTick = 0;
    await this.port.write(stopCommand(this.settings.address));
    this.abortGoto = false;
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
    await this.writeMove(this.jogFlags, this.settings.panSpeed, this.settings.tiltSpeed);
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

  /** Home / storage settle band — relaxed ±1.5° (not tied to UI landing resolution). */
  static readonly HOME_BAND_DEG = 1.5;

  /**
   * Home / storage / off = pan 0° and tilt 0° (flat level table).
   * Closed-loop drive, then a ±1.5° settle — close enough for storage.
   * Re-bases panTravel so the readout stays at 0 / 0.
   */
  async home(): Promise<void> {
    await this.gotoAbsolute(0, 0);
    await this.settleStorageFlat();
    await this.refreshEncoders();
    // Second pass if circular device pan still sits outside the hard band
    // (travel can look settled while the 0/360 wrap still reads ~±0.7°).
    if (this.circularPanErrorDeg(this.lastDevicePan) > MotionController.HOME_BAND_DEG) {
      await this.settleStorageFlat();
      await this.refreshEncoders();
    }
    this.rebaseTravelZero();
  }

  /** Smallest absolute error of device pan vs 0° (handles 359.x wrap). */
  private circularPanErrorDeg(devicePan: number | null): number {
    if (devicePan == null || !Number.isFinite(devicePan)) return 0;
    const d = ((devicePan % 360) + 360) % 360;
    return Math.min(d, 360 - d);
  }

  /**
   * Final micro-creep into the home band (|pan|≤1.5°, |tilt|≤1.5°).
   * Uses short pulses so gravity / backlash do not leave the table cocked.
   */
  private async settleStorageFlat(): Promise<void> {
    await this.settleToTarget(0, 0, MotionController.HOME_BAND_DEG);
  }

  /** Pulse-creep until travel/tilt are inside `band` of the requested target. */
  private async settleToTarget(
    panTravel: number | null,
    tilt: number | null,
    band: number,
  ): Promise<void> {
    for (let i = 0; i < 18 && !this.abortGoto; i += 1) {
      await this.refreshEncoders();
      let panErr = 0;
      if (panTravel != null && this.panTravel != null) panErr = panTravel - this.panTravel;
      // Prefer circular device-pan error when targeting absolute 0° so wrap
      // readings (e.g. 359.3°) are corrected instead of trusting travel alone.
      if (panTravel === 0 && this.lastDevicePan != null) {
        const d = ((this.lastDevicePan % 360) + 360) % 360;
        const circ = d > 180 ? d - 360 : d;
        if (Math.abs(circ) >= Math.abs(panErr)) panErr = -circ;
      }
      const tiltErr =
        tilt != null && this.pose.tilt != null ? tilt - this.pose.tilt : 0;
      const needPan = panTravel != null && Math.abs(panErr) > band;
      const needTilt = tilt != null && Math.abs(tiltErr) > band;
      if (!needPan && !needTilt) break;

      const flags: MoveFlags = {};
      if (needPan) {
        if (panErr > 0) flags.right = true;
        else flags.left = true;
      }
      if (needTilt) {
        if (tiltErr > 0) flags.up = true;
        else flags.down = true;
      }
      // Stronger micro-pulses when still >1.5× the land band so pan does not
      // stall ~0.3–0.5° outside the operator resolution.
      const far = Math.max(Math.abs(panErr), Math.abs(tiltErr)) > band * 1.5;
      await this.writeMove(flags, needPan ? (far ? 8 : 5) : 0, needTilt ? (far ? 9 : 6) : 0);
      await delay(far ? 110 : 85);
      await this.port.write(stopCommand(this.settings.address));
      await delay(140);
    }
  }

  /** Force panTravel to match absolute pan 0 after arriving at home. */
  rebaseTravelZero(): void {
    if (this.lastDevicePan == null) return;
    // Snap travel to the signed reading so home reads pan≈0 travel≈0.
    const device = ((this.lastDevicePan % 360) + 360) % 360;
    const nearZero = device <= 1 || device >= 359;
    this.panTravel = nearZero ? 0 : toSigned180(device);
    this.pose.panTravel = this.panTravel;
    this.emit('pose', { ...this.pose });
  }

  async gotoAbsolute(pan?: number, tilt?: number): Promise<void> {
    let travelTarget: number | null = null;
    if (pan != null) {
      const want = toSigned180(pan);
      // Only consider travel values that still encode the same absolute pan after
      // the ±180 revolution lock. (Picking 240 then clamping to 180 used to make
      // Sector C @ 240° unreachable from Sector B @ 120°.)
      const candidates = [want, want - 360, want + 360].filter(
        (c) => c >= PAN_TRAVEL_MIN - 1e-9 && c <= PAN_TRAVEL_MAX + 1e-9,
      );
      const pool = candidates.length ? candidates : [clamp(want, PAN_TRAVEL_MIN, PAN_TRAVEL_MAX)];
      const origin = this.panTravel != null && Number.isFinite(this.panTravel) ? this.panTravel : 0;
      let best = pool[0]!;
      let bestDist = Math.abs(best - origin);
      for (const cand of pool) {
        const d = Math.abs(cand - origin);
        if (d < bestDist) {
          best = cand;
          bestDist = d;
        }
      }
      travelTarget = clamp(best, PAN_TRAVEL_MIN, PAN_TRAVEL_MAX);
    }
    await this.gotoTravel(travelTarget, tilt ?? null, `goto pan=${pan ?? '-'} tilt=${tilt ?? '-'}`);
  }

  async gotoTravel(
    panTravel: number | null,
    tilt: number | null,
    label = 'goto',
  ): Promise<void> {
    if (this.busy) {
      this.requestAbortGoto();
      // Wait briefly for the active loop to notice abort; then force-stop.
      const start = Date.now();
      while (this.busy && Date.now() - start < 1500) await delay(40);
      if (this.busy) await this.stop();
    }
    this.abortGoto = false;
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

      // Sequential axes: these Chinese heads drop tilt when pan+tilt are
      // driven together, and encoder queries abort continuous moves.
      if (travelTarget != null) {
        await this.runApproachLoop({
          panTravel: travelTarget,
          tilt: null,
          axis: 'pan',
        });
      }
      if (tilt != null && !this.abortGoto) {
        // Closed-loop only — absolute 0x4D encoding on this head does not match
        // its dual-range encoder replies and can shove tilt the wrong way.
        await this.runApproachLoop({
          panTravel: null,
          tilt,
          axis: 'tilt',
        });
      }

      // Micro-settle only inside the operator landing resolution — do not fight
      // once pan/tilt are already within the chosen 0.5° / 1° / 2° band.
      if (!this.abortGoto) {
        const land = Math.max(0.5, this.settings.approach.deadband);
        await this.settleToTarget(travelTarget, tilt, land);
      }

      this.lastMove.after = this.getPose();
      this.emit('moveSnapshot', this.lastMove);
      this.emit('state', { mode: 'idle' });
    } finally {
      this.busy = false;
      this.moving = false;
      this.abortGoto = false;
      // Touch encoders so health doesn't look stale right after a move.
      void this.refreshEncoders().catch(() => undefined);
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
      const maxMs = 60000;
      let tickN = 0;
      let settleHits = 0;
      let bestErr = Number.POSITIVE_INFINITY;
      let lastProgressAt = Date.now();
      let lastCoastAt = 0;
      const settleNeed = 3;
      const stallMs = 12000;
      // Operator landing resolution (UI: 0.5° / 1° / 2°) — inside band = done, no fight.
      const deadband = Math.max(0.5, Math.min(2, approach.deadband));
      /** Coast once when entering this band, then creep — never re-coast forever. */
      const coastPan = Math.max(1.8, deadband * 3);
      const coastTilt = Math.max(2.2, deadband * 3.5);

      const tick = async () => {
        try {
          if (this.abortGoto) {
            await this.port.write(stopCommand(this.settings.address)).catch(() => undefined);
            this.clearGoto();
            resolve();
            return;
          }
          if (Date.now() - startedAt > maxMs) {
            await this.port.write(stopCommand(this.settings.address));
            this.clearGoto();
            this.emit('error', new Error('Goto timeout'));
            resolve();
            return;
          }

          tickN += 1;
          const travel = this.panTravel;
          const tilt = this.pose.tilt;
          let panErr =
            target.panTravel != null && travel != null ? target.panTravel - travel : 0;
          let tiltErr = target.tilt != null && tilt != null ? target.tilt - tilt : 0;
          const combinedErr =
            (target.panTravel != null ? Math.abs(panErr) : 0) +
            (target.tilt != null ? Math.abs(tiltErr) : 0);
          if (combinedErr + 0.2 < bestErr) {
            bestErr = combinedErr;
            lastProgressAt = Date.now();
          } else if (Date.now() - lastProgressAt > stallMs) {
            await this.port.write(stopCommand(this.settings.address)).catch(() => undefined);
            this.clearGoto();
            this.emit('error', new Error('Goto stalled (no progress)'));
            resolve();
            return;
          }
          const near =
            (target.panTravel == null || Math.abs(panErr) < approach.rampDistance) &&
            (target.tilt == null || Math.abs(tiltErr) < approach.rampDistance);
          const finalApproach =
            (target.panTravel == null || Math.abs(panErr) < 6) &&
            (target.tilt == null || Math.abs(tiltErr) < 6);

          // Far: poll every 3rd tick (queries abort motion on these heads).
          // Near/final: poll every tick so encoder feedback lands cleanly.
          const shouldPoll = tickN === 1 || near || tickN % 3 === 0;
          if (shouldPoll) {
            if (target.panTravel != null) {
              await this.port.write(queryPan(this.settings.address));
              await delay(30);
            }
            if (target.tilt != null) {
              await this.port.write(queryTilt(this.settings.address));
              await delay(45);
            }
            panErr =
              target.panTravel != null && this.panTravel != null
                ? target.panTravel - this.panTravel
                : 0;
            tiltErr =
              target.tilt != null && this.pose.tilt != null
                ? target.tilt - this.pose.tilt
                : 0;
          }

          if (
            (target.panTravel != null && this.panTravel == null) ||
            (target.tilt != null && this.pose.tilt == null)
          ) {
            this.gotoTimer = setTimeout(() => void tick(), approach.pollMs);
            return;
          }

          const flags: MoveFlags = {};
          if (target.panTravel != null && Math.abs(panErr) > deadband) {
            if (panErr > 0) flags.right = true;
            else flags.left = true;
          }
          if (target.tilt != null && Math.abs(tiltErr) > deadband) {
            if (tiltErr > 0) flags.up = true;
            else flags.down = true;
          }

          const needPan = !!(flags.left || flags.right);
          const needTilt = !!(flags.up || flags.down);
          if (!needPan && !needTilt) {
            settleHits += 1;
            await this.port.write(stopCommand(this.settings.address));
            if (settleHits >= settleNeed) {
              this.clearGoto();
              resolve();
              return;
            }
            this.gotoTimer = setTimeout(() => void tick(), Math.max(90, Math.floor(approach.pollMs * 0.7)));
            return;
          }
          settleHits = 0;

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

          // One-shot coast when first entering the near band, then creep pulses.
          const inCoast =
            (needPan && !needTilt && Math.abs(panErr) <= coastPan) ||
            (needTilt && !needPan && Math.abs(tiltErr) <= coastTilt);
          if (inCoast && Date.now() - lastCoastAt > 700) {
            lastCoastAt = Date.now();
            await this.port.write(stopCommand(this.settings.address));
            await delay(140);
            if (target.panTravel != null) {
              await this.port.write(queryPan(this.settings.address));
              await delay(35);
            }
            if (target.tilt != null) {
              await this.port.write(queryTilt(this.settings.address));
              await delay(45);
            }
            this.gotoTimer = setTimeout(() => void tick(), 70);
            return;
          }

          const ramp = Math.max(approach.rampDistance, 28);
          let panSpd = needPan
            ? approachSpeed(Math.abs(panErr), ramp, approach.speedFast, approach.speedSlow)
            : 0;
          let tiltSpd = needTilt
            ? approachSpeed(Math.abs(tiltErr), ramp, approach.speedFast, approach.speedSlow)
            : 0;

          if (needTilt) {
            const tAbs = Math.abs(tiltErr);
            if (tAbs > 25) tiltSpd = Math.max(20, tiltSpd);
            else if (tAbs > 10) tiltSpd = Math.max(12, Math.min(tiltSpd, 28));
            else if (tAbs > 4) tiltSpd = Math.max(8, Math.min(tiltSpd, 14));
            else {
              // Short creep pulse — hold move briefly then stop so gravity/inertia settle.
              tiltSpd = Math.max(5, Math.min(8, approach.speedSlow + 1));
            }
          }
          if (needPan) {
            const pAbs = Math.abs(panErr);
            if (pAbs < 3) panSpd = Math.min(panSpd, Math.max(4, approach.speedSlow));
            else if (pAbs < 8) panSpd = Math.min(panSpd, Math.max(approach.speedSlow, 14));
          }

          await this.writeMove(flags, panSpd, tiltSpd);
          // Near-target: pulse then hard-stop so we don't run through the band.
          if (needTilt && !needPan && Math.abs(tiltErr) <= 4) {
            await delay(90);
            await this.port.write(stopCommand(this.settings.address));
            await delay(100);
            await this.port.write(queryTilt(this.settings.address));
            await delay(45);
            this.gotoTimer = setTimeout(() => void tick(), 60);
            return;
          }
          if (needPan && !needTilt && Math.abs(panErr) <= 2.5) {
            await delay(70);
            await this.port.write(stopCommand(this.settings.address));
            await delay(80);
            await this.port.write(queryPan(this.settings.address));
            await delay(35);
            this.gotoTimer = setTimeout(() => void tick(), 60);
            return;
          }

          const basePoll = Math.max(70, approach.pollMs);
          this.gotoTimer = setTimeout(
            () => void tick(),
            finalApproach
              ? Math.max(55, Math.floor(basePoll * 0.5))
              : near
                ? Math.max(65, Math.floor(basePoll * 0.7))
                : basePoll,
          );
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
