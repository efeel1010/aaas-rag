/** 统一 API 响应信封的类型定义 */

/** 成功响应 */
export interface ApiSuccess<T> {
  success: true;
  data: T;
}

/** 失败响应 */
export interface ApiFailure {
  success: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

/** 成功 + 失败的判别联合 */
export type ApiResponse<T> = ApiSuccess<T> | ApiFailure;

/** 分页结构 */
export interface Page<T> {
  items: T[];
  /** 当前页码，从 1 开始 */
  page: number;
  perPage: number;
  /** 满足筛选条件的总条数 */
  total: number;
}

/** 错误码 —— 后续业务模块统一复用 */
export const ErrorCode = {
  INTERNAL: 'INTERNAL_ERROR',
  VALIDATION: 'VALIDATION_ERROR',
  NOT_FOUND: 'NOT_FOUND',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  CONFLICT: 'CONFLICT',
  NOT_IMPLEMENTED: 'NOT_IMPLEMENTED',
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];