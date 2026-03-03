const winston = require('winston');
const DailyRotateFile = require('winston-daily-rotate-file');
const path = require('path');
const fs = require('fs');

const logsDir = path.join(process.cwd(), 'logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

const logFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.printf(({ timestamp, level, message, stack, ...meta }) => {
    let log = `[${timestamp}] [${level.toUpperCase().padEnd(5)}] ${message}`;
    if (Object.keys(meta).length) {
      log += ` | ${JSON.stringify(meta)}`;
    }
    if (stack) {
      log += `\nStack Trace:\n${stack}`;
    }
    return log;
  })
);

const colorizedConsoleFormat = winston.format.combine(
  winston.format.colorize({ all: true }),
  winston.format.timestamp({ format: 'HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.printf(({ timestamp, level, message, stack, ...meta }) => {
    let log = `[${timestamp}] ${level}: ${message}`;
    if (Object.keys(meta).length) {
      log += ` | ${JSON.stringify(meta)}`;
    }
    if (stack) {
      log += `\n${stack}`;
    }
    return log;
  })
);

const dailyRotateTransport = new DailyRotateFile({
  filename: path.join(logsDir, 'debug-%DATE%.log'),
  datePattern: 'YYYY-MM-DD',
  maxFiles: '7d',
  maxSize: '20m',
  level: 'debug',
  format: logFormat,
});

dailyRotateTransport.on('rotate', (oldFilename, newFilename) => {
  console.log(`[Logger] Rotated log: ${oldFilename} → ${newFilename}`);
});

const logger = winston.createLogger({
  level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
  transports: [
    new winston.transports.Console({
      format: colorizedConsoleFormat,
    }),
    dailyRotateTransport,
  ],
  exitOnError: false,
});

module.exports = logger;
