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
export type VideoGenProviderId = 'offline' | 'minimax' | 'seedance' | 'custom';

export interface MiniMaxVideoGenConfig {
  apiKey: string;
  /** global=https://api.minimax.io / mainland=https://api.minimaxi.com；留空则按 region 推断 */
  baseUrl: string;
  /** 模型 id，默认 minimax-h3 */
  model: string;
  /**
   * 生成分辨率档位（官方 enum：H3 支持 768P / 2K）。
   * 默认 2K 不擅自降级；按秒计费 2K=0.80 元/秒、768P=0.50 元/秒，
   * 1080p 画布的成片验证阶段建议改 768P。
   */
  resolution: '768P' | '2K';
}

export interface SeedanceVideoGenConfig {
  /** 方舟 API Key（与 LLM 可同一账号） */
  apiKey: string;
  /** 默认方舟接入点根路径 */
  baseUrl: string;
  /** 模型 id 以方舟控制台视频生成列表为准（如 doubao-seedance-*） */
  model: string;
}

export interface CustomVideoGenConfig {
  /** OpenAI 兼容视频任务接入点根路径（POST {base}/videos） */
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface VideoGenConfig {
  active: VideoGenProviderId;
  minimax: MiniMaxVideoGenConfig;
  seedance: SeedanceVideoGenConfig;
  custom: CustomVideoGenConfig;
}

export const DEFAULT_VIDEO_GEN_CONFIG: VideoGenConfig = {
  active: 'offline',
  minimax: {
    apiKey: '',
    baseUrl: 'https://api.minimax.io',
    model: 'minimax-h3',
    resolution: '2K',
  },
  seedance: {
    apiKey: '',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    model: '',
  },
  custom: {
    baseUrl: '',
    apiKey: '',
    model: '',
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
      seedance: { ...DEFAULT_VIDEO_GEN_CONFIG.seedance, ...raw.seedance },
      custom: { ...DEFAULT_VIDEO_GEN_CONFIG.custom, ...raw.custom },
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
  if (config.active === 'seedance') return Boolean(config.seedance?.apiKey && config.seedance?.model);
  if (config.active === 'custom') return Boolean(config.custom?.apiKey && config.custom?.baseUrl && config.custom?.model);
  return Boolean(config.minimax.apiKey || process.env.MINIMAX_API_KEY);
}
