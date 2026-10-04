import { gzipSync, gunzipSync } from 'node:zlib';

/**
 * 火山引擎（豆包语音）大模型 TTS v3 WebSocket 双向流式的**二进制分帧协议**编解码。
 *
 * 契约来源与字段含义见 `.agents/Documents/接口设计/TTS火山v3与本地克隆接入契约.md` §1。
 * 帧布局（请求与响应同构，大端）：
 *
 * ```
 * b0 = version(0b0001)<<4 | headerSize/4
 * b1 = messageType<<4 | flags      // 0b0001=完整 JSON 帧，0b1011=带 session 的音频帧
 * b2 = serialization<<4 | compression // JSON=0b0001；gzip=0b0001
 * b3 = reserved
 * 之后按 messageType 依次是：event(int32) → [eventNumber] → [session] → [sequence] → payloadLen+payload
 * ```
 *
 * 本模块刻意做成纯函数（不依赖 electron / 网络），因此冒烟脚本可以用真实字节往返验证解析。
 */

export const VOLCANO_WS_ENDPOINT = 'wss://openspeech.bytedance.com/api/v3/tts/bidirection';

/** 会话事件号（v3 双向流式） */
export const VolcanoEvent = {
  START_CONNECTION: 1,
  FINISH_CONNECTION: 2,
  CONNECTION_STARTED: 50,
  CONNECTION_FAILED: 51,
  START_SESSION: 100,
  FINISH_SESSION: 102,
  SESSION_STARTED: 150,
  SESSION_FINISHED: 152,
  SESSION_FAILED: 153,
  TASK_REQUEST: 200,
  TTS_SENTENCE_START: 350,
  TTS_SENTENCE_END: 351,
  TTS_RESPONSE: 352,
} as const;

/** 服务端「正常结束」码（出现在 payload JSON 的 code 字段里） */
export const VOLCANO_DONE_CODE = 20000000;

// messageType
const MT_FULL_REQUEST = 0b0001;
const MT_FULL_SERVER_RESPONSE = 0b0001;
const MT_AUDIO_WITH_SESSION = 0b1011;
// flags：0b0100 = 携 eventNumber；0b0010 = 携 sequence
const FLAG_EVENT_NUMBER = 0b0100;
const FLAG_SEQUENCE = 0b0010;
// serialization / compression
const SER_JSON = 0b0001;
const COMP_GZIP = 0b0001;

/** 带 event 段的 messageType 集合（其余为裸帧/控制帧） */
const MESSAGE_TYPES_WITH_EVENT = new Set<number>([0b0001, 0b0010, 0b0011, 0b1001, 0b1011]);
/** 含 session_id 字段的 messageType 集合 */
const MESSAGE_TYPES_WITH_SESSION = new Set<number>([
  MT_FULL_SERVER_RESPONSE,
  0b1001,
  MT_AUDIO_WITH_SESSION,
]);

/** 按 speaker 特征推导 X-Api-Resource-Id；显式配置优先（配错会直接报 resource mismatch） */
export function resolveResourceId(speaker: string, override?: string): string {
  if (override && override.trim()) return override.trim();
  const s = speaker ?? '';
  if (s.startsWith('S_')) return 'seed-icl-2.0';
  if (s.includes('_uranus_') || s.startsWith('saturn_')) return 'seed-tts-2.0';
  return 'seed-tts-1.0';
}

/** 云端复刻音色判定（决定 additions.model_type 与 resource id） */
export function isClonedSpeaker(speaker: string): boolean {
  return /^S_[\w-]+$/i.test(speaker ?? '');
}

function frame(messageType: number, flags: number, compression = 0): Buffer {
  return Buffer.from([
    (0b0001 << 4) | 0b0001, // version 1 + header size 1（4 字节）
    (messageType << 4) | flags,
    (SER_JSON << 4) | compression,
    0,
  ]);
}

function withSession(event: number, sessionId?: string, payload?: Buffer): Buffer {
  const parts: Buffer[] = [frame(MT_FULL_REQUEST, FLAG_EVENT_NUMBER)];
  const head = Buffer.alloc(4);
  head.writeInt32BE(event, 0);
  parts.push(head);
  if (sessionId !== undefined) {
    const id = Buffer.from(sessionId, 'utf8');
    const len = Buffer.alloc(4);
    len.writeUInt32BE(id.length, 0);
    parts.push(len, id);
  }
  if (payload && payload.length) {
    const plen = Buffer.alloc(4);
    plen.writeUInt32BE(payload.length, 0);
    parts.push(plen, payload);
  } else {
    const empty = Buffer.from('{}', 'utf8');
    const plen = Buffer.alloc(4);
    plen.writeUInt32BE(empty.length, 0);
    parts.push(plen, empty);
  }
  return Buffer.concat(parts);
}

function jsonPayload(obj: unknown, gzip: boolean): Buffer {
  const raw = Buffer.from(JSON.stringify(obj), 'utf8');
  return gzip ? gzipSync(raw) : raw;
}

export interface StartSessionParams {
  speaker: string;
  format: string;
  sampleRate: number;
  /** 语速百分比偏移（-50~100），仅在 ≠0 时下发，避免不同模型语义歧义 */
  speechRate?: number;
  /** 云端复刻必须带 model_type:4；情感走 context_texts */
  additions?: Record<string, unknown>;
  /** 是否对 payload 做 gzip（部分接入方用它压体积） */
  gzip?: boolean;
}

export function encodeStartConnection(): Buffer {
  return withSession(VolcanoEvent.START_CONNECTION, undefined, undefined);
}

export function encodeFinishConnection(): Buffer {
  return withSession(VolcanoEvent.FINISH_CONNECTION, undefined, undefined);
}

export function encodeStartSession(sessionId: string, p: StartSessionParams): Buffer {
  const reqParams: Record<string, unknown> = {
    speaker: p.speaker,
    audio_params: {
      format: p.format,
      sample_rate: p.sampleRate,
      ...(p.speechRate ? { speech_rate: p.speechRate } : {}),
    },
  };
  // additions 必须是**序列化后的 JSON 字符串**，传对象服务端会静默忽略（官方文档坑）
  if (p.additions && Object.keys(p.additions).length > 0) {
    reqParams.additions = JSON.stringify(p.additions);
  }
  const payload = jsonPayload({ event: VolcanoEvent.START_SESSION, req_params: reqParams }, Boolean(p.gzip));
  return withSession(VolcanoEvent.START_SESSION, sessionId, payload);
}

export function encodeTaskRequest(sessionId: string, text: string, gzip = false): Buffer {
  const payload = jsonPayload(
    { event: VolcanoEvent.TASK_REQUEST, req_params: { text } },
    gzip,
  );
  return withSession(VolcanoEvent.TASK_REQUEST, sessionId, payload);
}

export function encodeFinishSession(sessionId: string): Buffer {
  return withSession(VolcanoEvent.FINISH_SESSION, sessionId, Buffer.from('{}', 'utf8'));
}

/** 解码后的响应帧；payload 已按需 inflate */
export interface DecodedFrame {
  messageType: number;
  flags: number;
  serialization: number;
  compression: number;
  event?: number;
  sessionId?: string;
  sequence?: number;
  payload: Buffer;
  /** payload 是 JSON 时的解析结果（失败为 undefined） */
  json?: Record<string, unknown>;
}

/**
 * 容错解析。为什么需要“两种布局都试”：
 * 官方文档对 flags 0b0100 的写法是「携 event number」，而已验证的公开实现里
 * 该位对应的就是 event 字段本身（[header][event][session][payload]）。
 * 先按布局 A 解，若 session 长度不合理再按布局 B（多一个 4 字节 eventNumber）解；
 * 两者都不合理时退回「剩余字节即 payload」，保证不会把音频截断成噪声。
 */
export function decodeFrame(input: unknown): DecodedFrame | null {
  const buf = toBuffer(input);
  if (!buf || buf.length < 4) return null;

  const headerSize = Math.max(4, (buf.readUInt8(0) & 0x0f) * 4);
  const messageType = buf.readUInt8(1) >> 4;
  const flags = buf.readUInt8(1) & 0x0f;
  const serialization = buf.readUInt8(2) >> 4;
  const compression = buf.readUInt8(2) & 0x0f;

  const hasEvent = MESSAGE_TYPES_WITH_EVENT.has(messageType);
  const wantsSession = MESSAGE_TYPES_WITH_SESSION.has(messageType);
  const hasSequence = (flags & FLAG_SEQUENCE) !== 0;

  interface Layout {
    event?: number;
    sessionId?: string;
    sequence?: number;
    payload: Buffer;
    /** session 字段是否解到了可信值 */
    sessionSane: boolean;
    frameSane: boolean;
  }

  const tryLayout = (skipEventNumber: boolean): Layout | null => {
    let cursor = headerSize;
    let event: number | undefined;
    if (hasEvent) {
      if (buf.length < cursor + 4) return null;
      event = buf.readInt32BE(cursor);
      cursor += 4;
    }
    if (skipEventNumber) {
      if (buf.length < cursor + 4) return null;
      cursor += 4; // 多余的 event number 字段
    }
    let sessionId: string | undefined;
    let sessionSane = !wantsSession;
    if (wantsSession && buf.length >= cursor + 4) {
      const idLen = buf.readUInt32BE(cursor);
      // session id 是 uuid 形态：只接 [A-Za-z0-9_-]，不能把紧跟其后的 JSON 负载误认成会话号
      if (idLen >= 4 && idLen <= 128 && buf.length >= cursor + 4 + idLen) {
        const text = buf.subarray(cursor + 4, cursor + 4 + idLen).toString('utf8');
        if (/^[A-Za-z0-9_-]+$/.test(text)) {
          sessionId = text;
          sessionSane = true;
          cursor += 4 + idLen;
        }
      }
    }
    let sequence: number | undefined;
    if (hasSequence && buf.length >= cursor + 4) {
      sequence = buf.readInt32BE(cursor);
      cursor += 4;
    }
    let payload = buf.subarray(cursor);
    let frameSane = true;
    if (buf.length >= cursor + 4) {
      const declared = buf.readUInt32BE(cursor);
      if (declared >= 0 && declared <= buf.length - cursor - 4) {
        payload = buf.subarray(cursor + 4, cursor + 4 + declared);
      } else if (!wantsSession || !sessionSane) {
        frameSane = false;
      }
    }
    return { event, sessionId, sequence, payload, sessionSane, frameSane };
  };

  const first = tryLayout(false);
  const second = tryLayout(true);
  let picked: Layout | null = first;
  if (wantsSession && first && second && !first.sessionSane && second.sessionSane) picked = second;
  if (picked && !picked.frameSane && second && second.frameSane) picked = second;
  if (!picked) return null;

  let payload = picked.payload;
  if (compression === COMP_GZIP && payload.length > 0) {
    try {
      payload = gunzipSync(payload);
    } catch {
      /* inflate 失败按原字节处理，交给上层的空音频/解析失败分支报清晰错误 */
    }
  }

  let json: Record<string, unknown> | undefined;
  if (payload.length > 0 && (serialization === SER_JSON || messageType === MT_FULL_SERVER_RESPONSE)) {
    const text = payload.toString('utf8').trim();
    if (text.startsWith('{') || text.startsWith('[')) {
      try {
        const parsed = JSON.parse(text) as unknown;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          json = parsed as Record<string, unknown>;
        }
      } catch {
        json = undefined; // 音频帧里混到 JSON 起始字节属正常，不算错
      }
    }
  }

  return {
    messageType,
    flags,
    serialization,
    compression,
    event: picked.event,
    sessionId: picked.sessionId,
    sequence: picked.sequence,
    payload,
    json,
  };
}

function toBuffer(input: unknown): Buffer | null {
  if (Buffer.isBuffer(input)) return input;
  if (typeof input === 'string') return Buffer.from(input, 'utf8'); // 文本帧（部分代理会发）
  if (input instanceof ArrayBuffer) return Buffer.from(new Uint8Array(input));
  if (ArrayBuffer.isView(input)) return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  return null;
}

/** 火山错误码 → 可行动的中文释义（面试/排障都用得上，别只丢一个数字） */
const ERROR_HINTS: Array<{ test: (code: number, msg: string) => boolean; hint: string }> = [
  {
    test: (c, msg) => c === 55000000 || /resource id is mismatched/i.test(msg),
    hint: 'X-Api-Resource-Id 与 speaker 不匹配：复刻音色 S_* 用 seed-icl-2.0，_uranus_/saturn_ 用 seed-tts-2.0，其余用 seed-tts-1.0',
  },
  {
    test: (c, msg) => c === 45000001 || /invalid param|invalid request/i.test(msg),
    hint: '请求参数非法：检查 speaker / format / sample_rate / 文本长度',
  },
  {
    test: (c, msg) => c === 55000001 || /agent busy/i.test(msg),
    hint: '服务端并发已满，稍后重试（本条会走降级链）',
  },
  {
    test: (c, msg) => c === 4001 || c === 3001 || /access token|auth|forbidden|unauthorized/i.test(msg),
    hint: '鉴权失败：核对控制台 APP ID 与「访问控制-API Key」，并确认已开通语音合成大模型',
  },
  {
    test: (c, msg) => c === 45000003 || /quota|balance|not activated|未开通|欠费/i.test(msg),
    hint: '额度/开通问题：到语音技术控制台确认已开通并有剩余字符额度',
  },
  { test: () => true, hint: '按错误码到语音技术控制台日志排查；合成会降级到备用链路，不阻断成片' },
];

/** 从 SESSION_FAILED / CONNECTION_FAILED 的 payload 里抽出 code + message */
export function extractFrameError(frame: DecodedFrame): { code: number; message: string } {
  const json = frame.json ?? {};
  const nested = (json.error && typeof json.error === 'object' ? json.error : json) as Record<string, unknown>;
  const code = Number(nested.code ?? json.code ?? json.status ?? 0) || 0;
  const message = String(nested.message ?? json.message ?? json.error ?? '').slice(0, 300);
  return { code, message };
}

/** 统一成一句「原因 + 下一步做什么」的中文提示 */
export function describeVolcanoError(code: number, message: string): string {
  const low = (message ?? '').toLowerCase();
  for (const rule of ERROR_HINTS) {
    if (rule.test(code, low)) return rule.hint;
  }
  return ERROR_HINTS[ERROR_HINTS.length - 1]!.hint;
}