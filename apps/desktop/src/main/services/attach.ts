import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { addAllowedPath } from '../protocol';

/**
 * 聊天附件接收（P1 地基）：渲染层拦截粘贴 → IPC 传 base64 → 主进程落 userData/temp → 返回附件元信息。
 *
 * 安全兜底：扩展名白名单 + 单文件大小上限 + 每次落盘顺带清理超时旧文件（TTL 清扫）。
 * temp 目录整体登记进 miaoma:// 白名单，渲染层用 toMediaUrl(path) 即可直接展示图片缩略图。
 * 内容识别与工具路由（L1–L4）在后续阶段接入，这里只负责“收得下、存得住、可回显”。
 */

export type AttachmentKind = 'image' | 'docx' | 'doc' | 'pdf' | 'text' | 'audio' | 'video' | 'other';

export interface Attachment {
  id: string;
  name: string;
  /** 本地绝对路径；渲染层经 toMediaUrl 转 miaoma:// 展示 */
  path: string;
  mime: string;
  kind: AttachmentKind;
  size: number;
  createdAt: number;
}

/** 单文件上限 25MB；临时文件保留 24 小时 */
const MAX_BYTES = 25 * 1024 * 1024;
const TTL_MS = 24 * 3600 * 1000;

const ALLOW_EXT = new Set([
  'png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp',
  'doc', 'docx', 'pdf', 'txt', 'md', 'markdown',
  'mp3', 'wav', 'm4a', 'aac', 'flac',
  'mp4', 'mov', 'webm', 'mkv', 'avi',
]);

const EXT_MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', markdown: 'text/markdown',
  mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac',
  mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska', avi: 'video/x-msvideo',
};

function tempDir(): string {
  const dir = path.join(app.getPath('userData'), 'temp');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  addAllowedPath(dir);
  return dir;
}

function extOf(name: string): string {
  return (path.extname(name || '') || '').replace(/^\./, '').toLowerCase();
}

function classify(ext: string, mime: string): AttachmentKind {
  if (/^image\//.test(mime) || ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'].includes(ext)) return 'image';
  if (ext === 'docx') return 'docx';
  if (ext === 'doc') return 'doc';
  if (ext === 'pdf') return 'pdf';
  if (['txt', 'md', 'markdown'].includes(ext) || /^text\//.test(mime)) return 'text';
  if (/^audio\//.test(mime) || ['mp3', 'wav', 'm4a', 'aac', 'flac'].includes(ext)) return 'audio';
  if (/^video\//.test(mime) || ['mp4', 'mov', 'webm', 'mkv', 'avi'].includes(ext)) return 'video';
  return 'other';
}

/** 顺带清理超过 TTL 的旧临时文件；单个删除失败不影响主流程 */
function sweep(dir: string): void {
  try {
    const now = Date.now();
    for (const f of readdirSync(dir)) {
      const p = path.join(dir, f);
      try {
        if (now - statSync(p).mtimeMs > TTL_MS) rmSync(p, { force: true });
      } catch {
        /* 忽略单个清理失败 */
      }
    }
  } catch {
    /* 目录读取失败忽略 */
  }
}

let seq = 0;
function newId(): string {
  seq += 1;
  return `att-${Date.now().toString(36)}-${seq.toString(36)}`;
}

export function saveAttachment(input: { name: string; mime?: string; dataBase64: string }): Attachment {
  const raw = Buffer.from(input.dataBase64 || '', 'base64');
  if (raw.length === 0) throw new Error('附件内容为空');
  if (raw.length > MAX_BYTES) throw new Error(`附件超过上限 ${Math.floor(MAX_BYTES / 1024 / 1024)}MB`);

  const ext = extOf(input.name);
  if (!ext || !ALLOW_EXT.has(ext)) {
    throw new Error(
      `不支持的附件格式「${ext ? '.' + ext : input.name || '未知'}」` +
        '。支持：文档 doc/docx/pdf/txt/md，图片 png/jpg/webp/gif/bmp，音视频 mp3/wav/m4a/aac/flac、mp4/mov/webm/mkv/avi；' +
        '若为 .xls/.ppt/.rtf/.pages 等其它格式，请另存为上述格式（推荐 .docx/.pdf/.txt）后重试',
    );
  }

  const dir = tempDir();
  sweep(dir);
  const id = newId();
  const filePath = path.join(dir, `${id}.${ext}`);
  writeFileSync(filePath, raw);

  const mime = input.mime && input.mime !== 'application/octet-stream' ? input.mime : EXT_MIME[ext] ?? 'application/octet-stream';
  return {
    id,
    name: input.name || path.basename(filePath),
    path: filePath,
    mime,
    kind: classify(ext, mime),
    size: raw.length,
    createdAt: Date.now(),
  };
}
