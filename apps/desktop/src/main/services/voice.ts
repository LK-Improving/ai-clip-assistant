import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { app } from 'electron';
import { probeMedia } from './probe';
import { resolveFfmpegPath } from '../ffmpeg';

/**
 * 自定义音色库（M3，PDF「音色导入/预览/删除全链路安全管控 + 原子化音色索引存储」）。
 *
 * - 索引 userData/voices.json：tmp + rename **原子写**，断电/崩溃不会留下半截 JSON；
 * - 样本 userData/voices/<id>.<ext>：导入即拷贝进私有目录（与原始文件解耦，删除连带清理）；
 * - 导入校验：音频扩展名 + 时长 3–20s + 非静音（ffmpeg volumedetect mean_volume > -60dB）。
 *   校验不过直接拒绝入库——坏参考音频只会产出坏克隆，宁可拒在门外。
 */

export interface VoiceProfile {
  id: string;
  name: string;
  /** 参考音频样本路径（userData/voices/ 下的私有副本） */
  samplePath: string;
  createdAt: string;
  durationMs: number;
  /** 导入时检测到的平均音量 dB（volumedetect 解析失败为 null） */
  meanVolumeDb: number | null;
}

const AUDIO_EXT = new Set(['.wav', '.mp3', '.m4a', '.aac', '.flac', '.ogg']);
const MIN_DURATION_MS = 3_000;
const MAX_DURATION_MS = 20_000;
/** 平均音量高于该阈值才算"有人声/有内容"；纯静音 wav 一般 < -90dB */
const SILENCE_MEAN_DB = -60;

function userDataDir(): string {
  const dir = app.getPath('userData');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function indexFile(): string {
  return path.join(userDataDir(), 'voices.json');
}

export function samplesDir(): string {
  const dir = path.join(userDataDir(), 'voices');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

let cache: VoiceProfile[] | null = null;

function loadIndex(): VoiceProfile[] {
  if (cache) return cache;
  try {
    const raw = JSON.parse(readFileSync(indexFile(), 'utf8')) as { voices?: VoiceProfile[] };
    // 样本文件被外部删除的条目自动清理，避免索引指向不存在的音频
    cache = (raw.voices ?? []).filter((v) => v && typeof v.id === 'string' && existsSync(v.samplePath));
  } catch {
    cache = [];
  }
  return cache;
}

/** 原子写：先写 tmp 再 rename（同目录内 rename 在 Windows/Linux 均为原子替换） */
function saveIndexVoices(voices: VoiceProfile[]): void {
  cache = voices;
  const target = indexFile();
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, JSON.stringify({ version: 1, voices }, null, 2), 'utf8');
  renameSync(tmp, target);
}

export function listVoices(): VoiceProfile[] {
  return [...loadIndex()];
}

export function getVoice(id: string): VoiceProfile | null {
  return loadIndex().find((v) => v.id === id) ?? null;
}

/** ffmpeg volumedetect：解析 mean_volume；失败返回 null（不阻断导入，仅失去静音判据时告警） */
function detectMeanVolumeDb(filePath: string): Promise<number | null> {
  return new Promise((resolve) => {
    const ffmpeg = resolveFfmpegPath();
    if (!ffmpeg) return resolve(null);
    const child = spawn(ffmpeg, ['-hide_banner', '-i', filePath, '-af', 'volumedetect', '-f', 'null', '-'], {
      windowsHide: true,
    });
    let stderr = '';
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    child.on('error', () => resolve(null));
    child.on('close', () => {
      const m = stderr.match(/mean_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/);
      resolve(m ? Number(m[1]) : null);
    });
  });
}

/**
 * 导入参考音频：校验 → 拷贝样本 → 登记索引。
 * 校验失败抛中文错误（UI 直接展示），不落索引。
 */
export async function addVoice(srcPath: string, displayName?: string): Promise<VoiceProfile> {
  if (!existsSync(srcPath)) throw new Error('参考音频文件不存在');
  const ext = path.extname(srcPath).toLowerCase();
  if (!AUDIO_EXT.has(ext)) {
    throw new Error(`不支持的参考音频格式「${ext || '未知'}」，请使用 wav / mp3 / m4a / aac / flac / ogg`);
  }

  let probe;
  try {
    probe = await probeMedia(srcPath);
  } catch (e) {
    throw new Error(`参考音频无法解析：${(e as Error).message}`);
  }
  if (!probe.hasAudio) throw new Error('文件中没有音频流，无法作为参考音频');
  if (probe.durationMs < MIN_DURATION_MS || probe.durationMs > MAX_DURATION_MS) {
    throw new Error(
      `参考音频时长 ${(probe.durationMs / 1000).toFixed(1)}s 超出要求（3–20 秒），请截取一段清晰人声`,
    );
  }

  const meanVolumeDb = await detectMeanVolumeDb(srcPath);
  if (meanVolumeDb !== null && meanVolumeDb < SILENCE_MEAN_DB) {
    throw new Error('参考音频接近纯静音，请换一段包含清晰人声的样本');
  }

  const id = randomUUID();
  const samplePath = path.join(samplesDir(), `${id}${ext}`);
  copyFileSync(srcPath, samplePath);
  const profile: VoiceProfile = {
    id,
    name: (displayName ?? path.basename(srcPath, ext)).slice(0, 40) || `音色 ${id.slice(0, 8)}`,
    samplePath,
    createdAt: new Date().toISOString(),
    durationMs: probe.durationMs,
    meanVolumeDb,
  };
  saveIndexVoices([...loadIndex(), profile]);
  return profile;
}

/** 删除音色：索引与样本文件一并清理（隐私要求：不留孤儿参考音频） */
export function removeVoice(id: string): boolean {
  const voices = loadIndex();
  const target = voices.find((v) => v.id === id);
  if (!target) return false;
  saveIndexVoices(voices.filter((v) => v.id !== id));
  try {
    rmSync(target.samplePath, { force: true });
  } catch {
    /* 样本被占用时索引已移除，下次启动 loadIndex 会自动清掉失效条目 */
  }
  return true;
}

/** 测试/重置用：清空内存缓存重新读盘 */
export function reloadVoiceIndex(): void {
  cache = null;
}
