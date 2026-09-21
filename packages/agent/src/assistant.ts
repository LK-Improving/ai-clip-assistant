import { invokeStructured } from './structured';
import type { AgentChatModel } from './types';

/**
 * 对话式剪辑规划器（R2）。
 *
 * 与 creative-brief / storyboard 同一套范式：JSON Schema 工具 + parse 校验 + 失败重试，
 * 复用 invokeStructured，不另起一套 LLM 调用路径。
 *
 * 关键设计：模型只被允许引用快照里的 **ref**（如「音乐轨#2」「选中」），
 * 不接触 uuid。否则 LLM 抄错一个字符就改错片段，而且错误不可读。
 * ref → clipId 的解析放在渲染进程（唯一知道完整时间线状态的地方）。
 */

/** 模型可请求的时间线动作，与渲染进程 lib/assistant-apply.ts 一一对应 */
export type AssistantAction =
  | { type: 'removeClip'; ref: string }
  | {
      type: 'updateClip';
      ref: string;
      patch: {
        startMs?: number;
        durationMs?: number;
        offsetMs?: number;
        volume?: number;
        muted?: boolean;
        fadeInMs?: number;
        fadeOutMs?: number;
      };
    }
  | { type: 'addCaption'; text: string; startMs: number; durationMs: number }
  | { type: 'seekTo'; startMs: number };

export interface AssistantClipSnapshot {
  ref: string;
  name: string;
  startMs: number;
  durationMs: number;
  volume?: number;
  muted?: boolean;
}

export interface AssistantTimelineSnapshot {
  totalMs: number;
  selectedRef?: string | null;
  tracks: Array<{ id: string; name: string; kind: string; clips: AssistantClipSnapshot[] }>;
}

export interface EditPlan {
  reply: string;
  actions: AssistantAction[];
}

const ACTION_TYPES = ['removeClip', 'updateClip', 'addCaption', 'seekTo'] as const;

const PLAN_TOOL_SCHEMA = {
  type: 'object',
  properties: {
    reply: { type: 'string', description: '给用户看的中文说明' },
    actions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: [...ACTION_TYPES] },
          ref: { type: 'string', description: '目标片段引用，必须逐字来自快照，如「音乐轨#2」或「选中」' },
          text: { type: 'string', description: 'addCaption 的字幕文本' },
          startMs: { type: 'number', description: '时间线起点（毫秒）' },
          durationMs: { type: 'number', description: '时长（毫秒）' },
          patch: { type: 'object', description: 'updateClip 的字段补丁（startMs/durationMs/offsetMs/volume/muted/fadeInMs/fadeOutMs）' },
        },
        required: ['type'],
      },
    },
  },
  required: ['reply', 'actions'],
} as const;

function requireRef(value: unknown, index: number): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`actions[${index}] 缺少 ref（必须用快照里的片段引用）`);
  return value.trim();
}

function num(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`${field} 必须是数字，实际：${String(value)}`);
  return n;
}

/** 严格解析：形状不对就抛错（错误文本会回灌给模型重试），绝不猜半个动作 */
export function parseEditPlan(value: unknown): EditPlan {
  const raw = value as { reply?: unknown; actions?: unknown };
  if (!raw || typeof raw !== 'object') throw new Error('期望对象 {reply, actions}');
  const reply = typeof raw.reply === 'string' ? raw.reply.trim() : '';
  if (!reply) throw new Error('reply 不能为空：必须告诉用户你要做什么');
  const list = Array.isArray(raw.actions) ? raw.actions : [];
  const actions: AssistantAction[] = list.map((item, index) => {
    const a = item as Record<string, unknown>;
    const type = a?.type;
    if (typeof type !== 'string' || !(ACTION_TYPES as readonly string[]).includes(type)) {
      throw new Error(`actions[${index}].type 非法：${String(type)}，只能是 ${ACTION_TYPES.join('/')}`);
    }
    if (type === 'seekTo') {
      const startMs = num(a.startMs, 'seekTo.startMs');
      if (startMs === undefined) throw new Error('seekTo 缺少 startMs');
      return { type: 'seekTo', startMs: Math.max(0, Math.round(startMs)) };
    }
    if (type === 'addCaption') {
      const text = typeof a.text === 'string' ? a.text.trim() : '';
      if (!text) throw new Error('addCaption 缺少 text');
      const startMs = num(a.startMs, 'addCaption.startMs') ?? 0;
      const durationMs = num(a.durationMs, 'addCaption.durationMs') ?? 3000;
      return { type: 'addCaption', text, startMs: Math.max(0, Math.round(startMs)), durationMs: Math.max(200, Math.round(durationMs)) };
    }
    const ref = requireRef(a.ref, index);
    if (type === 'removeClip') return { type: 'removeClip', ref };
    const patchRaw = (a.patch ?? {}) as Record<string, unknown>;
    const patch: Record<string, number | boolean> = {};
    for (const field of ['startMs', 'durationMs', 'offsetMs', 'volume', 'fadeInMs', 'fadeOutMs'] as const) {
      const n = num(patchRaw[field], `updateClip.patch.${field}`);
      if (n !== undefined) patch[field] = n;
    }
    if (typeof patchRaw.muted === 'boolean') patch.muted = patchRaw.muted;
    if (!Object.keys(patch).length) throw new Error(`actions[${index}].patch 为空：updateClip 至少要改一个字段`);
    return { type: 'updateClip', ref, patch };
  });
  return { reply, actions };
}

function snapshotForPrompt(snapshot: AssistantTimelineSnapshot): string {
  const lines = [`总时长：${(snapshot.totalMs / 1000).toFixed(2)}s`, `选中片段：${snapshot.selectedRef ?? '（无）'}`, '轨道：'];
  for (const track of snapshot.tracks) {
    lines.push(`- ${track.name}（${track.kind}，${track.clips.length} 个片段）`);
    for (const clip of track.clips) {
      const end = (clip.startMs + clip.durationMs) / 1000;
      const audio = `音量${clip.volume ?? 1}${clip.muted ? '·静音' : ''}`;
      lines.push(
        `    ${clip.ref} 「${clip.name}」 ${(clip.startMs / 1000).toFixed(2)}s–${end.toFixed(2)}s ${audio}`,
      );
    }
  }
  return lines.join('\n');
}

/**
 * 把一句自然语言变成可执行的时间线改动。
 *
 * 约束写进 system：只能用快照里的 ref、时间一律毫秒、拿不准就返回空 actions。
 * 这样最坏情况只是"没动手"，不会出现静默改错片段。
 */
export async function planEdits(opts: {
  model: AgentChatModel;
  message: string;
  snapshot: AssistantTimelineSnapshot;
  signal?: AbortSignal;
  logger?: (msg: string) => void;
}): Promise<EditPlan> {
  const system =
    '你是桌面视频剪辑软件的时间线操作助手。你只能依据用户给出的「当前工程快照」操作已存在的片段。' +
    '规则：' +
    '(1) 引用片段时必须逐字使用快照里的 ref（例如「音乐轨#2」），用户说「选中」时对应快照的 selectedRef；' +
    '(2) 所有时间单位为毫秒，1 秒 = 1000；' +
    '(3) 一次可以返回多个动作，按执行顺序排列；' +
    '(4) 快照里没有对应片段、或你不确定要改哪个，就返回空 actions 并在 reply 里说明缺什么，绝不要臆造 ref；' +
    '(5) 只做用户要求的事，不要顺手改别的片段；' +
    '(6) 输出 JSON：{reply:"中文说明", actions:[...]}，reply 简述你将怎么做。' +
    '可用动作：removeClip{ref} / updateClip{ref,patch{startMs,durationMs,offsetMs,volume(0-2),muted,fadeInMs,fadeOutMs}} / ' +
    'addCaption{text,startMs,durationMs} / seekTo{startMs}。';
  const user = JSON.stringify({ message: opts.message, timeline: snapshotForPrompt(opts.snapshot) });

  return invokeStructured<EditPlan>({
    model: opts.model,
    system,
    user,
    tool: { name: 'emit_edit_plan', description: '输出时间线改动计划', schema: PLAN_TOOL_SCHEMA },
    parse: parseEditPlan,
    signal: opts.signal,
    logger: opts.logger,
    fallback: () => ({
      reply: '我没把握直接改时间线，请把目标说得更具体些（例如「删掉音乐轨第 2 段」「把旁白音量降到 0.6」）。',
      actions: [],
    }),
  });
}
