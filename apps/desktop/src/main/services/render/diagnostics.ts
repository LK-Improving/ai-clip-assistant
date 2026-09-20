import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * 导出前置体检与失败分类（模块 5.2 P3：磁盘空间不足等异常场景兜底）。
 *
 * - probeFreeBytes：用 Node fs.statfs 查输出盘可用字节（Node <20.4 或平台不支持时
 *   返回 null 并静默跳过前置检查，不影响渲染）；
 * - classifyFfmpegFailure：把 ffmpeg stderr 归一成用户可行动的中文错误
 *   （空间不足 / 目标不可写 / 素材缺失 / 编码器不可用），不再把原始英文尾巴直接甩给用户。
 */

export interface FfmpegFailure {
  kind: 'disk-full' | 'permission' | 'missing-input' | 'encoder' | 'unknown';
  /** 面向用户的中文说明（保留原始 stderr 供诊断，由调用方拼接） */
  friendly: string;
}

export function classifyFfmpegFailure(stderr: string): FfmpegFailure {
  const s = stderr.toLowerCase();
  if (s.includes('no space left') || s.includes('enospc') || s.includes('disk full')) {
    return { kind: 'disk-full', friendly: '磁盘空间不足：请清理导出目标磁盘后重试' };
  }
  if (
    s.includes('error opening output') || s.includes('could not write') ||
    s.includes('permission denied') || s.includes('access denied') || s.includes('read-only') || s.includes('eacces')
  ) {
    // 输出侧错误优先于输入侧：file-as-dir 等路径非法场景 ffmpeg 也报 No such file，
    // 但它总是伴随 Error opening output file / Could not write，应归为导出不可写
    return { kind: 'permission', friendly: '导出目标不可写：请检查目录权限或更换导出位置' };
  }
  if (s.includes('no such file') || s.includes('file not found') || s.includes('does not exist')) {
    return { kind: 'missing-input', friendly: '素材文件缺失或已移动：请在素材库重新定位后重试' };
  }
  if (s.includes('unknown encoder') || s.includes('encoder') || s.includes('cannot open') || s.includes('error initializing')) {
    return { kind: 'encoder', friendly: '编码器不可用：将自动尝试兼容编码器回退' };
  }
  return { kind: 'unknown', friendly: 'FFmpeg 渲染失败' };
}

/** 输出盘可用字节；statfs 不可用/失败时返回 null（跳过前置空间检查，绝不因体检失败中断导出） */
export async function probeFreeBytes(outputPath: string): Promise<number | null> {
  try {
    if (typeof fs.statfs !== 'function') return null;
    const stat = await fs.statfs(path.dirname(outputPath));
    const block = Number(stat.bsize ?? 0);
    const avail = Number(stat.bavail ?? 0);
    if (!Number.isFinite(block) || !Number.isFinite(avail) || block <= 0) return null;
    return block * avail;
  } catch {
    return null;
  }
}

/** 按码率与时长估算输出体积（字节）：视频码率 + 192k AAC 音频 + 20% 封装余量 */
export function estimateOutputBytes(totalMs: number, videoBitrate: string): number {
  const m = /^\s*(\d+)\s*([kKMG]?)\s*$/.exec(videoBitrate ?? '');
  const suffix = (m?.[2] ?? '').toUpperCase();
  const scale = suffix === 'K' ? 1_000 : suffix === 'M' ? 1_000_000 : suffix === 'G' ? 1_000_000_000 : 1;
  const videoBps = (Number(m?.[1] ?? 16) || 16) * scale;
  const audioBps = 192_000;
  const seconds = Math.max(1, totalMs / 1000);
  return Math.ceil(((videoBps + audioBps) / 8) * seconds * 1.2);
}

/** 人性化容量描述（MB/GB） */
export function formatBytes(bytes: number): string {
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(0)} MB`;
  return `${Math.max(0, Math.round(bytes / 1024))} KB`;
}

/**
 * 渲染前的磁盘空间预检；不足时返回拒绝原因（调用方据此抛错），充足/无法探测返回 null。
 */
export async function precheckDiskSpace(
  outputPath: string,
  totalMs: number,
  videoBitrate: string,
): Promise<string | null> {
  const free = await probeFreeBytes(outputPath);
  if (free === null) return null;
  const required = estimateOutputBytes(totalMs, videoBitrate);
  if (free < required) {
    return `磁盘空间可能不足：目标盘剩余 ${formatBytes(free)}，预计需要约 ${formatBytes(required)}，请清理或更换导出目录`;
  }
  return null;
}
