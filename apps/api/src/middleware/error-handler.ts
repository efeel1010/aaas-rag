import type { Context, ErrorHandler, NotFoundHandler } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { ZodError } from 'zod';
import { AppError } from '../lib/errors.js';
import { fail } from '../lib/http.js';
import { logger } from '../lib/logger.js';
import type { AppEnv } from '../types.js';

function getRequestId(c: Context<AppEnv>): string {
  try {
    return c.get('requestId');
  } catch {
    return 'unknown';
  }
}

/** 全局异常处理器：把任意异常转成统一失败信封 */
export const onError: ErrorHandler<AppEnv> = (err, c) => {
  const requestId = getRequestId(c);

  if (err instanceof ZodError) {
    return c.json(
      fail('VALIDATION_ERROR', '请求参数校验失败', err.flatten()),
      422,
    );
  }

  if (err instanceof AppError) {
    return c.json(fail(err.code, err.message, err.details), err.statusCode as ContentfulStatusCode);
  }

  logger.error({ requestId, err: err instanceof Error ? err.stack : err }, 'unhandled error');
  return c.json(fail('INTERNAL_ERROR', '服务器内部错误'), 500);
};

/** 404 处理器 */
export const notFound: NotFoundHandler<AppEnv> = (c) => {
  return c.json(
    fail('NOT_FOUND', '接口不存在', { path: c.req.path, method: c.req.method }),
    404,
  );
};