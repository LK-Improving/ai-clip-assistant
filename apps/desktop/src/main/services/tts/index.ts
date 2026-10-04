import { LruCache, ttsCacheKey, ttsCachePath } from './cache';
import type { TtsConfig, TtsProviderId } from './config';
import { loadTtsConfig } from './config';
import { localProvider, probeLocal, zeroShotSynthesize } from './providers/local';
import type { LocalProbeResult } from './providers/local';
import { customProvider } from './providers/custom';
import { TtsAbortError, volcanoProvider } from './providers/volcano';
import { probeVolcano } from './providers/volcano';
import { probeMedia } from '../probe';
import { getVoice } from '../voice';
import type { VoiceProfile } from '../voice';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

export interface TtsSynthesizeContext {
  /** 覆盖默认 speaker（云端复刻音色传 S_xxxxx） */
  speaker?: string;
  /** 取消信号：abort 立即断开连接，且不被记为「失败降级」 */
  signal?: AbortSignal;
}

export interface TtsProvider {
  id: TtsProviderId;
  label: string;
  /** 配置是否齐全（缺密钥时前端给出明确提示，而不是静默失败） */
  isConfigured(config: TtsConfig): boolean;
  synthesize(
    req: { text: string; voice: string; speed: number },
    config: TtsConfig,
    ctx?: TtsSynthesizeContext,
  ): Promise<{ data: Buffer; ext: string }>;
}

const providers: Record<TtsProviderId, TtsProvider> = {
  volcano: volcanoProvider,
  local: localProvider,
  custom: customProvider,
};

/** 内存 LRU：最近 64 条合成结果直接命中，不走网络 */
const memoryCache = new LruCache<{ audioPath: string; durationMs: number }>(64);

export interface TtsResult {
  audioPath: string;
  durationMs: number;
  cached: boolean;
  /** volcano | local | custom | zero-shot:local | zero-shot:cloud */
  provider: string;
  voice: string;
}

export interface TtsRequest {
  text: string;
  voice?: string;
  speed?: number;
  provider?: TtsProviderId;
  /** 指定音色库 id 时走零样本克隆链（本地优先或云端优先，见 config.clonePreference） */
  voiceId?: string;
  /** 取消信号（导出/流水线中断时立即断开合成） */
  signal?: AbortSignal;
}

/** 降级链上的一环：为什么没走这条、结果如何、花了多久 */
export interface TtsRouteStep {
  stage: 'cache' | 'local-zero-shot' | 'cloud-zero-shot' | 'online' | 'offline-fallback';
  ok: boolean;
  latencyMs: number;
  reason: string;
}

export interface TtsProbeReport {
  active: TtsProviderId;
  clonePreference: TtsConfig['clonePreference'];
  volcano: { ok: boolean; configured: boolean; message: string; resourceId: string; latencyMs: number };
  local: (LocalProbeResult & { configured: boolean }) | { ok: boolean; configured: boolean; message: string; hints: string[] };
  custom: { ok: boolean; configured: boolean; message: string; hints: string[] };
}

const zeroShotLastNotice = new Map<string, string>();
let lastRouteTrace: TtsRouteStep[] = [];

/** 最近一次合成的降级链（UI / 日志可观察） */
export function ttsRouteTrace(): TtsRouteStep[] {
  return [...lastRouteTrace];
}

/** 读取最近一次零样本降级原因（UI/日志可观察性） */
export function zeroShotFallbackReason(voiceId: string): string | undefined {
  return zeroShotLastNotice.get(voiceId);
}

function voiceOf(config: TtsConfig, providerId: TtsProviderId, requested?: string): string {
  if (requested) return requested;
  if (providerId === 'volcano') return config.volcano.voice;
  if (providerId === 'custom') return config.custom.voice;
  return config.local.voice;
}

function unconfiguredMessage(providerId: TtsProviderId): string {
  if (providerId === 'volcano') {
    return '尚未配置火山引擎 TTS（APP ID / API Key），请在设置中心填写，或切换到本地 Index-TTS 2';
  }
  if (providerId === 'custom') {
    return '自定义 TTS 未配置服务地址（OpenAI 兼容 baseUrl），请在设置中心填写';
  }
  return '本地 Index-TTS 2 未配置服务地址，请在设置中心填写 baseUrl';
}

/** 命中内存/磁盘缓存则直接返回，避免重复请求（各链路缓存键互不串味） */
function lookupCache(key: string, provider: string, voice: string): TtsResult | null {
  const memoryHit = memoryCache.get(key);
  if (memoryHit && existsSync(memoryHit.audioPath)) {
    return { ...memoryHit, cached: true, provider, voice };
  }
  for (const ext of ['mp3', 'wav', 'pcm']) {
    const diskPath = ttsCachePath(key, ext);
    if (existsSync(diskPath)) {
      return { pendingPath: diskPath } as unknown as TtsResult & { pendingPath: string };
    }
  }
  return null;
}

async function persistAndReturn(
  key: string,
  provider: string,
  voice: string,
  audio: { data: Buffer; ext: string },
): Promise<TtsResult> {
  const audioPath = ttsCachePath(key, audio.ext);
  writeFileSync(audioPath, audio.data);
  const durationMs = await safeDuration(audioPath);
  memoryCache.set(key, { audioPath, durationMs });
  return { audioPath, durationMs, cached: false, provider, voice };
}

function isAbort(error: unknown): boolean {
  return error instanceof TtsAbortError || (error as Error)?.name === 'AbortError';
}

/** 本地 Index-TTS 2 零样本链（无 GPU / 服务未起时以中文原因失败，交给降级链） */
async function tryLocalZeroShot(
  voice: VoiceProfile,
  text: string,
  speed: number,
  config: TtsConfig,
  signal?: AbortSignal,
): Promise<{ result: TtsResult | null; step: TtsRouteStep }> {
  const started = Date.now();
  const failStep = (reason: string) => ({
    result: null,
    step: { stage: 'local-zero-shot' as const, ok: false, latencyMs: Date.now() - started, reason },
  });

  if (!localProvider.isConfigured(config)) {
    return failStep('本地 Index-TTS 2 未配置 baseUrl（无 NVIDIA 显卡时可改用云端复刻）');
  }
  if (signal?.aborted) throw new TtsAbortError();

  const probe = await probeLocal(config).catch(() => null);
  if (probe && !probe.reachable) {
    // 连不上才跳过；「服务在、但普通合成不通」不能误杀只实现克隆接口的服务
    return failStep(`本地零样本链不可用：服务不可达（${probe.message}）`);
  }

  const key = ttsCacheKey(text, `zsl:${voice.id}`, speed, 'zero-shot:local');
  const cached = lookupCache(key, 'zero-shot:local', voice.name) as TtsResult | null;
  if (cached) {
    return {
      result: await finalizeDiskHit(cached, key, 'zero-shot:local', voice.name),
      step: { stage: 'local-zero-shot', ok: true, latencyMs: Date.now() - started, reason: '命中本地零样本缓存' },
    };
  }

  try {
    const referenceAudioBase64 = readFileSync(voice.samplePath).toString('base64');
    const audio = await zeroShotSynthesize(config, {
      text,
      speed,
      voiceName: voice.name,
      referenceAudioBase64,
    });
    const result = await persistAndReturn(key, 'zero-shot:local', voice.name, audio);
    return { result, step: { stage: 'local-zero-shot', ok: true, latencyMs: Date.now() - started, reason: `本地 ${probe?.protocol ?? 'auto'} 协议合成成功` } };
  } catch (e) {
    if (isAbort(e)) throw e;
    return failStep(`本地零样本合成失败（${(e as Error).message}）`);
  }
}

/** 云端复刻链（火山 S_ 音色）：不依赖本地 GPU，是无显卡环境的真实克隆路径 */
async function tryCloudZeroShot(
  voice: VoiceProfile,
  text: string,
  speed: number,
  config: TtsConfig,
  signal?: AbortSignal,
): Promise<{ result: TtsResult | null; step: TtsRouteStep }> {
  const started = Date.now();
  const failStep = (reason: string) => ({
    result: null,
    step: { stage: 'cloud-zero-shot' as const, ok: false, latencyMs: Date.now() - started, reason },
  });

  const speaker = (voice.cloudSpeaker ?? '').trim();
  if (!speaker) return failStep(`音色「${voice.name}」未绑定云端复刻 Speaker ID`);
  if (!/^S_/i.test(speaker)) return failStep(`云端 Speaker ID 形态不对（应为控制台给的 S_xxxxx，当前 ${speaker}）`);
  if (!volcanoProvider.isConfigured(config)) return failStep('未配置火山引擎 TTS 凭证，云端复刻不可用');
  if (signal?.aborted) throw new TtsAbortError();

  const key = ttsCacheKey(text, `zsc:${voice.id}`, speed, 'zero-shot:cloud');
  const cached = lookupCache(key, 'zero-shot:cloud', voice.name) as TtsResult | null;
  if (cached) {
    return {
      result: await finalizeDiskHit(cached, key, 'zero-shot:cloud', voice.name),
      step: { stage: 'cloud-zero-shot', ok: true, latencyMs: Date.now() - started, reason: '命中云端复刻缓存' },
    };
  }

  try {
    const audio = await volcanoProvider.synthesize({ text, voice: speaker, speed }, config, { speaker, signal });
    const result = await persistAndReturn(key, 'zero-shot:cloud', voice.name, audio);
    return { result, step: { stage: 'cloud-zero-shot', ok: true, latencyMs: Date.now() - started, reason: `云端复刻 ${speaker} 合成成功` } };
  } catch (e) {
    if (isAbort(e)) throw e;
    return failStep(`云端复刻合成失败（${(e as Error).message}）`);
  }
}

/** lookupCache 命中磁盘时的补时长（probeMedia 是异步的，故单独收口） */
async function finalizeDiskHit(hit: TtsResult, key: string, provider: string, voice: string): Promise<TtsResult> {
  const pending = (hit as unknown as { pendingPath?: string }).pendingPath;
  if (!pending) return hit;
  const durationMs = await safeDuration(pending);
  memoryCache.set(key, { audioPath: pending, durationMs });
  return { audioPath: pending, durationMs, cached: true, provider, voice };
}

/**
 * 语音合成入口（模块 3.3）：
 * 零样本克隆链（按 clonePreference 排序）→ 常规 Provider（内存 LRU → 磁盘缓存 → 网络）
 */
export async function synthesizeSpeech(request: TtsRequest): Promise<TtsResult> {
  const text = request.text.trim();
  if (!text) throw new Error('合成文本不能为空');

  const config = loadTtsConfig();
  const speed = request.speed ?? 1;
  const trace: TtsRouteStep[] = [];

  // 零样本克隆：本地优先（默认，隐私最好）或云端优先（无 GPU 环境）
  if (request.voiceId) {
    const voice = getVoice(request.voiceId);
    if (!voice) {
      zeroShotLastNotice.set(request.voiceId, '音色不存在（可能已删除），已回退常规音色');
      trace.push({ stage: 'local-zero-shot', ok: false, latencyMs: 0, reason: '音色不存在（可能已删除）' });
    } else {
      const attempts =
        config.clonePreference === 'cloud-first'
          ? [() => tryCloudZeroShot(voice, text, speed, config, request.signal), () => tryLocalZeroShot(voice, text, speed, config, request.signal)]
          : [() => tryLocalZeroShot(voice, text, speed, config, request.signal), () => tryCloudZeroShot(voice, text, speed, config, request.signal)];
      for (const attempt of attempts) {
        const { result, step } = await attempt();
        trace.push(step);
        if (result) {
          zeroShotLastNotice.delete(request.voiceId);
          lastRouteTrace = trace;
          return result;
        }
        zeroShotLastNotice.set(request.voiceId, `${step.reason}，已继续降级`);
      }
      zeroShotLastNotice.set(request.voiceId, `${trace.map((s) => s.reason).join('；')}，已回退常规音色`);
    }
  }

  const providerId: TtsProviderId = request.provider ?? config.active;
  const provider = providers[providerId];
  const voice = voiceOf(config, providerId, request.voice);

  if (!provider.isConfigured(config)) {
    lastRouteTrace = trace.concat({ stage: 'online', ok: false, latencyMs: 0, reason: unconfiguredMessage(providerId) });
    throw new Error(unconfiguredMessage(providerId));
  }

  const key = ttsCacheKey(text, voice, speed, providerId);
  const cached = lookupCache(key, providerId, voice) as TtsResult | null;
  if (cached) {
    const hit = await finalizeDiskHit(cached, key, providerId, voice);
    lastRouteTrace = trace.concat({ stage: 'cache', ok: true, latencyMs: 0, reason: hit.cached ? '命中缓存' : '未命中' });
    return hit;
  }

  const started = Date.now();
  try {
    const audio = await provider.synthesize({ text, voice, speed }, config, { signal: request.signal });
    const result = await persistAndReturn(key, providerId, voice, audio);
    lastRouteTrace = trace.concat({ stage: 'online', ok: true, latencyMs: Date.now() - started, reason: `${provider.label} 合成成功` });
    return result;
  } catch (e) {
    const reason = (e as Error).message;
    lastRouteTrace = trace.concat({ stage: 'online', ok: false, latencyMs: Date.now() - started, reason });
    throw e;
  }
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
    clonePreference: config.clonePreference,
    cacheSize: memoryCache.size,
    configured: {
      volcano: providers.volcano.isConfigured(config),
      local: providers.local.isConfigured(config),
      custom: providers.custom.isConfigured(config),
    },
  };
}

/**
 * 连通性检测（设置页用）：火山只做握手探活（不产生字符费用），本地走协议识别 + 一次试合成。
 * 结论与真实合成同源，避免「显示可用、合成失败」两套话。
 */
export async function ttsProbe(options?: { force?: boolean }): Promise<TtsProbeReport> {
  const config = loadTtsConfig();
  const started = Date.now();

  const volcanoConfigured = providers.volcano.isConfigured(config);
  const volcanoProbe = volcanoConfigured
    ? await probeVolcano(config)
    : { ok: false, message: unconfiguredMessage('volcano'), resourceId: '' };

  const localConfigured = providers.local.isConfigured(config);
  const local = localConfigured
    ? { ...(await probeLocal(config, options?.force)), configured: true }
    : { ok: false, configured: false, message: unconfiguredMessage('local'), hints: ['无 NVIDIA 显卡时可直接用云端复刻：给音色绑定控制台 Speaker ID'] };

  const customConfigured = providers.custom.isConfigured(config);

  return {
    active: config.active,
    clonePreference: config.clonePreference,
    volcano: {
      ok: volcanoProbe.ok,
      configured: volcanoConfigured,
      message: volcanoProbe.message,
      resourceId: volcanoProbe.resourceId,
      latencyMs: Date.now() - started,
    },
    local,
    custom: {
      ok: customConfigured,
      configured: customConfigured,
      message: customConfigured ? `已配置 ${config.custom.baseUrl}` : unconfiguredMessage('custom'),
      hints: customConfigured ? [] : ['可接 DeepSeek 生态网关、F5-TTS / Index-TTS 的 OpenAI 兼容壳'],
    },
  };
}
