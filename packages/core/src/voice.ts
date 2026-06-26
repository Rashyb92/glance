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
  uptimeSec?: number;
}

export type VoiceAction = 'mute' | 'unmute' | 'mark' | 'none';

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
  if (has('clip', 'mark that', 'save that', 'bookmark')) {
    return { intent: 'mark', action: 'mark', speak: 'Marked this moment.' };
  }
  if (has('top supporter', 'top donor', 'biggest tip', 'biggest supporter', 'who is my top')) {
    return {
      intent: 'topSupporter',
      action: 'none',
      speak: snap.topSupporter
        ? `Your top supporter is ${snap.topSupporter.author} with ${snap.topSupporter.bits} bits.`
        : 'No supporters yet this session.',
    };
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
  if (has('how long', 'uptime', 'been live', 'live for')) {
    return {
      intent: 'uptime',
      action: 'none',
      speak:
        snap.uptimeSec != null ? `Live for ${formatDuration(snap.uptimeSec)}.` : "I don't have the uptime.",
    };
  }
  return {
    intent: 'unknown',
    action: 'none',
    speak: 'I can tell you about donations, questions, viewers, the mood, the summary, or clip a moment.',
  };
}

function formatDuration(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h > 0) return `${h} hour${h === 1 ? '' : 's'} ${m} minute${m === 1 ? '' : 's'}`;
  return `${m} minute${m === 1 ? '' : 's'}`;
}
