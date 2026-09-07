/**
 * 类型化错误体系。
 * 所有预期错误都应派生自 AppError，由全局异常处理器统一格式化为失败信封。
 */
export class AppError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly statusCode: number,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class ValidationError extends AppError {
  constructor(details?: unknown, message = '请求参数校验失败') {
    super(message, 'VALIDATION_ERROR', 422, details);
  }
}

export class NotFoundError extends AppError {
  constructor(resource = '资源', id?: string) {
    super(id ? `${resource}不存在: ${id}` : `${resource}不存在`, 'NOT_FOUND', 404);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = '未认证') {
    super(message, 'UNAUTHORIZED', 401);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = '无权限') {
    super(message, 'FORBIDDEN', 403);
  }
}

export class ConflictError extends AppError {
  constructor(message = '资源冲突') {
    super(message, 'CONFLICT', 409);
  }
}

export class NotImplementedError extends AppError {
  constructor(module = '该模块') {
    super(`${module}尚未实现`, 'NOT_IMPLEMENTED', 501);
  }
}

/** 429 限流命中（滑动窗口 rpm 超限） */
export class TooManyRequestsError extends AppError {
  constructor(message = '请求过于频繁，请稍后再试') {
    super(message, 'RATE_LIMITED', 429);
  }
}

/** 429 累计配额用尽 */
export class QuotaExceededError extends AppError {
  constructor(message = 'API 配额已用完') {
    super(message, 'QUOTA_EXCEEDED', 429);
  }
}