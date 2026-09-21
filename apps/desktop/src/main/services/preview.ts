import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, closeSync, openSync, readSync, renameSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { runFfmpegOrThrow, FfmpegNotFoundError } from '../ffmpeg';
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

function previewDir(): string {
  const dir = path.join(app.getPath('userData'), 'preview-cache');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  addAllowedPath(dir);
  return dir;
}

/** 代理缓存是否可用：存在且非空（历史遗留的 0 字节坏文件按不可用处理，重新转码） */
function isUsableProxy(proxyPath: string): boolean {
  try {
    return statSync(proxyPath).size > 0;
  } catch {
    return false;
  }
}

function removeQuiet(target: string): void {
  try {
    rmSync(target, { force: true });
  } catch {
    // 占用/已删除：不影响主流程
  }
}

/**
 * mp4/mov 是否 faststart（moov 索引在 mdat 之前）。
 *
 * 手机/剪辑软件导出的素材普遍把 moov 放在文件尾，Chromium 需要先取尾部索引，
 * 走自定义协议时经常直接报 SRC_NOT_SUPPORTED（本项目的非 faststart 录屏素材就是这样）。
 * 与其等 <video> 报错再降级转码（用户先看到一次加载失败），不如一开始就出代理。
 * 判断不了的情况一律当 faststart 处理，保持原行为。
 */
function isFaststartMp4(filePath: string): boolean {
  if (!/\.(mp4|m4v|mov)$/i.test(filePath)) return true;
  let fd: number | null = null;
  try {
    fd = openSync(filePath, 'r');
    const head = Buffer.alloc(16);
    let offset = 0;
    let sawMdat = false;
    // 顶层原子个数有限，限 64 次防止异常文件死循环
    for (let i = 0; i < 64; i += 1) {
      if (readSync(fd, head, 0, 8, offset) < 8) break;
      let size = head.readUInt32BE(0);
      const type = head.toString('latin1', 4, 8);
      if (size === 1) {
        // 64 位 largesize
        if (readSync(fd, head, 8, 8, offset + 8) < 8) break;
        size = Number(head.readBigUInt64BE(8));
      } else if (size === 0) {
        // size 0 表示本原子延伸到文件尾，后面不可能再有 moov
        return !sawMdat;
      }
      if (!Number.isFinite(size) || size < 8) break;
      if (type === 'moov') return !sawMdat;
      if (type === 'mdat') sawMdat = true;
      offset += size;
    }
    return true;
  } catch {
    return true;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // 关闭失败不影响判断
      }
    }
  }
}

/**
 * 确保某个本地素材可被 <video> 播放：
 *  - 视频、编码受支持且 mp4 索引在前（faststart）→ 原文件；
 *  - 视频但编码不受支持，或非 faststart（Chromium 取不到尾部索引会直接拒播）
 *    → 生成/复用 H.264 faststart 代理；
 *  - forceTranscode（预览失败自动降级链路）：编码受支持也强制出 faststart 代理，
 *    兜底高码率/特殊 profile 等 Chromium 实际拒播场景；
 *  - 音频 / 图片 / 其他 → 原文件（浏览器可直接处理）。
 */
export async function ensurePlayable(filePath: string, forceTranscode = false): Promise<PlayableResult> {
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

  if (
    !forceTranscode &&
    codec &&
    CHROMIUM_VIDEO_CODECS.has(codec.toLowerCase()) &&
    isFaststartMp4(filePath)
  ) {
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

  // 缓存键带上源路径哈希：仅靠 mtime+size 会让「同一批解压缩、大小恰好相同」的素材互相串代理
  const sourceKey = createHash('md5').update(path.resolve(filePath)).digest('hex').slice(0, 10);
  const proxyPath = path.join(previewDir(), `proxy-${sourceKey}-${mtime}-${size}.mp4`);
  if (isUsableProxy(proxyPath)) {
    return { path: proxyPath, proxied: true, codec, poster };
  }
  // 空壳残留（上次转码中途失败/被杀）：清掉重写，避免 ffmpeg 复用同一个坏文件
  removeQuiet(proxyPath);

  const pending = inFlight.get(proxyPath);
  if (pending) return pending;

  const task = transcode(filePath, proxyPath, codec, poster).finally(() => inFlight.delete(proxyPath));
  inFlight.set(proxyPath, task);
  return task;
}

/**
 * 生成 H.264 预览代理。
 *
 * 两道硬约束（曾经的故障点）：
 *  1. 只看「文件存在」不算成功：ffmpeg 开不起来编码器时也会先建好输出文件再退出（0 字节），
 *     旧逻辑把这种空壳当成果返回并永久缓存，<video> 拿到就是 SRC_NOT_SUPPORTED；
 *     现在走 runFfmpegOrThrow + 非空校验，失败就清掉半成品。
 *  2. `-encoders` 列出不代表能用（无 N 卡时 h264_nvenc 直接报 Cannot load nvcuda.dll），
 *     因此按候选链依次试错，任一编码器转出非空文件即成功。
 * 写入统一走 `.part` 临时文件再改名，保证对外可见的代理文件永远是完整的。
 */
async function transcode(
  filePath: string,
  proxyPath: string,
  codec: string | null,
  poster: string | null,
): Promise<PlayableResult> {
  const caps = currentCapabilities();
  const candidates = caps?.videoEncoderCandidates ?? [];
  // 没有 H.264 编码器时转码也无人能播（mpeg4 等 Chromium 照样解不了），直接回退静帧
  if (!candidates.length) {
    return {
      path: '',
      proxied: false,
      codec,
      poster,
      note:
        '当前 FFmpeg 没有可用的 H.264 编码器，无法生成预览代理。' +
        '请安装完整版 FFmpeg（含 libx264），或设置环境变量 MIAOMA_FFMPEG 指向其可执行文件后重启',
    };
  }
  const audioEncoder = caps?.audioEncoder ?? 'aac';
  // 临时文件保留 .mp4 后缀：ffmpeg 靠扩展名推断封装格式，写成 xxx.part 会「Invalid argument」
  const tmpPath = `${proxyPath.replace(/\.mp4$/i, '')}.part.mp4`;
  const failures: Array<{ encoder: string; message: string }> = [];

  for (const encoder of candidates) {
    const args: string[] = ['-hide_banner', '-y', '-i', filePath];
    // 限制到 1280x1280 以内（等比），并强制偶数边长：yuv420p 不允许奇数尺寸。
    // AI 生成素材的尺寸五花八门（实测 MiniMax H3 会回 1344x768），缩到 1280 宽会得到
    // 1280x731 这种奇数高 → libx264 报「height not divisible by 2」，整条代理链全挂。
    // 用 force_original_aspect_ratio / force_divisible_by 避免 filter 参数里出现逗号
    //（execFile 不走 shell，逗号无法转义）
    args.push('-vf', 'scale=1280:1280:force_original_aspect_ratio=decrease:force_divisible_by=2');
    args.push('-c:v', encoder);
    if (encoder === 'libx264') args.push('-preset', 'veryfast', '-crf', '28');
    else args.push('-b:v', '3000k');
    args.push('-pix_fmt', 'yuv420p');
    args.push('-c:a', audioEncoder, '-b:a', '128k');
    args.push('-movflags', '+faststart');
    args.push(tmpPath);

    try {
      await runFfmpegOrThrow(args, 10 * 60 * 1000);
    } catch (error) {
      removeQuiet(tmpPath);
      if (error instanceof FfmpegNotFoundError) {
        return { path: '', proxied: false, codec, poster, note: error.message };
      }
      failures.push({ encoder, message: error instanceof Error ? error.message : String(error) });
      continue;
    }

    if (!isUsableProxy(tmpPath)) {
      removeQuiet(tmpPath);
      failures.push({ encoder, message: '未写入任何数据' });
      continue;
    }

    let finalPath = proxyPath;
    try {
      renameSync(tmpPath, proxyPath);
    } catch {
      // 旧代理仍被 <video> 占用等场景：直接用临时文件对外提供（preview-cache 目录已在白名单内）
      finalPath = tmpPath;
    }
    addAllowedPath(finalPath);
    return { path: finalPath, proxied: true, codec, poster };
  }

  removeQuiet(tmpPath);
  // 同一个根因会在 7 个编码器上重复报（只报最后一个会把 libx264 的真实原因掉掉），
  // 因此按尝试顺序去重，并只留前两条：首选软件编码器的原因永远排在最前
  const distinct: string[] = [];
  for (const f of failures) if (!distinct.includes(f.message)) distinct.push(f.message);
  return {
    path: '',
    proxied: false,
    codec,
    poster,
    note:
      `预览转码失败（已依次尝试 ${candidates.join(' / ')}）：` +
      (distinct.slice(0, 2).join('；') || '未知原因'),
  };
}
