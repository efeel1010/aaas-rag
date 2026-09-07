import { pino } from 'pino';
import { env } from '../config/env.js';

/** 结构化 JSON 日志（代替散落的 console.log） */
export const logger = pino({
  level: env.LOG_LEVEL,
  base: undefined,
  timestamp: pino.stdTimeFunctions.isoTime,
});