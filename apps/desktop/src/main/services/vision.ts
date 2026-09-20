import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { loadLlmConfig } from './llm/config';

/**
 * 多模态素材解析（M4，PDF「素材语义预处理」的视觉级增强）。
 *
 * 架构原则：**可选增强、缺失即降级**——
 * - `@huggingface/transformers` 经 bundler 不可见的动态加载获取（Electron 主进程运行期解析），
 *   未安装依赖 / 未下载模型 / 推理失败时全部返回 null，调用方自动回退 P2 词法向量与启发式描述；
 * - CLIP ViT-B/32（q8 量化约 65MB）首启下载到 userData/models/clip，之后纯离线；
 *   也可用 `pnpm vision:warmup` 预下载到仓内 .models/clip（开发期共享）；
 * - 视觉向量只存在于素材库缓存（LibraryEntry.visionEmbedding），**不进工程 JSON**：
 *   Asset.embedding 仍为 96 维词法向量，match-assets 不受向量空间差异影响。
 */

const CLIP_MODEL_ID = 'Xenova/clip-vit-base-patch32';
/** 模型候选目录：userData 优先，仓内 .models 兜底（warmup 产物） */
function modelRootCandidates(): string[] {
  const dirs = [path.join(app.getPath('userData'), 'models')];
  if (process.env.MIAOMA_MODELS_DIR) dirs.unshift(process.env.MIAOMA_MODELS_DIR);
  return dirs;
}

/** transformers 模块与 pipeline 的单例缓存（加载/构建只发生一次） */
let transformersPromise: Promise<any> | null = null;
let extractorPromise: Promise<any> | null = null;
/** 视觉能力短路标记：失败一次后不再重试，避免每个素材都付一次加载开销 */
let visionBroken = false;
/** 最近一次不可用原因（UI/日志可观察） */
let visionReason = '';

export interface VisionStatus {
  /** npm 依赖是否可用 */
  installed: boolean;
  /** 本地模型是否已下载（任一候选目录） */
  modelPresent: boolean;
  /** 当前是否真正可用（前两者成立且未短路） */
  ready: boolean;
  reason: string;
}

async function loadTransformers(): Promise<any> {
  if (!transformersPromise) {
    transformersPromise = (async () => {
      // 主进程产物为 CJS：优先运行期 require（变量名不经 bundler 静态解析，
      // 未安装依赖时仅运行期失败 → 词法向量降级，构建不受影响）
      try {
        const dynamicRequire = require as NodeRequire;
        return dynamicRequire('@huggingface/transformers');
      } catch {
        /* fall through to ESM dynamic import */
      }
      // ESM 回退：模板体为常量、仅传入固定模块名，无任何外部输入拼接，不构成代码注入面
      const importer = new Function('s', 'return import(s)') as (s: string) => Promise<any>;
      return await importer('@huggingface/transformers');
    })().catch((e) => {
      transformersPromise = null;
      visionBroken = true;
      visionReason = `@huggingface/transformers 未安装或加载失败：${(e as Error).message}`;
      return null;
    });
  }
  return transformersPromise;
}

function modelPresent(): boolean {
  // transformers 布局：<root>/Xenova/clip-vit-base-patch32/{config.json,...}
  return modelRootCandidates().some((root) =>
    existsSync(path.join(root, CLIP_MODEL_ID, 'config.json')),
  );
}

async function getExtractor(): Promise<any> {
  if (visionBroken) return null;
  // 运行期只认已下载的本地模型：扫描/检索绝不触发意外联网下载（流量可控），
  // 模型获取的唯一入口是显式 `pnpm vision:warmup` 或首启引导
  if (!modelPresent()) {
    if (!visionReason) visionReason = '本地 CLIP 模型未下载（运行 pnpm vision:warmup 启用视觉增强）';
    return null;
  }
  if (!extractorPromise) {
    extractorPromise = (async () => {
      const tfs = await loadTransformers();
      if (!tfs) return null;
      const roots = modelRootCandidates();
      // 本地-only：transformers 找不到本地模型直接报错，不会回源下载
      tfs.env.localModelPath = roots.filter((d) => existsSync(d));
      tfs.env.allowRemoteModels = false;
      tfs.env.allowLocalModels = true;
      const { pipeline } = tfs;
      return await pipeline('feature-extraction', CLIP_MODEL_ID, { dtype: 'q8' });
    })().catch((e) => {
      extractorPromise = null;
      visionBroken = true;
      visionReason = `CLIP 模型加载失败（可重新运行 pnpm vision:warmup）：${(e as Error).message}`.slice(0, 300);
      return null;
    });
  }
  return extractorPromise;
}

export function visionStatus(): VisionStatus {
  return {
    installed: transformersPromise !== null && !visionBroken,
    modelPresent: modelPresent(),
    ready: !visionBroken && modelPresent(),
    reason: visionReason,
  };
}

/** 归一化 + round(4) 的向量输出，与词法向量存储口径一致 */
function tensorToVector(output: any): number[] {
  const data: number[] = output?.data ?? [];
  const norm = Math.sqrt(data.reduce((s, v) => s + v * v, 0)) || 1;
  return data.map((v) => Number((v / norm).toFixed(4)));
}

/** 图片（或视频关键帧图）→ CLIP 视觉向量；任何一环不可用返回 null（调用方降级） */
export async function embedImage(imagePath: string): Promise<number[] | null> {
  if (visionBroken || !existsSync(imagePath)) return null;
  const extractor = await getExtractor();
  if (!extractor) return null;
  try {
    const output = await extractor(imagePath, { pooling: 'mean', normalize: true });
    const vec = tensorToVector(output);
    return vec.length > 0 ? vec : null;
  } catch (e) {
    visionReason = `图像 embedding 失败：${(e as Error).message}`.slice(0, 200);
    return null;
  }
}

/** 查询文本 → 同空间 CLIP 文本向量（视觉检索用）；不可用返回 null */
export async function embedQueryText(text: string): Promise<number[] | null> {
  if (visionBroken) return null;
  const extractor = await getExtractor();
  if (!extractor) return null;
  try {
    const output = await extractor(text, { pooling: 'mean', normalize: true });
    const vec = tensorToVector(output);
    return vec.length > 0 ? vec : null;
  } catch {
    return null;
  }
}

/**
 * 视觉描述（可选路径）：配置了方舟 visionModel 时对帧图生成中文 caption。
 * 未配置 / 请求失败返回 null，由调用方保留启发式描述。带 8s 超时保护扫描节奏。
 */
export async function describeImage(imagePath: string): Promise<string | null> {
  const cfg = loadLlmConfig();
  const visionModel = cfg.ark.visionModel?.trim();
  const apiKey = cfg.ark.apiKey?.trim() || process.env.ARK_API_KEY;
  if (!visionModel || !apiKey || !existsSync(imagePath)) return null;
  try {
    const base = (cfg.ark.baseUrl || '').replace(/\/chat\/completions\/?$/, '');
    if (!base) return null;
    const imageBase64 = readFileSync(imagePath).toString('base64');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    try {
      const res = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          model: visionModel,
          max_tokens: 120,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: '用一句不超过40字的中文描述这张画面的主体、场景与氛围，只输出描述本身。' },
                { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${imageBase64}` } },
              ],
            },
          ],
        }),
      });
      if (!res.ok) return null;
      const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
      const caption = json.choices?.[0]?.message?.content?.trim();
      return caption && caption.length <= 200 ? caption : null;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null;
  }
}
