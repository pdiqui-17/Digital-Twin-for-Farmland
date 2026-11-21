export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

/**
 * Tạo logger cấu trúc (JSON khi chạy production/K8s, text gọn khi chạy local dev).
 */
export function createLogger(serviceName: string, minLevel?: LogLevel): Logger {
  const configuredLevel = (minLevel ?? (process.env.LOG_LEVEL as LogLevel) ?? 'info').toLowerCase() as LogLevel;
  const threshold = LOG_LEVEL_WEIGHT[configuredLevel] ?? LOG_LEVEL_WEIGHT.info;
  const isJson = process.env.LOG_FORMAT === 'json' || process.env.NODE_ENV === 'production';

  function write(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
    if (LOG_LEVEL_WEIGHT[level] < threshold) return;

    const ts = new Date().toISOString();
    if (isJson) {
      const entry = JSON.stringify({
        ts,
        level,
        service: serviceName,
        msg: message,
        ...(meta ?? {}),
      });
      if (level === 'error') {
        process.stderr.write(`${entry}\n`);
      } else {
        process.stdout.write(`${entry}\n`);
      }
      return;
    }

    const metaSuffix = meta && Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : '';
    const line = `[${ts}] [${level.toUpperCase()}] [${serviceName}] ${message}${metaSuffix}\n`;
    if (level === 'error') {
      process.stderr.write(line);
    } else {
      process.stdout.write(line);
    }
  }

  return {
    debug: (msg, meta) => write('debug', msg, meta),
    info: (msg, meta) => write('info', msg, meta),
    warn: (msg, meta) => write('warn', msg, meta),
    error: (msg, meta) => write('error', msg, meta),
  };
}
