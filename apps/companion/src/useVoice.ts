import { useCallback, useRef, useState } from 'react';

// The Web Speech recognition API is vendor-prefixed and not in the standard DOM lib,
// so we describe the minimal surface we use.
interface RecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
}
type RecognitionCtor = new () => RecognitionLike;

function getCtor(): RecognitionCtor | null {
  const w = window as unknown as {
    SpeechRecognition?: RecognitionCtor;
    webkitSpeechRecognition?: RecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export interface Voice {
  supported: boolean;
  listening: boolean;
  toggle: () => void;
}

/** Tap-to-talk speech recognition. Calls `onTranscript` with the recognized phrase. */
export function useVoice(onTranscript: (text: string) => void): Voice {
  const [listening, setListening] = useState(false);
  const recRef = useRef<RecognitionLike | null>(null);

  const toggle = useCallback(() => {
    if (recRef.current) {
      recRef.current.stop();
      return;
    }
    const Ctor = getCtor();
    if (!Ctor) return;
    const rec = new Ctor();
    rec.lang = 'en-US';
    rec.continuous = false;
    rec.interimResults = false;
    rec.onresult = (event) => {
      const text = event.results?.[0]?.[0]?.transcript ?? '';
      if (text) onTranscript(text);
    };
    const finish = (): void => {
      recRef.current = null;
      setListening(false);
    };
    rec.onerror = finish;
    rec.onend = finish;
    recRef.current = rec;
    setListening(true);
    try {
      rec.start();
    } catch {
      finish();
    }
  }, [onTranscript]);

  return { supported: getCtor() !== null, listening, toggle };
}
