/**
 * 轻量 token 估算 —— 没有真实分词器时的兜底方案。
 *
 * 规则与 M2 网关 `estimateTokens` 一致并更精细：
 *  - 连续字母/数字序列视为一个 token（拉丁语系按词边界切，排除 CJK）；
 *  - 中文字符（CJK）逐字计数（保守近似 1 字 ≈ 1 token）；
 *  - 确保最小为 0（空串），便于精确统计。
 */
const WORD_RE = /[\p{L}\p{N}]+/gu;
const CJK_RE = /[\p{Script=Han}]/gu;

export function countTokens(text: string): number {
  if (!text) return 0;
  // 先剔除汉字，避免 CJK 同时被 WORD_RE 与 CJK_RE 重复计数
  const nonCjk = text.replace(CJK_RE, ' ');
  const words = (nonCjk.match(WORD_RE) ?? []).length;
  const cjk = (text.match(CJK_RE) ?? []).length;
  return words + cjk;
}