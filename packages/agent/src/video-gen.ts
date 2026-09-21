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
 *   → 状态 succeeded 后从 task.content.url 下载结果视频到本地 workDir。
 *
 * 实测接口约定（2026-09，真实账号跑通）：
 * - 建任响应：顶层 task_id；
 * - 查询响应：状态与产物包在 task 对象里（{ task: { status, content: { url }, error } }），
 *   status 为小写 pending/running/succeeded/failed/cancelled；
 * - 模型档位：resolution 支持 768P / 2K（H3-Max 为 480P / 768P），duration 支持 4–15s。
 *
 * 当前只实现 MiniMax H3。接口与 AgentDeps.videoGen 预留了扩展位，未来可加即梦/可灵等 Provider，
 * 而无需改动流水线节点。
 *
 * 注意：MiniMax 国内（api.minimaxi.com）与海外（api.minimax.io）是两套独立账号体系，
 * Key 不通用；填错区域只会得到“invalid api key”，本 Provider 会自动换区重试一次。
 */

export type VideoGenRatio = '16:9' | '9:16' | '1:1';

/** 分辨率档位：官方 enum（MiniMax-H3 支持 768P/2K，H3-Max 支持 480P/768P） */
export type VideoGenResolution = '480P' | '768P' | '2K';

export interface VideoGenRequest {
  /** 文生视频提示词（也兼作图生视频/参考生视频的语义描述） */
  prompt: string;
  /** 期望时长（秒），Provider 负责夹取到模型允许区间（MiniMax H3 为 4–15s） */
  durationSec?: number;
  /** 画幅比（文生视频必需）；默认按工程画布推断 */
  ratio?: VideoGenRatio;
  /** 分辨率档位；不传则用 Provider 构造时的默认（2K） */
  resolution?: VideoGenResolution;
  /**
   * 主体一致性参考图（`data:image/<格式>;base64,<Base64>` 或公网 URL）。
   *
   * 逐段独立文生视频会“每段抽出不同主体”（用户反馈：三只不一样的猫），
   * 把上一段产物的一帧作为参考图传入是业界标准的跨段锁主体手段。
   * 不支持参考图的 Provider（如方舟 Seedance 纯文本任务）会直接忽略该字段。
   */
  referenceImage?: string;
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

/**
 * MiniMax 国内/海外接入点映射（两套账号体系独立，Key 不通用）。
 *
 * 实测：国内 Key 打 api.minimax.io 返回 401 / base_resp 2049 invalid api key，
 * 同一个 Key 打 api.minimaxi.com 鉴权直接通过 —— 用户很难从“invalid api key”猜到自己只是选错了域名。
 */
export function minimaxAlternateBase(base: string): string | null {
  const b = base.replace(/\/+$/, '');
  if (/api\.minimax\.io$/i.test(b)) return DEFAULT_MAINLAND_BASE;
  if (/api\.minimaxi\.com$/i.test(b)) return DEFAULT_GLOBAL_BASE;
  return null;
}

/** 从 v1（base_resp）/ v2（error 对象）两种错误体里认出“鉴权失败” */
function isMiniMaxAuthError(status: number, json: Record<string, unknown>): boolean {
  if (status === 401 || status === 403) return true;
  const base = json.base_resp as { status_code?: number; status_msg?: string } | undefined;
  const nested = json.error as { message?: string; type?: string } | undefined;
  const msg = `${base?.status_msg ?? ''} ${nested?.message ?? ''} ${nested?.type ?? ''}`;
  return base?.status_code === 2049 || /invalid api key|authenticat|authorized_error/i.test(msg);
}

/** 统一抽取服务端错误码/错误文本（兼容 base_resp 与 error 两种体） */
function miniMaxError(json: Record<string, unknown>): { code: string; message: string } {
  const base = json.base_resp as { status_code?: number; status_msg?: string } | undefined;
  const nested = json.error as { code?: string; message?: string; type?: string } | undefined;
  return {
    code: String(base?.status_code ?? nested?.code ?? nested?.type ?? ''),
    message: String(base?.status_msg ?? nested?.message ?? ''),
  };
}

export interface MiniMaxH3Options {
  apiKey: string;
  /** 不填则按 region 推断；global=api.minimax.io / mainland=api.minimaxi.com */
  baseUrl?: string;
  /** 模型 id，默认 minimax-h3 */
  model?: string;
  /**
   * 分辨率档位，默认 2K（保持旧行为）。
   * 官方按秒计费：2K = 0.80 元/秒、768P = 0.50 元/秒；工程画布只有 1080p 时，
   * 2K 产物导出必被下采样，验证阶段用 768P 可省 37.5%。
   */
  resolution?: VideoGenResolution;
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
  private baseUrl: string;
  private readonly model: string;
  private readonly resolution: VideoGenResolution;
  private readonly workDir: string;
  private readonly pollIntervalMs: number;
  private readonly pollTimeoutMs: number;
  private readonly logger?: (msg: string) => void;
  /** 区域切换只做一次，避免两个区域互相来回重试 */
  private triedAlternateRegion = false;

  constructor(opts: MiniMaxH3Options) {
    this.apiKey = opts.apiKey;
    this.baseUrl = normalizeBase(opts.baseUrl) ?? DEFAULT_GLOBAL_BASE;
    this.model = opts.model ?? 'minimax-h3';
    this.resolution = opts.resolution ?? '2K';
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
    // 档位以 Provider 配置为准（请求级 resolution 优先），单价按秒差 60%
    const resolution = req.resolution ?? this.resolution;
    const prompt = (req.prompt ?? '').trim();
    if (!prompt) throw new Error('[video-gen] 提示词为空');

    this.logger?.(
      `[video-gen] 创建任务：${prompt.slice(0, 40)}… (${ratio}, ${duration}s, ${resolution}${req.referenceImage ? ', +参考图锁主体' : ''})`,
    );
    const taskId = await this.createTask({ prompt, ratio, duration, resolution, referenceImage: req.referenceImage });
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

  private async createTask(args: {
    prompt: string;
    ratio: VideoGenRatio;
    duration: number;
    resolution: VideoGenResolution;
    referenceImage?: string;
  }): Promise<string> {
    const content: Array<Record<string, unknown>> = [{ type: 'text', text: args.prompt }];
    // 参考图走 reference_image（锁主体不锁构图）；官方规定它与 first_frame/last_frame 不可混用，
    // 我们从不发 first_frame，所以不冲突
    if (args.referenceImage) {
      content.push({ type: 'image_url', image_url: { url: args.referenceImage }, role: 'reference_image' });
    }
    const body = {
      model: this.model,
      content,
      ratio: args.ratio,
      duration: args.duration,
      resolution: args.resolution,
    };
    let { status, json } = await this.postCreate(body);

    // 国内 Key 打海外域名（或反之）只会给“invalid api key”，用户从文案里看不出是区域错：
    // 这里自动换另一个区域重试一次，并把实际使用的接入点记到日志
    if (isMiniMaxAuthError(status, json) && !this.triedAlternateRegion) {
      const alt = minimaxAlternateBase(this.baseUrl);
      if (alt) {
        this.triedAlternateRegion = true;
        this.logger?.(`[video-gen] ${this.baseUrl} 鉴权失败（MiniMax 国内/海外 Key 不通用），自动改用 ${alt} 重试`);
        this.baseUrl = alt;
        ({ status, json } = await this.postCreate(body));
      }
    }

    const serverErr = miniMaxError(json);
    const baseResp = json.base_resp as { status_code?: number } | undefined;
    if (status !== 200 || (baseResp?.status_code !== undefined && baseResp.status_code !== 0)) {
      throw toVideoGenError(status, serverErr.code, serverErr.message);
    }
    const taskId = (json.task_id ?? (json.task as { id?: string } | undefined)?.id ?? json.id) as string | undefined;
    if (!taskId) throw new Error('[video-gen] 创建任务未返回 task_id：' + JSON.stringify(json).slice(0, 200));
    return String(taskId);
  }

  /** POST 建任，返回状态码与解析后的 JSON（失败不抛，交给调用方判断是否换区域） */
  private async postCreate(body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
    const res = await fetch(`${this.baseUrl}/v2/video_generation`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    }).catch((e) => {
      throw new Error(`[video-gen] 请求失败：${(e as Error).message}`);
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { status: res.status, json };
  }

  private async pollUntilDone(taskId: string): Promise<string> {
    const deadline = Date.now() + this.pollTimeoutMs;
    let unknownShapeLogged = false;
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
      // v2 查询把字段包在 task 对象里（{ task: { status, content: { url }, error } }），
      // 早期按顶层 json.status 读永远拿到 undefined → 一直空转到超时
      const task = (json.task ?? json) as Record<string, unknown>;
      const status = String(task.status ?? '').toLowerCase();
      if (status === 'succeeded' || status === 'success') {
        const content = task.content as { url?: string; video_url?: string } | undefined;
        const url =
          content?.url ??
          content?.video_url ??
          (task.file_url as string | undefined) ??
          (task.video_url as string | undefined);
        if (!url) throw new Error('[video-gen] 任务成功但未返回下载链接（content.url）：' + JSON.stringify(task).slice(0, 200));
        return url;
      }
      if (status === 'failed' || status === 'expired' || status === 'cancelled') {
        const err = task.error as { code?: string; message?: string } | undefined;
        throw new Error(
          `[video-gen] 任务 ${status}：${err?.message ?? extractMsg(json) ?? ''}${err?.code ? `（${err.code}）` : ''}`,
        );
      }
      // 状态认不出来时把响应体前缀抖出来，否则只能看到一个没用的 undefined
      if (!status) {
        if (!unknownShapeLogged) {
          unknownShapeLogged = true;
          this.logger?.(`[video-gen] 未识别的任务响应（无 status）：${JSON.stringify(json).slice(0, 240)}`);
        }
        continue;
      }
      this.logger?.(`[video-gen] 任务状态=${task.status}`);
    }
    throw Object.assign(new Error(`[video-gen] 轮询超时（task_id=${taskId}，可能队列繁忙），可到 MiniMax 控制台查看该任务后重试`), {
      stopOnFailure: true,
    } as VideoGenError);
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

/** 带 configError 标记的错误：属于“配置不对”，重试/换场景都不会好，应直接告知用户 */
export interface VideoGenError extends Error {
  configError?: boolean;
  /** 轮询超时类失败：服务/网络整体不可用，后续场景再建任只会多等 N 倍时长、多刷 N 笔计费 */
  stopOnFailure?: boolean;
}

/**
 * 把服务端英文错误翻译成可行动的中文提示。
 *
 * 方舟视频接口最常见的两类错：模型 id 写错（InvalidEndpointOrModel.NotFound）与
 * 账号未开通该模型（ModelNotOpen），两者都会让生成“静默全失败”，必须标为配置错并给出下一步。
 */
export function toVideoGenError(status: number, code: string, raw: string): VideoGenError {
  const c = code.toLowerCase();
  const m = raw ?? '';
  let friendly = m || `HTTP ${status}`;
  let configError = false;
  if (c.includes('modelnotopen') || /has not activated|activate the model/i.test(m)) {
    const model = /model\s+(\S+)/i.exec(m)?.[1]?.replace(/[.,;]$/, '');
    friendly = `方舟账号未开通该视频模型${model ? `（${model}）` : ''}，请到 火山方舟控制台 →「模型广场 → 开通模型」开通后重试（视频模型按 Token 付费，开通通常要求账户余额+代金券达到下单预留金额门槛）`;
    configError = true;
  } else if (c.includes('notfound') || /does not exist or you do not have access/i.test(m)) {
    friendly =
      '模型 id 不存在或无访问权限：方舟视频模型 id 是小写带日期版本（如 doubao-seedance-2-5-260628），' +
      '可在设置中心「拉取可用模型」直接选择';
    configError = true;
  } else if (status === 401 || status === 403 || /authentication|invalid.?api.?key|permission|2049/i.test(c + m)) {
    friendly =
      'API Key 无效或没有该模型的访问权限（MiniMax 国内 minimaxi.com 与海外 minimax.io 是两套独立账号体系，Key 不通用；' +
      '方舟则需确认 Key 属于当前接入点所在空域）';
    configError = true;
  } else if (status === 429 || /quota|rate.?limit|insufficient/i.test(c + m)) {
    friendly = '额度不足或触发限流，请检查方舟账户余额/限流后重试';
    configError = true;
  } else if (/duration|resolution|ratio|parameter/i.test(m)) {
    friendly = `请求参数不被模型接受：${m}`;
  }
  return Object.assign(new Error(`[video-gen] ${friendly}（HTTP ${status}${code ? ` ${code}` : ''}）`), {
    configError,
  }) as VideoGenError;
}

/**
 * 通用「任务型」文生视频 Provider（P-自定义）：建任务 → 轮询 → 下载，
 * 支持两种协议形态，覆盖主流厂商：
 * - 'seedance'：火山方舟视频生成（POST {base}/contents/generations/tasks → GET 同路径/{id}，
 *   status: running/succeeded/failed，content.video_url）；
 * - 'openai-video'：OpenAI Videos 任务协议及兼容网关（POST {base}/videos → GET {base}/videos/{id}，
 *   status: completed/failed，video_url | download_url）。
 * 其他形态厂商可继续扩展 variant 而不改流水线。
 */
export type TaskVideoVariant = 'seedance' | 'openai-video';

export interface TaskVideoOptions {
  apiKey: string;
  baseUrl: string;
  /** 模型 id 以用户控制台为准（不猜测内置默认） */
  model: string;
  variant: TaskVideoVariant;
  workDir: string;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
  logger?: (msg: string) => void;
}

export class HttpTaskVideoProvider implements VideoGenProvider {
  readonly id: string;
  readonly label: string;
  private readonly opts: TaskVideoOptions;
  private readonly baseUrl: string;

  constructor(opts: TaskVideoOptions) {
    this.opts = opts;
    this.baseUrl = normalizeBase(opts.baseUrl) ?? '';
    this.id = `task-${opts.variant}`;
    this.label = `${opts.variant === 'seedance' ? 'Seedance（方舟视频）' : '自定义视频'}（${opts.model || '未填模型'}）`;
  }

  isConfigured(): boolean {
    return this.opts.apiKey.length > 0 && this.baseUrl.length > 0 && this.opts.model.length > 0;
  }

  private headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.opts.apiKey}`, 'Content-Type': 'application/json' };
  }

  async generate(req: VideoGenRequest): Promise<VideoGenResult> {
    if (!this.isConfigured()) throw new Error(`[video-gen] ${this.label} 未配置完整（apiKey/baseUrl/model）`);
    mkdirSync(this.opts.workDir, { recursive: true });
    const ratio = req.ratio ?? '16:9';
    // 方舟 Seedance 只接受固定时长档位，分镜常是 2s 短镜头，直接发 2 会被服务端拒掉
    const duration =
      this.opts.variant === 'seedance'
        ? pickSeedanceDuration(req.durationSec)
        : Math.min(15, Math.max(2, Math.round(req.durationSec ?? 5) || 5));
    const prompt = (req.prompt ?? '').trim();
    if (!prompt) throw new Error('[video-gen] 提示词为空');

    const createBody =
      this.opts.variant === 'seedance'
        ? { model: this.opts.model, content: [{ type: 'text', text: prompt }], ratio, duration }
        : { model: this.opts.model, prompt, seconds: String(duration), size: ratio === '9:16' ? '720x1280' : ratio === '1:1' ? '720x720' : '1280x720' };
    const createUrl = this.opts.variant === 'seedance' ? `${this.baseUrl}/contents/generations/tasks` : `${this.baseUrl}/videos`;

    this.opts.logger?.(`[video-gen] ${this.label} 创建任务：${prompt.slice(0, 40)}…`);
    const created = await this.fetchJson(createUrl, { method: 'POST', headers: this.headers(), body: JSON.stringify(createBody) });
    const taskId = String(created.id ?? created.task_id ?? '');
    if (!taskId) throw new Error(`[video-gen] 创建任务未返回 id：${JSON.stringify(created).slice(0, 200)}`);

    const statusUrl =
      this.opts.variant === 'seedance'
        ? `${this.baseUrl}/contents/generations/tasks/${taskId}`
        : `${this.baseUrl}/videos/${taskId}`;
    const deadline = Date.now() + (this.opts.pollTimeoutMs ?? 10 * 60_000);
    let videoUrl = '';
    while (Date.now() < deadline) {
      await sleep(this.opts.pollIntervalMs ?? 10_000);
      const st = await this.fetchJson(statusUrl, { method: 'GET', headers: this.headers() });
      const status = String(st.status ?? '').toLowerCase();
      if (status === 'succeeded' || status === 'completed') {
        const content = st.content as { video_url?: string } | undefined;
        videoUrl = String(content?.video_url ?? st.video_url ?? st.download_url ?? '');
        if (!videoUrl) throw new Error('[video-gen] 任务成功但未返回视频地址');
        break;
      }
      if (status === 'failed' || status === 'cancelled' || status === 'expired') {
        throw new Error(`[video-gen] 任务 ${status}：${extractMsg(st) ?? ''}`);
      }
      this.opts.logger?.(`[video-gen] ${this.label} 状态=${st.status ?? '-'}`);
    }
    if (!videoUrl) {
      throw Object.assign(new Error('[video-gen] 轮询超时（队列繁忙或网络不通）'), { stopOnFailure: true } as VideoGenError);
    }

    const res = await fetch(videoUrl);
    if (!res.ok) throw new Error(`[video-gen] 下载结果失败 ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const ext = inferExt(videoUrl, res.headers.get('content-type')) || 'mp4';
    const safeId = taskId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24);
    const outPath = path.join(this.opts.workDir, `gen-${this.opts.variant}-${safeId}.${ext}`);
    writeFileSync(outPath, buf);
    this.opts.logger?.(`[video-gen] ${this.label} 已下载 ${outPath}（${(buf.length / 1024).toFixed(0)}KB）`);
    const { width, height } = ratioToSize(ratio);
    return { videoPath: outPath, durationMs: duration * 1000, width, height, ext };
  }

  private async fetchJson(url: string, init: RequestInit): Promise<Record<string, unknown>> {
    const res = await fetch(url, init).catch((e) => {
      throw new Error(`[video-gen] 请求失败：${(e as Error).message}`);
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const err = json.error as { code?: string; message?: string } | undefined;
      throw toVideoGenError(res.status, String(err?.code ?? json.code ?? ''), String(err?.message ?? json.message ?? ''));
    }
    return json;
  }
}

/** Seedance 任务接口接受的时长档位（秒） */
const SEEDANCE_DURATIONS = [3, 5, 10, 12];

/** 取不小于请求时长的最小档位（超出最大档取最大），避免短镜头被服务端拒接 */
function pickSeedanceDuration(sec?: number): number {
  const s = Math.round(sec ?? 5) || 5;
  return SEEDANCE_DURATIONS.find((d) => d >= s) ?? SEEDANCE_DURATIONS[SEEDANCE_DURATIONS.length - 1] ?? 5;
}

/** 看起来是视频生成模型的 id（方舟/OpenAI 兼容列表里筛视频类） */
const VIDEO_MODEL_HINT = /(seedance|video|i2v|t2v|v2v|hailuo|minimax.*(video|hailuo)|cogvideo|kling|wan-?\d|veo|sora|pixverse|runway)/i;

/**
 * 拉取接入点可用的模型 id 列表（GET {base}/models）。
 *
 * 方舟模型 id 是小写带日期版本（如 doubao-seedance-2-5-260628），手填几乎必错，
 * 设置页靠这个接口直接选。videoOnly=false 时返回全量 id（供自定义 Provider 排查）。
 */
export async function listRemoteModelIds(opts: {
  baseUrl: string;
  apiKey?: string;
  videoOnly?: boolean;
}): Promise<string[]> {
  const base = normalizeBase(opts.baseUrl);
  if (!base) throw new Error('[video-gen] 接入点为空，无法拉取模型列表');
  const res = await fetch(`${base}/models`, {
    method: 'GET',
    headers: opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : undefined,
  }).catch((e) => {
    throw new Error(`[video-gen] 拉取模型列表失败：${(e as Error).message}`);
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const err = json.error as { code?: string; message?: string } | undefined;
    throw toVideoGenError(res.status, String(err?.code ?? json.code ?? ''), String(err?.message ?? json.message ?? ''));
  }
  const root = (json.data ?? json.models ?? json.body ?? json) as unknown;
  const items = Array.isArray(root) ? root : [];
  const ids = items
    .map((item) => {
      const o = item as Record<string, unknown>;
      return String(o.id ?? o.model ?? o.name ?? '');
    })
    .filter(Boolean);
  return opts.videoOnly === false ? ids : ids.filter((id) => VIDEO_MODEL_HINT.test(id));
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
