/**
 * 分片器单测 —— 三种切分策略的结构性不变量 + 输出稳定性。
 */
import { describe, expect, it } from 'vitest';
import { splitText } from '../../src/lib/ingest/splitter.js';
import { countTokens } from '../../src/lib/ingest/tokens.js';

const LONG = '这是一段用于切分测试的中文文本，包含若干句子。第二句在这里。'.repeat(20);
const PARAS = `第1段标题\n\n这是第一段的内容，用来验证空行分段。\n\n这是第二段的内容。`.repeat(12);

describe('splitText: sliding（滑动窗口）', () => {
  it('每块长度不超过 chunkSize，且统计与近似长度一致', () => {
    const chunks = splitText(LONG, { splitter: 'sliding', chunkSize: 100, overlap: 20 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.content.length).toBeLessThanOrEqual(100);
      expect(c.tokens).toBe(countTokens(c.content));
      expect(c.tokens).toBeGreaterThan(0);
    }
  });

  it('overlap 时相邻块有内容重叠', () => {
    const size = 100;
    const overlap = 30;
    const chunks = splitText(LONG, { splitter: 'sliding', chunkSize: size, overlap });
    const first = chunks[0]!.content;
    const second = chunks[1]!.content;
    // 滑动后第二块起点 = size - overlap，故两块的尾部与头部存在 substring 重叠
    expect(first.slice(-overlap)).toBe(second.slice(0, overlap));
  });
});

describe('splitText: delimiter（分隔符分段）', () => {
  it('按空行切段并聚合为不超过 chunkSize 的块', () => {
    const chunks = splitText(PARAS, { splitter: 'delimiter', chunkSize: 120, overlap: 0 });
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    for (const c of chunks) {
      expect(c.content.length).toBeLessThanOrEqual(120);
    }
  });
});

describe('splitText: recursive（递归字符窗口）', () => {
  it('长文本被拆成多块，且整体内容量守恒（重组 token 接近原文）', () => {
    const chunks = splitText(LONG, { splitter: 'recursive', chunkSize: 120, overlap: 20 });
    expect(chunks.length).toBeGreaterThan(1);
    const totalTokens = chunks.reduce((n, c) => n + c.tokens, 0);
    expect(totalTokens).toBeGreaterThanOrEqual(countTokens(LONG));
  });

  it('短文本不变（单块）', () => {
    const chunks = splitText('很短的一段文本', { splitter: 'recursive', chunkSize: 800, overlap: 200 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.content).toBe('很短的一段文本');
  });
});

describe('splitText: 一般性', () => {
  it('overlap 越界被收敛到合法区间，不抛错', () => {
    const chunks = splitText(LONG, { splitter: 'recursive', chunkSize: 100, overlap: 1000 });
    expect(chunks.length).toBeGreaterThan(1);
  });

  it('空串返回空数组', () => {
    expect(splitText('', { chunkSize: 100, overlap: 0 })).toHaveLength(0);
  });
});

describe('countTokens', () => {
  it('拉丁词与 CJK 分别计数', () => {
    expect(countTokens('hello world')).toBe(2);
    expect(countTokens('你好 世界')).toBe(4); // 4 个汉字
    expect(countTokens('hello 你好')).toBe(3); // 1 词 + 2 汉字
  });
});