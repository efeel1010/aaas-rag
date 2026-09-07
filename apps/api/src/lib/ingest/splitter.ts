/**
 * 文本切分（Chunking）—— 多种切分策略的纯函数实现，便于单测。
 *
 * 三种策略：
 *  - `delimiter`：按段落（空行分隔）聚合为不超过 chunkSize 的块；
 *  - `recursive`：递归字符分裂（优先完整语义边界，逐级降级到字符窗口），带重叠；
 *  - `sliding`  ：固定字符窗口滑动切片，带重叠。
 *
 * 所有策略输出 Chunk{ content, tokens }，tokens 由轻量估算器给出。
 */
import type { SplitterType } from '@pulse/contracts';
import { countTokens } from './tokens.js';

export interface Chunk {
  content: string;
  tokens: number;
}

export interface SplitOptions {
  /** 目标块长度（字符），约束 [64, 8192] */
  chunkSize: number;
  /** 相邻块重叠（字符），自动收敛到 [0, chunkSize-1] */
  overlap: number;
  splitter?: SplitterType;
}

/** 递归分裂时的语义边界优先级（从大到小） */
const SEPARATORS: Array<string | null> = [
  '\n\n',
  '\n',
  '。',
  '；',
  '！',
  '？',
  '，',
  '、',
  ' ',
  null,
];

function normalize(opts: SplitOptions): { chunkSize: number; overlap: number } {
  const chunkSize = Math.min(8192, Math.max(64, Math.trunc(opts.chunkSize)));
  const overlap = Math.max(0, Math.min(chunkSize - 1, Math.trunc(opts.overlap)));
  return { chunkSize, overlap };
}

function toChunk(content: string): Chunk {
  return { content, tokens: countTokens(content) };
}

/** 纯字符窗口切分（滑动/兜底） */
function sliceBySize(text: string, size: number, overlap: number): string[] {
  if (text.length <= size) return [text];
  const step = Math.max(1, size - overlap);
  const out: string[] = [];
  for (let i = 0; i < text.length; i += step) {
    out.push(text.slice(i, i + size));
  }
  return out;
}

/** 递归分裂：把文本拆成均不超过 chunkSize 的「叶子片段」，并尽量保留语义边界上的分隔符 */
function decompose(
  text: string,
  seps: Array<string | null>,
  depth: number,
  chunkSize: number,
  overlap: number,
): string[] {
  if (text.length <= chunkSize) return [text];
  const sep = seps[depth];
  // 无更多分隔符 → 字符窗口兜底
  if (sep === undefined || sep === null) return sliceBySize(text, chunkSize, overlap);
  const parts = text.split(sep);
  const out: string[] = [];
  const lastIndex = parts.length - 1;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (!p) continue;
    if (p.length <= chunkSize) {
      // 非末段补回分隔符，避免拼接时丢标点/换行
      out.push(i < lastIndex ? p + sep : p);
    } else {
      const sub = decompose(p, seps, depth + 1, chunkSize, overlap);
      for (let j = 0; j < sub.length; j++) {
        const isLastSub = j === sub.length - 1;
        out.push(i < lastIndex && isLastSub ? sub[j]! + sep : sub[j]!);
      }
    }
  }
  return out.length > 0 ? out : [text];
}

/** 把叶子片段按目标大小聚合成块，块间携带 overlap 尾部 */
function mergeLeaves(leaves: string[], chunkSize: number, overlap: number): string[] {
  const chunks: string[] = [];
  let cur = '';
  for (const leaf of leaves) {
    const candidate = cur === '' ? leaf : cur + leaf;
    if (cur !== '' && candidate.length > chunkSize) {
      chunks.push(cur.trim());
      const tail = overlap > 0 ? cur.slice(-overlap) : '';
      cur = tail + leaf;
    } else {
      cur = candidate;
    }
  }
  if (cur.trim()) chunks.push(cur.trim());
  return chunks;
}

function splitDelimiter(text: string, chunkSize: number): string[] {
  const paras = text
    .split(/\n\s*\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const chunks: string[] = [];
  let cur = '';
  for (const p of paras) {
    const candidate = cur === '' ? p : `${cur}\n\n${p}`;
    if (cur !== '' && candidate.length > chunkSize) {
      chunks.push(cur);
      cur = p;
    } else {
      cur = candidate;
    }
  }
  if (cur) chunks.push(cur);
  // 兜底：仍超长（极长单段）时降级为字符窗口
  const out: string[] = [];
  for (const c of chunks) {
    if (c.length <= chunkSize) out.push(c);
    else out.push(...sliceBySize(c, chunkSize, 0));
  }
  return out;
}

function splitRecursive(text: string, chunkSize: number, overlap: number): string[] {
  const leaves = decompose(text, SEPARATORS, 0, chunkSize, overlap);
  return mergeLeaves(leaves, chunkSize, overlap);
}

function splitSliding(text: string, chunkSize: number, overlap: number): string[] {
  return sliceBySize(text, chunkSize, overlap);
}

/** 按 dataset 配置切分文本 */
export function splitText(text: string, opts: SplitOptions): Chunk[] {
  const { chunkSize, overlap } = normalize(opts);
  const raw: string[] = (() => {
    switch (opts.splitter ?? 'recursive') {
      case 'delimiter':
        return splitDelimiter(text, chunkSize);
      case 'sliding':
        return splitSliding(text, chunkSize, overlap);
      case 'recursive':
      default:
        return splitRecursive(text, chunkSize, overlap);
    }
  })().filter((s) => s.length > 0);
  return raw.map(toChunk);
}