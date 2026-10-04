import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * 图像生成 Provider（P4a）：分镜关键帧（文生图）与关键帧编辑（图生图）。
 *
 * 与 video-gen 同一注入范式：离线 Provider isConfigured() 返回 false，
 * storyboard-image 节点据此跳过关键帧生成，整条链路仍可端到端跑通。
 *
 * 真实实现 QwenImageProvider 走阿里云百炼（DashScope）千问图像的**同步**接口：
 *   POST {base}/api/v1/services/aigc/multimodal-generation/generation
 *   body: { model, input:{ messages:[{ role:'user', content:[ {text} | {image},{text} ] }] },
 *           parameters:{ size, watermark:false, negative_prompt? } }
 *   resp: output.choices[0].message.content[].image = PNG URL（24h 有效）→ 下载到 workDir。
 *
 * 注意：图像编辑（edit）请求体形态按「千问-图像编辑」约定为 content 先 image 后 text，
 * 待填入真实 key 联调时如与实际接口有出入，只需调整 buildContent()。
 */

export type ImageGenMode = 'text2image' | 'edit';

export interface ImageGenRequest {
  mode: ImageGenMode;
  /** 文生图：画面描述；图生图：编辑指令 */
  prompt: string;
  /** edit 模式的底图（data URI 或公网 URL） */
  baseImage?: string;
  /** 输出分辨率「宽*高」；缺省 16:9 */
  size?: string;
  negativePrompt?: string;
}

export interface ImageGenResult {
  /** 下载到本地的图片绝对路径 */
  imagePath: string;
  width: number;
  height: number;
}

export interface ImageGenProvider {
  readonly id: string;
  readonly label: string;
  isConfigured(): boolean;
  generate(req: ImageGenRequest): Promise<ImageGenResult>;
}

/** 离线 Provider：未配置，节点跳过；generate 被调用即报错，便于定位误用 */
export class OfflineImageGenProvider implements ImageGenProvider {
  readonly id = 'offline';
  readonly label = '离线（不生成图像）';
  isConfigured(): boolean {
    return false;
  }
  async generate(_req: ImageGenRequest): Promise<ImageGenResult> {
    throw new Error('[image-gen] 离线 Provider 未配置，无法生成图像');
  }
}

const DEFAULT_BASE = 'https://dashscope.aliyuncs.com';

function normalizeBase(url?: string): string {
  if (!url) return DEFAULT_BASE;
  let u = url.trim();
  if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
  return u.replace(/\/+$/, '');
}

function parseSize(size: string | undefined): { width: number; height: number } {
  const m = /^(\d+)\D+(\d+)$/.exec(size ?? '');
  if (m) return { width: Number(m[1]), height: Number(m[2]) };
  return { width: 1664, height: 928 };
}

export interface QwenImageOptions {
  apiKey: string;
  /** DashScope 接入点根路径，默认 https://dashscope.aliyuncs.com */
  baseUrl?: string;
  /** 文生图模型，默认 qwen-image-3.0-pro */
  textModel?: string;
  /** 图像编辑模型，默认 qwen-image-edit-max */
  editModel?: string;
  /** 图片下载目录（绝对路径） */
  workDir: string;
  timeoutMs?: number;
  logger?: (msg: string) => void;
}

export class QwenImageProvider implements ImageGenProvider {
  readonly id = 'qwen-image';
  readonly label: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly textModel: string;
  private readonly editModel: string;
  private readonly workDir: string;
  private readonly timeoutMs: number;
  private readonly logger?: (msg: string) => void;

  constructor(opts: QwenImageOptions) {
    this.apiKey = opts.apiKey;
    this.baseUrl = normalizeBase(opts.baseUrl);
    this.textModel = opts.textModel || 'qwen-image-3.0-pro';
    this.editModel = opts.editModel || 'qwen-image-edit-max';
    this.workDir = opts.workDir;
    this.timeoutMs = opts.timeoutMs ?? 120_000;
    this.logger = opts.logger;
    this.label = `千问图像（${this.textModel}）`;
  }

  isConfigured(): boolean {
    return this.apiKey.length > 0;
  }

  private buildContent(req: ImageGenRequest): Array<Record<string, unknown>> {
    if (req.mode === 'edit' && req.baseImage) {
      // 图生图/编辑：先底图后指令（千问-图像编辑约定）
      return [{ image: req.baseImage }, { text: req.prompt }];
    }
    return [{ text: req.prompt }];
  }

  async generate(req: ImageGenRequest): Promise<ImageGenResult> {
    if (!this.isConfigured()) throw new Error('[image-gen] 千问图像未配置 API Key');
    const prompt = (req.prompt ?? '').trim();
    if (!prompt) throw new Error('[image-gen] 提示词为空');
    const model = req.mode === 'edit' ? this.editModel : this.textModel;
    const size = req.size ?? '1664*928';
    const body = {
      model,
      input: { messages: [{ role: 'user', content: this.buildContent(req) }] },
      parameters: {
        size,
        watermark: false,
        ...(req.negativePrompt ? { negative_prompt: req.negativePrompt } : {}),
      },
    };

    this.logger?.(`[image-gen] ${model} 生成图像：${prompt.slice(0, 40)}… (${size})`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let json: Record<string, unknown>;
    try {
      const res = await fetch(`${this.baseUrl}/api/v1/services/aigc/multimodal-generation/generation`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) throw toImageError(res.status, json);
    } finally {
      clearTimeout(timer);
    }

    // 业务错误也可能 200 返回体里带 code
    if (typeof json.code === 'string' && json.code) throw toImageError(200, json);

    const imageUrl = extractImageUrl(json);
    if (!imageUrl) throw new Error('[image-gen] 未返回图像 URL：' + JSON.stringify(json).slice(0, 200));

    mkdirSync(this.workDir, { recursive: true });
    const buf = await this.download(imageUrl);
    const outPath = path.join(this.workDir, `keyframe-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e4)}.png`);
    writeFileSync(outPath, buf);
    const { width, height } = parseSize(size);
    this.logger?.(`[image-gen] 已保存 ${outPath}（${(buf.length / 1024).toFixed(0)}KB）`);
    return { imagePath: outPath, width, height };
  }

  private async download(url: string): Promise<Buffer> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`[image-gen] 下载图像失败 ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }
}

/** 从同步响应里取第一张图的 URL */
function extractImageUrl(json: Record<string, unknown>): string | null {
  const output = json.output as { choices?: Array<{ message?: { content?: Array<Record<string, unknown>> } }> } | undefined;
  for (const choice of output?.choices ?? []) {
    for (const item of choice.message?.content ?? []) {
      const img = item.image;
      if (typeof img === 'string' && img) return img;
    }
  }
  return null;
}

/** 把 DashScope 错误体翻译成可行动的中文提示 */
function toImageError(status: number, json: Record<string, unknown>): Error {
  const code = String(json.code ?? '');
  const message = String(json.message ?? '');
  let friendly = message || `HTTP ${status}`;
  if (/invalid.?api.?key|authentication|Unauthorized/i.test(code + message)) {
    friendly = 'API Key 无效或未授权（DashScope 北京/新加坡为独立 Key 与域名，勿跨区）';
  } else if (/ModelNotFound|InvalidParameter.*model|not exist/i.test(code + message)) {
    friendly = `模型 id 不存在或无权限（${code || 'model'}）：请在百炼控制台确认已开通 qwen-image 系列`;
  } else if (/Throttling|quota|rate.?limit|insufficient/i.test(code + message)) {
    friendly = '额度不足或触发限流，请检查百炼账户余额/限流';
  }
  return new Error(`[image-gen] ${friendly}${code ? `（${code}）` : ''}`);
}
