// Web Bluetooth connection to the Cult smart scale. The frame format and the weigh-in state
// machine live in lib/scale-protocol.js; this file handles the browser API, timers and errors.
// Works in Chrome / Edge (desktop and Android) and in Bluefy on iPhone. Needs HTTPS.
import { SCALE_SERVICE_UUID, SCALE_MEASUREMENT_UUID, SCALE_NAME_PREFIXES, WeighInSession } from '../lib/scale-protocol.js';
import { UserError } from '../lib/utils.js';

const IDLE_AFTER_LOCK_MS = 6000;   // frames stopped after the lock → the scale has finished
const MAX_AFTER_LOCK_MS = 45000;   // never wait longer than this for a heart rate
const NO_DATA_HINT_MS = 15000;     // connected but silent → remind the user to stand on it

/** 'ok' | 'ios' (Safari: no Web Bluetooth) | 'insecure' (needs HTTPS) | 'unsupported' */
export function bluetoothSupport() {
  if (!window.isSecureContext) return 'insecure';
  if (navigator.bluetooth?.requestDevice) return 'ok';
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  return ios ? 'ios' : 'unsupported';
}

function toUserError(err) {
  const name = err?.name;
  const msg = String(err?.message || '');
  if (name === 'NotFoundError') {
    if (/adapter|not available|unavailable|turned off/i.test(msg)) return new UserError('Bluetooth is off or unavailable. Turn it on and try again.', err);
    return Object.assign(new UserError('No scale was selected.', err), { dismissed: true });
  }
  if (name === 'SecurityError' || name === 'NotAllowedError') return new UserError('Bluetooth access is blocked. Allow Bluetooth for this site in your browser settings and try again.', err);
  if (name === 'NetworkError') return new UserError("Couldn't connect to the scale. Step on it to wake it up, close the Cult app if it is connected, and try again.", err);
  return new UserError("Couldn't connect to the scale. Please try again.", err);
}

/**
 * Connects to the scale and runs one weigh-in. Call it from a click: the browser then shows its
 * device chooser. `on` handlers (all optional):
 *   status('choose' | 'connecting' | 'connected' | 'no-data')
 *   live({ weightKg, heartRate, locked }), locked({ weightKg }), heart({ heartRate, ticks })
 *   complete({ weightKg, heartRate, reason }) — exactly once
 *   error(UserError), disconnected() — the scale went away before a weight locked
 * Returns { cancel() }.
 */
export function startWeighIn(on = {}) {
  const emit = (type, payload) => {
    try { on[type]?.(payload); } catch (e) { console.error(`[NutriLog] scale ${type} handler failed`, e); }
  };
  const session = new WeighInSession();
  let device = null;
  let characteristic = null;
  let stopped = false;
  let idleTimer = null, capTimer = null, hintTimer = null;

  const teardown = () => {
    clearTimeout(idleTimer); clearTimeout(capTimer); clearTimeout(hintTimer);
    if (characteristic) {
      characteristic.removeEventListener('characteristicvaluechanged', onValue);
      characteristic.stopNotifications?.().catch(() => {});
      characteristic = null;
    }
    if (device) {
      device.removeEventListener('gattserverdisconnected', onDisconnect);
      if (device.gatt?.connected) device.gatt.disconnect();
      device = null;
    }
  };
  const complete = (event) => {
    if (!event || stopped) return;
    stopped = true;
    teardown();
    emit('complete', event);
  };
  function onValue(e) {
    if (stopped) return;
    clearTimeout(hintTimer);
    for (const ev of session.feed(e.target.value)) {
      if (ev.type === 'complete') { complete(ev); return; }
      emit(ev.type, ev);
    }
    if (session.locked) {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => complete(session.finish('idle')), IDLE_AFTER_LOCK_MS);
      capTimer ||= setTimeout(() => complete(session.finish('timeout')), MAX_AFTER_LOCK_MS);
    }
  }
  function onDisconnect() {
    if (stopped) return;
    const done = session.finish('disconnect');
    if (done) { complete(done); return; }
    stopped = true;
    teardown();
    emit('disconnected');
  }

  (async () => {
    let picked = null;
    // If the user closes the sheet while we are still connecting, drop the late connection.
    const abandoned = () => {
      if (!stopped) return false;
      if (picked?.gatt?.connected) picked.gatt.disconnect();
      return true;
    };
    try {
      emit('status', 'choose');
      // requestDevice runs synchronously inside the user's click, as the browser requires.
      picked = await navigator.bluetooth.requestDevice({
        filters: [...SCALE_NAME_PREFIXES.map((namePrefix) => ({ namePrefix })), { services: [SCALE_SERVICE_UUID] }],
        optionalServices: [SCALE_SERVICE_UUID],
      });
      if (abandoned()) return;
      device = picked;
      device.addEventListener('gattserverdisconnected', onDisconnect);
      emit('status', 'connecting');
      const server = await picked.gatt.connect();
      if (abandoned()) return;
      const service = await server.getPrimaryService(SCALE_SERVICE_UUID);
      const ch = await service.getCharacteristic(SCALE_MEASUREMENT_UUID);
      if (abandoned()) return;
      characteristic = ch;
      characteristic.addEventListener('characteristicvaluechanged', onValue);
      await characteristic.startNotifications();
      if (abandoned()) return;
      emit('status', 'connected');
      hintTimer = setTimeout(() => { if (!stopped && !session.locked) emit('status', 'no-data'); }, NO_DATA_HINT_MS);
    } catch (err) {
      if (abandoned()) return;
      stopped = true;
      teardown();
      const e = toUserError(err);
      console.warn('[NutriLog] scale connection failed', err);
      emit('error', e);
    }
  })();

  return { cancel() { stopped = true; teardown(); } };
}
