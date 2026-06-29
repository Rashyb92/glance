/**
 * Lightweight toxicity / harassment detector for moderation, 0 (clean) .. 1.
 * Pure and deterministic. Its job is to *flag* messages a streamer or their mods
 * should see and act on (harassment, self-harm encouragement, targeted insults) —
 * a safety signal, not a censor. A real deployment would back this with a
 * dedicated model behind the same function signature.
 */
export interface ToxicitySignal {
  score: number;
  flagged: boolean;
}

const PROFANITY = [
  'fuck',
  'shit',
  'bitch',
  'asshole',
  'dick',
  'cunt',
  'bastard',
  'douche',
  'prick',
];

const HARASSMENT: RegExp[] = [
  /\bk+y+s+\b/i, // "kys"
  /\bkill (yourself|urself|u)\b/i,
  /\b(you|u|ur|youre|you're)\s+(are\s+|r\s+)?(a\s+|an\s+)?(idiot|moron|loser|trash|garbage|worthless|pathetic|clown)\b/i,
  /\bnobody (likes|cares about|wants) (you|u)\b/i,
];

export function analyzeToxicity(text: string): ToxicitySignal {
  const lower = text.toLowerCase();
  let score = 0;

  for (const word of PROFANITY) {
    if (lower.includes(word)) score += 0.25;
  }

  let harassment = false;
  for (const pattern of HARASSMENT) {
    if (pattern.test(text)) {
      score += 0.6;
      harassment = true;
    }
  }

  // Sustained shouting adds a little weight.
  const letters = text.replace(/[^a-zA-Z]/g, '');
  if (letters.length >= 8) {
    const caps = (text.match(/[A-Z]/g) ?? []).length;
    if (caps / letters.length > 0.8) score += 0.1;
  }

  score = Math.min(1, score);
  return { score: Math.round(score * 100) / 100, flagged: harassment || score >= 0.5 };
}
