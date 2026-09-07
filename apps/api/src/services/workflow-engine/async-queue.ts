/**
 * 简单的异步队列：生产者在执行线程 push，消费者 for-await 消费。
 * 用于把「节点完成事件」从 LangGraph 执行线程实时转发到 SSE 输出线程。
 */
export class AsyncQueue<T> implements AsyncIterableIterator<T> {
  private items: T[] = [];
  private waiters: Array<{ resolve: (result: IteratorResult<T>) => void }> = [];
  private closed = false;

  push(item: T): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve({ done: false, value: item });
      return;
    }
    this.items.push(item);
  }

  close(): void {
    this.closed = true;
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift()!;
      waiter.resolve({ done: true, value: undefined as never });
    }
  }

  next(): Promise<IteratorResult<T>> {
    if (this.items.length > 0) {
      return Promise.resolve({ done: false, value: this.items.shift()! });
    }
    if (this.closed) {
      return Promise.resolve({ done: true, value: undefined as never });
    }
    return new Promise<IteratorResult<T>>((resolve) => {
      this.waiters.push({ resolve });
    });
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<T> {
    return this;
  }
}
