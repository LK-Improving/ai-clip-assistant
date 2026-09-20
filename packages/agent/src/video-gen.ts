import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * 视频生成 Provider（阶段五补充，2026-09-15）。
 *
 * 与 LlmProvider / AgentTtsProvider 同一套依赖注入范式：
 * - 离线 Provider（OfflineVideoGenProvider）isConfigured() 返回 false，流水线节点会跳过生成、
 *   保证无网络/无密钥时仍能端到端跑通（与 TTS 降级策略一致）；
 * - 真实 Provider（MiniMaxH3VideoProvider）走 MiniMax H3（Hailuo 3.0）v2 API：
 *   POST /v2/video_generation 建任务 → 轮询 GET /v2/query/video_generation/{task_id}
 *   → 状态 Success 后下载结果视频到本地 workDir。
 *
 * 当前只实现 MiniMax H3。接口与 AgentDeps.videoGen 预留了扩展位，未来可加即梦/可灵等 Provider，
 * 而无需改动流水线节点。
 */

export type VideoGenRatio = '16:9' | '9:16' | '1:1';

export interface VideoGenRequest {
  /** 文生视频提示词（也兼作图生视频/参考生视频的语义描述） */
  prompt: string;
  /** 期望时长（秒），Provider 负责夹取到模型允许区间（MiniMax H3 为 4–15s） */
  durationSec?: number;
  /** 画幅比（文生视频必需）；默认按工程画布推断 */
  ratio?: VideoGenRatio;
  /** 分辨率档位，MiniMax H3 仅接受 "2K" */
  resolution?: '768P' | '2K';
}

export interface VideoGenResult {
  /** 下载到本地的视频绝对路径（会被登记进 miaoma:// 白名单，渲染/预览可直接访问） */
  videoPath: string;
  /** 估算时长（毫秒） */
  durationMs: number;
  width: number;
  height: number;
  /** 文件扩展名，例如 "mp4" */
  ext: string;
}

export interface VideoGenProvider {
  readonly id: string;
  readonly label: string;
  /** 配置是否齐全（缺密钥时上层跳过生成，而非中断整条链路） */
  isConfigured(): boolean;
  /** 生成一段视频并返回本地路径 */
  generate(req: VideoGenRequest): Promise<VideoGenResult>;
}

/** 离线 Provider：未配置，节点会跳过；generate 不应被调用（调用即报错，便于定位误用） */
export class OfflineVideoGenProvider implements VideoGenProvider {
  readonly id = 'offline';
  readonly label = '离线（不生成视频）';

  isConfigured(): boolean {
    return false;
  }

  async generate(_req: VideoGenRequest): Promise<VideoGenResult> {
    throw new Error('[video-gen] 离线 Provider 未配置，无法生成视频');
  }
}

const DEFAULT_GLOBAL_BASE = 'https://api.minimax.io';
const DEFAULT_MAINLAND_BASE = 'https://api.minimaxi.com';

function ratioToSize(ratio: VideoGenRatio): { width: number; height: number } {
  switch (ratio) {
    case '9:16':
      return { width: 1080, height: 1920 };
    case '1:1':
      return { width: 1080, height: 1080 };
    case '16:9':
    default:
      return { width: 1920, height: 1080 };
  }
}

function clampDurationSec(sec?: number): number {
  const s = Math.round((sec ?? 5) || 5);
  return Math.min(15, Math.max(4, s));
}

export interface MiniMaxH3Options {
  apiKey: string;
  /** 不填则按 region 推断；global=api.minimax.io / mainland=api.minimaxi.com */
  baseUrl?: string;
  /** 模型 id，默认 minimax-h3 */
  model?: string;
  /** 结果视频下载目录（绝对路径） */
  workDir: string;
  /** 轮询相关：轮询间隔(ms) 与 总超时(ms) */
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
  logger?: (msg: string) => void;
}

/**
 * MiniMax H3（Hailuo 3.0）文生视频 Provider。
 *
 * 端点与字段（已对照 MiniMax 官方 v2 文档核实，2026-09）：
 * - 创建：POST {base}/v2/video_generation
 *      body: { model, content:[{type:"text",text}], ratio, duration, resolution:"2K" }
 *      返回：{ base_resp:{status_code,status_msg}, task_id }
 * - 查询：GET {base}/v2/query/video_generation/{task_id}（Header 带 Authorization: Bearer）
 *      轮询返回：{ status:"Queueing"|"Processing"|"Success"|"Failed"|"Expired", file_url }
 * - 说明：v2 接口不接受 v1 的 seed/watermark/with_audio 等参数（会 400），故这里只发必填字段。
 */
export class MiniMaxH3VideoProvider implements VideoGenProvider {
  readonly id = 'minimax-h3';
  readonly label: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly workDir: string;
  private readonly pollIntervalMs: number;
  private readonly pollTimeoutMs: number;
  private readonly logger?: (msg: string) => void;

  constructor(opts: MiniMaxH3Options) {
    this.apiKey = opts.apiKey;
    this.baseUrl = normalizeBase(opts.baseUrl) ?? DEFAULT_GLOBAL_BASE;
    this.model = opts.model ?? 'minimax-h3';
    this.workDir = opts.workDir;
    this.pollIntervalMs = opts.pollIntervalMs ?? 10_000;
    this.pollTimeoutMs = opts.pollTimeoutMs ?? 10 * 60_000;
    this.logger = opts.logger;
    this.label = `MiniMax H3（${this.model}）`;
  }

  isConfigured(): boolean {
    return this.apiKey.length > 0;
  }

  async generate(req: VideoGenRequest): Promise<VideoGenResult> {
    if (!this.isConfigured()) throw new Error('[video-gen] MiniMax H3 未配置 apiKey');
    mkdirSync(this.workDir, { recursive: true });

    const ratio: VideoGenRatio = req.ratio ?? '16:9';
    const duration = clampDurationSec(req.durationSec);
    const prompt = (req.prompt ?? '').trim();
    if (!prompt) throw new Error('[video-gen] 提示词为空');

    this.logger?.(`[video-gen] 创建任务：${prompt.slice(0, 40)}… (${ratio}, ${duration}s)`);
    const taskId = await this.createTask({ prompt, ratio, duration });
    this.logger?.(`[video-gen] task_id=${taskId}`);

    const fileUrl = await this.pollUntilDone(taskId);
    const localPath = await this.download(fileUrl, taskId);

    const { width, height } = ratioToSize(ratio);
    return {
      videoPath: localPath,
      durationMs: duration * 1000,
      width,
      height,
      ext: path.extname(localPath).replace(/^\./, '') || 'mp4',
    };
  }

  private async createTask(args: { prompt: string; ratio: VideoGenRatio; duration: number }): Promise<string> {
    const body = {
      model: this.model,
      content: [{ type: 'text', text: args.prompt }],
      ratio: args.ratio,
      duration: args.duration,
      resolution: '2K' as const,
    };
    const res = await fetch(`${this.baseUrl}/v2/video_generation`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const msg = extractMsg(json) || `${res.status}`;
      throw new Error(`[video-gen] 创建任务失败 ${msg}`);
    }
    const baseResp = json.base_resp as { status_code?: number; status_msg?: string } | undefined;
    if (baseResp && baseResp.status_code !== undefined && baseResp.status_code !== 0) {
      throw new Error(`[video-gen] 创建任务被拒：${baseResp.status_msg ?? baseResp.status_code}`);
    }
    const taskId = json.task_id as string | undefined;
    if (!taskId) throw new Error('[video-gen] 创建任务未返回 task_id：' + JSON.stringify(json).slice(0, 200));
    return taskId;
  }

  private async pollUntilDone(taskId: string): Promise<string> {
    const deadline = Date.now() + this.pollTimeoutMs;
    while (Date.now() < deadline) {
      await sleep(this.pollIntervalMs);
      const res = await fetch(`${this.baseUrl}/v2/query/video_generation/${taskId}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${this.apiKey}` },
      });
      const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        const msg = extractMsg(json) || `${res.status}`;
        this.logger?.(`[video-gen] 查询失败 ${msg}，继续重试`);
        continue;
      }
      const status = String(json.status ?? '').toLowerCase();
      if (status === 'success') {
        const url = (json.file_url as string | undefined) ?? (json.video_url as string | undefined);
        if (!url) throw new Error('[video-gen] 任务成功但未返回文件地址');
        return url;
      }
      if (status === 'failed' || status === 'expired' || status === 'cancelled') {
        throw new Error(`[video-gen] 任务 ${status}：${extractMsg(json) || ''}`);
      }
      this.logger?.(`[video-gen] 任务状态=${json.status}`);
    }
    throw new Error('[video-gen] 轮询超时（可能队列繁忙，请稍后重试）');
  }

  private async download(fileUrl: string, taskId: string): Promise<string> {
    const res = await fetch(fileUrl);
    if (!res.ok || !res.body) throw new Error(`[video-gen] 下载结果视频失败 ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const ext = inferExt(fileUrl, res.headers.get('content-type')) || 'mp4';
    const safeId = taskId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24);
    const outPath = path.join(this.workDir, `gen-${safeId}.${ext}`);
    writeFileSync(outPath, buf);
    this.logger?.(`[video-gen] 已下载到 ${outPath} (${(buf.length / 1024).toFixed(0)} KB)`);
    return outPath;
  }
}

function normalizeBase(url?: string): string | undefined {
  if (!url) return undefined;
  let u = url.trim();
  if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
  return u.replace(/\/+$/, '');
}

function extractMsg(json: Record<string, unknown>): string | undefined {
  const baseResp = json.base_resp as { status_msg?: string } | undefined;
  if (baseResp?.status_msg) return baseResp.status_msg;
  if (typeof json.message === 'string') return json.message;
  if (typeof json.status_msg === 'string') return json.status_msg;
  return undefined;
}

function inferExt(url: string, contentType?: string | null): string | undefined {
  const fromUrl = url.split('?')[0]?.split('#')[0]?.match(/\.(mp4|mov|webm|mkv|avi|m4v)$/i);
  if (fromUrl) return fromUrl[1]?.toLowerCase();
  if (contentType) {
    const map: Record<string, string> = {
      'video/mp4': 'mp4',
      'video/quicktime': 'mov',
      'video/webm': 'webm',
      'video/x-matroska': 'mkv',
      'video/x-msvideo': 'avi',
    };
    return map[contentType.toLowerCase()];
  }
  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 供 desktop 侧在 region 选择里快速判断是否填了合法 base（导出便于设置页回显默认值） */
export const MINIMAX_BASE_URLS = {
  global: DEFAULT_GLOBAL_BASE,
  mainland: DEFAULT_MAINLAND_BASE,
};
