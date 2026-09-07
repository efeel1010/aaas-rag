/**
 * @pulse/api 数据库单例 —— 惰性连接（Pool 延迟到首次查询才真正建连）。
 */
import { createDb, type Db } from '@pulse/db';
import { env } from '../config/env.js';

let instance: Db | undefined;

export function getDb(): Db {
  if (!instance) {
    instance = createDb({ connectionString: env.DATABASE_URL });
  }
  return instance;
}