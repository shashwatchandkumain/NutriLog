// Cult Smart Scale (CS-BF01) Bluetooth protocol + weigh-in state machine. Pure logic, no
// Web Bluetooth here (see services/scale.js), so it is unit-tested with captured frames.
//
// The scale streams 11-byte frames on notify characteristic 0xfff4 of service 0xfff0 — no
// handshake needed:
//   byte 0      0xCF marker
//   byte 1      heart rate (bpm) while the scale reads it; 0 otherwise
//   bytes 3–4   weight, little-endian uint16 ÷ 100 = kg
//   byte 9      0x01 while the weight settles, 0x00 once it is locked
//   byte 10     XOR of bytes 0–9
// Bytes 5–7 change every session and are not a usable impedance, so body composition is
// estimated from weight + profile instead (lib/body-composition.js).

export const SCALE_SERVICE_UUID = '0000fff0-0000-1000-8000-00805f9b34fb';
export const SCALE_MEASUREMENT_UUID = '0000fff4-0000-1000-8000-00805f9b34fb';
export const SCALE_NAME_PREFIXES = ['Cult', 'CULT'];

export const WEIGHT_LOCK_FRAMES = 3;   // identical weights in a row → the weight is locked
export const HR_LOCK_FRAMES = 3;       // identical heart-rate readings after the lock → HR converged
export const MIN_WEIGHT_KG = 10;       // ignore the empty-platform readings (0.00 kg)
const HR_RANGE = [40, 200];

/** Decodes one notification. Returns null for anything that is not an 11-byte 0xCF frame. */
export function parseScaleFrame(bytes) {
  const b = bytes instanceof DataView ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) : bytes;
  if (!b || b.length !== 11 || b[0] !== 0xcf) return null;
  let xor = 0;
  for (let i = 0; i < 10; i++) xor ^= b[i];
  const settling = b[9] === 0x01;
  return {
    checksumOk: xor === b[10],
    weightKg: (b[3] | (b[4] << 8)) / 100,
    heartRate: settling || !b[1] ? null : b[1],
    settling,
  };
}

/**
 * One weigh-in. feed() takes raw frames and returns the events they produce:
 *   { type: 'live', weightKg, heartRate, locked }  every valid frame
 *   { type: 'locked', weightKg }                   the weight has settled (once)
 *   { type: 'heart', heartRate, ticks }            heart-rate readings after the lock
 *   { type: 'complete', weightKg, heartRate, reason }  final reading (exactly once)
 * The caller ends a session that never converges with finish(reason) — on a timeout, when
 * frames stop, or when the scale disconnects.
 */
export class WeighInSession {
  constructor() {
    this.lastWeight = null; this.weightRepeats = 0;
    this.lockedWeight = null;
    this.lastHr = null; this.hrRepeats = 0; this.heartRate = null;
    this.done = false;
  }

  get locked() { return this.lockedWeight != null; }

  feed(bytes) {
    const f = parseScaleFrame(bytes);
    if (!f || !f.checksumOk || this.done) return [];
    const events = [{ type: 'live', weightKg: f.weightKg, heartRate: f.heartRate, locked: this.locked }];

    if (f.weightKg >= MIN_WEIGHT_KG) {
      if (f.weightKg === this.lastWeight) this.weightRepeats++;
      else { this.lastWeight = f.weightKg; this.weightRepeats = 1; }
      // The stable weight follows the latest value that repeated, never a passing reading.
      if (this.weightRepeats >= WEIGHT_LOCK_FRAMES && f.weightKg !== this.lockedWeight) {
        const first = !this.locked;
        this.lockedWeight = f.weightKg;
        if (first) events.push({ type: 'locked', weightKg: f.weightKg });
      }
    } else if (this.locked) {
      // Weight dropped to (near) zero after the lock: the user stepped off.
      events.push(this.finish('stepped-off'));
      return events;
    }

    if (this.locked && f.heartRate != null && f.heartRate >= HR_RANGE[0] && f.heartRate <= HR_RANGE[1]) {
      if (f.heartRate === this.lastHr) this.hrRepeats++;
      else { this.lastHr = f.heartRate; this.hrRepeats = 1; }
      if (this.hrRepeats >= HR_LOCK_FRAMES) this.heartRate = f.heartRate;
      events.push({ type: 'heart', heartRate: f.heartRate, ticks: this.hrRepeats });
      if (this.heartRate != null) events.push(this.finish('heart-rate'));
    }
    return events;
  }

  /** Ends the weigh-in. Returns the 'complete' event, or null if no weight ever locked. */
  finish(reason) {
    if (this.done || !this.locked) return null;
    this.done = true;
    return { type: 'complete', weightKg: this.lockedWeight, heartRate: this.heartRate, reason };
  }
}
