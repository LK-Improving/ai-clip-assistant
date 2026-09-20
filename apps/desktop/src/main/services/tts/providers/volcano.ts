import type { TtsProvider } from '../index';
import type { TtsConfig } from '../config';

/**
 * 火山引擎（豆包语音）WebSocket 流式 TTS。
 *
 * 说明：协议为二进制流式分帧，需 appId + accessToken 才能真实联调。
 * 这里按官方 v3 接口实现收发骨架：发送 start / session 事件后拼接音频分片；
 * 未配置密钥时 isConfigured() 返回 false，上层给出明确提示而非静默失败。
 */
const WS_ENDPOINT = 'wss://openspeech.bytedance.com/api/v3/tts/ws_binary';

type WebSocketCtor = new (url: string, protocols?: string | string[]) => {
  binaryType: string;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: unknown) => void) | null;
  send(data: string | ArrayBufferView | ArrayBuffer): void;
  close(): void;
};

function getWebSocket(): WebSocketCtor | null {
  const ctor = (globalThis as { WebSocket?: WebSocketCtor }).WebSocket;
  return ctor ?? null;
}

export const volcanoProvider: TtsProvider = {
  id: 'volcano',
  label: '火山引擎（豆包语音）',

  isConfigured(config: TtsConfig) {
    return Boolean(config.volcano.appId && config.volcano.accessToken);
  },

  async synthesize(req, config) {
    const WS = getWebSocket();
    if (!WS) throw new Error('当前 Node 版本不支持全局 WebSocket，无法使用火山引擎 TTS');

    const { appId, accessToken } = config.volcano;
    const url = `${WS_ENDPOINT}?appid=${encodeURIComponent(appId)}&access_token=${encodeURIComponent(accessToken)}`;

    const chunks: Buffer[] = [];

    await new Promise<void>((resolve, reject) => {
      const ws = new WS(url);
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        ws.close();
        if (error) reject(error);
        else resolve();
      };

      ws.binaryType = 'arraybuffer';
      ws.onopen = () => {
        ws.send(
          JSON.stringify({
            event: 'start',
            payload: {
              tts: { voice: req.voice, speed: req.speed, text: req.text, format: 'mp3' },
            },
          }),
        );
      };
      ws.onmessage = (event) => {
        const data = event.data;
        if (data instanceof ArrayBuffer) {
          chunks.push(Buffer.from(data));
          return;
        }
        if (typeof data === 'string') {
          try {
            const parsed = JSON.parse(data) as { event?: string; code?: number; message?: string };
            if (parsed.event === 'tts_end' || parsed.event === 'finish') finish();
            if (parsed.code && parsed.code !== 0) {
              finish(new Error(`火山引擎 TTS 返回错误 ${parsed.code}: ${parsed.message ?? ''}`));
            }
          } catch {
            // 非 JSON 文本忽略
          }
        }
      };
      ws.onerror = () => finish(new Error('火山引擎 TTS 连接失败，请检查 appId / accessToken 与网络'));
      ws.onclose = () => finish();
      setTimeout(() => finish(new Error('火山引擎 TTS 超时')), 30_000);
    });

    if (chunks.length === 0) throw new Error('火山引擎 TTS 未返回音频数据');
    return { data: Buffer.concat(chunks), ext: 'mp3' };
  },
};
