/**
 * 请求对象解析辅助 —— 让路由层的 safeParse 统一为 ValidationError。
 * 返回 schema 的「输出类型」（含 .default() 生效后的字段），
 * 避免用 ZodType<T> 收窄时把 T 绑定到输入类型（默认值字段会变可选）。
 */
import { z, type ZodType } from 'zod';
import { ValidationError } from './errors.js';

export function parse<TSchema extends ZodType>(schema: TSchema, raw: unknown): z.output<TSchema> {
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new ValidationError(result.error.flatten());
  }
  return result.data;
}