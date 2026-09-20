import { ChatPromptTemplate, HumanMessagePromptTemplate, PromptTemplate, SystemMessagePromptTemplate } from '@langchain/core/prompts';
import { AIMessage, AIMessageChunk, HumanMessage, SystemMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import type { Runnable } from '@langchain/core/runnables';
import type { ZodType } from 'zod';
import type { AgentChatModel } from './types';

/**
 * 结构化输出（PDF「Function Calling + Zod + 自动重试」方案的落地）：
 *
 * 1. ChatPromptTemplate（mustache 模板，{{{var}}} 原样插值，JSON 花括号安全）构造消息；
 * 2. 支持工具调用的模型经 `bindTools` 绑定 JSON Schema 工具（火山方舟走原生 function calling）；
 *    不支持的模型（离线/Ollama）走「要求 JSON 输出」路径，同一条解析链兜住；
 * 3. 响应优先取 tool_calls.args，否则 JSON.parse(content)，统一经 Zod 运行时校验；
 * 4. 校验失败自动重试（默认 2 次），并把错误原因回灌进对话让模型改错；
 * 5. 全部失败时执行 fallback（确定性降级），不拖垮流水线。
 */

export interface StructuredToolSpec {
  /** function calling 工具名，例如 emit_creative_brief */
  name: string;
  description: string;
  /** 手写 JSON Schema（避免 zod→JSON Schema 版本兼容问题），作为工具 parameters */
  schema: Record<string, unknown>;
}

export interface InvokeStructuredOptions<T> {
  model: AgentChatModel;
  system: string;
  user: string;
  tool: StructuredToolSpec;
  /** Zod 运行时校验；失败会触发带错误反馈的重试 */
  parse: (value: unknown) => T;
  /** 重试次数（不含首次调用），默认 2 */
  maxRetries?: number;
  signal?: AbortSignal;
  logger?: (msg: string) => void;
  /** 所有尝试均失败后的确定性降级；缺省则抛错 */
  fallback?: () => T;
  /**
   * M2 token 级流式（PDF「流式即时响应/打字机」）：提供后改用 model.stream()，
   * 逐块回调内容增量；tool_call 参数不回调（模型走工具调用时正文通常为空）。
   * 取消语义：signal abort 会中断 stream 迭代（for-await 抛错），不会残留半流状态。
   */
  onToken?: (delta: string) => void;
}

/**
 * 单次模型调用：无 onToken 走 invoke；有 onToken 走 stream 并用
 * AIMessageChunk.concat 聚合出与 invoke 等价的结果（含流式 tool_call 片段的合并解析）。
 */
async function callOnce(
  runnable: Runnable<BaseMessage[], BaseMessage>,
  messages: BaseMessage[],
  signal: AbortSignal | undefined,
  onToken: ((delta: string) => void) | undefined,
): Promise<BaseMessage> {
  if (!onToken) {
    return await (runnable.invoke as (m: BaseMessage[], c: unknown) => Promise<BaseMessage>)(messages, { signal });
  }
  const stream = await (runnable.stream as (m: BaseMessage[], c: unknown) => Promise<AsyncIterable<BaseMessage>>)(
    messages,
    { signal },
  );
  let acc: AIMessageChunk | null = null;
  for await (const chunk of stream) {
    const asChunk =
      chunk instanceof AIMessageChunk
        ? chunk
        : // 非 chunk 形态的兼容分支（理论上 stream 产出均为 MessageChunk）：按字段重建
          new AIMessageChunk({
            content: (chunk as AIMessage).content ?? '',
            tool_calls: (chunk as AIMessage).tool_calls ?? [],
            additional_kwargs: (chunk as AIMessage).additional_kwargs ?? {},
          });
    acc = acc ? (acc.concat(asChunk) as unknown as AIMessageChunk) : asChunk;
    const delta = typeof asChunk.content === 'string' ? asChunk.content : '';
    if (delta) onToken(delta);
  }
  return acc ?? new AIMessage('');
}

function mustacheVar(name: string): PromptTemplate {
  return new PromptTemplate({ template: `{{{${name}}}}`, inputVariables: [name], templateFormat: 'mustache' });
}

/** system + human 两段式模板；重试时在尾部追加 AIMessage(失败输出) + HumanMessage(校验错误) */
const STRUCTURED_PROMPT = ChatPromptTemplate.fromMessages([
  new SystemMessagePromptTemplate(mustacheVar('system')),
  new HumanMessagePromptTemplate(mustacheVar('user')),
]);

export async function renderStructuredMessages(system: string, user: string): Promise<BaseMessage[]> {
  return STRUCTURED_PROMPT.formatMessages({ system, user });
}

/** 兼容离线模型：OfflineChatModel 按消息内容分派，需要 SystemMessage/HumanMessage 形态（renderStructuredMessages 即产出该形态） */
export function rawMessages(system: string, user: string): BaseMessage[] {
  return [new SystemMessage(system), new HumanMessage(user)];
}

/**
 * 主入口：调用模型并获得经 Zod 校验的结构化结果。
 */
export async function invokeStructured<T>(opts: InvokeStructuredOptions<T>): Promise<T> {
  const { model, tool, parse, signal, logger } = opts;
  const maxRetries = opts.maxRetries ?? 2;

  const messages = await renderStructuredMessages(opts.system, opts.user);

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const runnable: Runnable<BaseMessage[], BaseMessage> =
      model.supportsToolCalling() && typeof model.bindTools === 'function'
        ? (model.bindTools([
            { name: tool.name, description: tool.description, schema: tool.schema },
          ]) as unknown as Runnable<BaseMessage[], BaseMessage>)
        : model;
    const res = await callOnce(runnable, messages, signal, opts.onToken);

    let value: unknown;
    let parseErr: Error | null = null;
    const toolCalls = ((res as AIMessage).tool_calls ?? []) as Array<{ name?: string; args?: unknown }>;
    const call = toolCalls.find((c) => !c.name || c.name === tool.name) ?? toolCalls[0];
    if (call && typeof call.args === 'object' && call.args !== null) {
      value = call.args;
    } else {
      const content = typeof res.content === 'string' ? res.content : JSON.stringify(res.content);
      try {
        value = JSON.parse(stripJsonFence(content));
      } catch (e) {
        parseErr = e as Error;
      }
    }

    if (!parseErr) {
      try {
        const ok = parse(value);
        if (attempt > 0) logger?.(`[structured] ${tool.name} 第 ${attempt + 1} 次尝试通过校验`);
        return ok;
      } catch (e) {
        parseErr = e as Error;
      }
    }

    logger?.(`[structured] ${tool.name} 第 ${attempt + 1} 次输出不合法：${parseErr.message.slice(0, 200)}`);
    if (attempt < maxRetries) {
      // 把失败输出与错误原因回灌进对话，让模型针对性改错（自动重试）
      messages.push(new AIMessage(typeof res.content === 'string' ? res.content : ''));
      messages.push(
        new HumanMessage(
          `上一次输出未通过校验：${parseErr.message}。请严格按工具 schema（${tool.description}）重新输出，只输出合法 JSON。`,
        ),
      );
    }
  }

  if (opts.fallback) {
    logger?.(`[structured] ${tool.name} 重试耗尽，执行降级兜底`);
    return opts.fallback();
  }
  throw new Error(`[structured] ${tool.name} 结构化输出连续失败`);
}

/** 剥离 ```json 围栏，部分模型会在 JSON 外套 markdown */
function stripJsonFence(text: string): string {
  const m = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  return (m?.[1] ?? text).trim();
}

/** 供节点复用：Zod schema 的 parse 即校验器 */
export function zodParser<T>(schema: ZodType<T>): (value: unknown) => T {
  return (value) => schema.parse(value);
}
