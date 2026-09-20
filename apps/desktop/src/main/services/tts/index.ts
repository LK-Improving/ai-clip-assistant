import { LruCache, ttsCacheKey, ttsCachePath } from './cache';
import type { TtsConfig } from './config';
import { loadTtsConfig } from './config';
import { localProvider, zeroShotSynthesize } from './providers/local';
import { volcanoProvider } from './providers/volcano';
import { probeMedia } from '../probe';
import { getVoice } from '../voice';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

export interface TtsProvider {
  id: 'volcano' | 'local';
  label: string;
  /** 配置是否齐全（缺密钥时前端给出明确提示，而不是静默失败） */
  isConfigured(config: TtsConfig): boolean;
  synthesize(
    req: { text: string; voice: string; speed: number },
    config: TtsConfig,
  ): Promise<{ data: Buffer; ext: string }>;
}

const providers: Record<TtsProvider['id'], TtsProvider> = {
  volcano: volcanoProvider,
  local: localProvider,
};

/** 内存 LRU：最近 64 条合成结果直接命中，不走网络 */
const memoryCache = new LruCache<{ audioPath: string; durationMs: number }>(64);

export interface TtsResult {
  audioPath: string;
  durationMs: number;
  cached: boolean;
  provider: string;
  voice: string;
}

export interface TtsRequest {
  text: string;
  voice?: string;
  speed?: number;
  provider?: TtsProvider['id'];
  /** M3：指定音色库 id 时走本地零样本克隆链；服务不可用/未配置时自动降级到常规 Provider */
  voiceId?: string;
}

/** 零样本路由的降级日志（供上层/日志展示，不阻断合成） */
export interface TtsRouteNotice {
  voiceId: string;
  reason: string;
}

const zeroShotLastNotice = new Map<string, string>();

/**
 * 尝试零样本音色合成（M3 双路由）：
 * 音色不存在/本地服务未配/请求失败 → 返回 null 并记录降级原因，由调用方回退常规链。
 */
async function tryZeroShot(
  request: TtsRequest,
  text: string,
  speed: number,
  config: TtsConfig,
): Promise<TtsResult | null> {
  const voice = getVoice(request.voiceId!);
  if (!voice) {
    zeroShotLastNotice.set(request.voiceId!, '音色不存在（可能已删除），已回退常规音色');
    return null;
  }
  if (!localProvider.isConfigured(config)) {
    zeroShotLastNotice.set(request.voiceId!, '本地音色服务（Index-TTS 2）未配置 baseUrl，已回退常规音色');
    return null;
  }
  const key = ttsCacheKey(text, `zs:${voice.id}`, speed, 'zero-shot');
  const memoryHit = memoryCache.get(key);
  if (memoryHit && existsSync(memoryHit.audioPath)) {
    return { ...memoryHit, cached: true, provider: 'zero-shot', voice: voice.name };
  }
  for (const ext of ['mp3', 'wav']) {
    const diskPath = ttsCachePath(key, ext);
    if (existsSync(diskPath)) {
      const durationMs = await safeDuration(diskPath);
      memoryCache.set(key, { audioPath: diskPath, durationMs });
      return { audioPath: diskPath, durationMs, cached: true, provider: 'zero-shot', voice: voice.name };
    }
  }
  try {
    const referenceAudioBase64 = readFileSync(voice.samplePath).toString('base64');
    const { data, ext } = await zeroShotSynthesize(config, {
      text,
      speed,
      voiceName: voice.name,
      referenceAudioBase64,
    });
    const audioPath = ttsCachePath(key, ext);
    writeFileSync(audioPath, data);
    const durationMs = await safeDuration(audioPath);
    memoryCache.set(key, { audioPath, durationMs });
    zeroShotLastNotice.delete(request.voiceId!);
    return { audioPath, durationMs, cached: false, provider: 'zero-shot', voice: voice.name };
  } catch (e) {
    zeroShotLastNotice.set(request.voiceId!, `零样本合成失败（${(e as Error).message}），已回退常规音色`);
    return null;
  }
}

/** 读取最近一次零样本降级原因（UI/日志可观察性） */
export function zeroShotFallbackReason(voiceId: string): string | undefined {
  return zeroShotLastNotice.get(voiceId);
}

/**
 * 语音合成入口（模块 3.3）：
 * 内存 LRU → 磁盘缓存 → 调用 Provider → 写盘 → 探测时长 → 回写缓存
 */
export async function synthesizeSpeech(request: TtsRequest): Promise<TtsResult> {
  const text = request.text.trim();
  if (!text) throw new Error('合成文本不能为空');

  const config = loadTtsConfig();
  const speed = request.speed ?? 1;

  // M3 双路由：指定音色库 id → 零样本克隆优先；任何一环不可用都静降级到下方常规链
  if (request.voiceId) {
    const zeroShot = await tryZeroShot(request, text, speed, config);
    if (zeroShot) return zeroShot;
  }

  const providerId = request.provider ?? config.active;
  const provider = providers[providerId];
  const voice = request.voice ?? (providerId === 'volcano' ? config.volcano.voice : config.local.voice);

  if (!provider.isConfigured(config)) {
    throw new Error(
      providerId === 'volcano'
        ? '尚未配置火山引擎 TTS（appId / accessToken），请在设置中心填写，或切换到本地 Index-TTS 2'
        : '本地 Index-TTS 2 未配置服务地址，请在设置中心填写 baseUrl',
    );
  }

  const key = ttsCacheKey(text, voice, speed, providerId);

  const memoryHit = memoryCache.get(key);
  if (memoryHit && existsSync(memoryHit.audioPath)) {
    return { ...memoryHit, cached: true, provider: providerId, voice };
  }

  // 磁盘缓存：mp3 / wav 两种扩展名都尝试命中
  for (const ext of ['mp3', 'wav']) {
    const diskPath = ttsCachePath(key, ext);
    if (existsSync(diskPath)) {
      const durationMs = await safeDuration(diskPath);
      memoryCache.set(key, { audioPath: diskPath, durationMs });
      return { audioPath: diskPath, durationMs, cached: true, provider: providerId, voice };
    }
  }

  const { data, ext } = await provider.synthesize({ text, voice, speed }, config);
  const audioPath = ttsCachePath(key, ext);
  writeFileSync(audioPath, data);

  const durationMs = await safeDuration(audioPath);
  memoryCache.set(key, { audioPath, durationMs });
  return { audioPath, durationMs, cached: false, provider: providerId, voice };
}

async function safeDuration(filePath: string): Promise<number> {
  try {
    return (await probeMedia(filePath)).durationMs;
  } catch {
    return 0;
  }
}

export function ttsStatus() {
  const config = loadTtsConfig();
  return {
    active: config.active,
    cacheSize: memoryCache.size,
    configured: {
      volcano: providers.volcano.isConfigured(config),
      local: providers.local.isConfigured(config),
    },
  };
}
