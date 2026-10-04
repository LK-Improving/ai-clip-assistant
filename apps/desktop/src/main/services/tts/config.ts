import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { app } from 'electron';

/**
 * TTS 配置（契约见 .agents/Documents/接口设计/TTS火山v3与本地克隆接入契约.md）。
 *
 * 兼容性：所有新增字段均为「落盘可缺省」——loadTtsConfig / saveTtsConfig 统一走
 * normalizeTtsConfig 补齐默认值，老用户的 tts-config.json 不需要手工迁移。
 */

/** 火山 v3 音频容器：pcm 仅在需要接实时播放时使用，落盘走 mp3 / wav */
export type VolcanoAudioFormat = 'mp3' | 'wav' | 'pcm';

export interface VolcanoTtsConfig {
  /** 控制台 APP ID（v3 握手头 X-Api-App-Key） */
  appId: string;
  /** 访问控制 API Key（v3 握手头 X-Api-Access-Key） */
  accessToken: string;
  /** 默认 speaker：官方音色名或云端复刻音色 S_xxxxx */
  voice: string;
  /** 覆盖按 speaker 推导的 X-Api-Resource-Id（留空 = 自动路由） */
  resourceId: string;
  format: VolcanoAudioFormat;
  sampleRate: number;
  /** 自然语言情感提示（火山 additions.context_texts，仅 2.0/复刻音色响应） */
  emotion: string;
  /** 单次合成超时（含建连），超时即关闭连接并降级 */
  timeoutMs: number;
}

/**
 * 本地自托管 TTS 协议形态：
 * - custom：约定 {base}/tts 与 {base}/tts/zero-shot（本项目内置壳）
 * - openai：OpenAI 兼容 {base}/audio/speech（F5-TTS / Index-TTS 兼容壳等）
 * - gradio：官方 Index-TTS 2 WebUI(7860) 的 Gradio REST 协议
 * - auto：探活后按特征自动定型（gradio → openai → custom）
 */
export type LocalTtsMode = 'auto' | 'gradio' | 'openai' | 'custom';

export interface LocalTtsConfig {
  /** 本地 Index-TTS 2 服务地址，例如 http://127.0.0.1:7860 */
  baseUrl: string;
  voice: string;
  mode: LocalTtsMode;
  /** Gradio 模式下的命名端点（留空 = 从 /gradio_api/info 自动挑 tts/generate/synth） */
  gradioApiName: string;
  timeoutMs: number;
}

export interface CustomTtsConfig {
  /** OpenAI 兼容 TTS 接入点根路径（如 http://127.0.0.1:5000/v1），POST {base}/audio/speech */
  baseUrl: string;
  /** 模型 id（部分自托管服务不校验，可填任意占位） */
  model: string;
  voice: string;
  /** 可选：兼容网关需要 Bearer 时填 */
  apiKey?: string;
}

/** 零样本克隆链路优先级（无 GPU 环境可切 cloud-first 直接走云端复刻） */
export type ClonePreference = 'local-first' | 'cloud-first';

export type TtsProviderId = 'volcano' | 'local' | 'custom';

export interface TtsConfig {
  active: TtsProviderId;
  volcano: VolcanoTtsConfig;
  local: LocalTtsConfig;
  custom: CustomTtsConfig;
  clonePreference: ClonePreference;
}

/**
 * 可缺省的配置入参形态：历史落盘与冒烟脚本只会写部分字段（包括只写 volcano.voice 这种），
 * 统一由 normalizeTtsConfig 补齐，避免调用方被迫手抄全量字段。
 */
export interface TtsConfigInput {
  active?: TtsProviderId;
  volcano?: Partial<VolcanoTtsConfig>;
  local?: Partial<LocalTtsConfig>;
  custom?: Partial<CustomTtsConfig>;
  clonePreference?: ClonePreference;
}

const DEFAULT_CONFIG: TtsConfig = {
  active: 'local',
  volcano: {
    appId: '',
    accessToken: '',
    voice: 'zh_female_vv_uranus_bigtts',
    resourceId: '',
    format: 'mp3',
    sampleRate: 24000,
    emotion: '',
    timeoutMs: 30_000,
  },
  local: {
    baseUrl: 'http://127.0.0.1:7860',
    voice: 'default',
    mode: 'auto',
    gradioApiName: '',
    timeoutMs: 60_000,
  },
  custom: { baseUrl: '', model: 'tts-1', voice: 'default', apiKey: '' },
  clonePreference: 'local-first',
};

const PROVIDER_IDS = new Set<TtsProviderId>(['volcano', 'local', 'custom']);
const LOCAL_MODES = new Set<LocalTtsMode>(['auto', 'gradio', 'openai', 'custom']);
const FORMATS = new Set<VolcanoAudioFormat>(['mp3', 'wav', 'pcm']);

function str(v: unknown, fallback: string): string {
  return typeof v === 'string' && v.trim() ? v.trim() : fallback;
}

function num(v: unknown, fallback: number, min: number, max: number): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** 补齐缺省字段并夹紧非法值；渲染进程传入的任何形态都在此收敛为完整配置 */
export function normalizeTtsConfig(raw: TtsConfigInput | null | undefined): TtsConfig {
  const v: Partial<VolcanoTtsConfig> = raw?.volcano ?? {};
  const l: Partial<LocalTtsConfig> = raw?.local ?? {};
  const c: Partial<CustomTtsConfig> = raw?.custom ?? {};
  const format = str(v.format, DEFAULT_CONFIG.volcano.format) as VolcanoAudioFormat;
  const mode = str(l.mode, DEFAULT_CONFIG.local.mode);
  return {
    active: raw?.active && PROVIDER_IDS.has(raw.active) ? raw.active : DEFAULT_CONFIG.active,
    volcano: {
      appId: str(v.appId, DEFAULT_CONFIG.volcano.appId),
      accessToken: str(v.accessToken, DEFAULT_CONFIG.volcano.accessToken),
      voice: str(v.voice, DEFAULT_CONFIG.volcano.voice),
      resourceId: typeof v.resourceId === 'string' ? v.resourceId.trim() : '',
      format: FORMATS.has(format) ? format : DEFAULT_CONFIG.volcano.format,
      sampleRate: num(v.sampleRate, DEFAULT_CONFIG.volcano.sampleRate, 8_000, 48_000),
      emotion: typeof v.emotion === 'string' ? v.emotion.trim() : '',
      timeoutMs: num(v.timeoutMs, DEFAULT_CONFIG.volcano.timeoutMs, 3_000, 180_000),
    },
    local: {
      baseUrl: str(l.baseUrl, DEFAULT_CONFIG.local.baseUrl),
      voice: str(l.voice, DEFAULT_CONFIG.local.voice),
      // 旧配置无 mode 字段：补 auto（探活定型），不强迫用户重建配置
      mode: LOCAL_MODES.has(mode as LocalTtsMode) ? (mode as LocalTtsMode) : DEFAULT_CONFIG.local.mode,
      gradioApiName: typeof l.gradioApiName === 'string' ? l.gradioApiName.trim() : '',
      timeoutMs: num(l.timeoutMs, DEFAULT_CONFIG.local.timeoutMs, 3_000, 600_000),
    },
    custom: {
      baseUrl: typeof c.baseUrl === 'string' ? c.baseUrl.trim() : DEFAULT_CONFIG.custom.baseUrl,
      model: str(c.model, DEFAULT_CONFIG.custom.model),
      voice: str(c.voice, DEFAULT_CONFIG.custom.voice),
      apiKey: typeof c.apiKey === 'string' ? c.apiKey.trim() : '',
    },
    clonePreference:
      raw?.clonePreference === 'cloud-first' || raw?.clonePreference === 'local-first'
        ? raw.clonePreference
        : DEFAULT_CONFIG.clonePreference,
  };
}

function configFile() {
  const dir = app.getPath('userData');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return path.join(dir, 'tts-config.json');
}

export function loadTtsConfig(): TtsConfig {
  try {
    return normalizeTtsConfig(JSON.parse(readFileSync(configFile(), 'utf8')) as TtsConfigInput);
  } catch {
    return normalizeTtsConfig(null);
  }
}

/** 接受不完整配置（历史冷数据 / 冒烟脚本只关心部分字段），落盘前统一补齐 */
export function saveTtsConfig(config: TtsConfigInput): void {
  writeFileSync(configFile(), JSON.stringify(normalizeTtsConfig(config), null, 2), 'utf8');
}
