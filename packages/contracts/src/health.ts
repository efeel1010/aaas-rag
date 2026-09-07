import { z } from 'zod';

/** 健康检查结果 */
export const healthResultSchema = z.object({
  status: z.literal('up'),
  service: z.string(),
  version: z.string(),
  uptimeSec: z.number().nonnegative(),
  timestamp: z.string(),
});

export type HealthResult = z.infer<typeof healthResultSchema>;

/** 失败信封存在的运行时校验（用于测试 / 契约校验） */
export const apiFailureSchema = z.object({
  success: z.literal(false),
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});

export type ApiFailureBody = z.infer<typeof apiFailureSchema>;