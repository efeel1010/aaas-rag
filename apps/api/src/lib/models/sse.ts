/**
 * SSE 编码规范（M2 对外流式约定）+ 上游 SSE 解析器。
 *
 * 对外 SSE 事件格式（每个事件以空行 \n\n 分隔）：
 *   event: <delta|usage|done|error>
 *   data:  <JSON 字符串，字段与 ModelStreamEvent 一致>
 *
 * 错误双通道约定：
 *   1. 流未开始即失败          -> 返回统一 HTTP 失败信封（非 200）；
 *   2. 已开始流后中途失败       -> 输出 `event: error`，随后关闭流（字段 code/message）。
 */
import type { ModelStreamEvent, sseEventTypeSchema } from '@pulse/contracts';

/** 事件类型（保证与契约枚举一致） */
export type SseEventType = (typeof sseEventTypeSchema._def.values)[number];

/** 把一个归一化事件编码为一段完整的 SSE 块 */
export function sseEncode(event: ModelStreamEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

/** SSE 心跳注释块（可选的连接保活） */
export function sseKeepAlive(): string {
  return `: keep-alive\n\n`;
}

/** 便捷错误事件编码 */
export function sseError(code: string, message: string): string {
  return sseEncode({ type: 'error', code, message });
}

/**
 * 将上游 ReadableStream 逐字节解析为 SSE `data:` 行。
 * 跳过注释行与 `event:`/`id:` 元数据，只 yield `data:`（可能含 "")。直接 yield JSON。
 */
export async function* parseSseDataLines(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let sepIndex: number;
      while ((sepIndex = buffer.indexOf('\n\n')) !== -1) {
        const raw = buffer.slice(0, sepIndex);
        buffer = buffer.slice(sepIndex + 2);
        for (const line of raw.split('\n')) {
          if (line.startsWith('data:')) {
            const data = line.slice(5).trimStart();
            if (data.trim() === '[DONE]') return;
            yield data;
          }
          // 忽略 event: / id: / 注释
        }
      }
    }
    // 尾部残留
    for (const line of buffer.split('\n')) {
      if (line.startsWith('data:')) {
        const data = line.slice(5).trimStart();
        if (data.trim() !== '' && data.trim() !== '[DONE]') yield data;
      }
    }
  } finally {
    reader.releaseLock();
  }
}