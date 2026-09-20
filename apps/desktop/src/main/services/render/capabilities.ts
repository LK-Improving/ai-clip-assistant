import { spawnSync } from 'node:child_process';
import { resolveFfmpegPath } from '../../ffmpeg';
import type { RenderCapabilities } from './filter-builder';

const VIDEO_ENCODER_PRIORITY = ['libx264', 'h264_nvenc', 'h264_qsv', 'h264_mf', 'mpeg4'];
const AUDIO_ENCODER_PRIORITY = ['aac', 'libmp3lame', 'mp3'];

const cache = new Map<string, RenderCapabilities>();

function hasToken(output: string, token: string): boolean {
  return new RegExp(`\\b${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(output);
}

/**
 * 探测给定 ffmpeg 的能力：可用的最佳视频/音频编码器、是否支持 drawtext / subtitles。
 * 结果按 ffmpeg 路径缓存。
 */
export function detectCapabilities(ffmpegPath: string): RenderCapabilities {
  const cached = cache.get(ffmpegPath);
  if (cached) return cached;

  const enc = spawnSync(ffmpegPath, ['-hide_banner', '-encoders'], {
    encoding: 'utf8',
    windowsHide: true,
  }).stdout ?? '';

  const filters = spawnSync(ffmpegPath, ['-hide_banner', '-filters'], {
    encoding: 'utf8',
    windowsHide: true,
  }).stdout ?? '';

  const videoEncoder =
    VIDEO_ENCODER_PRIORITY.find((e) => hasToken(enc, e)) ?? 'mpeg4';
  const audioEncoder =
    AUDIO_ENCODER_PRIORITY.find((e) => hasToken(enc, e)) ?? 'aac';
  const drawtext = hasToken(filters, 'drawtext');
  const subtitles = hasToken(filters, 'subtitles');

  const caps: RenderCapabilities = {
    videoEncoder,
    audioEncoder,
    // 硬件编码器（nvenc/qsv/mf）通常要求 yuv420p；mpeg4/libx264 同样兼容
    pixelFormat: 'yuv420p',
    drawtext,
    subtitles,
  };
  cache.set(ffmpegPath, caps);
  return caps;
}

/** 解析当前环境的 ffmpeg（处理未找到的情况由调用方判断） */
export function currentCapabilities(): RenderCapabilities | null {
  const ff = resolveFfmpegPath();
  if (!ff) return null;
  return detectCapabilities(ff);
}
