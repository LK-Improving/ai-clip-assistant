import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { app } from 'electron';

/**
 * LLM 配置（阶段二续）：落盘到 userData/llm-config.json。
 * 参照 tts/config.ts 的模式，缺文件或解析失败时回退默认值，避免启动时崩溃。
 */

export type LlmProviderId = 'offline' | 'ark' | 'ollama' | 'custom';

export interface ArkLlmConfig {
  apiKey: string;
  model: string;
  /** OpenAI 兼容端点，默认火山方舟 */
  baseUrl: string;
  /** M4 可选：视觉模型 id（如 doubao-vision-pro-32k），配置后扫描素材时生成画面描述 */
  visionModel?: string;
}

export interface OllamaLlmConfig {
  /** 本地 Ollama 服务地址（M1：三模型引擎之一，纯离线/私有化场景） */
  baseUrl: string;
  model: string;
}

export interface CustomLlmConfig {
  /** OpenAI 兼容接入点根路径（如 https://api.deepseek.com/v1） */
  baseUrl: string;
  apiKey: string;
  /** 模型 id 以服务商控制台为准（如 deepseek-chat / deepseek-reasoner） */
  model: string;
}

export interface LlmConfig {
  /** offline=内置确定性；ark=火山方舟；ollama=本地 Ollama；custom=任意 OpenAI 兼容端点（DeepSeek 等） */
  active: LlmProviderId;
  ark: ArkLlmConfig;
  ollama: OllamaLlmConfig;
  custom: CustomLlmConfig;
}

export const DEFAULT_LLM_CONFIG: LlmConfig = {
  active: 'offline',
  ark: {
    apiKey: '',
    model: 'doubao-seed-1-6-250615',
    // 火山方舟 OpenAI 兼容接入点根路径（ARK 真实域名；normalizeArkBaseUrl 会兼容历史写全 /chat/completions 的配置）
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
  },
  ollama: {
    baseUrl: 'http://127.0.0.1:11434',
    model: 'qwen2.5:7b',
  },
  custom: {
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: '',
    model: 'deepseek-chat',
  },
};

function configFile(): string {
  const dir = app.getPath('userData');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return path.join(dir, 'llm-config.json');
}

export function loadLlmConfig(): LlmConfig {
  try {
    const raw = JSON.parse(readFileSync(configFile(), 'utf8')) as Partial<LlmConfig>;
    return {
      active: raw.active ?? DEFAULT_LLM_CONFIG.active,
      ark: { ...DEFAULT_LLM_CONFIG.ark, ...raw.ark },
      // 旧配置文件无 ollama 字段：用默认值补齐，不强迫用户重建配置
      ollama: { ...DEFAULT_LLM_CONFIG.ollama, ...raw.ollama },
      custom: { ...DEFAULT_LLM_CONFIG.custom, ...raw.custom },
    };
  } catch {
    return {
      ...DEFAULT_LLM_CONFIG,
      ark: { ...DEFAULT_LLM_CONFIG.ark },
      ollama: { ...DEFAULT_LLM_CONFIG.ollama },
      custom: { ...DEFAULT_LLM_CONFIG.custom },
    };
  }
}

export function saveLlmConfig(config: LlmConfig): void {
  writeFileSync(configFile(), JSON.stringify(config, null, 2), 'utf8');
}

/** 当前选中的 Provider 是否真的可用（供 UI 与引擎判断是否需要回退） */
export function isLlmConfigured(config: LlmConfig = loadLlmConfig()): boolean {
  if (config.active === 'offline') return true;
  if (config.active === 'ollama') {
    // 本机服务：选了就算可用；连接失败由 invokeStructured 的重试/降级兜底接住
    return Boolean(config.ollama?.baseUrl || process.env.OLLAMA_BASE_URL);
  }
  if (config.active === 'custom') {
    return Boolean(config.custom?.apiKey && config.custom?.baseUrl);
  }
  return Boolean(config.ark.apiKey || process.env.ARK_API_KEY);
}
