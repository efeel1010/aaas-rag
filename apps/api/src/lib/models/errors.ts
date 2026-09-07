/**
 * Provider 桥接层错误 —— 由各 provider 实现向上抛出，最终被路由层转换为
 * 「HTTP 失败信封」或「SSE error 事件」（错误双通道）。
 */
import { AppError } from '../errors.js';

export class ProviderError extends AppError {
  constructor(message: string, readonly upstreamStatus?: number) {
    super(message, 'PROVIDER_ERROR', 502, { upstreamStatus });
  }
}

export class ProviderAuthError extends AppError {
  constructor(message = '上游 Provider 鉴权失败') {
    super(message, 'PROVIDER_AUTH_ERROR', 502);
  }
}

export class ProviderUnavailableError extends AppError {
  constructor(message = '上游 Provider 不可用') {
    super(message, 'PROVIDER_UNAVAILABLE', 503);
  }
}