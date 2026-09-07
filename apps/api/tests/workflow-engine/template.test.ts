/**
 * M5 模板渲染单测 —— resolvePath 路径取值 + renderTemplate 占位替换。
 */
import { describe, expect, it } from 'vitest';
import { renderTemplate, resolvePath } from '../../src/services/workflow-engine/template.js';

describe('resolvePath', () => {
  it('空路径返回根对象；单键/多级点路径', () => {
    expect(resolvePath({ a: 1 }, '')).toEqual({ a: 1 });
    expect(resolvePath({ a: 1 }, 'a')).toBe(1);
    expect(resolvePath({ a: { b: { c: 3 } } }, 'a.b.c')).toBe(3);
  });

  it('数组下标 a[0] / 带引号键 a["k"]', () => {
    expect(resolvePath({ list: ['x', 'y'] }, 'list[1]')).toBe('y');
    expect(resolvePath({ items: { 'my-key': 42 } }, 'items["my-key"]')).toBe(42);
    expect(resolvePath({ items: { 'my-key': 42 } }, "items['my-key']")).toBe(42);
  });

  it('路径不存在 / 中间为 null 或标量 → undefined', () => {
    expect(resolvePath({ a: 1 }, 'a.b')).toBeUndefined();
    expect(resolvePath({ a: null }, 'a.b')).toBeUndefined();
    expect(resolvePath({ a: 'str' }, 'a.b')).toBeUndefined();
    expect(resolvePath({}, 'x')).toBeUndefined();
  });
});

describe('renderTemplate', () => {
  it('替换 {{var}}；变量缺失替换为空串', () => {
    expect(renderTemplate('你好 {{name}}', { name: '世界' })).toBe('你好 世界');
    expect(renderTemplate('你好 {{missing}}!', {})).toBe('你好 !');
  });

  it('路径与数组下标；对象值 JSON 序列化；数字字符串化', () => {
    expect(renderTemplate('{{user.name}}', { user: { name: 'evan' } })).toBe('evan');
    expect(renderTemplate('{{list[0]}}', { list: ['a'] })).toBe('a');
    expect(renderTemplate('{{obj}}', { obj: { a: 1 } })).toBe('{"a":1}');
    expect(renderTemplate('{{n}}', { n: 42 })).toBe('42');
    expect(renderTemplate('{{f}}', { f: 1.5 })).toBe('1.5');
  });

  it('null/undefined 变量 → 空串；无占位模板原样返回', () => {
    expect(renderTemplate('{{v}}', { v: null })).toBe('');
    expect(renderTemplate('plain text', {})).toBe('plain text');
  });

  it('布尔值字符串化', () => {
    expect(renderTemplate('{{flag}}', { flag: true })).toBe('true');
  });
});
