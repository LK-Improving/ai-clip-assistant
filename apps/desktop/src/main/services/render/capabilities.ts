import { spawnSync } from 'node:child_process';
import { resolveFfmpegPath } from '../../ffmpeg';
import type { RenderCapabilities } from './filter-builder';

const VIDEO_ENCODER_PRIORITY = ['libx264', 'h264_nvenc', 'h264_qsv', 'h264_mf', 'mpeg4'];
const AUDIO_ENCODER_PRIORITY = ['aac', 'libmp3lame', 'mp3'];

/**
 * H.264 系编码器优先级（预览代理专用）：
 * 软编放最前（对显卡/驱动无依赖，成功率最高），硬件编码器依次兜底。
 * mpeg4 不在列：Chromium 解不了，用它转出来的代理照样播不出。
 */
const H264_ENCODER_PRIORITY = [
  'libx264',
  'h264_nvenc',
  'h264_qsv',
  'h264_amf',
  'h264_mf',
  'h264_vaapi',
  'h264_d3d12va',
];

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
    // 只列真正存在的 H.264 编码器；`-encoders` 里列出不代表能用（如无 N 卡时 nvenc），
    // 能否用由调用方（预览转码）按顺序试错回退
    videoEncoderCandidates: H264_ENCODER_PRIORITY.filter((e) => hasToken(enc, e)),
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
