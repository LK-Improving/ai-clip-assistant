import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { app } from 'electron';

/**
 * 视频生成模型配置（阶段五补充，2026-09-15）。
 *
 * 落盘 userData/video-gen-config.json，模式与 llm/config.ts / tts/config.ts 一致：
 * 缺文件或解析失败时回退默认值，避免启动时崩溃。
 *
 * 默认 active='offline'（不生成视频，AI 成片退化为仅字幕/标题）；
 * 用户在「设置中心 → AI 设置 → 视频生成模型」里选择 MiniMax H3 并填入 API Key 后，
 * 桌面端会把 MiniMaxH3VideoProvider 注入引擎，流水线 generate-clips 节点开始补全素材。
 */
export type VideoGenProviderId = 'offline' | 'minimax';

export interface MiniMaxVideoGenConfig {
  apiKey: string;
  /** global=https://api.minimax.io / mainland=https://api.minimaxi.com；留空则按 region 推断 */
  baseUrl: string;
  /** 模型 id，默认 minimax-h3 */
  model: string;
}

export interface VideoGenConfig {
  active: VideoGenProviderId;
  minimax: MiniMaxVideoGenConfig;
}

export const DEFAULT_VIDEO_GEN_CONFIG: VideoGenConfig = {
  active: 'offline',
  minimax: {
    apiKey: '',
    baseUrl: 'https://api.minimax.io',
    model: 'minimax-h3',
  },
};

function configFile(): string {
  const dir = app.getPath('userData');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return path.join(dir, 'video-gen-config.json');
}

export function loadVideoGenConfig(): VideoGenConfig {
  try {
    const raw = JSON.parse(readFileSync(configFile(), 'utf8')) as Partial<VideoGenConfig>;
    return {
      active: raw.active ?? DEFAULT_VIDEO_GEN_CONFIG.active,
      minimax: { ...DEFAULT_VIDEO_GEN_CONFIG.minimax, ...raw.minimax },
    };
  } catch {
    return { ...DEFAULT_VIDEO_GEN_CONFIG, minimax: { ...DEFAULT_VIDEO_GEN_CONFIG.minimax } };
  }
}

export function saveVideoGenConfig(config: VideoGenConfig): void {
  writeFileSync(configFile(), JSON.stringify(config, null, 2), 'utf8');
}

/** 当前选中的 Provider 是否真的可用（供 UI 与引擎判断是否需要回退） */
export function isVideoGenConfigured(config: VideoGenConfig = loadVideoGenConfig()): boolean {
  if (config.active === 'offline') return true;
  return Boolean(config.minimax.apiKey || process.env.MINIMAX_API_KEY);
}
