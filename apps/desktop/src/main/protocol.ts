import { createReadStream, promises as fsp, statSync } from 'node:fs';
import { Readable } from 'node:stream';
import path from 'node:path';
import { protocol } from 'electron';

/**
 * miaoma:// 本地协议（模块 4.3 安全加固）
 *
 * 安全要点：
 *  - 路径白名单：只有显式 addAllowedPath 登记的目录（素材库目录、userData、导出目录等）
 *    下的文件才可被加载，避免任意本地文件被 <video>/<img> 读取（信息泄露）；
 *  - Range 支持：解析 HTTP Range 请求头，以 206 + Content-Range 返回字节区间，
 *    让 <video> 进度条可拖动、可拖动预览；
 *  - 用 protocol.handle（新版 API）返回 Response，配合 registerSchemesAsPrivileged 的
 *    stream/supportFetchAPI 特权，天然支持流式 Range。
 */

const allowedDirs = new Set<string>();
const allowedFiles = new Set<string>();

/** 登记允许被 miaoma:// 访问的目录（递归生效）或单个文件 */
export function addAllowedPath(target: string): void {
  const resolved = path.resolve(target);
  try {
    if (statSync(resolved).isDirectory()) allowedDirs.add(resolved);
    else allowedFiles.add(resolved);
  } catch {
    // 不存在则按目录登记，后续子文件可能在创建后出现
    allowedDirs.add(resolved);
  }
}

function isAllowed(filePath: string): boolean {
  const resolved = path.resolve(filePath);
  if (allowedFiles.has(resolved)) return true;
  for (const dir of allowedDirs) {
    // Windows 路径大小写不敏感：统一小写比较，避免盘符/目录大小写不一致导致误判 403
    if (resolved.toLowerCase() === dir.toLowerCase()) return true;
    if (resolved.toLowerCase().startsWith((dir + path.sep).toLowerCase())) return true;
  }
  return false;
}

/**
 * 诊断某个本地路径为何能被 / 不能被 miaoma:// 读取。
 *
 * 预览区黑屏最常见的原因就是协议层 403，而 <video> 的 error 事件不会带原因，
 * 因此渲染侧在 onError 时回调这里拿到人类可读的解释。
 */
export function explainAccess(filePath: string): { ok: boolean; reason: string } {
  if (!filePath) return { ok: false, reason: '素材路径为空' };
  let resolved: string;
  try {
    resolved = path.resolve(filePath);
  } catch {
    return { ok: false, reason: `路径非法：${filePath}` };
  }
  let info;
  try {
    info = statSync(resolved);
  } catch {
    return { ok: false, reason: `文件不存在或无法读取：${resolved}` };
  }
  if (!info.isFile()) return { ok: false, reason: `目标不是文件：${resolved}` };
  if (!isAllowed(resolved)) {
    return { ok: false, reason: `路径未授权（未在素材库 / 工程中登记）：${resolved}` };
  }
  return { ok: true, reason: 'ok' };
}

const MIME: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.webm': 'video/webm',
  '.avi': 'video/x-msvideo',
  '.m4v': 'video/mp4',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.srt': 'application/x-subrip',
  '.vtt': 'text/vtt',
  '.ass': 'text/x-ssa',
};

function mimeOf(filePath: string): string {
  return MIME[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

function forbidden(body: string, status = 403): Response {
  return new Response(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}

export function registerProtocols(): void {
  protocol.handle('miaoma', async (request: Request): Promise<Response> => {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return forbidden('Bad URL');
    }
    // 去掉前导斜杠：miaoma:///D:/a.mp4 -> /D:/a.mp4 -> D:/a.mp4
    let filePath = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
    filePath = path.normalize(filePath);
    if (!isAllowed(filePath)) {
      return forbidden(`访问被拒绝：${filePath}`);
    }

    let info;
    try {
      info = await fsp.stat(filePath);
    } catch {
      return forbidden('文件不存在', 404);
    }
    if (!info.isFile()) return forbidden('不是文件', 400);

    const headers = new Headers();
    headers.set('Accept-Ranges', 'bytes');
    headers.set('Content-Type', mimeOf(filePath));
    headers.set('Access-Control-Allow-Origin', '*');

    const range = request.headers.get('range');
    // 多段 Range（含逗号）不实现，直接按整文件返回，避免解析歧义
    if (range && !range.includes(',')) {
      const size = info.size;
      const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
      let start = 0;
      let end = size - 1;
      if (match) {
        const [, rawStart, rawEnd] = match;
        if (!rawStart && rawEnd) {
          // 后缀范围 bytes=-N：取末尾 N 字节
          const suffix = Number(rawEnd);
          start = suffix >= size ? 0 : size - suffix;
          end = size - 1;
        } else {
          if (rawStart) start = Number(rawStart);
          // 宽容处理越界 end（部分播放器会请求超过文件长度的区间）
          if (rawEnd) end = Math.min(Number(rawEnd), size - 1);
        }
      }
      if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= size) {
        headers.set('Content-Range', `bytes */${size}`);
        return new Response('Range Not Satisfiable', { status: 416, headers });
      }
      const chunkSize = end - start + 1;
      headers.set('Content-Range', `bytes ${start}-${end}/${size}`);
      headers.set('Content-Length', String(chunkSize));
      const stream = createReadStream(filePath, { start, end });
      return new Response(Readable.toWeb(stream) as unknown as ReadableStream, {
        status: 206,
        headers,
      });
    }

    headers.set('Content-Length', String(info.size));
    const stream = createReadStream(filePath);
    return new Response(Readable.toWeb(stream) as unknown as ReadableStream, { status: 200, headers });
  });
}
