import type { TtsProvider } from '../index';
import type { TtsConfig } from '../config';

/**
 * 本地 Index-TTS 2 适配器（隐私模式）。
 * 约定本地服务暴露：
 * - POST {baseUrl}/tts          入参 { text, voice, speed }，返回音频二进制（普通合成）；
 * - POST {baseUrl}/tts/zero-shot 入参 { text, speed, voiceName, referenceAudioBase64 }，
 *   返回音频二进制（M3 零样本音色克隆：参考音频驱动，无需训练）。
 */
export const localProvider: TtsProvider = {
  id: 'local',
  label: '本地 Index-TTS 2',

  isConfigured(config: TtsConfig) {
    return Boolean(config.local.baseUrl);
  },

  async synthesize(req, config) {
    const base = config.local.baseUrl.replace(/\/$/, '');
    let response: Response;
    try {
      response = await fetch(`${base}/tts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: req.text, voice: req.voice, speed: req.speed }),
      });
    } catch (error) {
      throw new Error(
        `无法连接本地 Index-TTS 2（${base}）：${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (!response.ok) {
      throw new Error(`本地 Index-TTS 2 返回 ${response.status} ${response.statusText}`);
    }

    const contentType = response.headers.get('content-type') ?? '';
    const buffer = Buffer.from(await response.arrayBuffer());
    const ext = contentType.includes('wav') || looksLikeWav(buffer) ? 'wav' : 'mp3';
    return { data: buffer, ext };
  },
};

/** RIFF....WAVE 文件头判断 */
function looksLikeWav(buffer: Buffer): boolean {
  return buffer.length > 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WAVE';
}

export interface ZeroShotRequest {
  text: string;
  speed: number;
  /** 音色展示名（服务端仅作日志/多说话人提示用） */
  voiceName: string;
  /** 参考音频样本的 base64（导入时已通过时长/静音校验） */
  referenceAudioBase64: string;
}

/**
 * 零样本音色克隆合成（M3）：参考音频 + 目标文本 → 克隆音色音频。
 * 失败抛错由上层路由降级链接住（回退在线/离线）。
 */
export async function zeroShotSynthesize(
  config: TtsConfig,
  req: ZeroShotRequest,
): Promise<{ data: Buffer; ext: string }> {
  const base = config.local.baseUrl.replace(/\/$/, '');
  let response: Response;
  try {
    response = await fetch(`${base}/tts/zero-shot`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: req.text,
        speed: req.speed,
        voice_name: req.voiceName,
        reference_audio_base64: req.referenceAudioBase64,
      }),
    });
  } catch (error) {
    throw new Error(
      `无法连接本地零样本音色服务（${base}）：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!response.ok) {
    throw new Error(`零样本音色服务返回 ${response.status} ${response.statusText}`);
  }
  const contentType = response.headers.get('content-type') ?? '';
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length === 0) throw new Error('零样本音色服务返回空音频');
  const ext = contentType.includes('wav') || looksLikeWav(buffer) ? 'wav' : 'mp3';
  return { data: buffer, ext };
}
