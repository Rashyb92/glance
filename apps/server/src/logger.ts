/**
 * Structured, leveled logger. JSON lines in production (for log aggregation),
 * human-friendly colored output in dev. Level via GLANCE_LOG_LEVEL.
 */
type Level = 'debug' | 'info' | 'warn' | 'error';
type Fields = Record<string, unknown>;

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const MIN = LEVELS[(process.env['GLANCE_LOG_LEVEL'] as Level | undefined) ?? 'info'] ?? 20;
const PRETTY =
  process.env['GLANCE_LOG_PRETTY'] === '1' || process.env['NODE_ENV'] !== 'production';

function color(level: Level): string {
  switch (level) {
    case 'error':
      return '\x1b[31m';
    case 'warn':
      return '\x1b[33m';
    case 'info':
      return '\x1b[36m';
    default:
      return '\x1b[2m';
  }
}

function emit(level: Level, msg: string, fields?: Fields): void {
  if (LEVELS[level] < MIN) return;
  const ts = new Date().toISOString();
  if (PRETTY) {
    const extra = fields && Object.keys(fields).length ? ` ${JSON.stringify(fields)}` : '';
    console.log(`\x1b[2m${ts.slice(11, 19)}\x1b[0m ${color(level)}${level.toUpperCase().padEnd(5)}\x1b[0m ${msg}${extra}`);
  } else {
    console.log(JSON.stringify({ t: ts, level, msg, ...fields }));
  }
}

export const logger = {
  debug: (msg: string, fields?: Fields) => emit('debug', msg, fields),
  info: (msg: string, fields?: Fields) => emit('info', msg, fields),
  warn: (msg: string, fields?: Fields) => emit('warn', msg, fields),
  error: (msg: string, fields?: Fields) => emit('error', msg, fields),
};

/** Normalize an unknown thrown value to a short message for logging. */
export function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
