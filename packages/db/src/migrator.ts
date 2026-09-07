/**
 * 迁移执行器 —— 供应用在启动时可选执行（或由 db:migrate 脚本调用）。
 */
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDb, type Db } from './client.js';

export interface MigrateOptions {
  connectionString: string;
  migrationsFolder?: string;
}

/** 在给定连接上执行位于 packages/db/migrations 下的迁移 */
export async function runMigrations(db: Db, migrationsFolder: string): Promise<void> {
  await migrate(db, { migrationsFolder });
  return;
}

export { createDb };