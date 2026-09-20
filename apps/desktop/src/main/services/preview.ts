import { existsSync, mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { runFfmpeg } from '../ffmpeg';
import { addAllowedPath } from '../protocol';
import { kindOf } from './library';
import { probeMedia } from './probe';
import { currentCapabilities } from './render/capabilities';
import { generateThumbnail } from './thumbnail';

/**
 * 预览可播放性（模块 4.3 / 3.2 补强）
 *
 * 问题：工程里的素材往往是手机/录屏导出的 HEVC(H.265) 等编码，FFmpeg 能解码并渲染导出，
 * 但 Electron 内置的 Chromium 解码器不支持，`<video>` 直接报错 → 编辑区预览黑屏
 * （`media:diagnose` 只能给出「编码格式可能不被支持」，用户干着急）。
 *
 * 方案：预览用的素材如果编码不被 Chromium 支持，就用 FFmpeg **按需转码**成本地 H.264 低码率代理，
 * 缓存到 userData/preview-cache（按 路径+大小+mtime 命中复用），并登记进 miaoma:// 白名单。
 * 导出仍走原始素材（FFmpeg 解码无障碍），因此画质不受影响。
 */

/** Chromium/Electron 内置解码器可直接播放的视频编码，其余一律转码为 H.264 代理 */
const CHROMIUM_VIDEO_CODECS = new Set(['h264', 'avc1', 'vp8', 'vp9', 'av1', 'theora']);

export interface PlayableResult {
  /** 本地绝对路径：可直接播放的原文件，或转码后的代理文件；失败时为空串 */
  path: string;
  /** 是否使用了转码代理 */
  proxied: boolean;
  /** 源文件视频编码（探测得到时） */
  codec: string | null;
  /** 源文件静帧（转码中 / 失败时的占位图） */
  poster: string | null;
  /** 非致命说明（如转码失败原因） */
  note?: string;
}

/** 同一素材的并发请求去重：共用一次转码 */
const inFlight = new Map<string, Promise<PlayableResult>>();

function isH264Family(encoder: string | null | undefined): encoder is string {
  return !!encoder && (encoder === 'libx264' || encoder.startsWith('h264'));
}

function previewDir(): string {
  const dir = path.join(app.getPath('userData'), 'preview-cache');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  addAllowedPath(dir);
  return dir;
}

/**
 * 确保某个本地素材可被 <video> 播放：
 *  - 视频且编码受支持 → 原文件；
 *  - 视频且编码不受支持 → 生成/复用 H.264 代理；
 *  - 音频 / 图片 / 其他 → 原文件（浏览器可直接处理）。
 */
export async function ensurePlayable(filePath: string): Promise<PlayableResult> {
  const kind = kindOf(filePath);
  if (kind !== 'video') {
    return { path: filePath, proxied: false, codec: null, poster: null };
  }

  let codec: string | null = null;
  try {
    codec = (await probeMedia(filePath)).videoCodec;
  } catch {
    // 探测失败：无法判断编码，保守起见走转码（下面若转码也失败会回退静帧）
  }

  if (codec && CHROMIUM_VIDEO_CODECS.has(codec.toLowerCase())) {
    return { path: filePath, proxied: false, codec, poster: null };
  }

  // 静帧兜底：转码期间 / 转码失败时用户至少能看到画面
  let poster: string | null = null;
  try {
    poster = await generateThumbnail(filePath, { atMs: 800 });
  } catch {
    poster = null;
  }

  let size = 0;
  let mtime = 0;
  try {
    const st = statSync(filePath);
    size = st.size;
    mtime = Math.round(st.mtimeMs);
  } catch {
    return { path: '', proxied: false, codec, poster, note: '源文件不可读' };
  }

  const proxyPath = path.join(previewDir(), `proxy-${mtime}-${size}.mp4`);
  if (existsSync(proxyPath)) {
    return { path: proxyPath, proxied: true, codec, poster };
  }

  const pending = inFlight.get(proxyPath);
  if (pending) return pending;

  const task = transcode(filePath, proxyPath, codec, poster).finally(() => inFlight.delete(proxyPath));
  inFlight.set(proxyPath, task);
  return task;
}

async function transcode(
  filePath: string,
  proxyPath: string,
  codec: string | null,
  poster: string | null,
): Promise<PlayableResult> {
  const caps = currentCapabilities();
  const encoder = caps?.videoEncoder;
  // 没有 H.264 编码器时转码也无人能播，直接回退静帧
  if (!isH264Family(encoder)) {
    return {
      path: '',
      proxied: false,
      codec,
      poster,
      note: '当前 FFmpeg 缺少 H.264 编码器，无法生成预览代理（请使用完整版 FFmpeg）',
    };
  }
  const audioEncoder = caps?.audioEncoder ?? 'aac';

  const args: string[] = ['-hide_banner', '-y', '-i', filePath];
  // 限制到 1280x1280 以内（等比），保证预览足够清晰又转得快 —— 用 force_original_aspect_ratio
  // 避免 filter 参数里出现逗号（execFile 不走 shell，逗号无法转义）
  args.push('-vf', 'scale=1280:1280:force_original_aspect_ratio=decrease');
  args.push('-c:v', encoder);
  if (encoder === 'libx264') args.push('-preset', 'veryfast', '-crf', '28');
  else args.push('-b:v', '3000k');
  args.push('-pix_fmt', 'yuv420p');
  args.push('-c:a', audioEncoder, '-b:a', '128k');
  args.push('-movflags', '+faststart');
  args.push(proxyPath);

  try {
    await runFfmpeg(args, 10 * 60 * 1000);
  } catch (error) {
    return {
      path: '',
      proxied: false,
      codec,
      poster,
      note: `预览转码失败：${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (!existsSync(proxyPath)) {
    return { path: '', proxied: false, codec, poster, note: '预览转码未生成文件' };
  }

  addAllowedPath(proxyPath);
  return { path: proxyPath, proxied: true, codec, poster };
}
