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

export interface TtsConfig {
  active: 'volcano' | 'local';
  volcano: VolcanoTtsConfig;
  local: LocalTtsConfig;
}

const DEFAULT_CONFIG: TtsConfig = {
  active: 'local',
  volcano: { appId: '', accessToken: '', voice: 'zh_female_roumei' },
  local: { baseUrl: 'http://127.0.0.1:7860', voice: 'default' },
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
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function saveTtsConfig(config: TtsConfig): void {
  writeFileSync(configFile(), JSON.stringify(config, null, 2), 'utf8');
}
