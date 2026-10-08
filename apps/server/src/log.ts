import { type Logger, pino } from 'pino';
import pretty from 'pino-pretty';

export type { Logger } from 'pino';

/** Keys that must never reach a log line, wherever they appear. */
export const REDACT_PATHS = [
  'token',
  '*.token',
  'authorization',
  '*.authorization',
  'headers.authorization',
  '*.headers.authorization',
  'apiKey',
  '*.apiKey',
  'ANTHROPIC_API_KEY',
  '*.ANTHROPIC_API_KEY',
];

export interface LoggerOptions {
  /** Human-readable output (dev, TTY). JSON lines otherwise. */
  pretty?: boolean;
  level?: string;
  name?: string;
}

/** Creates the process logger. Secrets are redacted by key; never log a token or key by value either. */
export function createLogger(options: LoggerOptions = {}): Logger {
  const base = {
    name: options.name ?? 'minevibe',
    level: options.level ?? process.env.MINEVIBE_LOG_LEVEL ?? 'info',
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
  };
  if (options.pretty) {
    return pino(
      base,
      pretty({ colorize: true, translateTime: 'SYS:HH:MM:ss.l', ignore: 'pid,hostname', sync: true }),
    );
  }
  return pino(base);
}

/** A logger that discards everything (tests). */
export function silentLogger(): Logger {
  return pino({ level: 'silent' });
}
