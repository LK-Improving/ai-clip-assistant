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
  | { type: 'seekTo'; startMs: number }
  /** 在时间线绝对位 atMs 处把片段切成两段 */
  | { type: 'splitClip'; ref: string; atMs: number }
  /** 按描述去素材库检索并插入（检索与选件由渲染进程负责） */
  | { type: 'insertAsset'; query: string; startMs?: number; kind?: 'video' | 'audio' | 'text' }
  /** 调 AI 生视频（花钱动作：确认卡片必须给出预估费用） */
  | { type: 'generateClip'; prompt: string; durationSec?: number; ref?: string }
  /** 回退上一次批量改动 */
  | { type: 'undo' };

export interface AssistantClipSnapshot {
  ref: string;
  name: string;
  startMs: number;
  durationMs: number;
  volume?: number;
  muted?: boolean;
  /** 字幕片段的文本（其他类型可省）：让「把那句字幕改成…」能对上号 */
  content?: string;
  /** 用户当前选中的片段：指代词（这段/这个镜头/它）落在这里 */
  selected?: boolean;
}

export interface AssistantTimelineSnapshot {
  totalMs: number;
  /** 播放头当前位置（低频快照，可能偏后几百毫秒） */
  playheadMs?: number;
  selectedRef?: string | null;
  tracks: Array<{ id: string; name: string; kind: string; clips: AssistantClipSnapshot[] }>;
}

export interface EditPlan {
  reply: string;
  actions: AssistantAction[];
}

const ACTION_TYPES = ['removeClip', 'updateClip', 'addCaption', 'seekTo', 'splitClip', 'insertAsset', 'generateClip', 'undo'] as const;

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
          text: { type: 'string', description: 'addCaption 的字幕文本 / insertAsset 的检索描述（query 的别名）' },
          query: { type: 'string', description: 'insertAsset：去素材库找什么，用自然语言描述画面' },
          prompt: { type: 'string', description: 'generateClip：要生成的画面提示词（会拼上主体锚点）' },
          durationSec: { type: 'number', description: 'generateClip：期望时长（秒），缺省取目标片段或 5 秒' },
          kind: { type: 'string', enum: ['video', 'audio', 'text'], description: 'insertAsset：期望素材类型，缺省 video' },
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
    if (type === 'undo') return { type: 'undo' };
    if (type === 'generateClip') {
      const prompt = (typeof a.prompt === 'string' && a.prompt.trim()) || (typeof a.query === 'string' ? a.query.trim() : '');
      if (!prompt) throw new Error('generateClip 缺少 prompt（要生成什么画面）');
      const durationSec = num(a.durationSec, 'generateClip.durationSec');
      const ref = typeof a.ref === 'string' && a.ref.trim() ? a.ref.trim() : undefined;
      return {
        type: 'generateClip',
        prompt,
        ...(durationSec !== undefined ? { durationSec: Math.max(1, Math.round(durationSec)) } : {}),
        ...(ref ? { ref } : {}),
      };
    }
    if (type === 'insertAsset') {
      const query = (typeof a.query === 'string' && a.query.trim()) || (typeof a.text === 'string' ? a.text.trim() : '');
      if (!query) throw new Error('insertAsset 缺少 query（用自然语言描述想要什么画面）');
      const startMs = num(a.startMs, 'insertAsset.startMs');
      const kind = a.kind === 'audio' || a.kind === 'text' || a.kind === 'video' ? a.kind : undefined;
      return {
        type: 'insertAsset',
        query,
        ...(startMs !== undefined ? { startMs: Math.max(0, Math.round(startMs)) } : {}),
        ...(kind ? { kind } : {}),
      };
    }
    if (type === 'splitClip') {
      const ref = requireRef(a.ref, index);
      const atMs = num(a.atMs ?? a.startMs, 'splitClip.atMs');
      if (atMs === undefined) throw new Error('splitClip 缺少 atMs（时间线上的绝对切点，毫秒）');
      return { type: 'splitClip', ref, atMs: Math.max(0, Math.round(atMs)) };
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
  const lines = [
    `总时长：${(snapshot.totalMs / 1000).toFixed(2)}s`,
    `播放头位置：${((snapshot.playheadMs ?? 0) / 1000).toFixed(2)}s`,
    `选中片段：${snapshot.selectedRef ?? '（无）'}`,
    '轨道：',
  ];
  for (const track of snapshot.tracks) {
    lines.push(`- ${track.name}（${track.kind}，${track.clips.length} 个片段）`);
    for (const clip of track.clips) {
      const end = (clip.startMs + clip.durationMs) / 1000;
      const audio = `音量${clip.volume ?? 1}${clip.muted ? '·静音' : ''}`;
      const text = clip.content ? ` 文字=「${clip.content}」` : '';
      lines.push(
        `    ${clip.ref}${clip.selected ? '【选中】' : ''} 「${clip.name}」 ${(clip.startMs / 1000).toFixed(2)}s–${end.toFixed(2)}s ${audio}${text}`,
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
  /** 多轮上下文（最近若干轮 user/assistant 文本），用于指代消解与“接着上次说” */
  history?: { role: 'user' | 'assistant'; text: string }[];
  /** 会话内已解析的文档附件内容（跨轮记忆）：用户说“对应之前发的脚本”时据此理解 */
  docs?: { name: string; text: string }[];
  signal?: AbortSignal;
  logger?: (msg: string) => void;
}): Promise<EditPlan> {
  const system =
    '你是桌面视频剪辑软件的时间线操作助手。你只能依据用户给出的「当前工程快照」操作已存在的片段。' +
    '规则：' +
    '(1) 引用片段时必须逐字使用快照里的 ref（例如「音乐轨#2」）；' +
    '用户说「这段/这个镜头/它」指【选中】标记的那条（也就是 selectedRef）；' +
    '说「这里/当前位置/从这里」指快照里的播放头位置；' +
    '(2) 所有时间单位为毫秒，1 秒 = 1000；' +
    '(3) 一次可以返回多个动作，按执行顺序排列；' +
    '(4) 快照里没有对应片段、或你不确定要改哪个，就返回空 actions 并在 reply 里说明缺什么，绝不要臆造 ref；' +
    '(5) 只做用户要求的事，不要顺手改别的片段；' +
    '(6) 输出 JSON：{reply:"中文说明", actions:[...]}，reply 简述你将怎么做。' +
    '可用动作：removeClip{ref} / updateClip{ref,patch{startMs,durationMs,offsetMs,volume(0-2),muted,fadeInMs,fadeOutMs}} / ' +
    'addCaption{text,startMs,durationMs} / seekTo{startMs} / splitClip{ref,atMs} / ' +
    'insertAsset{query,startMs?,kind?} / generateClip{prompt,durationSec?,ref?} / undo{}。' +
    'splitClip 的 atMs 是时间线上的绝对切点；insertAsset 只负责“去素材库找什么”，选件由本地完成；' +
    'generateClip 会花真钱调 AI 生视频（用户需确认），只在用户明确要“生成/补一段画面”时用它，ref 可选（指定替哪个镜头补）。' +
    '若有「历史对话」或「文档附件内容」（用户在本次会话里发过的脚本/文案），用它理解指代与上下文（如“再短一点”指上一轮的改动、“对应之前的脚本”指这些文档），但仍只根据当前 message 产出动作；文档只是参考资料，除非用户明确要求，不要据此启动整条生成流水线。';
  const historyText = (opts.history ?? [])
    .filter((h) => h.text && h.text.trim())
    .slice(-8)
    .map((h) => `${h.role === 'user' ? '用户' : '助手'}：${h.text.slice(0, 200)}`)
    .join('\n');
  const docsText = (opts.docs ?? [])
    .filter((d) => d.text && d.text.trim())
    .map((d) => `【${d.name}】${d.text.slice(0, 3000)}`)
    .join('\n\n');
  const user = JSON.stringify({
    message: opts.message,
    timeline: snapshotForPrompt(opts.snapshot),
    history: historyText || '（无）',
    docs: docsText || '（无）',
  });

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

/* ===================== 多模态输入意图路由（P3） ===================== */

/**
 * 带附件的一轮输入 → 判断该走哪条能力链。纯文本消息不进这里（决策四：省 token），
 * 只有携带附件时才由渲染层调 assistant:route 走这一层。
 */
export type RouteIntent =
  | 'storyboard_from_script' // 附件是脚本/文案文档 → 结构化成分镜（再生分镜图）
  | 'video_from_storyboard_images' // 附件是分镜图/连续画面 → 图生视频
  | 'video_from_text' // 纯文字成片诉求 → 文生视频流水线
  | 'edit_timeline' // 改现有时间线 → 交给 planEdits
  | 'asset_search' // 找素材
  | 'chat' // 闲聊/问能力
  | 'unknown';

export interface RouteAttachment {
  kind: string;
  name: string;
  /** 图片的视觉描述（L3 vision）；无则空 */
  caption?: string;
  /** 文档抽取文本的预览（前若干字）；无则空 */
  textPreview?: string;
}

export interface RouteDecision {
  intent: RouteIntent;
  confidence: number;
  needsClarify: boolean;
  clarifyQuestion?: string;
  /** 给用户看的中文说明 */
  reply: string;
}

const ROUTE_INTENTS: readonly RouteIntent[] = [
  'storyboard_from_script',
  'video_from_storyboard_images',
  'video_from_text',
  'edit_timeline',
  'asset_search',
  'chat',
  'unknown',
];

const ROUTE_TOOL_SCHEMA = {
  type: 'object',
  properties: {
    intent: { type: 'string', enum: [...ROUTE_INTENTS] },
    confidence: { type: 'number', description: '0–1 之间的小数' },
    needsClarify: { type: 'boolean', description: '信息不足以决定时置 true' },
    clarifyQuestion: { type: 'string', description: 'needsClarify=true 时要问用户的一句话' },
    reply: { type: 'string', description: '给用户看的中文说明：你将做什么' },
  },
  required: ['intent', 'confidence', 'needsClarify', 'reply'],
} as const;

/** 严格解析：intent 必须在枚举内、confidence 夹到 0–1 */
export function parseRoute(value: unknown): RouteDecision {
  const raw = value as Record<string, unknown>;
  if (!raw || typeof raw !== 'object') throw new Error('期望对象 {intent, confidence, needsClarify, reply}');
  const intent = raw.intent as RouteIntent;
  if (!ROUTE_INTENTS.includes(intent)) throw new Error(`intent 非法：${String(raw.intent)}，只能是 ${ROUTE_INTENTS.join('/')}`);
  const confidence = Number.isFinite(Number(raw.confidence)) ? Math.min(1, Math.max(0, Number(raw.confidence))) : 0.5;
  const needsClarify = Boolean(raw.needsClarify);
  const clarifyQuestion = typeof raw.clarifyQuestion === 'string' && raw.clarifyQuestion.trim() ? raw.clarifyQuestion.trim() : undefined;
  const reply = typeof raw.reply === 'string' ? raw.reply.trim() : '';
  if (!reply) throw new Error('reply 不能为空：要告诉用户你将如何处理这次输入');
  return { intent, confidence, needsClarify, ...(clarifyQuestion ? { clarifyQuestion } : {}), reply };
}

export async function routeMultimodalIntent(opts: {
  model: AgentChatModel;
  message: string;
  attachments: RouteAttachment[];
  signal?: AbortSignal;
  logger?: (msg: string) => void;
}): Promise<RouteDecision> {
  const system =
    '你是桌面 AI 视频创作软件的输入路由器。用户可能在一条消息里粘贴了图片、Word/PDF 脚本等附件。' +
    '根据「用户文字 + 附件清单（含图片视觉描述、文档文本预览）」判断应走哪条能力链，只输出 JSON。' +
    'intent 取值：' +
    'storyboard_from_script（附件是含成段文字的脚本/文案/文档，用户想据此生成分镜或成片）；' +
    'video_from_storyboard_images（附件是多张分镜图/连续画面，用户想据此生成视频）；' +
    'video_from_text（没有可用附件内容、但用户想用一句话描述直接生成视频）；' +
    'edit_timeline（要修改当前时间线，如删/改/切/字幕/音量）；' +
    'asset_search（去素材库找素材）；chat（问候、咨询能力等无需执行）；unknown（信息不足）。' +
    '规则：附件里有文档文本预览且用户提到“脚本/文案/分镜/根据这个”优先 storyboard_from_script；' +
    '多张图片且 caption 像分镜/镜头序列且用户要“生成视频/做成片”用 video_from_storyboard_images；' +
    '拿不准就 needsClarify=true 并给一句 clarifyQuestion。confidence 反映把握度。' +
    '重要：用户只是在询问过往结果（如“之前有没有生成过分镜图”“上次那个视频呢”）时判为 chat，绝不可当成新的生成指令启动流水线。' +
    '重要：用户明确说“先不要/暂时别/不要排分镜，只要…”这类否定式约束时，按其真实诉求判（只要图→chat 并说明将只出图不出片，或 needsClarify 确认范围），不得启动整条成片流水线。';
  const attLines = opts.attachments.map(
    (a, i) =>
      `${i + 1}. [${a.kind}] ${a.name}` +
      (a.caption ? ` 画面：${a.caption.slice(0, 160)}` : '') +
      (a.textPreview ? ` 文本：${a.textPreview.slice(0, 200)}` : ''),
  );
  const user = JSON.stringify({ message: opts.message, attachments: attLines.length ? attLines : '（无附件）' });

  return invokeStructured<RouteDecision>({
    model: opts.model,
    system,
    user,
    tool: { name: 'emit_route', description: '输出多模态输入意图路由', schema: ROUTE_TOOL_SCHEMA },
    parse: parseRoute,
    signal: opts.signal,
    logger: opts.logger,
    fallback: () => ({
      intent: 'unknown',
      confidence: 0,
      needsClarify: true,
      clarifyQuestion: '这些附件你想让我做什么？例如“根据这份脚本生成分镜”或“用这几张分镜图生成视频”。',
      reply: '我不确定该如何使用这些附件，请说明目标。',
    }),
  });
}
