import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { app } from 'electron';

/**
 * 图像模型配置（P4a）：落盘 userData/image-gen-config.json，模式与 video-gen/config.ts 一致。
 *
 * 默认从环境变量取 DashScope 配置（DASHSCOPE_BASE_URL / TEXT_TO_IMAGE_MODEL / IMAGE_EDIT_MODEL），
 * active 默认 'offline'（不生成关键帧，generate-clips 退回文生视频）；
 * 用户在「设置中心 → AI 设置 → 图像模型」填入 API Key 并启用后，storyboard-image 节点开始逐镜出分镜图。
 */
export type ImageGenProviderId = 'offline' | 'qwen';

export interface QwenImageGenConfig {
  apiKey: string;
  baseUrl: string;
  textModel: string;
  editModel: string;
}

export interface ImageGenConfig {
  active: ImageGenProviderId;
  qwen: QwenImageGenConfig;
}

export const DEFAULT_IMAGE_GEN_CONFIG: ImageGenConfig = {
  active: 'offline',
  qwen: {
    apiKey: process.env.DASHSCOPE_API_KEY ?? '',
    baseUrl: process.env.DASHSCOPE_BASE_URL ?? 'https://dashscope.aliyuncs.com',
    textModel: process.env.TEXT_TO_IMAGE_MODEL ?? 'qwen-image-3.0-pro',
    editModel: process.env.IMAGE_EDIT_MODEL ?? 'qwen-image-edit-max',
  },
};

function configFile(): string {
  const dir = app.getPath('userData');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return path.join(dir, 'image-gen-config.json');
}

export function loadImageGenConfig(): ImageGenConfig {
  try {
    const raw = JSON.parse(readFileSync(configFile(), 'utf8')) as Partial<ImageGenConfig>;
    return {
      active: raw.active ?? DEFAULT_IMAGE_GEN_CONFIG.active,
      qwen: { ...DEFAULT_IMAGE_GEN_CONFIG.qwen, ...raw.qwen },
    };
  } catch {
    return { active: DEFAULT_IMAGE_GEN_CONFIG.active, qwen: { ...DEFAULT_IMAGE_GEN_CONFIG.qwen } };
  }
}

export function saveImageGenConfig(config: ImageGenConfig): void {
  writeFileSync(configFile(), JSON.stringify(config, null, 2), 'utf8');
}

/** 当前选中的图像 Provider 是否真的可用（供 UI 与引擎判断是否跳过关键帧生成） */
export function isImageGenConfigured(config: ImageGenConfig = loadImageGenConfig()): boolean {
  if (config.active === 'offline') return false;
  return Boolean(config.qwen?.apiKey);
}
