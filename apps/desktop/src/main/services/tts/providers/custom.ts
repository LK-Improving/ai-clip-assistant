import type { TtsProvider } from '../index';
import type { TtsConfig } from '../config';

/**
 * 自定义 OpenAI 兼容 TTS（P-自定义）：POST {baseUrl}/audio/speech
 * body { model, input, voice, response_format: 'mp3' } → 音频字节流。
 * 覆盖 DeepSeek 生态网关、F5-TTS/Index-TTS 的 OpenAI 兼容壳、各类自建推理服务等；
 * 零样本克隆服务仍走 local provider 的 /tts/zero-shot 协议，两者互不影响。
 */
export const customProvider: TtsProvider = {
  id: 'custom',
  label: '自定义（OpenAI 兼容 TTS）',

  isConfigured(config: TtsConfig) {
    return Boolean(config.custom?.baseUrl);
  },

  async synthesize(req, config) {
    const base = config.custom.baseUrl.replace(/\/$/, '');
    let response: Response;
    try {
      response = await fetch(`${base}/audio/speech`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(config.custom.apiKey ? { Authorization: `Bearer ${config.custom.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: config.custom.model || 'tts-1',
          input: req.text,
          voice: req.voice || config.custom.voice || 'default',
          speed: req.speed,
          response_format: 'mp3',
        }),
      });
    } catch (error) {
      throw new Error(
        `无法连接自定义 TTS 服务（${base}）：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!response.ok) {
      throw new Error(`自定义 TTS 服务返回 ${response.status} ${response.statusText}`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length === 0) throw new Error('自定义 TTS 服务返回空音频');
    const contentType = response.headers.get('content-type') ?? '';
    const ext = contentType.includes('wav') ? 'wav' : contentType.includes('ogg') ? 'ogg' : 'mp3';
    return { data: buffer, ext };
  },
};
