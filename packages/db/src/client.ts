/**
 * @pulse/db client —— 基于 node-postgres 的连接池封装。
 */
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema/index.js';

export type Db = NodePgDatabase<typeof schema>;

export interface CreateDbOptions {
  connectionString: string;
  poolSize?: number;
  idleTimeoutMs?: number;
  connectionTimeoutMs?: number;
}

/** 根据连接串创建带 schema 类型的 drizzle 实例 */
export function createDb(options: CreateDbOptions): Db {
  const pool = new Pool({
    connectionString: options.connectionString,
    max: options.poolSize ?? 10,
    idleTimeoutMillis: options.idleTimeoutMs ?? 30_000,
    connectionTimeoutMillis: options.connectionTimeoutMs ?? 5_000,
  });
  return drizzle(pool, { schema });
}

export { schema };