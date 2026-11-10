/** Pelco-D frame helpers for Chinese pan/tilt heads. */

export const PRESET_IDS = [1, 2, 3, 4, 5, 6, 7, 8, 9] as const;
export type PresetId = (typeof PRESET_IDS)[number];

export type MoveFlags = {
  left?: boolean;
  right?: boolean;
  up?: boolean;
  down?: boolean;
};

export function checksum(bytes: number[]): number {
  return (bytes[1]! + bytes[2]! + bytes[3]! + bytes[4]! + bytes[5]!) & 0xff;
}

export function buildFrame(
  address: number,
  cmd1: number,
  cmd2: number,
  data1: number,
  data2: number,
): Uint8Array {
  const frame = [0xff, address & 0xff, cmd1 & 0xff, cmd2 & 0xff, data1 & 0xff, data2 & 0xff, 0];
  frame[6] = checksum(frame);
  return Uint8Array.from(frame);
}

export function clampSpeed(speed: number): number {
  if (!Number.isFinite(speed)) return 0;
  return Math.max(0, Math.min(63, Math.round(speed)));
}

export function moveCommand(
  address: number,
  flags: MoveFlags,
  panSpeed: number,
  tiltSpeed: number,
): Uint8Array {
  let cmd2 = 0;
  if (flags.right) cmd2 |= 0x02;
  if (flags.left) cmd2 |= 0x04;
  // Physical table: logical UP/BACK must drive the platform aft. Live operator
  // check showed the previous 0x10=up mapping sent the plate forward instead.
  // Textbook Pelco-D (0x08 up / 0x10 down) matches this head's mechanical BACK.
  if (flags.up) cmd2 |= 0x08;
  if (flags.down) cmd2 |= 0x10;

  let pan = clampSpeed(panSpeed);
  let tilt = clampSpeed(tiltSpeed);
  const tiltOnly = (flags.up || flags.down) && !flags.left && !flags.right;
  // Some boards ignore tilt when the pan-speed byte is 0 — mirror tilt speed.
  if (tiltOnly && pan === 0 && tilt > 0) pan = tilt;

  return buildFrame(address, 0x00, cmd2, pan, tilt);
}

export function stopCommand(address: number): Uint8Array {
  return buildFrame(address, 0x00, 0x00, 0x00, 0x00);
}

export function setPreset(address: number, id: PresetId): Uint8Array {
  return buildFrame(address, 0x00, 0x03, 0x00, id);
}

export function clearPreset(address: number, id: PresetId): Uint8Array {
  return buildFrame(address, 0x00, 0x05, 0x00, id);
}

export function callPreset(address: number, id: PresetId): Uint8Array {
  return buildFrame(address, 0x00, 0x07, 0x00, id);
}

export function queryPan(address: number): Uint8Array {
  return buildFrame(address, 0x00, 0x51, 0x00, 0x00);
}

export function queryTilt(address: number): Uint8Array {
  return buildFrame(address, 0x00, 0x53, 0x00, 0x00);
}

/** Wrap any angle into signed travel range (-180, +180]. */
export function toSigned180(degrees: number): number {
  let d = ((((degrees + 180) % 360) + 360) % 360) - 180;
  // Keep +180 as the positive end-stop (not collapsed to -180).
  if (d <= -180) return 180;
  return d;
}

/** Map signed UI pan (-180..+180) to device 0..360 encoding. */
export function signedPanToDevice(degrees: number): number {
  const s = toSigned180(degrees);
  return s < 0 ? s + 360 : s;
}

export function encodeAngleCenti(degrees: number): [number, number] {
  const device = signedPanToDevice(degrees);
  const centi = Math.round(device * 100);
  const wrapped = ((centi % 36000) + 36000) % 36000;
  return [(wrapped >> 8) & 0xff, wrapped & 0xff];
}

export function absolutePan(address: number, degrees: number): Uint8Array {
  const [hi, lo] = encodeAngleCenti(degrees);
  return buildFrame(address, 0x00, 0x4b, hi, lo);
}

export function absoluteTilt(address: number, degrees: number): Uint8Array {
  let centi: number;
  if (degrees < 0) {
    // Negative elevation: |deg|*100 in the low range (raw 0..18000).
    centi = Math.round(Math.abs(degrees) * 100);
  } else if (degrees === 0) {
    centi = 0;
  } else {
    // Positive elevation on this head: 65536 - deg*100 (wraps into high words).
    // Live probe: +20.2° → raw 63516.
    centi = (65536 - Math.round(degrees * 100)) & 0xffff;
  }
  centi = Math.max(0, Math.min(65535, centi));
  return buildFrame(address, 0x00, 0x4d, (centi >> 8) & 0xff, centi & 0xff);
}

/** Device reports 0..360 — keep that for display. */
export function decodePanDegrees(raw: number): number {
  return raw / 100;
}

export function decodeTiltDegrees(raw: number): number {
  // Dual-range raw decode, then negate so UI/sign match the table:
  //   + = BACK (aft), − = FORWARD, 0 = LEVEL / storage.
  // Raw bands (device-native before sign flip):
  //   raw 0..18000        → |elev| in low band
  //   raw 18001..36000    → classic Chinese ((36000-raw)/100)
  //   raw high (near 2^16)→ wrap (65536-raw)/100
  let native: number;
  if (raw <= 18000) native = -raw / 100;
  else if (raw <= 36000) native = (36000 - raw) / 100;
  else {
    const posFromWrap = (65536 - raw) / 100;
    if (posFromWrap >= 0 && posFromWrap <= 100) native = posFromWrap;
    else {
      const signed = raw > 32767 ? raw - 65536 : raw;
      native = signed / 100;
    }
  }
  return -native;
}

export type PositionResponse = {
  kind: 'pan' | 'tilt';
  address: number;
  raw: number;
  degrees: number;
};

export type ParsedChunk =
  | { type: 'position'; value: PositionResponse }
  | { type: 'frame'; bytes: Uint8Array }
  | { type: 'sync_noise'; byte: number };

export class PelcoParser {
  private buf: number[] = [];

  push(data: Uint8Array): ParsedChunk[] {
    const out: ParsedChunk[] = [];
    for (const byte of data) {
      if (this.buf.length === 0) {
        if (byte !== 0xff) {
          out.push({ type: 'sync_noise', byte });
          continue;
        }
        this.buf.push(byte);
        continue;
      }
      this.buf.push(byte);
      if (this.buf.length < 7) continue;
      const frame = this.buf.slice(0, 7);
      this.buf = this.buf.slice(7);
      const sum = checksum(frame);
      if (sum !== frame[6]) {
        this.buf = frame.slice(1).concat(this.buf);
        continue;
      }
      const bytes = Uint8Array.from(frame);
      const cmd2 = frame[3]!;
      const address = frame[1]!;
      const raw = ((frame[4]! << 8) | frame[5]!) & 0xffff;
      if (cmd2 === 0x59) {
        out.push({
          type: 'position',
          value: { kind: 'pan', address, raw, degrees: decodePanDegrees(raw) },
        });
      } else if (cmd2 === 0x5b) {
        out.push({
          type: 'position',
          value: { kind: 'tilt', address, raw, degrees: decodeTiltDegrees(raw) },
        });
      } else {
        out.push({ type: 'frame', bytes });
      }
    }
    return out;
  }

  reset(): void {
    this.buf = [];
  }
}

export function toHex(bytes: Uint8Array | number[]): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0').toUpperCase())
    .join(' ');
}

export function approachSpeed(
  errorAbs: number,
  rampDistance: number,
  speedFast: number,
  speedSlow: number,
): number {
  if (errorAbs >= rampDistance) return clampSpeed(speedFast);
  if (rampDistance <= 0) return clampSpeed(speedSlow);
  const t = errorAbs / rampDistance;
  return clampSpeed(speedSlow + (speedFast - speedSlow) * t);
}

/**
 * Linear pan error on a limited ±180 axis (NO circular shortest path).
 * Example: current=+180, target=-178 → delta=-358 (go back through 0),
 * not +2° across the seam.
 */
export function linearPanDelta(current: number, target: number): number {
  return toSigned180(target) - toSigned180(current);
}

/** @deprecated use linearPanDelta — kept name alias during transition */
export function shortestPanDelta(current: number, target: number): number {
  return linearPanDelta(current, target);
}
