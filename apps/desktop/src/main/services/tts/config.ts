import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { app } from 'electron';

export interface VolcanoTtsConfig {
  appId: string;
  accessToken: string;
  voice: string;
}

export interface LocalTtsConfig {
  /** 本地 Index-TTS 2 服务地址，例如 http://127.0.0.1:7860 */
  baseUrl: string;
  voice: string;
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

export interface TtsConfig {
  active: 'volcano' | 'local' | 'custom';
  volcano: VolcanoTtsConfig;
  local: LocalTtsConfig;
  custom: CustomTtsConfig;
}

const DEFAULT_CONFIG: TtsConfig = {
  active: 'local',
  volcano: { appId: '', accessToken: '', voice: 'zh_female_roumei' },
  local: { baseUrl: 'http://127.0.0.1:7860', voice: 'default' },
  custom: { baseUrl: '', model: 'tts-1', voice: 'default', apiKey: '' },
};

function configFile() {
  const dir = app.getPath('userData');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return path.join(dir, 'tts-config.json');
}

export function loadTtsConfig(): TtsConfig {
  try {
    const raw = JSON.parse(readFileSync(configFile(), 'utf8')) as Partial<TtsConfig>;
    return {
      active: raw.active ?? DEFAULT_CONFIG.active,
      volcano: { ...DEFAULT_CONFIG.volcano, ...raw.volcano },
      local: { ...DEFAULT_CONFIG.local, ...raw.local },
      // 旧配置无 custom 字段：补默认，不强迫用户重建配置
      custom: { ...DEFAULT_CONFIG.custom, ...raw.custom },
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function saveTtsConfig(config: TtsConfig): void {
  writeFileSync(configFile(), JSON.stringify(config, null, 2), 'utf8');
}
