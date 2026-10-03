// Speaking a meal: the browser's speech recognition turns it into text, which then goes through
// the same pipeline as typing (database first, AI only for unknown foods). Chrome, Edge and
// Safari support it; elsewhere the Voice button is hidden.
const Recognition = typeof window !== 'undefined' ? window.SpeechRecognition || window.webkitSpeechRecognition : null;

export const voiceSupported = () => !!Recognition;

const ERRORS = {
  'not-allowed': 'Microphone permission is needed to log by voice. Allow it for this site in your browser settings.',
  'service-not-allowed': 'Voice input is turned off in this browser.',
  'no-speech': "Didn't hear anything. Tap Voice and say what you ate.",
  'audio-capture': 'No microphone was found.',
  network: 'Voice input needs an internet connection.',
};

/**
 * Listens once. onText(text) while speaking, onDone(finalText) at the end, onState(listening),
 * onError(message). Returns { stop() }.
 */
export function startVoice({ onText, onDone, onState, onError, lang = 'en-IN' }) {
  const r = new Recognition();
  r.lang = lang;
  r.interimResults = true;
  r.continuous = false;
  r.maxAlternatives = 1;
  let text = '';
  let failed = false;
  r.onresult = (e) => {
    text = [...e.results].map((res) => res[0].transcript).join(' ').replace(/\s+/g, ' ').trim();
    onText?.(text);
  };
  r.onerror = (e) => {
    if (e.error === 'aborted') return;
    failed = true;
    onError?.(ERRORS[e.error] || "Voice input didn't work. Please type your meal instead.");
  };
  r.onend = () => { onState?.(false); if (!failed) onDone?.(text); };
  try {
    r.start();
    onState?.(true);
  } catch (e) {
    onError?.("Voice input couldn't start. Please type your meal instead.");
    console.warn('[NutriLog] voice', e);
  }
  return { stop: () => { try { r.stop(); } catch { /* already stopped */ } } };
}
