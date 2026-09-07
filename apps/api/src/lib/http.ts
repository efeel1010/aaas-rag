/** 统一响应信封的构建辅助。 */
import type { ApiFailure, ApiSuccess } from '@pulse/contracts';

/** 成功信封 { success: true, data } */
export function ok<T>(data: T): ApiSuccess<T> {
  return { success: true, data };
}

/** 失败信封 { success: false, error } */
export function fail(code: string, message: string, details?: unknown): ApiFailure {
  return { success: false, error: { code, message, ...(details !== undefined && { details }) } };
}