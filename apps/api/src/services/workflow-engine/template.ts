/**
 * 变量模板渲染（纯函数，可直接单测）。
 *
 * 语法：{{var}} / {{a.b.c}} / {{list[0]}} / {{items["key"]}} / {{items['key']}}
 *  - 变量不存在 → 替换为空字符串；
 *  - 对象值 → JSON.stringify 序列化；
 *  - 其余 → String() 化。
 */
const TEMPLATE_RE = /\{\{\s*([\w.$[\]"'-]+)\s*\}\}/g;

/** 按点/下标路径从根对象取值（a.b、a[0]、a["k"]） */
export function resolvePath(root: unknown, path: string): unknown {
  if (path === '') return root;
  const parts = path
    .split(/[.[\]]+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .map((p) => p.replace(/^["']|["']$/g, ''));
  let cur: unknown = root;
  for (const part of parts) {
    if (cur === null || cur === undefined) return undefined;
    if (typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function stringify(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** 渲染模板：把 {{path}} 替换为变量值 */
export function renderTemplate(template: string, variables: Record<string, unknown>): string {
  return template.replace(TEMPLATE_RE, (_match, path: string) => {
    const value = resolvePath(variables, path);
    return value === undefined ? '' : stringify(value);
  });
}

/** 检测模板是否包含任意 {{...}} 占位 */
export function hasTemplate(template: string): boolean {
  TEMPLATE_RE.lastIndex = 0;
  return TEMPLATE_RE.test(template);
}
