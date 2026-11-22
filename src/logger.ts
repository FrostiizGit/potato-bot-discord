type Level = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const COLORS: Record<Level, string> = { debug: '\x1b[90m', info: '\x1b[36m', warn: '\x1b[33m', error: '\x1b[31m' };
const RESET = '\x1b[0m';

const envLevel = process.env.LOG_LEVEL?.toLowerCase() as Level | undefined;
const minLevel = ORDER[envLevel ?? 'info'] ?? ORDER.info;
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;

function write(level: Level, scope: string, message: string, extra: unknown[]) {
  if (ORDER[level] < minLevel) return;
  const time = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const tag = level.toUpperCase().padEnd(5);
  const line = useColor
    ? `\x1b[90m${time}${RESET} ${COLORS[level]}${tag}${RESET} \x1b[1m[${scope}]${RESET} ${message}`
    : `${time} ${tag} [${scope}] ${message}`;
  const out = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  out(line, ...extra);
}

export interface Logger {
  debug(message: string, ...extra: unknown[]): void;
  info(message: string, ...extra: unknown[]): void;
  warn(message: string, ...extra: unknown[]): void;
  error(message: string, ...extra: unknown[]): void;
}

/** `createLogger('player')` → lines like `2026-11-22 14:03:12 INFO  [player] Now playing ...`. Set LOG_LEVEL=debug for more. */
export function createLogger(scope: string): Logger {
  return {
    debug: (m, ...e) => write('debug', scope, m, e),
    info: (m, ...e) => write('info', scope, m, e),
    warn: (m, ...e) => write('warn', scope, m, e),
    error: (m, ...e) => write('error', scope, m, e),
  };
}
