/**
 * 文档解析（Document Parsing）—— 从二进制原文件中抽取纯文本 + 原文元数据。
 *
 * 支持格式：
 *  - txt / md ：按 UTF-8 直接解码（md 保留可读纯文本）；
 *  - pdf      ：pdf-parse（pdf.js），抽取文本与 Info 元数据（页数/标题/作者…)；
 *  - docx     ：mammoth.extractRawText；
 *  - html     ：html-to-text 转纯文本；
 *  - xlsx/xls ：SheetJS(xlsx)，每个工作表转成 CSV 表格文本（保留表头与行列）。
 *
 * 通过 `createParser(deps)` 注入外部抽取实现，便于单测时用 mock 覆盖
 * 需要真实二进制文件的 PDF / DOCX / HTML / XLSX，离线环境也能验证调度逻辑。
 */
export type SourceType = 'txt' | 'md' | 'pdf' | 'docx' | 'html' | 'xlsx';

export interface ParseResult {
  text: string;
  metadata: Record<string, unknown>;
}

export interface ParserDeps {
  /** PDF 抽取（默认走 pdf-parse） */
  parsePdf?: (buffer: Buffer) => Promise<ParseResult>;
  /** DOCX 抽取（默认走 mammoth） */
  parseDocx?: (buffer: Buffer) => Promise<ParseResult>;
  /** HTML 抽取（默认走 html-to-text） */
  parseHtml?: (buffer: Buffer) => Promise<ParseResult>;
  /** Excel 抽取（默认走 xlsx / SheetJS） */
  parseXlsx?: (buffer: Buffer) => Promise<ParseResult>;
}

/** 由文件名推断源类型 */
export function detectSourceType(filename: string): SourceType | null {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  switch (ext) {
    case 'txt':
      return 'txt';
    case 'md':
    case 'markdown':
      return 'md';
    case 'pdf':
      return 'pdf';
    case 'docx':
      return 'docx';
    case 'html':
    case 'htm':
      return 'html';
    case 'xlsx':
    case 'xls':
    case 'csv':
    case 'tsv':
      return 'xlsx';
    default:
      return null;
  }
}

export class ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ParseError';
  }
}

function readUtf8(buffer: Buffer): string {
  return buffer.toString('utf8');
}

async function parsePdfDefault(buffer: Buffer): Promise<ParseResult> {
  let pdf: { getText(): Promise<{ text: string }>; getInfo(): Promise<InfoResultLike>; destroy(): Promise<void> } | undefined;
  try {
    const mod = await import('pdf-parse');
    const { PDFParse } = mod as { PDFParse: new (o: { data: Uint8Array }) => {
      getText(): Promise<{ text: string }>;
      getInfo(): Promise<InfoResultLike>;
      destroy(): Promise<void>;
    } };
    pdf = new PDFParse({ data: new Uint8Array(buffer) });
    const [textRes, infoRes] = await Promise.all([
      pdf.getText(),
      pdf.getInfo().catch(() => null as InfoResultLike | null),
    ]);
    const info = toPlain(infoRes?.info);
    return {
      text: textRes.text,
      metadata: {
        pageCount: infoRes?.total ?? undefined,
        title: info?.Title,
        author: info?.Author,
        subject: info?.Subject,
        producer: info?.Producer,
        creator: info?.Creator,
      },
    };
  } catch (err) {
    if (err instanceof ParseError) throw err;
    throw new ParseError(
      `PDF 解析失败（pdf-parse）：${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    await pdf?.destroy().catch(() => {});
  }
}

/** pdf 元数据是任意对象，安全折叠为可序列化记录 */
function toPlain(value: unknown): Record<string, unknown> {
  if (typeof value === 'object' && value !== null) {
    return { ...(value as Record<string, unknown>) };
  }
  return {};
}

interface InfoResultLike {
  total?: number;
  info?: Record<string, unknown> | null;
}

async function parseDocxDefault(buffer: Buffer): Promise<ParseResult> {
  try {
    const mod = await import('mammoth');
    const mammoth = (mod.default ?? mod) as {
      extractRawText(input: { buffer: Buffer }): Promise<{ value: string; messages: unknown[] }>;
    };
    const res = await mammoth.extractRawText({ buffer });
    return {
      text: res.value,
      metadata: { messages: res.messages ?? [] },
    };
  } catch (err) {
    throw new ParseError(
      `DOCX 解析失败（mammoth）：${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function parseHtmlDefault(buffer: Buffer): Promise<ParseResult> {
  try {
    const mod = await import('html-to-text');
    const { htmlToText } = mod as { htmlToText(text: string, options?: Record<string, unknown>): string };
    const text = htmlToText(readUtf8(buffer), {
      wordwrap: false,
      selectors: [
        { selector: 'a', options: { ignoreHref: true } },
        { selector: 'img', format: 'skip' },
      ],
    });
    return { text, metadata: { charset: 'utf-8' } };
  } catch (err) {
    throw new ParseError(
      `HTML 解析失败（html-to-text）：${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function parseXlsxDefault(buffer: Buffer): Promise<ParseResult> {
  try {
    const mod = await import('xlsx');
    const XLSX = (mod.default ?? mod) as {
      read(data: Buffer | Uint8Array, opts?: Record<string, unknown>): {
        SheetNames: string[];
        Sheets: Record<string, unknown>;
      };
      utils: {
        sheet_to_csv(sheet: unknown, opts?: Record<string, unknown>): string;
      };
    };
    const wb = XLSX.read(buffer, { type: 'buffer' });
    const parts: string[] = [];
    for (const sheetName of wb.SheetNames) {
      const ws = wb.Sheets[sheetName];
      const csv = XLSX.utils.sheet_to_csv(ws, { blankrows: false });
      if (!csv.replace(/[,\s]/g, '')) continue; // 过滤空表 / 全空表
      parts.push(`### 工作表：${sheetName}\n${csv.trim()}`);
    }
    const text = parts.join('\n\n');
    if (!text) throw new ParseError('Excel 中没有可读取的表格数据');
    return { text, metadata: { sheets: wb.SheetNames } };
  } catch (err) {
    if (err instanceof ParseError) throw err;
    throw new ParseError(
      `Excel 解析失败（xlsx）：${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * 解析文档。返回纯文本 + 元数据。
 * 未知扩展名抛 ParseError（上传层识别为校验失败）。
 */
export function createParser(deps: ParserDeps = {}): {
  parse(filename: string, buffer: Buffer): Promise<ParseResult>;
  typeOf(filename: string): SourceType | null;
} {
  const parsePdf = deps.parsePdf ?? parsePdfDefault;
  const parseDocx = deps.parseDocx ?? parseDocxDefault;
  const parseHtml = deps.parseHtml ?? parseHtmlDefault;
  const parseXlsx = deps.parseXlsx ?? parseXlsxDefault;

  return {
    typeOf(filename: string): SourceType | null {
      return detectSourceType(filename);
    },
    async parse(filename: string, buffer: Buffer): Promise<ParseResult> {
      const type = detectSourceType(filename);
      switch (type) {
        case 'txt':
        case 'md':
          return { text: readUtf8(buffer), metadata: { encoding: 'utf-8' } };
        case 'pdf':
          return parsePdf(buffer);
        case 'docx':
          return parseDocx(buffer);
        case 'html':
          return parseHtml(buffer);
        case 'xlsx':
          return parseXlsx(buffer);
        default:
          throw new ParseError(
            `不支持的文件类型「${filename.split('.').pop() ?? ''}」，支持 txt/md/pdf/docx/html/xlsx`,
          );
      }
    },
  };
}

/** 默认解析器（真实三方库实现） */
export const parser = createParser();