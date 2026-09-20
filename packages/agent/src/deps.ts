import { mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OfflineChatModel } from './llm';
import { OfflineVideoGenProvider } from './video-gen';
import type { AgentDeps, AgentTtsProvider, AgentTtsRequest, AgentTtsResult, MediaProbe } from './types';

/** ===== 离线 TTS Provider：生成合法的静音 WAV，保证无引擎也能端到端跑通 ===== */

const VIDEO_EXTS = ['mp4', 'mov', 'webm', 'mkv', 'avi', 'm4v'];
const IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'];
const AUDIO_EXTS = ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg'];
const SUBTITLE_EXTS = ['srt', 'ass', 'vtt'];

export class OfflineTtsProvider implements AgentTtsProvider {
  readonly id = 'offline';

  isConfigured(): boolean {
    return true;
  }

  async synthesize(req: AgentTtsRequest): Promise<AgentTtsResult> {
    const text = (req.text ?? '').trim();
    if (!text) throw new Error('合成文本不能为空');
    const durationMs = Math.min(20_000, Math.max(800, text.length * 180));
    const data = makeSilentWav(durationMs, 24_000);
    return { data, ext: 'wav', durationMs };
  }
}

/** 生成单声道 16bit PCM 静音 WAV 缓冲（仅表头 + 零采样） */
function makeSilentWav(durationMs: number, sampleRate: number): Buffer {
  const numSamples = Math.floor((durationMs / 1000) * sampleRate);
  const dataSize = numSamples * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);

  const writeStr = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);
  // 采样区保持为 0（静音）
  return buffer;
}

/** ===== 离线媒体探测：基于扩展名给出启发式元数据（生产环境由 desktop probeMedia 替换） ===== */

export const offlineProbe: (filePath: string) => Promise<MediaProbe> = async (filePath: string) => {
  const ext = path.extname(filePath).toLowerCase().replace(/^\./, '');
  if (IMAGE_EXTS.includes(ext) || SUBTITLE_EXTS.includes(ext)) {
    return { durationMs: 0, width: 1920, height: 1080, fps: null, hasAudio: false };
  }
  if (AUDIO_EXTS.includes(ext)) {
    return { durationMs: 5000, width: null, height: null, fps: null, hasAudio: true };
  }
  if (VIDEO_EXTS.includes(ext)) {
    return { durationMs: 5000, width: 1920, height: 1080, fps: 30, hasAudio: false };
  }
  return { durationMs: 0, width: null, height: null, fps: null, hasAudio: false };
};

/** ===== 默认依赖容器（离线） ===== */

export function createDefaultDeps(): AgentDeps {
  return {
    llm: new OfflineChatModel({}),
    tts: new OfflineTtsProvider(),
    videoGen: new OfflineVideoGenProvider(),
    probe: offlineProbe,
    workDir: path.join(os.tmpdir(), 'miaoma-agent'),
  };
}

/** 合并用户注入的依赖与默认离线依赖 */
export function resolveDeps(partial?: Partial<AgentDeps>): AgentDeps {
  const base = createDefaultDeps();
  const merged: AgentDeps = {
    llm: partial?.llm ?? base.llm,
    tts: partial?.tts ?? base.tts,
    videoGen: partial?.videoGen ?? base.videoGen,
    probe: partial?.probe ?? base.probe,
    workDir: partial?.workDir ?? base.workDir,
    logger: partial?.logger,
    onToken: partial?.onToken,
    signal: partial?.signal,
  };
  mkdirSync(merged.workDir, { recursive: true });
  return merged;
}
