import { SimpleChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessageChunk } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { ChatGenerationChunk } from '@langchain/core/outputs';
import type { CallbackManagerForLLMRun } from '@langchain/core/callbacks/manager';
import { ChatOllama } from '@langchain/ollama';
import { ChatOpenAI } from '@langchain/openai';
import type { AgentChatModel } from './types';

/**
 * LLM 接入层（模块 2.1，LangChain 版）。
 *
 * 三类模型共用 LangChain `BaseChatModel` 模型抽象，节点层不感知厂商差异：
 * - OfflineChatModel：无网络/无密钥时的确定性 Provider（输出即 JSON），保证链路端到端可跑；
 * - ArkChatModel：火山方舟（OpenAI 兼容端点），经 @langchain/openai 接入，支持原生 function calling；
 * - OllamaChatModel：本地私有化模型，经 @langchain/ollama 接入。
 * 结构化输出统一走 invokeStructured（structured.ts）：Function Calling + Zod 校验 + 失败自动重试 + 降级兜底。
 */

/** ===== 离线确定性生成逻辑（OfflineChatModel 与结构化输出兜底共用） ===== */

export function offlineBriefJson(requirement: string): string {
  const theme = /旅行|vlog|travel|出游|风景/.test(requirement) ? '旅行' : '生活记录';
  const vertical = /竖屏|vertical|9:16|抖音|短视频/.test(requirement);
  const targetDurationMs = parseDurationHint(requirement) ?? 30_000;
  const brief = {
    title: requirement.slice(0, 24) || '未命名作品',
    theme,
    tone: '轻松',
    targetDurationMs,
    canvas: vertical
      ? { width: 1080, height: 1920, fps: 30 }
      : { width: 1920, height: 1080, fps: 30 },
    style: ['明亮', '轻快', '记录感'],
    outline: [
      `开篇：用一句话点题——${requirement}`,
      '中段：交替呈现核心画面与细节特写',
      '结尾：收束情绪，留下记忆点',
    ],
  };
  return JSON.stringify(brief);
}

export function offlineStoryboardJson(userPayload: string): string {
  let payload: {
    requirement?: string;
    brief?: { targetDurationMs?: number };
    assets?: Array<{ id: string; name: string; type: string; durationMs?: number }>;
  } = {};
  try {
    payload = JSON.parse(userPayload);
  } catch {
    payload = { requirement: userPayload };
  }
  const requirement = payload.requirement ?? '记录此刻';
  const target = payload.brief?.targetDurationMs ?? 0;
  const visuals = (payload.assets ?? []).filter((a) => a.type === 'video' || a.type === 'image');

  let scenes: Array<{
    order: number;
    title: string;
    description: string;
    narration: string;
    assetType: 'video' | 'image' | 'audio' | 'any';
    durationMs: number;
  }>;

  if (visuals.length > 0) {
    scenes = visuals.slice(0, 8).map((a, i) => ({
      order: i,
      title: `场景 ${i + 1}：${a.name}`,
      description: `展示素材「${a.name}」`,
      narration: `${requirement}（第 ${i + 1} 段）`,
      assetType: a.type === 'image' ? 'image' : 'video',
      durationMs: clampDuration(a.durationMs ?? 5000),
    }));
  } else {
    scenes = [0, 1, 2].map((i) => ({
      order: i,
      title: `段落 ${i + 1}`,
      description: `${requirement} 的第 ${i + 1} 个段落`,
      narration: `${requirement}（第 ${i + 1} 段）`,
      assetType: 'any' as const,
      durationMs: 5000,
    }));
  }

  // 若简报给了目标时长，按比例把各场时长缩放到目标总时长
  const total = scenes.reduce((s, c) => s + c.durationMs, 0);
  if (target > 0 && total > 0) {
    const factor = target / total;
    for (const c of scenes) c.durationMs = Math.max(1000, Math.round(c.durationMs * factor));
  }

  return JSON.stringify(scenes);
}

/**
 * 离线确定性模型：按系统提示词中的标记（creative-brief / storyboard）分派生成逻辑。
 * 输出即 JSON 字符串，invokeStructured 走「非 tool_calls → content JSON 解析」路径，
 * 与真实 Provider 共用同一条校验/重试链路。
 */
export class OfflineChatModel extends SimpleChatModel implements AgentChatModel {
  readonly providerId = 'offline';
  readonly label = '离线确定性 Provider';

  isConfigured(): boolean {
    return true;
  }

  supportsToolCalling(): boolean {
    return false;
  }

  _llmType(): string {
    return 'offline';
  }

  async _call(messages: BaseMessage[]): Promise<string> {
    const system = messages.find((m) => m.getType() === 'system')?.content?.toString() ?? '';
    const user = messages.find((m) => m.getType() === 'human')?.content?.toString() ?? '';
    if (/creative-brief/i.test(system)) return offlineBriefJson(user);
    if (/storyboard/i.test(system)) return offlineStoryboardJson(user);
    return user;
  }

  /**
   * M2：离线确定性模型的分块流式（模拟 token 推送，无密钥也能演示打字机效果）。
   * 把完整 JSON 按 12 字符切块 yield，与真实 Provider 的 stream 行为同构，
   * invokeStructured 的聚合/解析链无需区分对待。
   */
  override async *_streamResponseChunks(
    messages: BaseMessage[],
    _options: this['ParsedCallOptions'],
    runManager?: CallbackManagerForLLMRun,
  ): AsyncGenerator<ChatGenerationChunk> {
    const full = await this._call(messages);
    const CHUNK_SIZE = 12;
    for (let i = 0; i < full.length; i += CHUNK_SIZE) {
      const part = full.slice(i, i + CHUNK_SIZE);
      const chunk = new ChatGenerationChunk({ text: part, message: new AIMessageChunk({ content: part }) });
      yield chunk;
      await runManager?.handleLLMNewToken(part);
    }
  }
}

/** 端点归一：兼容旧配置里写全 /chat/completions 的 baseUrl，转成 OpenAI SDK 需要的根路径 */
export function normalizeArkBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/chat\/completions\/?$/, '');
}

/** 火山方舟（Ark）：OpenAI 兼容协议，经 @langchain/openai 接入，支持原生 function calling */
export class ArkChatModel extends ChatOpenAI {
  readonly providerId = 'ark';
  readonly label: string;
  private readonly apiKeyValue: string;

  constructor(opts: { apiKey: string; model?: string; baseUrl?: string; label?: string }) {
    super({
      apiKey: opts.apiKey,
      model: opts.model ?? 'doubao-seed-1-6-250615',
      temperature: 0.7,
      maxTokens: 2048,
      configuration: {
        baseURL: normalizeArkBaseUrl(
          opts.baseUrl ?? 'https://ark.cn-beijing.volces.com/api/v3',
        ),
      },
    });
    this.apiKeyValue = opts.apiKey;
    this.label = opts.label ?? `火山方舟 ${opts.model ?? 'doubao-seed-1-6-250615'}`;
  }

  isConfigured(): boolean {
    return this.apiKeyValue.length > 0;
  }

  supportsToolCalling(): boolean {
    return true;
  }
}

/** 本地 Ollama（@langchain/ollama）：私有化/离线大模型场景，PDF 所述「混合云」的本地一翼 */
export class OllamaChatModel extends ChatOllama {
  readonly providerId = 'ollama';
  readonly label: string;

  constructor(opts: { baseUrl?: string; model?: string }) {
    super({
      baseUrl: opts.baseUrl ?? 'http://127.0.0.1:11434',
      model: opts.model ?? 'qwen2.5:7b',
    });
    this.label = `Ollama ${opts.model ?? 'qwen2.5:7b'}`;
  }

  isConfigured(): boolean {
    // Ollama 是本机服务，无法在不发请求时静态判断；按「已选择本地模型」处理，
    // 连接失败由 invokeStructured 的重试/降级兜底接住。
    return true;
  }

  supportsToolCalling(): boolean {
    // Ollama 的工具调用取决于具体模型，保守走 JSON 内容 + Zod 校验路径
    return false;
  }
}

/**
 * 自定义 OpenAI 兼容模型（P-自定义）：DeepSeek / 任意兼容网关。
 * DeepSeek 官方即 OpenAI 协议（https://api.deepseek.com/v1）且支持 tools，
 * 因此与方舟同走 bindTools Function Calling 链路；模型 id 以用户控制台显示为准填入 model。
 */
export class CustomChatModel extends ChatOpenAI {
  readonly providerId = 'custom';
  readonly label: string;
  private readonly keyValue: string;

  constructor(opts: { apiKey: string; baseUrl: string; model?: string; label?: string }) {
    super({
      apiKey: opts.apiKey,
      model: opts.model ?? 'gpt-4o-mini',
      temperature: 0.7,
      maxTokens: 2048,
      configuration: { baseURL: normalizeArkBaseUrl(opts.baseUrl) },
    });
    this.keyValue = opts.apiKey;
    this.label = opts.label ?? `自定义 ${opts.model ?? 'OpenAI 兼容'}`;
  }

  isConfigured(): boolean {
    return this.keyValue.length > 0;
  }

  supportsToolCalling(): boolean {
    return true;
  }
}

export interface LlmProviderConfig {
  type?: 'offline' | 'ark' | 'ollama' | 'custom';
  apiKey?: string;
  model?: string;
  baseUrl?: string;
}

/** 根据配置/env 创建聊天模型；默认离线。与 createLLM 别名保持对外兼容 */
export function createLlmProvider(config: LlmProviderConfig = {}): AgentChatModel {
  const type =
    config.type ?? (process.env.AGENT_LLM_PROVIDER as 'offline' | 'ark' | 'ollama' | 'custom' | undefined) ?? 'offline';
  if (type === 'custom') {
    return new CustomChatModel({
      apiKey: config.apiKey ?? process.env.CUSTOM_LLM_API_KEY ?? '',
      baseUrl: config.baseUrl ?? process.env.CUSTOM_LLM_BASE_URL ?? 'https://api.deepseek.com/v1',
      model: config.model ?? process.env.CUSTOM_LLM_MODEL,
    });
  }
  if (type === 'ark') {
    return new ArkChatModel({
      apiKey: config.apiKey ?? process.env.ARK_API_KEY ?? '',
      model: config.model ?? process.env.ARK_MODEL,
      baseUrl: config.baseUrl ?? process.env.ARK_BASE_URL,
    });
  }
  if (type === 'ollama') {
    return new OllamaChatModel({
      baseUrl: config.baseUrl ?? process.env.OLLAMA_BASE_URL,
      model: config.model ?? process.env.OLLAMA_MODEL,
    });
  }
  return new OfflineChatModel({});
}

/** 兼容旧调用点的工厂别名（桌面端/冒烟脚本按 LLM 语义使用） */
export const createLLM = createLlmProvider;

/** 兼容旧代码里 `new OfflineLlmProvider()` 的构造点 */
export const OfflineLlmProvider = OfflineChatModel;
export type OfflineLlmProvider = OfflineChatModel;

function parseDurationHint(text: string): number | null {
  const min = text.match(/(\d+)\s*分(钟)?/);
  if (min) return Number(min[1]) * 60_000;
  const sec = text.match(/(\d+)\s*秒/);
  if (sec) return Number(sec[1]) * 1000;
  return null;
}

function clampDuration(ms: number): number {
  if (!Number.isFinite(ms) || ms <= 0) return 5000;
  return Math.min(60_000, Math.max(1000, Math.round(ms)));
}
