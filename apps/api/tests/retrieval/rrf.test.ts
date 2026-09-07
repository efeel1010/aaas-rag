/**
 * RRF（Reciprocal Rank Fusion）单测 —— 融合排序、跨路去重与来源标记。
 */
import { describe, expect, it } from 'vitest';
import { rrfFusion } from '../../src/lib/retrieval/rrf.js';

describe('rrfFusion', () => {
  it('两路结果按倒数排名融合排序，多路命中的共享项靠前', () => {
    const fused = rrfFusion(
      [
        {
          source: 'vector',
          items: [
            { id: 'a', score: 0.9 },
            { id: 'b', score: 0.8 },
            { id: 'c', score: 0.7 },
          ],
        },
        {
          source: 'keyword',
          items: [
            { id: 'b', score: 0.6 },
            { id: 'c', score: 0.5 },
            { id: 'd', score: 0.4 },
          ],
        },
      ],
      60,
    );

    // b: 1/61(vector rank2) + 1/61(keyword rank1) = 2/61 ≈ 0.0328
    // c: 1/61(vector rank3) + 1/62(keyword rank2) ≈ 0.0325
    // a: 1/61(vector rank1) ≈ 0.0164；d: 1/63(keyword rank3) ≈ 0.0159
    // RRF 输出为两路候选的并集（不是交集），故 d 也在结果中
    expect(fused.map((f) => f.id)).toEqual(['b', 'c', 'a', 'd']);
    const b = fused.find((f) => f.id === 'b')!;
    expect(b.hybrid).toBe(true);
    expect(b.sources).toContain('vector');
    expect(b.sources).toContain('keyword');
    // d 只在关键词路 rank3
    expect(fused.find((f) => f.id === 'd')?.hybrid).toBe(false);
  });

  it('单路输入退化为该路排名', () => {
    const fused = rrfFusion([{ source: 'keyword', items: [{ id: 'x', score: 0.1 }] }]);
    expect(fused).toHaveLength(1);
    expect(fused[0]?.id).toBe('x');
    expect(fused[0]?.hybrid).toBe(false);
    expect(fused[0]?.score).toBeCloseTo(1 / 61);
  });

  it('k 越小排名贡献越尖锐（第一名占比较 k=60 大）', () => {
    const one = (k: number) =>
      rrfFusion([{ source: 'vector', items: [{ id: 'a', score: 1 }, { id: 'b', score: 0.9 }] }], k);
    const s1 = one(1)[0]!.score;
    const s60 = one(60)[0]!.score;
    // k=1: 1/2=0.5；k=60: 1/61≈0.0164
    expect(s1).toBeGreaterThan(s60);
  });

  it('同路内出现重复 id 时只计一次', () => {
    const fused = rrfFusion([
      {
        source: 'vector',
        items: [
          { id: 'a', score: 0.9 },
          { id: 'a', score: 0.8 }, // 重复
          { id: 'b', score: 0.7 },
        ],
      },
    ]);
    const a = fused.find((f) => f.id === 'a')!;
    // rank1 贡献 1/61，未因重复累加
    expect(a.score).toBeCloseTo(1 / 61);
  });
});