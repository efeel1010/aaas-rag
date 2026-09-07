import { serve } from '@hono/node-server';
import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { createApp } from './app.js';

async function main(): Promise<void> {
  const app = createApp();

  const server = serve(
    {
      fetch: app.fetch,
      port: env.API_PORT,
    },
    (info) => {
      logger.info(
        { address: info.address, port: info.port },
        'pulse-rag api listening',
      );
    },
  );

  // 优雅关闭
  const shutdown = (signal: NodeJS.Signals) => {
    logger.info({ signal }, 'shutting down');
    server.close(() => {
      logger.info('server closed');
      process.exit(0);
    });
    // 兜底：5s 内未关闭则强制退出
    setTimeout(() => process.exit(1), 5_000).unref();
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  logger.error({ err: err instanceof Error ? err.stack : err }, 'fatal startup error');
  process.exit(1);
});