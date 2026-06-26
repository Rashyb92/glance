/**
 * Device audio output for the HUD: spoken text (Web Speech API) and short earcons
 * (WebAudio). This is the "hear it" half of the routing matrix — used when the
 * device's audio output is enabled. All calls degrade silently if the browser
 * lacks the API.
 */
let audioContext: AudioContext | null = null;

function getContext(): AudioContext | null {
  try {
    const Ctor =
      window.AudioContext ??
      (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    audioContext ??= new Ctor();
    return audioContext;
  } catch {
    return null;
  }
}

let pending = 0;
const MAX_PENDING = 2;

/**
 * Speak text via the Web Speech API. Keeps the earbud near real-time: if the queue
 * is backing up (or `interrupt` is set — e.g. a priority callout), it clears pending
 * speech so the creator hears the latest, not a stale backlog.
 */
export function speak(text: string, volume = 1, interrupt = false): void {
  try {
    const synth = window.speechSynthesis;
    if (!synth) return;
    if (interrupt || pending >= MAX_PENDING) {
      synth.cancel();
      pending = 0;
    }
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.volume = Math.max(0, Math.min(1, volume));
    utterance.rate = 1.05;
    pending += 1;
    const done = (): void => {
      pending = Math.max(0, pending - 1);
    };
    utterance.onend = done;
    utterance.onerror = done;
    synth.speak(utterance);
  } catch {
    /* speech synthesis unavailable */
  }
}

export type EarconKind = 'donation' | 'event' | 'alert';

export function earcon(kind: EarconKind, volume = 1): void {
  const ctx = getContext();
  if (!ctx) return;
  try {
    const notes = kind === 'donation' ? [880, 1320] : kind === 'alert' ? [520, 392] : [660, 990];
    const base = ctx.currentTime;
    notes.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      const start = base + i * 0.12;
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(0.2 * Math.max(0, Math.min(1, volume)), start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, start + 0.18);
      osc.connect(gain).connect(ctx.destination);
      osc.start(start);
      osc.stop(start + 0.2);
    });
  } catch {
    /* audio output unavailable */
  }
}
