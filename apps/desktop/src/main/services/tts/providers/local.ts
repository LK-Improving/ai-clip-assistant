import type { TtsProvider } from '../index';
import type { LocalTtsMode, TtsConfig } from '../config';

/**
 * 本地 Index-TTS 2（自托管服务）适配器：三种真实存在的服务形态 + 探活诊断。
 *
 * 契约见 `.agents/Documents/接口设计/TTS火山v3与本地克隆接入契约.md` §2。
 *
 * 事实边界（写清楚，免得面试/用户误判）：
 * - 应用**不内置模型权重**；Index-TTS 2 推理要 NVIDIA GPU，CPU 极慢不推荐；
 * - 因此本适配器只负责「接上已经跑起来的服务」，接不上时必须给出可行动的中文原因，
 *   并由上层降级到云端复刻 / 在线音色 / 离线静音，绝不阻断成片。
 */

export type DetectedLocalProtocol = 'gradio' | 'openai' | 'custom';

export interface LocalProbeResult {
  ok: boolean;
  /**
   * 连接层是否可达（只要 TCP/HTTP 能回话就算）。
   * 很多本地壳只实现克隆接口、不实现普通合成，探活时「/tts 404」不能当成“服务不可用”，
   * 否则零样本链会被误杀。路由只在连接层不可达时才跳过本地环。
   */
  reachable: boolean;
  latencyMs: number;
  /** 生效协议形态（mode=auto 时由探活结果定型） */
  protocol: DetectedLocalProtocol;
  /** 实际打到的地址（脱敏：不含凭证） */
  endpoint: string;
  capabilities: { plain: boolean; zeroShot: boolean };
  message: string;
  hints: string[];
}

interface ZeroShotPayload {
  text: string;
  speed: number;
  voiceName: string;
  referenceAudioBase64: string;
}

const PROBE_TTL_MS = 60_000;
const probeCache = new Map<string, { at: number; result: LocalProbeResult }>();

function trimBase(url: string): string {
  return url.replace(/\/+$/, '');
}

/** baseUrl 的站点根（Gradio 的 /gradio_api 挂在根路径下，而 OpenAI 兼容壳常带 /v1 前缀） */
function siteRoot(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return trimBase(url).replace(/^(https?:\/\/[^/]+).*$/, '$1');
  }
}

async function httpFetch(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function looksLikeAudio(buffer: Buffer, contentType: string): boolean {
  if (/audio|mpeg|mp3|wav|x-wav/.test(contentType)) return true;
  if (buffer.length < 12) return false;
  const head = buffer.subarray(0, 4).toString('ascii');
  return head === 'RIFF' || head === 'fLaT' || head === 'OggS' || buffer[0] === 0xff || buffer.readUInt16BE(0) === 0x4944;
}

/** 部分壳服务把音频塞在 JSON 的 base64 字段里，这里一并接住 */
function maybeDecodeJsonAudio(buffer: Buffer): { data: Buffer; ext: string } | null {
  if (buffer.length < 2 || buffer[0] !== 0x7b) return null; // 不以 '{' 开头直接跳过
  try {
    const parsed = JSON.parse(buffer.toString('utf8')) as Record<string, unknown>;
    for (const key of ['audio', 'data', 'audio_base64', 'b64_audio']) {
      const value = parsed[key];
      if (typeof value === 'string' && value.length > 128) {
        const ext = String(parsed.format ?? parsed.response_format ?? 'mp3');
        return { data: Buffer.from(value, 'base64'), ext: ext === 'wav' ? 'wav' : 'mp3' };
      }
    }
  } catch {
    /* 不是 JSON，交回上层按音频处理 */
  }
  return null;
}

async function readAudio(response: Response): Promise<{ data: Buffer; ext: string }> {
  const contentType = response.headers.get('content-type') ?? '';
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length === 0) throw new Error('服务返回空音频');
  const decoded = maybeDecodeJsonAudio(buffer);
  if (decoded) return decoded;
  if (!looksLikeAudio(buffer, contentType)) {
    throw new Error(`服务返回的不是音频（content-type=${contentType || '未知'}，前 64 字节：${buffer.subarray(0, 64).toString('utf8').replace(/\s+/g, ' ')}`);
  }
  const ext = /wav|_x-wav/.test(contentType) || buffer.subarray(0, 4).toString('ascii') === 'RIFF' ? 'wav' : 'mp3';
  return { data: buffer, ext };
}

/** undici 的 fetch 失败只报「fetch failed」，真正原因（ECONNREFUSED 等）在 cause 里，必须挖出来才能给对诊断 */
function flattenError(error: unknown): string {
  const parts: string[] = [];
  let cursor: unknown = error;
  for (let depth = 0; depth < 4 && cursor; depth += 1) {
    const e = cursor as { message?: string; code?: string; errno?: string; cause?: unknown };
    if (e.message) parts.push(e.message);
    if (e.code) parts.push(String(e.code));
    cursor = e.cause;
  }
  return parts.join('｜');
}

function errHint(error: unknown): { message: string; hints: string[] } {
  const msg = flattenError(error);
  const hints: string[] = [];
  if (/aborted/.test(msg)) hints.push('请求超时：CPU 推理 Index-TTS 2 会慢到不可用，建议改云端复刻（火山 S_ 音色）或调高超时');
  if (/ECONNREFUSED|connection refused|连接被拒/i.test(msg)) {
    hints.push('连接被拒：本地服务没起来，或端口写错（官方 WebUI 默认 7860，自建 HTTP 壳看启动日志）');
    hints.push('无 NVIDIA 显卡时 Index-TTS 2 基本起不来：这不是应用问题，可在设置中心把「克隆优先级」切成云端优先，或给音色绑定云端复刻 Speaker ID（S_xxxxx）');
  }
  // undici 对非法/不可用地址直接拒收（如 bad port），或统一包成 fetch failed：都算连不上
  if (/bad port|ERR_INVALID_ARG|fetch failed/i.test(msg) && !/ECONNREFUSED/i.test(msg)) {
    hints.push('无法与本地服务建立连接：检查 baseUrl 是否合法、服务是否在跑（无 NVIDIA 显卡时 Index-TTS 2 起不来，可改云端复刻）');
  }
  if (/certificate|self-signed|ERR_TLS|unable to verify/i.test(msg)) hints.push('HTTPS 证书校验失败：本地服务请用 http://');
  if (/ENOTFOUND|getaddrinfo|invalid url/i.test(msg)) hints.push('地址无法解析：检查 baseUrl 是否形如 http://127.0.0.1:7860');
  return { message: msg, hints };
}

// ===== 形态一：本项目内置壳（POST /tts、POST /tts/zero-shot） =====

async function callCustomPlain(config: TtsConfig, req: { text: string; voice: string; speed: number }) {
  const base = trimBase(config.local.baseUrl);
  const response = await httpFetch(
    `${base}/tts`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: req.text, voice: req.voice, speed: req.speed }),
    },
    config.local.timeoutMs,
  );
  if (!response.ok) throw new Error(`本地 Index-TTS 服务返回 ${response.status} ${response.statusText}`);
  return readAudio(response);
}

async function callCustomZeroShot(config: TtsConfig, payload: ZeroShotPayload) {
  const base = trimBase(config.local.baseUrl);
  const response = await httpFetch(
    `${base}/tts/zero-shot`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      text: payload.text,
      speed: payload.speed,
      voice_name: payload.voiceName,
      reference_audio_base64: payload.referenceAudioBase64,
    }) },
    config.local.timeoutMs,
  );
  if (!response.ok) throw new Error(`零样本音色服务返回 ${response.status} ${response.statusText}`);
  return readAudio(response);
}

// ===== 形态二：OpenAI 兼容壳（POST /audio/speech） =====

async function openaiEndpoint(config: TtsConfig): Promise<string> {
  const base = trimBase(config.local.baseUrl);
  const candidates = [`${base}/audio/speech`, `${base}/v1/audio/speech`];
  for (const url of candidates) {
    const probe = await httpFetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }, 8_000).catch(() => null);
    // 空文本被服务端以 4xx 拒绝，恰好证明该路径存在；404/无响应才继续试下一个
    if (probe && probe.status !== 404) return url;
  }
  return candidates[0]!;
}

async function callOpenai(
  config: TtsConfig,
  req: { text: string; voice: string; speed: number },
  extra?: { reference_audio_base64?: string; voice_name?: string },
) {
  const base = trimBase(config.local.baseUrl);
  const url = await openaiEndpoint(config);
  const response = await httpFetch(
    url,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'index-tts-2',
        input: req.text,
        voice: req.voice || 'default',
        speed: req.speed,
        response_format: 'mp3',
        ...extra,
      }),
    },
    config.local.timeoutMs,
  );
  if (!response.ok) throw new Error(`本地 TTS（OpenAI 兼容 ${url.replace(base, '{base')}）返回 ${response.status} ${response.statusText}`);
  return readAudio(response);
}

// ===== 形态三：官方 WebUI 的 Gradio REST（Index-TTS 2 默认发布形态） =====

interface GradioInfo {
  named_endpoints?: Record<string, unknown>;
  unnamed_endpoints?: Record<string, unknown>;
}

function normalizeApiName(name: string): string {
  return name.replace(/^\/+/, '');
}

async function fetchGradioInfo(config: TtsConfig): Promise<{ info: GradioInfo; root: string } | null> {
  const root = siteRoot(config.local.baseUrl);
  for (const url of [`${root}/gradio_api/info`, `${root}/api/info?include_test_data=true`]) {
    try {
      const response = await httpFetch(url, { method: 'GET' }, Math.min(10_000, config.local.timeoutMs));
      if (!response.ok) continue;
      const info = (await response.json()) as GradioInfo;
      if (info && typeof info === 'object' && (info.named_endpoints || info.unnamed_endpoints)) {
        return { info, root };
      }
    } catch {
      /* 换下一个形态 */
    }
  }
  return null;
}

function pickGradioApi(config: TtsConfig, info: GradioInfo): string | null {
  const named = Object.keys(info.named_endpoints ?? {});
  if (config.local.gradioApiName) {
    const wanted = normalizeApiName(config.local.gradioApiName);
    return named.find((n) => normalizeApiName(n) === wanted) ?? wanted;
  }
  const preferred = named.find((n) => /tts|synth|clone|generate/i.test(n));
  return preferred ? normalizeApiName(preferred) : null;
}

/** 从 Gradio 返回值里挖出文件（{path|url|name} 可能嵌在数组/对象多层里） */
function extractGradioFile(value: unknown): { path?: string; url?: string } | null {
  if (!value) return null;
  if (typeof value === 'string') return /\.(mp3|wav|ogg|flac)(\?|$)/i.test(value) ? { url: value } : null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = extractGradioFile(item);
      if (found) return found;
    }
    return null;
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const path = typeof obj.path === 'string' ? obj.path : undefined;
    const url = typeof obj.url === 'string' ? obj.url : undefined;
    const name = typeof obj.name === 'string' ? obj.name : undefined;
    if (path || url) return { path, url };
    if (name && /\.(mp3|wav|ogg|flac)$/i.test(name)) return { path: name };
    for (const nested of Object.values(obj)) {
      const found = extractGradioFile(nested);
      if (found) return found;
    }
  }
  return null;
}

async function uploadGradioFile(root: string, base64: string, fileName: string, timeoutMs: number): Promise<string> {
  const bytes = Buffer.from(base64, 'base64');
  const form = new FormData();
  form.append('files', new Blob([new Uint8Array(bytes)], { type: 'application/octet-stream' }), fileName);
  for (const url of [`${root}/gradio_api/upload`, `${root}/upload`, `${root}/api/upload`] as const) {
    try {
      const response = await httpFetch(url, { method: 'POST', body: form }, timeoutMs);
      if (!response.ok) continue;
      const parsed = (await response.json()) as unknown;
      const list = Array.isArray(parsed) ? parsed : [parsed];
      const first = list[0] as Record<string, unknown> | undefined;
      const path = first && typeof first === 'object' ? String(first.path ?? '') : '';
      if (path) return path;
    } catch {
      /* 换下一个上传端点 */
    }
  }
  throw new Error('Gradio 上传参考音频失败：服务端未暴露 /gradio_api/upload（官方 WebUI 需以 API 模式启动）');
}

async function callGradio(
  config: TtsConfig,
  req: { text: string; voice: string; speed: number },
  reference?: { base64: string; name: string },
): Promise<{ data: Buffer; ext: string }> {
  const found = await fetchGradioInfo(config);
  if (!found) throw new Error('目标地址不是 Gradio 服务（/gradio_api/info 无响应），请把协议模式改为「内置壳」或「OpenAI 兼容」');
  const { info, root } = found;
  const apiName = pickGradioApi(config, info);
  if (!apiName) throw new Error('Gradio 服务没有命名端点（官方 WebUI 需带 --enable_api 启动才能被应用调用）');

  const data: unknown[] = [req.text];
  if (reference) {
    const uploaded = await uploadGradioFile(root, reference.base64, `${reference.name || 'reference'}.wav`, config.local.timeoutMs);
    data.push({ path: uploaded, url: `${root}/gradio_api/file=${uploaded}`, size: null, orig_name: `${reference.name}.wav` });
  }
  data.push({ length: 10, speed: req.speed }); // 常见附加参数位；服务端忽略多余字段

  // Gradio 5：/gradio_api/call/{api} 拿 event_id，再读 SSE；Gradio 3/4 回退 /api/predict
  let value: unknown = null;
  try {
    const start = await httpFetch(
      `${root}/gradio_api/call/${apiName}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data }) },
      config.local.timeoutMs,
    );
    if (start.ok) {
      const { event_id: eventId } = (await start.json()) as { event_id?: string };
      if (!eventId) throw new Error('Gradio 未返回 event_id');
      const stream = await httpFetch(
        `${root}/gradio_api/call/${apiName}/${eventId}`,
        { method: 'GET', headers: { accept: 'text/event-stream' } },
        config.local.timeoutMs,
      );
      const text = await stream.text();
      for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const body = trimmed.slice(5).trim();
        if (!body || body.startsWith('process_completed')) continue;
        try {
          const parsed = JSON.parse(body) as Record<string, unknown>;
          if (parsed.value !== undefined) value = parsed.value;
        } catch {
          /* SSE 心跳/分帧片段，忽略 */
        }
      }
    }
  } catch (e) {
    const { message } = errHint(e);
    throw new Error(`Gradio 调用 /${apiName} 失败：${message}`);
  }

  if (value === null) {
    const legacy = await httpFetch(
      `${root}/api/predict`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data }) },
      config.local.timeoutMs,
    ).catch(() => null);
    if (!legacy || !legacy.ok) throw new Error(`Gradio 端点 /${apiName} 无有效返回：参数顺序与官方 WebUI 组件不一致时需要一个薄适配壳（见契约 §2）`);
    const parsed = (await legacy.json()) as Record<string, unknown>;
    value = parsed.data;
  }

  const file = extractGradioFile(value);
  if (!file) throw new Error(`Gradio 返回里没有音频文件引用（拿到：${JSON.stringify(value).slice(0, 160)}）`);
  // Gradio 常给根相对地址（/gradio_api/file=...）或绝对地址，两者都要能拉
  const raw = file.url ?? `${root}/gradio_api/file=${file.path}`;
  const url = /^https?:\/\//i.test(raw) ? raw : `${root}${raw.startsWith('/') ? '' : '/'}${raw}`;
  const audio = await httpFetch(url, { method: 'GET' }, config.local.timeoutMs);
  if (!audio.ok) throw new Error(`下载 Gradio 产物失败 ${audio.status}：${url.replace(root, '{root}')}`);
  return readAudio(audio);
}

// ===== 探活与协议定型 =====

async function detectProtocol(config: TtsConfig): Promise<{ protocol: DetectedLocalProtocol; endpoint: string; hints: string[]; ok: boolean; message: string }> {
  const base = trimBase(config.local.baseUrl);
  const root = siteRoot(config.local.baseUrl);
  const hints: string[] = [];

  if (config.local.mode === 'gradio') return { protocol: 'gradio', endpoint: `${root}/gradio_api`, hints, ok: true, message: '按配置走 Gradio' };
  if (config.local.mode === 'openai') return { protocol: 'openai', endpoint: `${base}/audio/speech`, hints, ok: true, message: '按配置走 OpenAI 兼容' };
  if (config.local.mode === 'custom') return { protocol: 'custom', endpoint: `${base}/tts`, hints, ok: true, message: '按配置走内置壳协议' };

  // auto：先看 Gradio 特征，再看 OpenAI 特征，最后退回内置壳
  const info = await fetchGradioInfo(config);
  if (info) {
    const api = pickGradioApi(config, info.info);
    if (api) {
      hints.push(`识别到 Gradio 服务，选用端点 /${api}`);
      if (!api) hints.push('未找到含 tts/synth/generate 的命名端点，可在设置中心手工指定');
      return { protocol: 'gradio', endpoint: `${root}/gradio_api/call/${api}`, hints, ok: true, message: '自动识别为 Gradio（官方 WebUI）' };
    }
    hints.push('识别到 Gradio 但无命名端点：官方 WebUI 需以 --enable_api 启动');
  }
  for (const url of [`${base}/models`, `${base}/v1/models`, `${siteRoot(base)}/v1/models`]) {
    try {
      const response = await httpFetch(url, { method: 'GET' }, 8_000);
      if (response.ok) {
        hints.push(`识别到 OpenAI 兼容服务（${url.replace(siteRoot(base), '{root}')}）`);
        return { protocol: 'openai', endpoint: url.replace('/models', '/audio/speech'), hints, ok: true, message: '自动识别为 OpenAI 兼容壳' };
      }
    } catch {
      /* 继续试下一个 */
    }
  }
  hints.push('未识别到 Gradio / OpenAI 特征，按内置壳协议（POST /tts、POST /tts/zero-shot）尝试');
  return { protocol: 'custom', endpoint: `${base}/tts`, hints, ok: false, message: '未命中已知协议特征：只能按内置壳协议试跑' };
}

/**
 * 连接层失败（服务根本没起 / 地址不可用）与协议层失败（服务在、接口不对）的区分。
 * 协议层失败在 fetch 里表现为 HTTP 状态码，不会抛出 fetch failed，因此抛错一律算连接层。
 */
function isConnectionLevelFailure(message: string): boolean {
  return /ECONNREFUSED|ECONNRESET|ENOTFOUND|EHOSTUNREACH|ETIMEDOUT|bad port|fetch failed|连接被拒|超时|aborted/i.test(message);
}

/** 探活（带 TTL 缓存）：设置页「连通性检测」与零样本路由共用同一份结论 */
export async function probeLocal(config: TtsConfig, force = false): Promise<LocalProbeResult> {
  const key = `${config.local.baseUrl}|${config.local.mode}|${config.local.gradioApiName}`;
  const cached = probeCache.get(key);
  if (!force && cached && Date.now() - cached.at < PROBE_TTL_MS) return cached.result;

  const started = Date.now();
  const detected = await detectProtocol(config);
  const hints = [...detected.hints];
  let ok = detected.ok;
  let reachable = true;
  let message = detected.message;
  const capabilities = { plain: false, zeroShot: false };

  if (detected.protocol === 'custom') {
    // 内置壳没有标准探活路径：用 1 字符合成做一次真实往返（失败原因即诊断信息）
    try {
      const result = await callCustomPlain(config, { text: '一', voice: config.local.voice, speed: 1 });
      capabilities.plain = true;
      capabilities.zeroShot = true; // 同一服务通常同时提供 /tts/zero-shot
      ok = true;
      message = `内置壳协议可用（试合成 ${result.data.length} 字节）`;
    } catch (e) {
      const wrapped = errHint(e);
      ok = false;
      message = wrapped.message;
      reachable = !isConnectionLevelFailure(wrapped.message);
      hints.push(...wrapped.hints);
      if (reachable) {
        hints.push('服务在跑但普通合成接口不通（可能只实现了克隆接口），零样本链仍会尝试真实调用');
      }
    }
  } else {
    capabilities.plain = true;
    capabilities.zeroShot = detected.protocol === 'gradio';
    ok = true;
  }

  const result: LocalProbeResult = {
    ok,
    reachable,
    latencyMs: Date.now() - started,
    protocol: detected.protocol,
    endpoint: detected.endpoint,
    capabilities,
    message,
    hints,
  };
  if (result.latencyMs > 8_000) {
    result.hints.push('探活耗时偏长：CPU 跑 Index-TTS 2 会慢到不可用，建议「克隆优先级」选云端优先');
  }
  probeCache.set(key, { at: Date.now(), result });
  return result;
}

export function resetLocalProbeCache(): void {
  probeCache.clear();
}

export const localProvider: TtsProvider = {
  id: 'local',
  label: '本地 Index-TTS 2（自托管服务）',

  isConfigured(config: TtsConfig) {
    return Boolean(config.local.baseUrl);
  },

  async synthesize(req, config) {
    const { protocol } = await detectProtocol(config);
    try {
      if (protocol === 'gradio') return await callGradio(config, req);
      if (protocol === 'openai') return await callOpenai(config, req);
      return await callCustomPlain(config, req);
    } catch (e) {
      const { message, hints } = errHint(e);
      throw new Error(`无法连接本地 Index-TTS 2：${message}${hints.length ? `（${hints[0]}）` : ''}`);
    }
  },
};

/**
 * 零样本音色克隆合成（本地链）：参考音频驱动，无需训练。
 * 失败抛错由上层降级链接住（云端复刻 → 在线常规 → 离线静音）。
 */
export async function zeroShotSynthesize(
  config: TtsConfig,
  req: ZeroShotPayload,
): Promise<{ data: Buffer; ext: string }> {
  const probe = await probeLocal(config);
  try {
    if (probe.protocol === 'gradio') {
      return await callGradio(config, { text: req.text, voice: req.voiceName, speed: req.speed }, {
        base64: req.referenceAudioBase64,
        name: req.voiceName || 'reference',
      });
    }
    if (probe.protocol === 'openai') {
      return await callOpenai(config, { text: req.text, voice: req.voiceName, speed: req.speed }, {
        reference_audio_base64: req.referenceAudioBase64,
        voice_name: req.voiceName,
      });
    }
    return await callCustomZeroShot(config, req);
  } catch (e) {
    const { message, hints } = errHint(e);
    throw new Error(`本地零样本克隆失败：${message}${hints.length ? `（${hints[0]}）` : ''}`);
  }
}

/** 本地服务是否支持零样本链（路由决策用；不触发网络时按配置形态保守判断） */
export function localModeSupportsZeroShot(mode: LocalTtsMode): boolean {
  return mode !== 'openai';
}
