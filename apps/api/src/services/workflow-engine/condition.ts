/**
 * 条件求值（纯函数，可直接单测）。
 *
 * 用于 condition 节点边路由 与 边条件判断：
 *  - 边条件 { variable, operator, value } 缺省 variable/operator 即视为「兜底/else」；
 *  - 支持 eq/ne/gt/gte/lt/lte/contains/starts_with/ends_with/is_empty/
 *    is_not_empty/in/not_in/regex/truthy/falsy 共 16 种操作符。
 */
import type { WorkflowEdgeCondition } from '@pulse/contracts';
import type { WorkflowEdgeDefinition } from './types.js';
import { resolvePath } from './template.js';

/** 标量宽松相等（number/string/boolean 互转比较；对象走引用相等） */
function looseEq(a: unknown, b: unknown): boolean {
  if (typeof a === typeof b) return a === b;
  if (a !== null && b !== null && ['string', 'number', 'boolean'].includes(typeof a) && ['string', 'number', 'boolean'].includes(typeof b)) {
    return String(a) === String(b);
  }
  return a === b;
}

/** 判断单个边条件是否命中 */
export function evaluateCondition(cond: WorkflowEdgeCondition, variables: Record<string, unknown>): boolean {
  const { variable, operator, value } = cond;
  if (variable === undefined || operator === undefined) return false;
  const actual = resolvePath(variables, variable);
  switch (operator) {
    case 'eq':
      return looseEq(actual, value);
    case 'ne':
      return !looseEq(actual, value);
    case 'gt':
      return Number(actual) > Number(value);
    case 'gte':
      return Number(actual) >= Number(value);
    case 'lt':
      return Number(actual) < Number(value);
    case 'lte':
      return Number(actual) <= Number(value);
    case 'contains': {
      if (Array.isArray(actual)) return actual.some((item) => looseEq(item, value));
      return typeof actual === 'string' && actual.includes(String(value));
    }
    case 'starts_with':
      return typeof actual === 'string' && actual.startsWith(String(value));
    case 'ends_with':
      return typeof actual === 'string' && actual.endsWith(String(value));
    case 'is_empty':
      return isEmpty(actual);
    case 'is_not_empty':
      return !isEmpty(actual);
    case 'in':
      return containsAny(value, actual);
    case 'not_in':
      return !containsAny(value, actual);
    case 'regex':
      return typeof actual === 'string' ? safeRegex(String(value)).test(actual) : false;
    case 'truthy':
      return Boolean(actual);
    case 'falsy':
      return !actual;
    default:
      return false;
  }
}

function isEmpty(actual: unknown): boolean {
  return (
    actual === undefined ||
    actual === null ||
    actual === '' ||
    (Array.isArray(actual) && actual.length === 0) ||
    (typeof actual === 'object' && !Array.isArray(actual) && Object.keys(actual as Record<string, unknown>).length === 0)
  );
}

/** in / not_in：value 可为数组或逗号分隔字符串 */
function containsAny(value: unknown, actual: unknown): boolean {
  const list = Array.isArray(value) ? value : String(value).split(',').map((s) => s.trim());
  return list.some((v) => looseEq(actual, v));
}

function safeRegex(pattern: string): RegExp {
  try {
    return new RegExp(pattern);
  } catch {
    return /(?!)/; // 永不匹配
  }
}

export interface BranchHit {
  edge: WorkflowEdgeDefinition;
  /** 命中分支的展示名：优先 condition.branch，缺省用目标节点 id */
  branchLabel: string;
}

/**
 * 按顺序求值一组出边，返回首个命中边：
 *  - 无 condition 或 缺 variable/operator 的边 = 兜底（else）分支，直接命中；
 *  - 有完整条件的边按 evaluateCondition 判定。
 * 全部未命中 → null（调用方决定抛错）。
 */
export function findBranch(edges: WorkflowEdgeDefinition[], variables: Record<string, unknown>): BranchHit | null {
  for (const edge of edges) {
    const cond = edge.condition;
    if (!cond || cond.variable === undefined || cond.operator === undefined) {
      return { edge, branchLabel: cond?.branch ?? edge.targetNodeId };
    }
    if (evaluateCondition(cond, variables)) {
      return { edge, branchLabel: cond.branch ?? edge.targetNodeId };
    }
  }
  return null;
}

/** 取兜底边（无条件的边）；无则 null */
export function fallbackEdge(edges: WorkflowEdgeDefinition[]): WorkflowEdgeDefinition | null {
  for (const edge of edges) {
    const cond = edge.condition;
    if (!cond || cond.variable === undefined || cond.operator === undefined) return edge;
  }
  return null;
}
