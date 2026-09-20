import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { stat, unlink } from 'node:fs/promises';
import { FfmpegNotFoundError, resolveFfmpegPath } from '../../ffmpeg';
import { QUALITY_BITRATE, type ExportQuality } from '../../../lib/export-request';
import { probeMedia } from '../probe';
import { detectCapabilities } from './capabilities';
import { classifyFfmpegFailure, precheckDiskSpace } from './diagnostics';
import { buildRenderPlan, type BuildOptions } from './filter-builder';

export interface RenderProgress {
  /** 0 - 100 */
  percent: number;
  phase: 'preparing' | 'rendering' | 'finalizing';
  fps: number;
  speed: number;
  timeSec: number;
  totalSec: number;
}

export interface RenderRequest {
  project: Parameters<typeof buildRenderPlan>[0];
  outputPath: string;
  /** 强制指定视频编码器（覆盖探测结果），例如 'mpeg4' 保证 CPU 可用 */
  encoder?: string;
  /** 导出质量，决定视频码率；优先级低于显式 bitrate */
  quality?: ExportQuality;
  /** 显式视频码率，如 '16M'；不传则按 quality 推导（默认 high=16M） */
  videoBitrate?: string;
  onProgress?: (p: RenderProgress) => void;
  signal?: AbortSignal;
}

export interface RenderResult {
  outputPath: string;
  durationMs: number;
  warnings: string[];
  encoderUsed: string;
}

export class RenderAbortError extends Error {
  constructor() {
    super('渲染已被用户取消');
    this.name = 'RenderAbortError';
  }
}

function parseProgress(stderrLine: string, totalSec: number): Omit<RenderProgress, 'phase'> | null {
  const timeMatch = stderrLine.match(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!timeMatch) return null;
  const [, h, m, s] = timeMatch;
  const timeSec = Number(h) * 3600 + Number(m) * 60 + Number(s);
  const fpsMatch = stderrLine.match(/fps=\s*(\d+(?:\.\d+)?)/);
  const speedMatch = stderrLine.match(/speed=\s*(\d+(?:\.\d+)?)x/);
  const fps = fpsMatch ? Number(fpsMatch[1]) : 0;
  const speed = speedMatch ? Number(speedMatch[1]) : 0;
  const percent = totalSec > 0 ? Math.min(100, Math.max(0, (timeSec / totalSec) * 100)) : 0;
  return { percent, fps, speed, timeSec, totalSec };
}

function spawnFfmpeg(
  ffmpegPath: string,
  args: string[],
  totalSec: number,
  onProgress: ((p: RenderProgress) => void) | undefined,
  signal: AbortSignal | undefined,
): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { windowsHide: true });
    let stderr = '';
    let lastReport = 0;

    const onAbort = () => {
      child.kill('SIGKILL');
      reject(new RenderAbortError());
    };
    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
    }

    const cleanup = () => signal?.removeEventListener('abort', onAbort);

    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      const line = text.split('\n').pop() ?? '';
      const parsed = parseProgress(line, totalSec);
      if (parsed && onProgress) {
        const now = Date.now();
        if (now - lastReport > 120) {
          lastReport = now;
          const phase: RenderProgress['phase'] =
            parsed.percent < 3 ? 'preparing' : parsed.percent > 97 ? 'finalizing' : 'rendering';
          onProgress({ ...parsed, phase });
        }
      }
    });

    child.on('error', (err) => {
      cleanup();
      reject(err);
    });

    child.on('close', (code) => {
      cleanup();
      resolve({ code, stderr });
    });
  });
}

/**
 * 执行工程渲染。返回输出文件路径与告警信息。
 * 当探测到的硬件编码器在某些机器上不可用时，自动回退到 mpeg4 重试一次。
 * 失败/取消时删除半成品输出文件（失败回滚）：ffmpeg 被中断或中途报错时，
 * 磁盘上残留的 mp4 头部不完整、不可播放也不可读回，统一清理避免误导用户。
 */
export async function renderProject(req: RenderRequest): Promise<RenderResult> {
  const ffmpegPath = resolveFfmpegPath();
  if (!ffmpegPath) throw new FfmpegNotFoundError();

  const caps = detectCapabilities(ffmpegPath);
  const videoEncoder = req.encoder ?? caps.videoEncoder;

  const videoBitrate =
    req.videoBitrate ?? (req.quality ? QUALITY_BITRATE[req.quality] : QUALITY_BITRATE.high);

  const buildOpts = (encoder: string): BuildOptions => ({
    drawtextAvailable: caps.drawtext,
    subtitlesAvailable: caps.subtitles,
    videoEncoder: encoder,
    audioEncoder: caps.audioEncoder,
    pixelFormat: caps.pixelFormat,
    videoBitrate,
  });

  /** 失败回滚：删除本次渲染写坏/写一半的输出文件（删除失败不掩盖原始错误） */
  const rollbackPartial = async (): Promise<void> => {
    try {
      if (existsSync(req.outputPath)) await unlink(req.outputPath);
    } catch {
      // 清理失败（文件被占用等）不影响向上抛渲染错误
    }
  };

  const runOnce = async (encoder: string): Promise<RenderResult> => {
    const plan = buildRenderPlan(req.project, req.outputPath, buildOpts(encoder));
    const totalSec = plan.totalMs / 1000;

    // 渲染前磁盘空间预检（P3）：空间不足时在启动 ffmpeg 前就给出可行动提示；
    // statfs 不可用时静默跳过，绝不因体检失败阻断正常导出
    const spaceReject = await precheckDiskSpace(req.outputPath, plan.totalMs, videoBitrate);
    if (spaceReject) throw new Error(spaceReject);

    let code: number | null;
    let stderr: string;
    try {
      ({ code, stderr } = await spawnFfmpeg(
        ffmpegPath,
        plan.args,
        totalSec,
        req.onProgress,
        req.signal,
      ));
    } catch (e) {
      // 取消或 spawn 失败：ffmpeg 可能已经写了部分文件，同样回滚
      await rollbackPartial();
      throw e;
    }
    if (code !== 0) {
      await rollbackPartial();
      // 失败分类（P3）：把英文 stderr 归一为用户可行动的中文提示，原始尾巴保留供诊断；
      // 「FFmpeg 渲染失败」前缀与分类文案共存，兼容旧调用方的文案断言
      const failure = classifyFfmpegFailure(stderr);
      throw Object.assign(
        new Error(`FFmpeg 渲染失败：${failure.friendly}（exit ${code}）\n${stderr.slice(-800)}`),
        {
          encoder,
          failureKind: failure.kind,
          // 仅编码器类失败触发 mpeg4 回退重试
          looksLikeEncoderError: failure.kind === 'encoder',
        },
      );
    }
    let durationMs = plan.totalMs;
    try {
      await stat(req.outputPath);
      const probe = await probeMedia(req.outputPath);
      durationMs = probe.durationMs;
    } catch {
      // 探测失败不影响主流程，沿用计划时长
    }
    return {
      outputPath: req.outputPath,
      durationMs,
      warnings: plan.warnings,
      encoderUsed: encoder,
    };
  };

  try {
    return await runOnce(videoEncoder);
  } catch (err) {
    const e = err as Error & { encoder?: string; looksLikeEncoderError?: boolean };
    const triedFallback = videoEncoder !== 'mpeg4' && e.looksLikeEncoderError;
    if (triedFallback) {
      return await runOnce('mpeg4');
    }
    throw err;
  }
}
