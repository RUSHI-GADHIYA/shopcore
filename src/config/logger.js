/**
 * Winston logger.
 *
 * Development gets human-readable coloured lines on the console; production gets
 * JSON on the console (for a log collector) plus rotating error/combined files.
 * Request-scoped fields such as requestId are attached by callers via child loggers.
 */
import path from 'node:path';
import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import { env, isProduction, isTest } from './env.js';

const LOG_DIR = path.resolve('logs');

const developmentFormat = winston.format.combine(
  winston.format.colorize(),
  winston.format.timestamp({ format: 'HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.printf(({ level, message, timestamp, stack, requestId, ...meta }) => {
    const scope = requestId ? ` [${requestId}]` : '';
    const extra = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
    return `${timestamp} ${level}${scope}: ${stack || message}${extra}`;
  })
);

const productionFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.errors({ stack: true }),
  winston.format.json()
);

const transports = [
  new winston.transports.Console({
    // Tests are noisy enough without a running commentary; only surface real errors.
    silent: isTest,
  }),
];

if (isProduction) {
  transports.push(
    new DailyRotateFile({
      dirname: LOG_DIR,
      filename: 'error-%DATE%.log',
      level: 'error',
      datePattern: 'YYYY-MM-DD',
      maxFiles: '30d',
      zippedArchive: true,
    }),
    new DailyRotateFile({
      dirname: LOG_DIR,
      filename: 'combined-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      maxFiles: '14d',
      zippedArchive: true,
    })
  );
}

export const logger = winston.createLogger({
  level: isProduction ? 'info' : 'debug',
  format: isProduction ? productionFormat : developmentFormat,
  defaultMeta: { service: 'shopcore', env: env.NODE_ENV },
  transports,
  exitOnError: false,
});

/** Morgan writes its formatted line here so HTTP logs share one pipeline. */
export const morganStream = {
  write: (message) => logger.http?.(message.trim()) ?? logger.info(message.trim()),
};

export default logger;
