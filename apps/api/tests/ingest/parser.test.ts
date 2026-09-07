/**
 * 解析器单测 —— 使用注入式 mock 覆盖需要真实二进制文件的 PDF/DOCX/HTML，
 * 同时验证纯文本(txt/md)的离线解析与调度、类型分派。
 */
import { describe, expect, it } from 'vitest';
import { createParser, detectSourceType, ParseError } from '../../src/lib/ingest/parser.js';

const MOCK = createParser({
  parsePdf: async () => ({ text: 'pdf-text', metadata: { pageCount: 3 } }),
  parseDocx: async () => ({ text: 'docx-text', metadata: {} }),
  parseHtml: async () => ({ text: 'html-text', metadata: { title: 't' } }),
  parseXlsx: async () => ({ text: 'xlsx-text', metadata: { sheets: ['Sheet1'] } }),
});

describe('detectSourceType', () => {
  it('按扩展名识别类型', () => {
    expect(detectSourceType('a.txt')).toBe('txt');
    expect(detectSourceType('a.md')).toBe('md');
    expect(detectSourceType('a.MARKDOWN')).toBe('md');
    expect(detectSourceType('a.pdf')).toBe('pdf');
    expect(detectSourceType('b.docx')).toBe('docx');
    expect(detectSourceType('a.html')).toBe('html');
    expect(detectSourceType('data.xlsx')).toBe('xlsx');
    expect(detectSourceType('data.XLS')).toBe('xlsx');
    expect(detectSourceType('data.csv')).toBe('xlsx');
    expect(detectSourceType('data.tsv')).toBe('xlsx');
    expect(detectSourceType('a.xyz')).toBeNull();
  });
});

describe('createParser.parse：mock 外部解析器', () => {
  it('pdf/docx/html/xlsx 走注入实现', async () => {
    expect((await MOCK.parse('r.pdf', Buffer.from('x'))).text).toBe('pdf-text');
    expect((await MOCK.parse('r.docx', Buffer.from('x'))).text).toBe('docx-text');
    const html = await MOCK.parse('r.html', Buffer.from('<b>hi</b>'));
    expect(html.text).toBe('html-text');
    expect(html.metadata.title).toBe('t');
    const xlsx = await MOCK.parse('data.xlsx', Buffer.from('x'));
    expect(xlsx.text).toBe('xlsx-text');
    expect(xlsx.metadata.sheets).toEqual(['Sheet1']);
  });

  it('txt/md 离线 UTF-8 直接解码', async () => {
    const txt = await MOCK.parse('note.txt', Buffer.from('你好 world'));
    expect(txt.text).toBe('你好 world');
    expect(txt.metadata.encoding).toBe('utf-8');

    const md = await MOCK.parse('doc.md', Buffer.from('# 标题\n正文'));
    expect(md.text).toBe('# 标题\n正文');
  });

  it('不支持的扩展名抛出 ParseError', async () => {
    await expect(MOCK.parse('a.bin', Buffer.from('x'))).rejects.toBeInstanceOf(ParseError);
    await expect(MOCK.parse('a.bin', Buffer.from('x'))).rejects.toThrow('不支持的文件类型');
  });
});

describe('真实解析器 receive Default (parser default)', () => {
  it('txt 无需三方库即可解析', async () => {
    // 直接用默认 parser 保证 txt 分支不依赖外部库
    const { parser } = await import('../../src/lib/ingest/parser.js');
    const res = await parser.parse('f.txt', Buffer.from('pure txt'));
    expect(res.text).toBe('pure txt');
  });
});