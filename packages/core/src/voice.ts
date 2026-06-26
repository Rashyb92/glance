/**
 * @glance/core — voice commands.
 *
 * The "ask Glance" path: a creator speaks a query into an earbud/glasses mic, and
 * Glance answers aloud. This is the pure intent parser — given a transcript and a
 * snapshot of the live session, it returns what to speak back (and an optional control
 * action). The browser/native client owns speech-to-text and text-to-speech; this is
 * deterministic and unit-tested.
 */
export interface VoiceSnapshot {
  viewers: number | null;
  chatters: number;
  bitsTotal: number;
  questionsWaiting: number;
  mood: string;
  topSupporter?: { author: string; bits: number };
  summary?: string;
  topPriority?: { author?: string; text: string };
}

export type VoiceAction = 'mute' | 'unmute' | 'none';

export interface VoiceResponse {
  intent: string;
  action: VoiceAction;
  speak: string;
}

export function parseVoiceCommand(transcript: string, snap: VoiceSnapshot): VoiceResponse {
  const t = transcript.toLowerCase();
  const has = (...words: string[]): boolean => words.some((w) => t.includes(w));

  if (has('mute', 'quiet', 'silence', 'stop talking', 'shut up')) {
    return { intent: 'mute', action: 'mute', speak: 'Muted.' };
  }
  if (has('unmute', 'resume', 'start listening', 'listen up')) {
    return { intent: 'unmute', action: 'unmute', speak: 'Listening.' };
  }
  if (has('donation', 'donate', 'bits', 'tips', 'money', 'cheer')) {
    if (snap.bitsTotal > 0) {
      const top = snap.topSupporter ? `, top from ${snap.topSupporter.author}` : '';
      return { intent: 'donations', action: 'none', speak: `${snap.bitsTotal} bits this session${top}.` };
    }
    return { intent: 'donations', action: 'none', speak: 'No bits yet this session.' };
  }
  if (has('question')) {
    const n = snap.questionsWaiting;
    return {
      intent: 'questions',
      action: 'none',
      speak: n > 0 ? `${n} question${n === 1 ? '' : 's'} waiting.` : 'No questions waiting.',
    };
  }
  if (has('summary', 'recap', 'happening', 'catch me up', 'going on')) {
    return {
      intent: 'summary',
      action: 'none',
      speak: snap.summary ?? "It's been quiet — no summary yet.",
    };
  }
  if (has('viewer', 'watching', 'how many people')) {
    return {
      intent: 'viewers',
      action: 'none',
      speak: snap.viewers != null ? `${snap.viewers} watching right now.` : "Viewer count isn't available.",
    };
  }
  if (has('chatter', 'chatting', 'active')) {
    return { intent: 'chatters', action: 'none', speak: `${snap.chatters} people chatting.` };
  }
  if (has('priority', 'answer', 'important', 'who should')) {
    return {
      intent: 'priority',
      action: 'none',
      speak: snap.topPriority
        ? `${snap.topPriority.author ?? 'Chat'} says: ${snap.topPriority.text}`
        : 'Nothing urgent right now.',
    };
  }
  if (has('mood', 'vibe', 'feel')) {
    return { intent: 'mood', action: 'none', speak: `The vibe is ${snap.mood}.` };
  }
  return {
    intent: 'unknown',
    action: 'none',
    speak: 'I can tell you about donations, questions, viewers, the mood, or a summary.',
  };
}
