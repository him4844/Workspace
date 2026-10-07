import { pino, type Logger } from 'pino';

const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers["x-hub-signature-256"]',
  'req.headers["x-internal-token"]',
  '*.access_token',
  '*.accessToken',
  '*.access_token_enc',
  '*.password',
  '*.password_hash',
  '*.token',
  '*.secret',
  '*.apiKey',
];

export function createLogger(level = process.env.LOG_LEVEL ?? 'info'): Logger {
  return pino({
    level,
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    base: undefined,
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}

export type { Logger };
