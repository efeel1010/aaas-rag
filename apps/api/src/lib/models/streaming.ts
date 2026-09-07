/**
 * 把模型聊天流转换为浏览器可消费的 SSE ReadableStream。
 *
 * 错误双通道落地在此处：
 *  - 调用方在设置流头之前完成的校验（模型查找/参数）失败 -> 直接 throw，由全局处理器返回 HTTP 失败信封；
 *  - 流已开始后上游出错 -> 写入 `event: error` 块后关闭流。
 */
import type { ModelStreamEvent } from '@pulse/contracts';
import { chatStream, chatStreamWithFallback } from './index.js';
import { sseEncode } from './sse.js';
import { AppError } from '../errors.js';
import type { ChatInvocation, ModelDescriptor, ProviderDescriptor } from './types.js';

export function toSseReadable(
  provider: ProviderDescriptor,
  model: ModelDescriptor,
  request: ChatInvocation,
  chain?: Array<{ provider: ProviderDescriptor; model: ModelDescriptor }>,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  // 提供 modelChain 时启用主备降级；缺省走单模型直连（行为不变）
  const iterator = (chain && chain.length > 1
    ? chatStreamWithFallback(chain, request)
    : chatStream(provider, model, request))[Symbol.asyncIterator]();

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await iterator.next();
        if (done) {
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode(sseEncode(value)));
      } catch (err) {
        const e = toStreamError(err);
        controller.enqueue(encoder.encode(sseEncode(e)));
        controller.close();
      }
    },
    async cancel() {
      await iterator.return?.();
    },
  });
}

/** 把任意错误归一化为 SSE error 事件 */
function toStreamError(err: unknown): ModelStreamEvent {
  if (err instanceof AppError) {
    return { type: 'error', code: err.code, message: err.message };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { type: 'error', code: 'PROVIDER_ERROR', message };
}