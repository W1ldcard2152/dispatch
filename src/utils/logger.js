import { appendFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import config from '../config.js';

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const currentLevel = LEVELS[config.logLevel] ?? LEVELS.info;

const logDir = join(config.dataDir, 'logs');
mkdirSync(logDir, { recursive: true });

const logFile = join(logDir, `dispatch-${new Date().toISOString().slice(0, 10)}.log`);

function format(level, msg, meta) {
  const ts = new Date().toISOString();
  const base = `[${ts}] [${level.toUpperCase()}] ${msg}`;
  return meta ? `${base} ${JSON.stringify(meta)}` : base;
}

function write(level, msg, meta) {
  if (LEVELS[level] < currentLevel) return;
  const line = format(level, msg, meta);
  console[level === 'error' ? 'error' : 'log'](line);
  try {
    appendFileSync(logFile, line + '\n');
  } catch { /* best effort */ }
}

export const log = {
  debug: (msg, meta) => write('debug', msg, meta),
  info: (msg, meta) => write('info', msg, meta),
  warn: (msg, meta) => write('warn', msg, meta),
  error: (msg, meta) => write('error', msg, meta),
};
