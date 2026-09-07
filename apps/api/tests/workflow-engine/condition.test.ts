/**
 * M5 条件求值单测 —— evaluateCondition 16 种操作符 + findBranch 分支路由 + fallbackEdge。
 */
import { describe, expect, it } from 'vitest';
import type { WorkflowEdgeCondition } from '@pulse/contracts';
import { evaluateCondition, fallbackEdge, findBranch } from '../../src/services/workflow-engine/condition.js';
import type { WorkflowEdgeDefinition } from '../../src/services/workflow-engine/types.js';

function edge(overrides: Partial<WorkflowEdgeDefinition> = {}): WorkflowEdgeDefinition {
  return {
    id: 'e1',
    sourceNodeId: 'src',
    targetNodeId: 'dst',
    condition: null,
    ...overrides,
  };
}

function cond(overrides: Partial<WorkflowEdgeCondition> = {}): WorkflowEdgeCondition {
  return { variable: 'x', operator: 'eq', value: 1, ...overrides };
}

describe('evaluateCondition', () => {
  it('缺 variable/operator → false（不命中）', () => {
    expect(evaluateCondition({ branch: 'b' }, {})).toBe(false);
    expect(evaluateCondition({ variable: 'x' }, {})).toBe(false);
  });

  it('eq/ne：数值/字符串/布尔宽松相等', () => {
    expect(evaluateCondition(cond({ operator: 'eq', value: 5 }), { x: 5 })).toBe(true);
    expect(evaluateCondition(cond({ operator: 'eq', value: '5' }), { x: 5 })).toBe(true);
    expect(evaluateCondition(cond({ operator: 'eq', value: 'hi' }), { x: 'hi' })).toBe(true);
    expect(evaluateCondition(cond({ operator: 'ne', value: 'other' }), { x: 'hi' })).toBe(true);
    expect(evaluateCondition(cond({ operator: 'ne', value: 'hi' }), { x: 'hi' })).toBe(false);
  });

  it('gt/gte/lt/lte：数值比较', () => {
    expect(evaluateCondition(cond({ operator: 'gt', value: 10 }), { x: 11 })).toBe(true);
    expect(evaluateCondition(cond({ operator: 'gt', value: 10 }), { x: 10 })).toBe(false);
    expect(evaluateCondition(cond({ operator: 'gte', value: 10 }), { x: 10 })).toBe(true);
    expect(evaluateCondition(cond({ operator: 'lt', value: 10 }), { x: 9 })).toBe(true);
    expect(evaluateCondition(cond({ operator: 'lte', value: 10 }), { x: 10 })).toBe(true);
  });

  it('contains：字符串子串 / 数组包含', () => {
    expect(evaluateCondition(cond({ operator: 'contains', value: '你好' }), { x: '你好世界' })).toBe(true);
    expect(evaluateCondition(cond({ operator: 'contains', value: 'x' }), { x: 'abc' })).toBe(false);
    expect(evaluateCondition(cond({ operator: 'contains', value: 'b' }), { x: ['a', 'b'] })).toBe(true);
  });

  it('starts_with / ends_with', () => {
    expect(evaluateCondition(cond({ operator: 'starts_with', value: 'he' }), { x: 'hello' })).toBe(true);
    expect(evaluateCondition(cond({ operator: 'ends_with', value: 'lo' }), { x: 'hello' })).toBe(true);
    expect(evaluateCondition(cond({ operator: 'starts_with', value: 'lo' }), { x: 'hello' })).toBe(false);
  });

  it('is_empty / is_not_empty：undefined/null/空串/空数组/空对象', () => {
    for (const v of [undefined, null, '', [], {}]) {
      expect(evaluateCondition(cond({ operator: 'is_empty' }), { x: v })).toBe(true);
      expect(evaluateCondition(cond({ operator: 'is_not_empty' }), { x: v })).toBe(false);
    }
    expect(evaluateCondition(cond({ operator: 'is_not_empty' }), { x: 'v' })).toBe(true);
    expect(evaluateCondition(cond({ operator: 'is_not_empty' }), { x: [1] })).toBe(true);
  });

  it('in / not_in：数组或逗号分隔字符串', () => {
    expect(evaluateCondition(cond({ operator: 'in', value: ['a', 'b'] }), { x: 'b' })).toBe(true);
    expect(evaluateCondition(cond({ operator: 'in', value: 'a,b' }), { x: 'b' })).toBe(true);
    expect(evaluateCondition(cond({ operator: 'in', value: ['a'] }), { x: 'z' })).toBe(false);
    expect(evaluateCondition(cond({ operator: 'not_in', value: ['a'] }), { x: 'z' })).toBe(true);
  });

  it('regex：字符串匹配；非法正则永不命中', () => {
    expect(evaluateCondition(cond({ operator: 'regex', value: '^h.*o$' }), { x: 'hello' })).toBe(true);
    expect(evaluateCondition(cond({ operator: 'regex', value: '^h.*o$' }), { x: 'nope' })).toBe(false);
    expect(evaluateCondition(cond({ operator: 'regex', value: '[' }), { x: 'hello' })).toBe(false);
    expect(evaluateCondition(cond({ operator: 'regex', value: 'x' }), { x: 123 })).toBe(false);
  });

  it('truthy / falsy', () => {
    expect(evaluateCondition(cond({ operator: 'truthy' }), { x: 1 })).toBe(true);
    expect(evaluateCondition(cond({ operator: 'truthy' }), { x: 0 })).toBe(false);
    expect(evaluateCondition(cond({ operator: 'falsy' }), { x: 0 })).toBe(true);
    expect(evaluateCondition(cond({ operator: 'falsy' }), { x: 'a' })).toBe(false);
  });

  it('路径取值：支持 a.b / a[0]', () => {
    expect(evaluateCondition(cond({ variable: 'user.age', operator: 'gte', value: 18 }), { user: { age: 20 } })).toBe(true);
    expect(evaluateCondition(cond({ variable: 'list[0]', operator: 'eq', value: 'x' }), { list: ['x'] })).toBe(true);
  });
});

describe('findBranch', () => {
  it('按顺序求值：首个命中边胜出', () => {
    const edges = [
      edge({ id: 'e1', targetNodeId: 'a', condition: cond({ operator: 'eq', value: 1 }) }),
      edge({ id: 'e2', targetNodeId: 'b', condition: cond({ operator: 'eq', value: 2 }) }),
    ];
    expect(findBranch(edges, { x: 2 })?.edge.id).toBe('e2');
    expect(findBranch(edges, { x: 1 })?.edge.id).toBe('e1');
  });

  it('无条件的边 = 兜底（else）分支，直接命中', () => {
    const edges = [
      edge({ id: 'e1', targetNodeId: 'a', condition: cond({ operator: 'eq', value: 1 }) }),
      edge({ id: 'e2', targetNodeId: 'fallback' }),
    ];
    const hit = findBranch(edges, { x: 99 });
    expect(hit?.edge.id).toBe('e2');
    expect(hit?.branchLabel).toBe('fallback');
  });

  it('全部未命中且无兜底 → null', () => {
    const edges = [edge({ id: 'e1', targetNodeId: 'a', condition: cond({ operator: 'eq', value: 1 }) })];
    expect(findBranch(edges, { x: 99 })).toBeNull();
  });

  it('branchLabel：优先 condition.branch，缺省目标节点 id', () => {
    const withLabel = edge({ id: 'e1', targetNodeId: 't', condition: cond({ branch: '是' }) });
    expect(findBranch([withLabel], { x: 1 })?.branchLabel).toBe('是');
    const noLabel = edge({ id: 'e1', targetNodeId: 't', condition: null });
    expect(findBranch([noLabel], { x: 1 })?.branchLabel).toBe('t');
  });
});

describe('fallbackEdge', () => {
  it('返回首个无条件边；无则 null', () => {
    const edges = [
      edge({ id: 'e1', condition: cond({ operator: 'eq', value: 1 }) }),
      edge({ id: 'e2' }),
    ];
    expect(fallbackEdge(edges)?.id).toBe('e2');
    expect(fallbackEdge([edge({ id: 'e1', condition: cond({ operator: 'eq', value: 1 }) })])).toBeNull();
  });
});
