import { randomUUID } from 'node:crypto';
import type { TtsProvider } from '../index';
import type { TtsConfig } from '../config';
import {
  VOLCANO_WS_ENDPOINT,
  VolcanoEvent,
  decodeFrame,
  describeVolcanoError,
  encodeFinishConnection,
  encodeFinishSession,
  encodeStartConnection,
  encodeStartSession,
  encodeTaskRequest,
  extractFrameError,
  isClonedSpeaker,
  resolveResourceId,
  VOLCANO_DONE_CODE,
} from './volcano-protocol';

/**
 * 火山引擎（豆包语音）大模型 TTS：v3 WebSocket **双向流式**二进制分帧协议。
 *
 * 时序：StartConnection →(50) StartSession →(150) TaskRequest(text) → FinishSession
 * → 收 352 音频分片 →(152) 完成；153/51 立即失败。协议细节见
 * `.agents/Documents/接口设计/TTS火山v3与本地克隆接入契约.md` §1。
 *
 * 鉴权要握手头，故优先走支持 `{ headers }` 扩展的实现（undici / ws），
 * 环境不支持时降级为无自定义头连接并在错误信息里说清楚原因。
 */

/** 主进程实际依赖的 WebSocket 最小面（供冒烟注入假服务端时复用同一类型） */
export interface WebSocketLike {
  binaryType: string;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: unknown) => void) | null;
  send(data: string | ArrayBufferView | ArrayBuffer): void;
  close(): void;
}

/** 建连工厂：headers 为 v3 鉴权握手头，测试可据此断言 resource 路由 */
export type VolcanoWsFactory = (url: string, headers: Record<string, string>) => WebSocketLike;

type WebSocketCtor = new (
  url: string,
  init?: string | string[] | { headers?: Record<string, string> },
) => WebSocketLike;

export interface VolcanoRunOptions {
  /** 覆盖默认 speaker（云端复刻音色传 S_xxxxx） */
  speaker?: string;
  /** 只做握手探活：收到 CONNECTION_STARTED 即成功返回，不产生合成费用 */
  handshakeOnly?: boolean;
  signal?: AbortSignal;
}

export interface VolcanoRunResult {
  data: Buffer;
  ext: string;
  resourceId: string;
  speaker: string;
  /** 握手头是否真的送达（false = 当前环境不支持自定义头，鉴权多半会失败） */
  headersApplied: boolean;
}

/** 冒烟/测试注入点：用可控的「服务端」替换真实建连，避免联网与凭证依赖 */
let injectedFactory: VolcanoWsFactory | null = null;

export function setVolcanoWebSocketFactory(factory: VolcanoWsFactory | null): void {
  injectedFactory = factory;
}

function openSocket(url: string, headers: Record<string, string>): { ws: WebSocketLike; headersApplied: boolean } {
  if (injectedFactory) return { ws: injectedFactory(url, headers), headersApplied: true };
  const Ctor = (globalThis as { WebSocket?: WebSocketCtor }).WebSocket;
  if (!Ctor) throw new Error('当前运行环境没有全局 WebSocket，无法使用火山引擎 TTS（v3 需要 WebSocket 流式通道）');
  try {
    // undici 扩展：第二参对象可携带握手头
    return { ws: new Ctor(url, { headers }), headersApplied: true };
  } catch {
    // 退回 WHATWG 标准形态（无自定义头）
    return { ws: new Ctor(url), headersApplied: false };
  }
}

/** 用户主动取消：单独成类型，上层据此「不记失败、不写降级日志」 */
export class TtsAbortError extends Error {
  override readonly name = 'AbortError';
  constructor() {
    super('语音合成已取消');
  }
}

function speechRateOf(speed: number): number | undefined {
  if (!Number.isFinite(speed) || speed === 1) return undefined;
  return Math.max(-50, Math.min(100, Math.round((speed - 1) * 100)));
}

export function volcanoAuthHeaders(config: TtsConfig): Record<string, string> {
  const connectId = randomUUID();
  return {
    'X-Api-App-Key': config.volcano.appId,
    'X-Api-Access-Key': config.volcano.accessToken,
    'X-Api-Connect-Id': connectId,
  };
}

/** speaker + resource id 决定计费与效果版本，探活与正式合成共用同一推导 */
export function volcanoRoute(config: TtsConfig, speaker?: string): { speaker: string; resourceId: string } {
  const finalSpeaker = (speaker && speaker.trim()) || config.volcano.voice;
  return { speaker: finalSpeaker, resourceId: resolveResourceId(finalSpeaker, config.volcano.resourceId) };
}

/**
 * 跑一次完整会话。握手探活（handshakeOnly）与正式合成共用同一状态机，
 * 保证「设置页显示可用」与「真的能合成」不会说两套话。
 */
export function runVolcanoSession(
  config: TtsConfig,
  req: { text: string; speed: number },
  opts: VolcanoRunOptions = {},
): Promise<VolcanoRunResult> {
  const { speaker, resourceId } = volcanoRoute(config, opts.speaker);
  const cloned = isClonedSpeaker(speaker);

  return new Promise<VolcanoRunResult>((resolve, reject) => {
    let settled = false;
    let headersApplied = true;
    const chunks: Buffer[] = [];
    const sessionId = randomUUID();
    const headers: Record<string, string> = { ...volcanoAuthHeaders(config), 'X-Api-Resource-Id': resourceId };

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        ws.close();
      } catch {
        /* 已断开 */
      }
      reject(error);
    };
    const done = () => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        ws.send(encodeFinishConnection());
      } catch {
        /* 忽略：结果已定 */
      }
      try {
        ws.close();
      } catch {
        /* 已断开 */
      }
      resolve({ data: Buffer.concat(chunks), ext: config.volcano.format, resourceId, speaker, headersApplied });
    };

    let ws: WebSocketLike;
    try {
      const opened = openSocket(VOLCANO_WS_ENDPOINT, headers);
      ws = opened.ws;
      headersApplied = opened.headersApplied;
    } catch (e) {
      reject(e as Error);
      return;
    }

    const timer = setTimeout(() => {
      fail(new Error(`火山引擎 TTS 合成超时（${Math.round(config.volcano.timeoutMs / 1000)}s），已关闭连接`));
    }, config.volcano.timeoutMs);

    const onAbort = () => fail(new TtsAbortError());
    if (opts.signal) {
      if (opts.signal.aborted) {
        fail(new TtsAbortError());
        return;
      }
      opts.signal.addEventListener('abort', onAbort, { once: true });
    }

    function cleanup(): void {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
    }

    ws.binaryType = 'arraybuffer';
    ws.onopen = () => {
      try {
        ws.send(encodeStartConnection());
      } catch (e) {
        fail(new Error(`火山引擎 TTS 发送握手帧失败：${(e as Error).message}`));
      }
    };

    ws.onmessage = (event) => {
      const decoded = decodeFrame((event as { data: unknown }).data);
      if (!decoded) return;
      const code = Number(decoded.json?.code ?? 0) || 0;
      if (code && code !== VOLCANO_DONE_CODE && code !== 0) {
        fail(new Error(`火山引擎 TTS 返回错误 ${code}: ${describeVolcanoError(code, String(decoded.json?.message ?? ''))}`));
        return;
      }
      switch (decoded.event) {
        case VolcanoEvent.CONNECTION_STARTED:
          if (opts.handshakeOnly) {
            done();
            return;
          }
          try {
            ws.send(
              encodeStartSession(sessionId, {
                speaker,
                format: config.volcano.format,
                sampleRate: config.volcano.sampleRate,
                speechRate: speechRateOf(req.speed),
                // 复刻音色必须带 model_type:4（且在 additions 字符串内），情感走 context_texts
                additions: {
                  ...(cloned ? { model_type: 4 } : {}),
                  ...(config.volcano.emotion ? { context_texts: [config.volcano.emotion] } : {}),
                },
              }),
            );
          } catch (e) {
            fail(new Error(`火山引擎 TTS 发送会话帧失败：${(e as Error).message}`));
          }
          return;
        case VolcanoEvent.SESSION_STARTED:
          try {
            ws.send(encodeTaskRequest(sessionId, req.text));
            ws.send(encodeFinishSession(sessionId));
          } catch (e) {
            fail(new Error(`火山引擎 TTS 发送文本帧失败：${(e as Error).message}`));
          }
          return;
        case VolcanoEvent.TTS_RESPONSE:
          if (decoded.payload.length > 0 && !decoded.json) chunks.push(Buffer.from(decoded.payload));
          return;
        case VolcanoEvent.SESSION_FINISHED:
          if (chunks.length === 0) {
            fail(new Error('火山引擎 TTS 未返回音频数据（speaker 或模型版本可能不匹配）'));
          } else {
            done();
          }
          return;
        case VolcanoEvent.SESSION_FAILED:
        case VolcanoEvent.CONNECTION_FAILED: {
          const { code: errCode, message } = extractFrameError(decoded);
          const finalCode = errCode || code;
          fail(new Error(`火山引擎 TTS 返回错误 ${finalCode}: ${describeVolcanoError(finalCode, message)}`));
          return;
        }
        default:
          return;
      }
    };

    ws.onerror = () => {
      const authHint = headersApplied
        ? '请检查 appId / accessToken 与网络，并确认已在语音技术控制台开通语音合成大模型'
        : '当前环境的 WebSocket 不支持自定义握手头，v3 鉴权无法送达（需在支持 headers 的 Node/Electron 环境运行）';
      fail(new Error(`火山引擎 TTS 连接失败：${authHint}`));
    };

    ws.onclose = () => {
      if (settled) return;
      if (chunks.length > 0) {
        done();
        return;
      }
      fail(new Error('火山引擎 TTS 连接已关闭但未收到音频：多为鉴权失败或额度不足，请查看设置中心的连通性检测'));
    };
  });
}

/** 探活：只走握手，不发起合成、不产生字符费用 */
export async function probeVolcano(config: TtsConfig): Promise<{ ok: boolean; message: string; resourceId: string }> {
  const route = volcanoRoute(config);
  try {
    await runVolcanoSession(config, { text: '', speed: 1 }, { handshakeOnly: true, speaker: route.speaker });
    return { ok: true, message: `握手成功（resource=${route.resourceId}）`, resourceId: route.resourceId };
  } catch (e) {
    const msg = (e as Error).message;
    if (/超时/.test(msg)) return { ok: false, message: '握手超时：网络或服务地址不可达', resourceId: route.resourceId };
    return { ok: false, message: msg, resourceId: route.resourceId };
  }
}

export const volcanoProvider: TtsProvider = {
  id: 'volcano',
  label: '火山引擎（豆包语音 v3 WebSocket 流式）',

  isConfigured(config: TtsConfig) {
    return Boolean(config.volcano.appId && config.volcano.accessToken);
  },

  async synthesize(req, config, ctx) {
    const result = await runVolcanoSession(
      config,
      { text: req.text, speed: req.speed },
      { speaker: ctx?.speaker, signal: ctx?.signal },
    );
    if (result.data.length === 0) throw new Error('火山引擎 TTS 未返回音频数据');
    return { data: result.data, ext: result.ext };
  },
};
