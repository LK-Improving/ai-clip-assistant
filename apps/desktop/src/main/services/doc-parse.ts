import { readFileSync } from 'node:fs';
import type { AttachmentKind } from './attach';

/**
 * 文档解析（P2）：把附件抽成可交给下游的纯文本。解析逻辑全部跑在主进程。
 *
 * - docx → mammoth.extractRawText；
 * - pdf  → pdf-parse v2（new PDFParse({data}).getText()）；
 * - txt/md → 直读；
 * - image/audio/video → 本阶段不产文本（视觉/媒体解析在 P3/P4 接入），仅回 note；
 * - OCR 预留：node-tesseract 未装时静默跳过（可选增强，不阻断）。
 *
 * 说明：接口与实现都放主进程服务，类型经 preload 透出给渲染层；不放进 packages/core，
 * 避免把 mammoth/pdfjs 这类 Node-only 依赖的类型污染到会被打进渲染层的 DSL 包。
 */

export interface ParsedDoc {
  kind: AttachmentKind;
  /** 抽取到的纯文本（图片/音视频等无文本时为空） */
  text: string;
  /** 文本字符数（截断前） */
  chars: number;
  /** 页数（pdf/docx 有则填） */
  pageCount?: number;
  /** 图片的视觉描述（L3 vision，仅 image 附件） */
  caption?: string;
  /** 供 UI 展示的补充说明（如“非文本附件”“解析失败原因”） */
  note?: string;
}

/** 单个附件的分析结果（id/name + 解析产物），经 input:analyze 返回给渲染层 */
export interface AnalyzedAttachment extends ParsedDoc {
  id: string;
  name: string;
}

/** 单附件文本上限，避免超长文档撑爆后续 LLM 上下文；超出截断并标注 */
const MAX_TEXT_CHARS = 200_000;

function truncate(text: string): { text: string; chars: number; note?: string } {
  const chars = text.length;
  if (chars <= MAX_TEXT_CHARS) return { text, chars };
  return { text: text.slice(0, MAX_TEXT_CHARS), chars, note: `文本已截断至 ${MAX_TEXT_CHARS} 字（原 ${chars} 字）` };
}

async function parseDocx(path: string): Promise<ParsedDoc> {
  // 动态 import：不把 mammoth 打进主进程启动路径，用到才加载
  const { extractRawText } = await import('mammoth');
  const { value } = await extractRawText({ path });
  const t = truncate((value ?? '').trim());
  return { kind: 'docx', text: t.text, chars: t.chars, note: t.note };
}

async function parseDoc(path: string): Promise<ParsedDoc> {
  // 旧版 .doc（二进制 OLE）：mammoth 不支持，用 word-extractor 抽正文（动态 import，用到才加载）
  const { default: WordExtractor } = await import('word-extractor');
  const doc = await new WordExtractor().extract(path);
  const t = truncate((doc.getBody() ?? '').trim());
  return { kind: 'doc', text: t.text, chars: t.chars, note: t.note };
}

async function parsePdf(path: string): Promise<ParsedDoc> {
  // 动态 import：pdf-parse/pdfjs 较重且依赖 DOMMatrix 等 polyfill（Electron 自带 Node 22 具备；
  // 若某运行环境缺失，构造/解析会抛错，由 input:analyze 逐文件 try/catch 降级为 note，不崩主进程）
  const { PDFParse } = await import('pdf-parse');
  const buf = readFileSync(path);
  const parser = new PDFParse({ data: new Uint8Array(buf) });
  try {
    const result = await parser.getText();
    const raw = (result?.text ?? (result?.pages ?? []).map((p) => p.text).join('\n') ?? '').trim();
    const t = truncate(raw);
    const pageCount = Array.isArray(result?.pages) ? result.pages.length : undefined;
    return { kind: 'pdf', text: t.text, chars: t.chars, pageCount, note: t.note };
  } finally {
    await parser.destroy().catch(() => undefined);
  }
}

function parsePlainText(path: string, kind: AttachmentKind): ParsedDoc {
  const raw = readFileSync(path, 'utf8').trim();
  const t = truncate(raw);
  return { kind, text: t.text, chars: t.chars, note: t.note };
}

/** 非文本附件（图片/音视频）本阶段不解析内容，仅回占位说明，交由后续视觉/媒体链路处理 */
function nonText(kind: AttachmentKind, name: string): ParsedDoc {
  const label = kind === 'image' ? '图片' : kind === 'audio' ? '音频' : kind === 'video' ? '视频' : '文件';
  return { kind, text: '', chars: 0, note: `${label}「${name}」内容识别将在后续阶段接入` };
}

export async function parseDocument(input: {
  path: string;
  name: string;
  kind: AttachmentKind;
}): Promise<ParsedDoc> {
  const { path, name, kind } = input;
  switch (kind) {
    case 'docx':
      return parseDocx(path);
    case 'doc':
      return parseDoc(path);
    case 'pdf':
      return parsePdf(path);
    case 'text':
      return parsePlainText(path, kind);
    case 'image':
    case 'audio':
    case 'video':
    default:
      return nonText(kind, name);
  }
}
