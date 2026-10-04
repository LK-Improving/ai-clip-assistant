import {
  ArrowUp,
  Check,
  ChevronRight,
  Download,
  Eraser,
  FileText,
  Film,
  Loader2,
  MessageSquare,
  PanelRightClose,
  PanelRightOpen,
  Paperclip,
  Play,
  Plus,
  RefreshCw,
  Sparkles,
  Square,
  Trash2,
  Undo2,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '@/components/ui/button';
import { ThumbPlaceholder } from '@/components/ui/misc';
import { useApplyTimeline, useCanUndo, useTimelineSelection, useTimelineTracks, undoTimeline } from '@/hooks/use-timeline';
import {
  cancelAgent,
  getAgentSession,
  removeScene,
  resetAgentSession,
  resumeAgent,
  retryAgent,
  startAgent,
  subscribeAgentSession,
  updateScene,
} from '@/lib/agent-session';
import type { AgentSessionState } from '@/lib/agent-session';
import { buildTimelineSnapshot, translatePlan, type PendingGenerate, type PendingInsert } from '@/lib/assistant-apply';
import { getActiveProject, openProject } from '@/lib/active-project';
import { isDockOpen, requestOpenDock, setDockOpen, subscribeDock } from '@/lib/dock-control';
import type { VideoGenCost } from '@/main/services/assistant';
import { getPlayheadMs, nextFreeStart, requestSeek, trackForKind, type TimelineAction } from '@/lib/timeline-store';
import { formatTimecode, timelineTotalMs, type TimelineClip, type TimelineTrack } from '@/lib/timeline-utils';
import type { AnalyzedAttachment, Attachment, ChatThread, LibraryEntry, RouteDecision } from '@/preload';
import { cn } from '@/lib/utils';

/**
 * AI 助手常驻面板（右缘浮层）：既是跨页面的会话式剪辑助手，也是完整的
 * 「一句话成片」流水线宿主——发起 → 分镜确认（内联可编辑）→ 视频生成进度 →
 * 生成完成后「查看视频」跳剪辑页精修、或「另存为」直接导出到所选路径。
 *
 * 开关态提到 lib/dock-control 全局管理：侧栏入口、新建创作、workflow 意图都能从任意位置拉起。
 */

interface DockMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  text: string;
  /** 用户消息携带的附件（图片渲染为可放大缩略图，文档/媒体渲染为文件名 chip） */
  attachments?: { name: string; kind: string; path: string }[];
  /** 附件解析出的文档正文摘要（跨轮记忆：随会话持久化，规划时供大模型回看“之前发的脚本”） */
  docs?: { name: string; text: string }[];
  /** 素材检索结果卡片（可一键入轨） */
  assets?: LibraryEntry[];
  /** 里程碑记录（分镜/成片），渲染为可点击展开的详情卡 */
  record?: {
    kind: 'storyboard' | 'video';
    sceneCount: number;
    totalMs: number;
    projectId?: string;
    scenes?: { order: number; title: string; narration: string; durationMs: number; keyframePath?: string }[];
  };
}

/** 待确认的改动：确认卡片上写的就是实际执行的（同一份 translatePlan 输出） */
interface PendingPlan {
  reply: string;
  lines: string[];
  notes: string[];
  actions: TimelineAction[];
  seekMs: number | null;
  /** 确认时才去素材库检索的插件（translatePlan 是同步的，检索异步） */
  inserts: PendingInsert[];
  /** 确认时才调 AI 生视频（花钱 + 耗时，必须用户点过确认） */
  generations: PendingGenerate[];
  /** 本批生成动作的费用预估；单价未知时 yuan 为 null */
  cost: VideoGenCost | null;
  undo: boolean;
}

const NODE_LABELS: Record<string, string> = {
  'scan-assets': '素材扫描',
  'creative-brief': '创意简报',
  'storyboard-plan': '分镜规划',
  'storyboard-review': '分镜审批',
  'match-assets': '素材匹配',
  'storyboard-image': '分镜关键帧',
  'generate-clips': '视频生成',
  'speech-synthesis': '语音合成',
  'assemble-timeline': '时间线组装',
  validate: '工程校验',
  'save-project': '工程落盘',
};

/** 多模态路由意图的中文标签（确认卡展示用） */
const INTENT_LABEL: Record<string, string> = {
  storyboard_from_script: '根据脚本文档生成分镜',
  video_from_storyboard_images: '用分镜图生成视频（P4）',
  video_from_text: '按描述生成视频',
  edit_timeline: '修改当前时间线',
  asset_search: '检索素材库',
  chat: '仅回复',
  unknown: '需要澄清',
};

/** 按工程画布推画幅比（与流水线 generate-clips 同一规则） */
function ratioForCanvas(): '16:9' | '9:16' | '1:1' {
  const canvas = getActiveProject().canvas;
  if (canvas.height > canvas.width) return '9:16';
  if (canvas.width === canvas.height) return '1:1';
  return '16:9';
}

let seq = 0;
const nextId = () => `m${Date.now().toString(36)}-${seq++}`;

/** 附件是否按文档解析（正文可进跨轮记忆） */
const isDocKind = (kind: string) => kind === 'docx' || kind === 'doc' || kind === 'pdf' || kind === 'text';

function summaryText(tracks: TimelineTrack[]): string {
  const totalMs = timelineTotalMs(tracks);
  const clips = tracks.reduce((n, t) => n + t.clips.length, 0);
  return clips === 0
    ? '时间线还是空的。直接描述需求即可一句话成片，也可以说「找一段猫的视频」查素材库。'
    : `当前工程：${tracks.length} 条轨道 / ${clips} 个片段，总时长 ${formatTimecode(totalMs)}。试试「找一段猫的视频」。`;
}

/** 回答“之前有没有生成过分镜图/成片”这类历史问题：基于里程碑记录卡与当前 Agent 会话本地秒回，不花 token、绝不猜测 */
function historyAnswerText(text: string, session: AgentSessionState, records: DockMessage[]): string {
  const asksVideo = /视频|成片/.test(text) && !/分镜|关键帧|图/.test(text);
  if (asksVideo) {
    const videoRec = [...records].reverse().find((m) => m.record?.kind === 'video')?.record;
    if (videoRec) return `有，之前生成过 ${videoRec.sceneCount} 场 · ${formatTimecode(videoRec.totalMs)} 的成片。展开上方「成片记录」卡片可点「查看视频」跳剪辑页。`;
    if (session.status === 'completed' && session.projectId) return '有，当前会话刚生成完成片，点生成卡片上的「查看视频」即可跳剪辑页。';
    return '当前会话还没有成片记录。直接描述需求即可开始制作（例如「做一段猫的视频」）。';
  }
  const recScenes = [...records].reverse().find((m) => m.record?.scenes?.length)?.record?.scenes;
  const scenes = recScenes?.length
    ? recScenes
    : session.scenes.map((s) => ({ order: s.order, title: s.title, narration: s.narration, durationMs: s.durationMs, keyframePath: s.keyframePath }));
  if (!scenes.length) return '当前会话还没有生成分镜记录。直接描述需求即可开始（分镜会先暂停等你确认，可顺带产出关键帧图）。';
  const totalMs = scenes.reduce((n, s) => n + s.durationMs, 0);
  const withKey = scenes.filter((s) => s.keyframePath).length;
  const head = `有，之前生成过 ${scenes.length} 场分镜（${formatTimecode(totalMs)}）`;
  if (withKey) return `${head}，其中 ${withKey} 场已产出关键帧图。展开上方「分镜记录」卡片，点击缩略图即可放大预览。`;
  return `${head}，但没有关键帧图（图像模型未配置或当时生成失败）。展开上方「分镜记录」卡片可查看各场详情。`;
}

/** 历史询问特征：“之前/上次/刚才…” + 完成体或疑问词 + 生成类名词，三者同时命中才判为在问过往结果 */
const HISTORY_PAST = /之前|以前|刚才|刚刚|上次|此前|先前/;
const HISTORY_ASK = /(?:生成|做|出|产出|跑)过|有没有|是否有|是不是|在哪|哪里|怎么|如何|吗\s*[？?]?\s*$|[？?]\s*$/;

/** 否定指令（“先不要排分镜”“暂时别生成”）：绝不能直接开跑流水线，交给大模型理解真实意图 */
const NEGATED_REQUEST = /(先不|暂时不|不急着?|不要|不用|不需要|别)(?:要|用|着)?[^，。\s]{0,6}(生成|排|做|出|来|剪|搞)/;

/**
 * 极简意图路由：本地能秒回的（检索/摘要/历史询问）不花 token；成片/生图/分镜类直接开跑流水线（含 storyboard-image 关键帧），其余交给大模型规划。
 */
function routeIntent(input: string): string {
  const text = input.trim();
  // 否定式创作词（“先不要排分镜”）是约束/改需求，不是开工指令
  if (NEGATED_REQUEST.test(text)) return 'llm';
  // 历史询问（“之前有生成过分镜图吗”）只是在问过往结果，不能误触发创作流水线或素材检索
  if (HISTORY_PAST.test(text) && (HISTORY_ASK.test(text) || /[？?]\s*$/.test(text)) && /分镜|关键帧|图|成片|视频/.test(text)) return 'history';
  if (/^找|^搜|检索|有没有|查一下/.test(text)) return 'search';
  if (/^现在多长|工程摘要|几个片段|总时长/.test(text)) return 'summary';
  // 成片 / 生图 / 分镜图 / 出图 都归为创作流水线（非时间线编辑）
  if (
    /成片|一键|做个视频|做一条|剪一个|生成.*视频|生成.*图|分镜图|出图|画.*图|生成分镜|根据.*脚本/.test(text) &&
    !/删|去掉|剪掉|改|加字幕|音量/.test(text)
  )
    return 'workflow';
  return 'llm';
}

function clipFromEntry(entry: LibraryEntry): Omit<TimelineClip, 'id'> {
  const kind = entry.kind === 'audio' ? 'audio' : entry.kind === 'subtitle' ? 'text' : 'video';
  return {
    name: entry.name,
    kind,
    start: 0,
    duration: entry.durationMs || 5000,
    offset: 0,
    hue: (entry.name.charCodeAt(0) * 7) % 360,
    assetPath: entry.path.startsWith('mock://') ? undefined : entry.path,
  };
}

/** 按描述从素材库选一条最合适的素材（语义检索 topK 后按类型过滤取首位） */
async function pickAsset(query: string, kind: string): Promise<LibraryEntry | null> {
  const api = window.electronAPI;
  if (!api?.library?.search) return null;
  const hits = await api.library.search(query, 12);
  const hit = hits.find((item) => item.entry.kind === kind) ?? hits.find((item) => !item.entry.error);
  return hit?.entry ?? null;
}

/** 渲染层把 File 读成 base64（分块避免超长参数），交给主进程 attach:save 落盘 */
async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

/** 关键帧放大预览浮层：portal 到 body 渲染（不受浮层/滚动容器 overflow 裁剪），点遮罩或 Esc 关闭 */
function ImageLightbox({ src, caption, onClose }: { src: string; caption?: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  if (typeof document === 'undefined') return null;
  return createPortal(
    <div
      role="dialog"
      aria-label="关键帧放大预览"
      onClick={onClose}
      className="fixed inset-0 z-[120] flex items-center justify-center bg-black/70 p-6 backdrop-blur-sm"
    >
      <div className="relative max-w-4xl" onClick={(event) => event.stopPropagation()}>
        <img src={src} alt={caption ?? ''} className="max-h-[80vh] w-auto rounded-lg bg-secondary object-contain shadow-2xl" />
        {caption ? <p className="mt-2 max-w-[80vw] truncate text-center text-xs text-white/70">{caption}</p> : null}
        <button
          title="关闭（Esc）"
          onClick={onClose}
          className="bg-secondary hover:bg-background absolute -top-3 -right-3 flex size-7 items-center justify-center rounded-full text-foreground shadow-lg"
        >
          <X className="size-4" />
        </button>
      </div>
    </div>,
    document.body,
  );
}

/** 用户消息里的图片附件缩略图：临时目录被清理（miaoma:// 加载失败）时退化为文件名 chip，不留碎图标 */
function AttachmentImageChip({ att, onPreview }: { att: { name: string; path: string }; onPreview: (src: string, caption: string) => void }) {
  const [failed, setFailed] = useState(false);
  const src = window.electronAPI?.toMediaUrl(att.path) ?? '';
  if (failed || !src) {
    return (
      <span className="flex items-center gap-1 rounded-lg border bg-background/60 px-2 py-1 text-[10px] text-muted-foreground">
        <FileText className="size-3 shrink-0" />
        <span className="max-w-32 truncate">{att.name}</span>
      </span>
    );
  }
  return (
    <img
      src={src}
      alt={att.name}
      title={`${att.name}（点击放大预览）`}
      onClick={() => onPreview(src, att.name)}
      onError={() => setFailed(true)}
      className="size-14 cursor-zoom-in rounded-lg border border-input object-cover ring-offset-2 transition-shadow hover:ring-2 hover:ring-primary/70"
    />
  );
}

/** 确认卡内嵌回复框：回车/点击即按普通用户消息发送，大模型带会话上下文（含文档记忆）回应，不必先取消或用底部输入框 */
function CardReplyBox({ placeholder, onSend, disabled }: { placeholder: string; onSend: (text: string) => void; disabled?: boolean }) {
  const [value, setValue] = useState('');
  const send = () => {
    const t = value.trim();
    if (!t) return;
    setValue('');
    onSend(t);
  };
  return (
    <div className="mt-2 flex items-center gap-1.5">
      <input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            send();
          }
        }}
        placeholder={placeholder}
        disabled={disabled}
        className="min-w-0 flex-1 rounded-md border border-input bg-transparent px-2 py-1 text-[11px] outline-none placeholder:text-muted-foreground focus:border-ring disabled:opacity-50"
      />
      <Button size="sm" variant="ghost" className="h-6 shrink-0 gap-1 rounded-full border border-input px-2 text-[11px]" disabled={disabled || !value.trim()} onClick={send}>
        <ArrowUp className="size-3" /> 回复
      </Button>
    </div>
  );
}

/** 里程碑记录卡：点击展开查看分镜/成片详情；成片记录可直接跳剪辑页查看 */
function RecordCard({ record }: { record: NonNullable<DockMessage['record']> }) {
  const [expanded, setExpanded] = useState(false);
  const [preview, setPreview] = useState<{ src: string; caption?: string } | null>(null);
  const isVideo = record.kind === 'video';
  return (
    <div className="w-full max-w-[92%] overflow-hidden rounded-lg border bg-background/60">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[11px]"
      >
        <span className={cn('flex size-6 shrink-0 items-center justify-center rounded', isVideo ? 'bg-brand text-white' : 'bg-secondary text-primary')}>
          {isVideo ? <Play className="size-3.5" /> : <Film className="size-3.5" />}
        </span>
        <span className="min-w-0 flex-1 truncate font-medium">
          {isVideo ? '成片记录' : '分镜记录'} · {record.sceneCount} 场 · {formatTimecode(record.totalMs)}
        </span>
        <ChevronRight className={cn('size-3.5 shrink-0 text-muted-foreground transition-transform', expanded && 'rotate-90')} />
      </button>
      {expanded ? (
        <div className="max-h-72 space-y-2 overflow-y-auto border-t px-2.5 py-2">
          {record.scenes?.map((s) => (
            <div key={s.order} className="flex items-start gap-2 text-[11px] leading-relaxed">
              {s.keyframePath ? (
                <img
                  src={window.electronAPI?.toMediaUrl(s.keyframePath)}
                  alt=""
                  title="点击放大预览"
                  onClick={() => setPreview({ src: window.electronAPI!.toMediaUrl(s.keyframePath!), caption: `${String(s.order + 1).padStart(2, '0')} · ${s.title || '（无标题）'}` })}
                  className="size-10 shrink-0 cursor-zoom-in rounded object-cover ring-offset-2 transition-shadow hover:ring-2 hover:ring-primary/70"
                />
              ) : (
                <ThumbPlaceholder hue={(s.order * 47) % 360} className="size-10 shrink-0 rounded" />
              )}
              <div className="min-w-0">
                <p className="text-muted-foreground">
                  {String(s.order + 1).padStart(2, '0')} · {(s.durationMs / 1000).toFixed(1)}s
                </p>
                <p className="font-medium">{s.title || '（无标题）'}</p>
                {s.narration ? <p className="text-muted-foreground">{s.narration}</p> : null}
              </div>
            </div>
          ))}
          {isVideo && record.projectId ? (
            <button
              onClick={() => {
                void (async () => {
                  const project = await openProject(record.projectId!);
                  if (project) {
                    setDockOpen(true);
                    window.location.hash = '#/editor';
                  }
                })();
              }}
              className="bg-brand flex w-full items-center justify-center gap-1.5 rounded-full py-1.5 text-[11px] font-medium text-white hover:opacity-95"
            >
              <Play className="size-3.5" /> 查看视频
            </button>
          ) : null}
        </div>
      ) : null}
      {preview ? <ImageLightbox src={preview.src} caption={preview.caption} onClose={() => setPreview(null)} /> : null}
    </div>
  );
}

/**
 * AI 助手面板（共享组件）：会话式剪辑 + 完整「一句话成片」流水线宿主。
 * - variant='page'：整页形态（/chat 对话页），始终展开、无把手；
 * - variant='drawer'：右缘浮层（仅剪辑页），开关态由 lib/dock-control 管理。
 */
export function AssistantPanel({ variant }: { variant: 'page' | 'drawer' }) {
  const [open, setOpen] = useState(isDockOpen);
  const isOpen = variant === 'page' || open;
  const [input, setInput] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [busy, setBusy] = useState(false);
  const [session, setSession] = useState<AgentSessionState>(getAgentSession);
  const tracks = useTimelineTracks();
  const [selection] = useTimelineSelection();
  const applyActions = useApplyTimeline();
  const [messages, setMessages] = useState<DockMessage[]>([]);
  const [pending, setPending] = useState<PendingPlan | null>(null);
  const [routePending, setRoutePending] = useState<{
    decision: RouteDecision;
    analyzed: AnalyzedAttachment[];
    message: string;
    /** 原始附件列表（含本地路径）：启动流水线时图片附件要作为角色参考图透传 */
    atts: Attachment[];
  } | null>(null);
  const [applying, setApplying] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [regen, setRegen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportPct, setExportPct] = useState<number | null>(null);
  // 分镜关键帧/附件图片放大预览浮层（点击缩略图打开）
  const [keyframePreview, setKeyframePreview] = useState<{ src: string; caption?: string } | null>(null);
  // 会话管理（仅整页 /chat）：多会话列表 + 当前会话 + 项目绑定
  const [threads, setThreads] = useState<ChatThread[]>([]);
  const [currentId, setCurrentId] = useState('');
  const [boundProject, setBoundProject] = useState<{ id: string; name: string } | null>(null);
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([]);
  const currentThreadRef = useRef<ChatThread | null>(null);
  const saveTimer = useRef<number | undefined>(undefined);
  const undoable = useCanUndo();
  const listRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const greeted = useRef(false);
  const lastRecordRef = useRef('');
  // 历史询问（“之前有生成过分镜图吗”）需要读最新消息列表，用 ref 避免把 messages 塞进 ask 的依赖导致频繁重建
  const messagesRef = useRef<DockMessage[]>([]);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  /** 推一条消息并返回其 id（附件解析完成后需要回填到刚推的用户消息上） */
  const push = useCallback((message: Omit<DockMessage, 'id'>): string => {
    const id = nextId();
    setMessages((prev) => [...prev.slice(-59), { ...message, id }]);
    return id;
  }, []);

  /** 把解析出的文档正文回填到指定消息（跨轮记忆载体，随会话持久化） */
  const attachDocsToMessage = useCallback((msgId: string, analyzed: AnalyzedAttachment[]) => {
    const docs = analyzed.filter((r) => isDocKind(r.kind) && r.text.trim()).map((r) => ({ name: r.name, text: r.text.slice(0, 4000) }));
    if (!docs.length) return;
    setMessages((prev) => prev.map((m) => (m.id === msgId ? { ...m, docs } : m)));
  }, []);

  /** 接收粘贴/选择的文件：主进程落临时目录，回显为附件 chips */
  const ingestFiles = useCallback(
    async (files: File[]) => {
      if (!files.length) return;
      const api = window.electronAPI;
      if (!api?.attach?.save) {
        push({ role: 'system', text: '需在桌面端才能接收附件（浏览器预览模式不支持）。' });
        return;
      }
      for (const file of files) {
        try {
          const dataBase64 = await fileToBase64(file);
          const att = await api.attach.save({ name: file.name, mime: file.type, dataBase64 });
          setAttachments((prev) => [...prev, att]);
        } catch (error) {
          push({ role: 'system', text: `附件「${file.name}」接收失败：${(error as Error).message}` });
        }
      }
    },
    [push],
  );

  /** P2：对附件跑 L1–L2 解析（文档→字数概览；图片回视觉描述或不可用原因），回显结果；文档正文回填到 msgId 消息作跨轮记忆 */
  const analyzeAndReport = useCallback(
    async (atts: Attachment[], msgId?: string) => {
      const api = window.electronAPI;
      if (!api?.input?.analyze) return;
      try {
        const results = await api.input.analyze(atts);
        if (msgId) attachDocsToMessage(msgId, results);
        for (const r of results) {
          if (isDocKind(r.kind)) {
            push({
              role: 'system',
              text: `已解析「${r.name}」：约 ${r.chars} 字${r.pageCount ? ` · ${r.pageCount} 页` : ''}${r.note ? ` · ${r.note}` : ''}`,
            });
          } else {
            push({ role: 'system', text: r.note ?? `「${r.name}」已接收` });
          }
        }
      } catch (error) {
        push({ role: 'system', text: `附件解析失败：${(error as Error).message}` });
      }
    },
    [push, attachDocsToMessage],
  );
  useEffect(() => subscribeDock(() => setOpen(isDockOpen())), []);
  useEffect(() => {
    if (variant !== 'drawer' || !open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setDockOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, variant]);

  // AI 事件流：终态写进会话；分镜待确认 / 生成完成时自动拉起浮层，并落一条可点击回看的里程碑记录
  useEffect(
    () =>
      subscribeAgentSession((next) => {
        setSession(next);
        const scenesLite = next.scenes.map((s) => ({ order: s.order, title: s.title, narration: s.narration, durationMs: s.durationMs, keyframePath: s.keyframePath }));
        const totalMs = next.scenes.reduce((n, s) => n + s.durationMs, 0);
        if (next.status === 'error' && next.error) {
          push({ role: 'system', text: `AI 任务失败：${next.error}` });
        } else if (next.status === 'completed') {
          push({ role: 'system', text: 'AI 成片完成，可查看视频或导出。' });
          const key = `video:${next.projectId ?? totalMs}`;
          if (key !== lastRecordRef.current) {
            lastRecordRef.current = key;
            push({ role: 'assistant', text: '', record: { kind: 'video', sceneCount: next.scenes.length, totalMs, projectId: next.projectId ?? undefined, scenes: scenesLite } });
          }
          requestOpenDock();
        } else if (next.status === 'interrupted') {
          const key = `sb:${next.requirement?.length ?? 0}:${next.scenes.length}`;
          if (key !== lastRecordRef.current) {
            lastRecordRef.current = key;
            push({ role: 'assistant', text: '', record: { kind: 'storyboard', sceneCount: next.scenes.length, totalMs, scenes: scenesLite } });
          }
          requestOpenDock();
        }
      }),
    [push],
  );

  // 首次展开（或整页首次挂载）时补一条当前工程摘要（之后不重复刷）
  useEffect(() => {
    if (!isOpen || greeted.current) return;
    greeted.current = true;
    push({ role: 'assistant', text: summaryText(tracks) });
  }, [isOpen, push, tracks]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  const runAssetSearch = useCallback(
    async (text: string) => {
      const api = window.electronAPI;
      const query = text.replace(/帮我|找一段|找|搜索|查一下|有没有|的(视频|素材|图片|音频)|请问|一下/g, ' ').trim();
      if (!api?.library?.search || !query) {
        push({ role: 'assistant', text: '需要桌面端并给出关键词，例如「找一段猫的视频」。' });
        return;
      }
      const hits = await api.library.search(query, 8);
      const entries = hits.map((h) => h.entry);
      push(
        entries.length
          ? { role: 'assistant', text: `素材库找到 ${entries.length} 条与「${query}」相近的素材：`, assets: entries }
          : { role: 'assistant', text: `素材库里没有匹配「${query}」的素材（可先在素材页扫描目录）。` },
      );
    },
    [push],
  );

  /** 大模型规划时间线改动（只出计划，用户确认后才执行）；纯文本与 edit_timeline 路由共用 */
  const runPlanEdits = useCallback(
    async (text: string) => {
      const api = window.electronAPI;
      if (!api?.assistant?.plan) {
        push({ role: 'system', text: '需在桌面端使用：浏览器预览模式无法调用大模型。' });
        return;
      }
      const plan = await api.assistant.plan({
        message: text,
        snapshot: buildTimelineSnapshot(tracks, selection, getPlayheadMs()),
        history: messages
          .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.text.trim())
          .slice(-8)
          .map((m) => ({ role: m.role as 'user' | 'assistant', text: m.text })),
        // 跨轮记忆：会话内解析过的文档正文（取最近 3 份），让“对应之前发的脚本”能被理解
        docs: messages.flatMap((m) => m.docs ?? []).slice(-3),
      });
      const translated = translatePlan(plan, tracks, selection);
      push({ role: 'assistant', text: plan.reply });
      for (const note of translated.notes) push({ role: 'system', text: note });
      const hasWork =
        translated.actions.length > 0 ||
        translated.seekMs !== null ||
        translated.inserts.length > 0 ||
        translated.generations.length > 0 ||
        translated.undo;
      if (hasWork) {
        setPending({
          reply: plan.reply,
          lines: translated.lines,
          notes: translated.notes,
          actions: translated.actions,
          seekMs: translated.seekMs,
          inserts: translated.inserts,
          generations: translated.generations,
          cost: plan.cost ?? null,
          undo: translated.undo,
        });
      } else if (!translated.lines.length) {
        push({ role: 'system', text: '本次没有可执行的改动，时间线未变。' });
      }
    },
    [push, tracks, selection, messages],
  );

  const ask = useCallback(
    async (raw: string) => {
      const text = raw.trim();
      if (!text && attachments.length === 0) return;
      const atts = attachments;
      const names = atts.map((a) => a.name);
      const shown = names.length ? (text ? `${text}\n📎 附件：${names.join('、')}` : `📎 附件：${names.join('、')}`) : text;
      const userMsgId = push({ role: 'user', text: shown, attachments: atts.length ? atts.map((a) => ({ name: a.name, kind: a.kind, path: a.path })) : undefined });
      setInput('');
      setAttachments([]);

      // 带附件 + 有正文：走 P3 多模态路由（analyze → route → 确认闸门），不跑本地文本意图
      if (atts.length && text) {
        setBusy(true);
        try {
          const api = window.electronAPI;
          const analyzed = api?.input?.analyze ? await api.input.analyze(atts) : [];
          attachDocsToMessage(userMsgId, analyzed);
          for (const r of analyzed) {
            push({
              role: 'system',
              text:
                isDocKind(r.kind)
                  ? `已解析「${r.name}」：约 ${r.chars} 字${r.pageCount ? ` · ${r.pageCount} 页` : ''}`
                  : r.caption
                    ? `已识别图片「${r.name}」：${r.caption.slice(0, 60)}`
                    : (r.note ?? `「${r.name}」已接收`),
            });
          }
          if (!api?.assistant?.route) {
            push({ role: 'system', text: '需在桌面端且配好大模型才能自动路由附件用途。' });
          } else {
            const decision = await api.assistant.route({
              message: text,
              attachments: analyzed.map((a) => ({ kind: a.kind, name: a.name, caption: a.caption, textPreview: a.text.slice(0, 500) })),
            });
            setRoutePending({ decision, analyzed, message: text, atts });
          }
        } catch (error) {
          push({ role: 'system', text: `附件处理出错：${(error as Error).message}` });
        } finally {
          setBusy(false);
        }
        return;
      }

      // 只有附件、无正文：解析回显 + 提示说明用途（文档正文回填到本条消息作跨轮记忆）
      if (atts.length) {
        void analyzeAndReport(atts, userMsgId);
        push({ role: 'system', text: `已接收 ${names.length} 个附件。想让我做什么？例如“根据这份脚本生成分镜”或“用这几张分镜图生成视频”。` });
        return;
      }

      // 纯文本：本地意图路由（决策四：跳过 L1–L4，省 token）
      setBusy(true);
      try {
        const intent = routeIntent(text);
        if (intent === 'summary') {
          push({ role: 'assistant', text: summaryText(tracks) });
        } else if (intent === 'history') {
          push({ role: 'assistant', text: historyAnswerText(text, getAgentSession(), messagesRef.current) });
        } else if (intent === 'workflow') {
          const ok = await startAgent(text, session.sourceDirs);
          if (ok) {
            requestOpenDock();
            push({ role: 'assistant', text: '已开始生成，进度和分镜确认都在下方卡片进行。' });
          } else {
            push({ role: 'system', text: '需在桌面端使用：浏览器预览模式无法调用 AI 引擎。' });
          }
        } else if (intent === 'search') {
          await runAssetSearch(text);
        } else {
          await runPlanEdits(text);
        }
      } catch (error) {
        push({ role: 'system', text: `出错了：${(error as Error).message}` });
      } finally {
        setBusy(false);
      }
    },
    [push, tracks, session.sourceDirs, attachments, analyzeAndReport, attachDocsToMessage, runAssetSearch, runPlanEdits],
  );

  /**
   * 确认应用：先按需回退，再把 insertAsset 异步解析成 addClip，最后走统一 action 通道。
   */
  const confirmPending = useCallback(async () => {
    if (!pending || applying) return;
    setApplying(true);
    const parts: string[] = [];
    try {
      if (pending.undo) {
        const undone = undoTimeline();
        parts.push(undone ? `已撤销上一次改动（还剩 ${undone.remaining} 步可退）` : '没有可撤销的改动');
      }

      const actions = [...pending.actions];
      for (const insert of pending.inserts) {
        const entry = await pickAsset(insert.query, insert.kind);
        if (!entry) {
          parts.push(`素材库没找到「${insert.query}」，这条未执行`);
          continue;
        }
        const track = trackForKind(insert.kind);
        if (!track) {
          parts.push(`目标轨道已不存在，「${entry.name}」未插入`);
          continue;
        }
        const base = clipFromEntry(entry);
        actions.push({
          type: 'addClip',
          trackId: track.id,
          clip: { ...base, start: insert.startMs ?? nextFreeStart(track) },
        });
        parts.push(`已选用「${entry.name}」`);
      }

      if (pending.seekMs !== null) requestSeek(pending.seekMs);

      // 生成动作：花钱且单段 1–3 分钟，只能在用户点过确认后走到这里
      if (pending.generations.length) {
        const api = window.electronAPI;
        if (!api?.assistant?.generateClips) {
          parts.push('需在桌面端才能调 AI 生视频');
        } else {
          const outcomes = await api.assistant.generateClips(
            pending.generations.map((g) => ({ prompt: g.prompt, durationSec: g.durationSec, ratio: ratioForCanvas() })),
          );
          outcomes.forEach((outcome, i) => {
            const want = pending.generations[i];
            if (!want) return;
            if (!outcome.ok || !outcome.videoPath) {
              parts.push(`第 ${i + 1} 段生成失败：${outcome.error ?? '未知原因'}`);
              return;
            }
            const track = tracks.find((item) => item.id === want.trackId) ?? trackForKind('video');
            if (!track) {
              parts.push(`第 ${i + 1} 段已生成但没有可放入的轨道`);
              return;
            }
            const durationMs = outcome.durationMs ?? want.durationSec * 1000;
            actions.push({
              type: 'addClip',
              trackId: track.id,
              clip: {
                name: `AI生成-${want.prompt.slice(0, 8)}.${outcome.ext ?? 'mp4'}`,
                kind: 'video',
                start: want.startMs ?? nextFreeStart(track),
                duration: durationMs,
                offset: 0,
                hue: 280,
                assetPath: outcome.videoPath,
              },
            });
            if (want.replaceClipId) {
              actions.push({
                type: 'removeClip',
                trackId: want.replaceTrackId ?? track.id,
                clipId: want.replaceClipId,
              });
            }
            parts.push(`第 ${i + 1} 段已生成并入轨（${formatTimecode(durationMs)}）`);
          });
        }
      }

      if (actions.length) {
        const result = applyActions(actions);
        if (result.applied > 0) parts.push(`已应用 ${result.applied} 项改动`);
        if (result.skipped.length) parts.push(`跳过：${result.skipped.join('；')}`);
      } else if (pending.seekMs !== null) {
        parts.push('已跳转播放头');
      }
    } catch (error) {
      parts.push(`执行出错：${(error as Error).message}`);
    } finally {
      setApplying(false);
    }

    push({ role: 'system', text: parts.join(' · ') || '未产生任何改动' });
    setPending(null);
  }, [applying, applyActions, pending, push]);

  const undoLast = useCallback(() => {
    const undone = undoTimeline();
    push({
      role: 'system',
      text: undone ? `已撤销上一次改动（${undone.clips} 个片段，还剩 ${undone.remaining} 步可退）` : '没有可撤销的改动。',
    });
  }, [push]);

  const cancelPending = useCallback(() => {
    setPending(null);
    push({ role: 'system', text: '已取消，时间线未变。' });
  }, [push]);

  /** 确认路由结果：按 intent 分派到对应能力链（storyboard_from_script 已可端到端跑通） */
  const confirmRoute = useCallback(async () => {
    if (!routePending) return;
    const { decision, analyzed, message } = routePending;
    setRoutePending(null);
    switch (decision.intent) {
      case 'storyboard_from_script': {
        const docs = analyzed.filter((a) => a.kind === 'docx' || a.kind === 'doc' || a.kind === 'pdf' || a.kind === 'text');
        const script = docs.map((d) => d.text).join('\n\n').trim();
        // 角色设计图：本地路径作参考图透传给 storyboard-image 锁主体外貌；视觉描述写进需求，让分镜规划就固定角色特征
        const refImages = (routePending.atts ?? []).filter((a) => a.kind === 'image').map((a) => a.path);
        const imageCaptions = analyzed.filter((a) => a.kind === 'image' && a.caption).map((a) => `${a.name}：${a.caption}`);
        let requirement = script ? `${message}\n\n【附件脚本】\n${script.slice(0, 6000)}` : message;
        if (imageCaptions.length) {
          requirement += `\n\n【角色设计图特征】\n${imageCaptions.join('；')}\n（所有镜头的主角必须保持上述发型、发色与服装特征，跨镜头不得变化）`;
        }
        const ok = await startAgent(requirement, session.sourceDirs, refImages);
        if (ok) {
          requestOpenDock();
          push({ role: 'assistant', text: refImages.length ? `已根据脚本文档启动分镜生成，并以 ${refImages.length} 张角色设计图锁定主体一致性，进度与分镜确认见下方卡片。` : '已根据脚本文档启动分镜生成，进度与分镜确认见下方卡片。' });
        } else {
          push({ role: 'system', text: '需在桌面端运行 AI 引擎。' });
        }
        break;
      }
      case 'video_from_text': {
        const refImages = (routePending.atts ?? []).filter((a) => a.kind === 'image').map((a) => a.path);
        const ok = await startAgent(message, session.sourceDirs, refImages);
        if (ok) {
          requestOpenDock();
          push({ role: 'assistant', text: '已开始生成。' });
        }
        break;
      }
      case 'video_from_storyboard_images':
        push({ role: 'system', text: '识别为「分镜图 → 视频」。图生视频（I2V）将在 P4 接入，届时这些图会作为每段首帧驱动生成。' });
        break;
      case 'edit_timeline':
        await runPlanEdits(message);
        break;
      case 'asset_search':
        await runAssetSearch(message);
        break;
      default:
        push({ role: 'assistant', text: decision.clarifyQuestion ?? decision.reply });
    }
  }, [routePending, session.sourceDirs, push, runPlanEdits, runAssetSearch]);

  const cancelRoute = useCallback(() => {
    if (!routePending) return;
    push({ role: 'system', text: '已取消，未执行。' });
    setRoutePending(null);
  }, [routePending, push]);

  /* ===== 会话管理（仅整页 /chat）：多会话 + 持久化 + 项目绑定 ===== */
  const newThreadId = () => `t${Date.now().toString(36)}-${Math.floor(Math.random() * 1e4).toString(36)}`;

  const applyThread = useCallback((t: ChatThread) => {
    setCurrentId(t.id);
    setMessages((t.messages as DockMessage[]) ?? []);
    greeted.current = ((t.messages?.length ?? 0) > 0);
    const pid = t.projectId;
    if (pid) void openProject(pid).then((p) => setBoundProject(p ? { id: pid, name: p.name } : null));
    else setBoundProject(null);
  }, []);

  // 挂载：拉项目列表 + 会话列表（无则建一条），并进入首条会话
  useEffect(() => {
    if (variant !== 'page') return;
    void (async () => {
      const api = window.electronAPI;
      if (!api?.chat) return;
      try {
        setProjects((await api.project.list()).map((p) => ({ id: p.id, name: p.name })));
      } catch {
        /* 预览模式无项目列表 */
      }
      let list: ChatThread[];
      try {
        list = await api.chat.list();
        if (!list.length) {
          list = [await api.chat.save({ id: newThreadId(), title: '新对话', projectId: null, createdAt: Date.now(), updatedAt: Date.now(), messages: [] })];
        }
      } catch {
        // 主进程未注册 chat handler（旧构建）或落盘失败：退化为内存态单会话，不阻断页面
        list = [{ id: newThreadId(), title: '新对话', projectId: null, createdAt: Date.now(), updatedAt: Date.now(), messages: [] }];
      }
      setThreads(list);
      if (list[0]) applyThread(list[0]);
    })();
  }, [variant, applyThread]);

  // 同步当前会话引用
  useEffect(() => {
    currentThreadRef.current = threads.find((t) => t.id === currentId) ?? null;
  }, [threads, currentId]);

  // 消息变化 → 防抖持久化到当前会话（首条用户消息自动作为标题）
  useEffect(() => {
    if (variant !== 'page' || !currentId) return;
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      const api = window.electronAPI;
      const cur = currentThreadRef.current;
      if (!api?.chat || !cur) return;
      const firstUser = messages.find((m) => m.role === 'user')?.text?.trim();
      const title = cur.title === '新对话' && firstUser ? firstUser.slice(0, 24) : cur.title;
      void api.chat
        .save({ ...cur, title, messages })
        .then((saved) => setThreads((prev) => prev.map((t) => (t.id === saved.id ? saved : t))))
        .catch(() => {
          /* 旧构建无 handler / 落盘失败：保持内存态 */
        });
    }, 600);
    return () => window.clearTimeout(saveTimer.current);
  }, [messages, currentId, variant]);

  const handleNewThread = useCallback(async () => {
    const api = window.electronAPI;
    if (!api?.chat) return;
    let t: ChatThread;
    try {
      t = await api.chat.save({ id: newThreadId(), title: '新对话', projectId: null, createdAt: Date.now(), updatedAt: Date.now(), messages: [] });
    } catch {
      t = { id: newThreadId(), title: '新对话', projectId: null, createdAt: Date.now(), updatedAt: Date.now(), messages: [] };
    }
    setThreads((prev) => [t, ...prev]);
    applyThread(t);
  }, [applyThread]);

  const handleSwitchThread = useCallback(
    (id: string) => {
      if (id === currentId) return;
      const t = threads.find((x) => x.id === id);
      if (t) applyThread(t);
    },
    [currentId, threads, applyThread],
  );

  const handleDeleteThread = useCallback(
    async (id: string) => {
      const api = window.electronAPI;
      if (!api?.chat) return;
      try {
        await api.chat.remove(id);
      } catch {
        /* 旧构建无 handler：仅本地移除 */
      }
      const rest = threads.filter((t) => t.id !== id);
      setThreads(rest);
      if (id === currentId) {
        if (rest[0]) applyThread(rest[0]);
        else void handleNewThread();
      }
    },
    [threads, currentId, applyThread, handleNewThread],
  );

  const handleBindProject = useCallback(async (id: string) => {
    const api = window.electronAPI;
    if (!api) return;
    const cur = currentThreadRef.current;
    const persist = async (patch: Partial<ChatThread>) => {
      if (!cur || !api.chat) return;
      try {
        const s = await api.chat.save({ ...cur, ...patch });
        setThreads((prev) => prev.map((t) => (t.id === s.id ? s : t)));
      } catch {
        setThreads((prev) => prev.map((t) => (t.id === cur.id ? { ...t, ...patch } : t)));
      }
    };
    if (!id) {
      setBoundProject(null);
      await persist({ projectId: null });
      return;
    }
    const p = await openProject(id);
    if (!p) return;
    setBoundProject({ id, name: p.name });
    await persist({ projectId: id });
  }, []);

  const insertAsset = useCallback(
    (entry: LibraryEntry) => {
      const track = trackForKind(entry.kind === 'audio' ? 'audio' : entry.kind === 'subtitle' ? 'text' : 'video');
      if (!track) {
        push({ role: 'system', text: '时间线里没有可用轨道，先去编辑器加一条。' });
        return;
      }
      const base = clipFromEntry(entry);
      const result = applyActions([{ type: 'addClip', trackId: track.id, clip: { ...base, start: nextFreeStart(track) } }]);
      push({
        role: 'system',
        text: result.applied
          ? `已把「${entry.name}」加到「${track.name}」，时长 ${formatTimecode(base.duration)}。`
          : `加入失败：${result.skipped.join('；')}`,
      });
    },
    [applyActions, push],
  );

  const totalSceneMs = useMemo(() => session.scenes.reduce((n, s) => n + s.durationMs, 0), [session.scenes]);

  const handleResume = useCallback(async () => {
    setConfirming(true);
    await resumeAgent();
    setConfirming(false);
  }, []);

  const handleRegenerate = useCallback(async () => {
    const req = session.requirement?.trim();
    if (!req) return;
    setRegen(true);
    // 重新生成必须带上原参考图，否则关键帧退化为纯文生图、刚锁住的主体一致性又丢
    await startAgent(req, session.sourceDirs, session.referenceImages);
    setRegen(false);
  }, [session.requirement, session.sourceDirs, session.referenceImages]);

  const viewVideo = useCallback(async () => {
    const id = session.projectId;
    if (!id) return;
    const project = await openProject(id);
    if (project) {
      // 跳剪辑页并以抽屉形式展开 AI 助手（对话页→剪辑页的唯一跳转入口）
      setDockOpen(true);
      window.location.hash = '#/editor';
    }
  }, [session.projectId]);

  /** 另存为导出成片：选目标路径 → render:start 落盘 → 浮层内展示进度 */
  const exportVideo = useCallback(async () => {
    const api = window.electronAPI;
    const id = session.projectId;
    if (!api?.render || !id) {
      push({ role: 'system', text: '需在桌面端且成片已生成后才能导出。' });
      return;
    }
    const project = await openProject(id);
    if (!project) {
      push({ role: 'system', text: '成片工程加载失败，无法导出。' });
      return;
    }
    const safeName = (project.name || '成片').replace(/[\\/:*?"<>|]/g, '_');
    const outPath = await api.export?.pickSavePath?.(`${safeName}.mp4`);
    if (!outPath) return;
    setExporting(true);
    setExportPct(0);
    const unsub = api.render.onProgress((p) => setExportPct(Math.round(p.percent)));
    try {
      await api.render.start({ project, outputPath: outPath, quality: 'high' });
      setExportPct(100);
      push({ role: 'system', text: `已导出到：${outPath}` });
      void api.shell?.openPath(outPath);
    } catch (error) {
      const msg = (error as Error).message;
      push({ role: 'system', text: msg.includes('RENDER_CANCELLED') ? '导出已取消' : `导出失败：${msg}` });
    } finally {
      unsub();
      setExporting(false);
    }
  }, [push, session.projectId]);

  if (variant === 'drawer' && !open) {
    return null;
  }

  const running = session.status === 'running';
  const shellClass =
    variant === 'drawer'
      ? 'fixed top-12 right-0 bottom-0 z-40 flex w-[360px] flex-col border-l bg-card/97 shadow-2xl shadow-black/40 backdrop-blur'
      : 'flex h-full min-h-0 flex-row bg-background';

  return (
    <div className={shellClass}>
      {variant === 'page' ? (
        <aside className="flex w-60 shrink-0 flex-col border-r bg-card/40">
          <div className="flex h-11 shrink-0 items-center gap-2 border-b px-3">
            <Sparkles className="size-4 text-primary" />
            <span className="text-sm font-semibold">AI 助手</span>
            <button
              onClick={() => void handleNewThread()}
              title="新建会话"
              className="ml-auto rounded p-1 text-muted-foreground hover:bg-secondary hover:text-foreground"
            >
              <Plus className="size-4" />
            </button>
          </div>
          <div className="border-b p-2">
            <label className="mb-1 block text-[10px] text-muted-foreground">关联项目（对话将改该项目时间线）</label>
            <select
              value={boundProject?.id ?? ''}
              onChange={(e) => void handleBindProject(e.target.value)}
              className="h-8 w-full rounded-md border border-input bg-transparent px-2 text-xs outline-none focus:border-ring"
            >
              <option value="">未绑定（自由创作）</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
          <div className="min-h-0 flex-1 space-y-1 overflow-y-auto p-2">
            {threads.map((t) => (
              <div
                key={t.id}
                className={cn(
                  'group flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs',
                  t.id === currentId ? 'bg-primary/15 text-white' : 'text-muted-foreground hover:bg-secondary hover:text-foreground',
                )}
              >
                <MessageSquare className="size-3.5 shrink-0" />
                <button onClick={() => handleSwitchThread(t.id)} className="min-w-0 flex-1 truncate text-left" title={t.title}>
                  {t.title}
                </button>
                <button
                  onClick={() => void handleDeleteThread(t.id)}
                  title="删除会话"
                  className="shrink-0 opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
                >
                  <Trash2 className="size-3.5" />
                </button>
              </div>
            ))}
          </div>
        </aside>
      ) : null}

      <div className="flex min-w-0 flex-1 flex-col">
      <header className="flex h-11 shrink-0 items-center gap-2 border-b px-3">
        <Sparkles className="size-4 text-primary" />
        <span className="text-sm font-semibold">AI 助手</span>
        <div className="ml-auto flex items-center gap-1">
          <button
            title={undoable ? '撤销上一次时间线改动' : '没有可撤销的改动'}
            onClick={undoLast}
            disabled={!undoable}
            className="rounded p-1 text-muted-foreground hover:bg-secondary hover:text-foreground disabled:opacity-40"
          >
            <Undo2 className="size-3.5" />
          </button>
          <button
            title="清空会话"
            onClick={() => {
              greeted.current = true;
              setMessages([{ id: nextId(), role: 'assistant', text: summaryText(tracks) }]);
            }}
            className="rounded p-1 text-muted-foreground hover:bg-secondary hover:text-foreground"
          >
            <Eraser className="size-3.5" />
          </button>
          {variant === 'drawer' ? (
            <button
              title="收起面板"
              onClick={() => setDockOpen(false)}
              className="rounded p-1 text-muted-foreground hover:bg-secondary hover:text-foreground"
            >
              <PanelRightClose className="size-4" />
            </button>
          ) : null}
        </div>
      </header>

      {/* 生成流水线卡（flex order 排在聊天消息下方）：running / interrupted（分镜内联编辑）/ completed（查看视频+导出）/ error */}
      {session.status !== 'idle' && (
        <div className="order-2 shrink-0 space-y-2 border-t bg-secondary/20 p-3">
          {running && (
            <div className="flex items-center gap-2 text-xs">
              <Loader2 className="size-3.5 shrink-0 animate-spin text-primary" />
              <span className="min-w-0 flex-1 truncate">
                AI 生成中：{session.node ? NODE_LABELS[session.node] ?? session.node : '…'}
              </span>
              <button
                onClick={cancelAgent}
                className="flex shrink-0 items-center gap-1 rounded border border-input px-1.5 py-0.5 text-[11px] text-muted-foreground hover:border-destructive/50 hover:text-destructive"
              >
                <Square className="size-3" /> 停止
              </button>
            </div>
          )}
          {running && session.streamText ? (
            <p className="max-h-16 overflow-y-auto break-all whitespace-pre-wrap rounded border border-primary/25 bg-primary/5 p-2 font-mono text-[10px] text-foreground/75">
              {session.streamText.slice(-300)}
            </p>
          ) : null}
          {running && session.logs.length ? (
            <p className="truncate text-[10px] text-muted-foreground">{session.logs[session.logs.length - 1]}</p>
          ) : null}

          {session.status === 'interrupted' && (
            <div className="space-y-2">
              <p className="text-[11px] font-medium">
                分镜已生成（{session.scenes.length} 场 · {formatTimecode(totalSceneMs)}），可就地调整或确认续跑：
              </p>
              {!session.scenes.some((s) => s.keyframePath) ? (
                <p className="rounded border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-[10px] leading-relaxed text-amber-300">
                  未生成关键帧图（图像模型未配置、或额度不足/调用失败）；确认后将退为文生视频。可去“设置中心 → AI 设置 → 图像模型”检查额度与配置。
                </p>
              ) : null}
              <div className="max-h-64 space-y-2 overflow-y-auto pr-0.5">
                {session.scenes.map((sb) => (
                  <div key={sb.order} className="space-y-1 rounded-lg border bg-background/60 p-2">
                    <div className="flex items-center gap-1.5">
                      {sb.keyframePath ? (
                        <img
                          src={window.electronAPI?.toMediaUrl(sb.keyframePath)}
                          alt=""
                          title="分镜关键帧（将作为 I2V 首帧），点击放大预览"
                          onClick={() => setKeyframePreview({ src: window.electronAPI!.toMediaUrl(sb.keyframePath!), caption: `${String(sb.order + 1).padStart(2, '0')} · ${sb.title || '（无标题）'}` })}
                          className="size-8 shrink-0 cursor-zoom-in rounded object-cover ring-offset-2 transition-shadow hover:ring-2 hover:ring-primary/70"
                        />
                      ) : null}
                      <span className="flex size-5 shrink-0 items-center justify-center rounded bg-secondary text-[10px] font-semibold">
                        {String(sb.order + 1).padStart(2, '0')}
                      </span>
                      <input
                        value={sb.title}
                        onChange={(e) => updateScene(sb.order, { title: e.target.value })}
                        placeholder="镜头标题"
                        className="min-w-0 flex-1 rounded border border-input bg-transparent px-1.5 py-1 text-[11px] outline-none focus:border-ring"
                      />
                      <input
                        type="number"
                        min={0.5}
                        step={0.5}
                        value={(sb.durationMs / 1000).toFixed(1)}
                        onChange={(e) => {
                          const sec = Number(e.target.value);
                          if (Number.isFinite(sec) && sec > 0) updateScene(sb.order, { durationMs: Math.round(sec * 1000) });
                        }}
                        className="w-14 shrink-0 rounded border border-input bg-transparent px-1.5 py-1 text-[11px] outline-none focus:border-ring"
                        title="时长（秒）"
                      />
                      <button
                        onClick={() => removeScene(sb.order)}
                        disabled={session.scenes.length <= 1}
                        className="shrink-0 text-muted-foreground hover:text-destructive disabled:opacity-30"
                        title="删除本场"
                      >
                        <X className="size-3.5" />
                      </button>
                    </div>
                    <textarea
                      value={sb.narration}
                      onChange={(e) => updateScene(sb.order, { narration: e.target.value })}
                      placeholder="旁白文案（留空则不生成旁白与字幕）"
                      rows={2}
                      className="w-full resize-y rounded border border-input bg-transparent px-1.5 py-1 text-[11px] outline-none focus:border-ring"
                    />
                  </div>
                ))}
              </div>
              <div className="flex gap-2">
                <Button size="sm" className="bg-brand h-8 flex-1 gap-1.5 rounded-full text-xs hover:opacity-95" disabled={confirming} onClick={() => void handleResume()}>
                  {confirming ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
                  {confirming ? '生成中…' : '确认分镜，继续生成'}
                </Button>
                <Button size="sm" variant="ghost" className="h-8 flex-1 gap-1.5 rounded-full border border-input text-xs" disabled={regen} onClick={() => void handleRegenerate()}>
                  {regen ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
                  重新生成
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-8 shrink-0 gap-1 rounded-full border border-input px-3 text-xs text-muted-foreground hover:text-destructive"
                  title="放弃本次生成（时间线不变），回到自由对话后可继续输入自定义要求"
                  onClick={() => {
                    cancelAgent();
                    resetAgentSession();
                    push({ role: 'system', text: '已取消本次生成，分镜未写入时间线。直接在下方输入框回复即可（例如“先不要排分镜，只要一张分镜图”）。' });
                  }}
                >
                  <X className="size-3.5" /> 取消
                </Button>
              </div>
              <CardReplyBox
                placeholder="对分镜有调整意见？直接回复，如“先只出一张分镜图，不出片”"
                onSend={(t) => void ask(t)}
                disabled={busy || confirming || regen}
              />
            </div>
          )}

          {session.status === 'completed' && (
            <div className="space-y-2">
              <div className="flex items-center gap-2.5">
                <span className="bg-brand flex size-9 shrink-0 items-center justify-center rounded-lg text-white">
                  <Play className="size-4 fill-white" />
                </span>
                <div className="min-w-0">
                  <p className="text-xs font-medium">成片已生成</p>
                  <p className="text-[10px] text-muted-foreground">
                    {session.scenes.length} 场 · {formatTimecode(totalSceneMs)}
                  </p>
                </div>
              </div>
              {exportPct !== null && (
                <div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-secondary">
                    <div className="h-full rounded-full bg-brand transition-all" style={{ width: `${exportPct}%` }} />
                  </div>
                  <p className="mt-0.5 text-right text-[10px] text-muted-foreground">导出中 {exportPct}%</p>
                </div>
              )}
              <div className="flex gap-2">
                <Button size="sm" className="bg-brand h-8 flex-1 gap-1.5 rounded-full text-xs hover:opacity-95" onClick={() => void viewVideo()}>
                  <Play className="size-3.5" /> 查看视频
                </Button>
                <Button size="sm" variant="ghost" className="h-8 flex-1 gap-1.5 rounded-full border border-input text-xs" disabled={exporting} onClick={() => void exportVideo()}>
                  {exporting ? <Loader2 className="size-3.5 animate-spin" /> : <Download className="size-3.5" />}
                  {exporting ? '导出中…' : '另存为导出'}
                </Button>
              </div>
            </div>
          )}

          {session.status === 'error' && (
            <div className="flex items-center gap-2 text-xs">
              <span className="min-w-0 flex-1 truncate text-destructive">{session.error || 'AI 任务失败'}</span>
              <button
                onClick={() => void retryAgent()}
                className="flex shrink-0 items-center gap-1 rounded border border-destructive/40 px-1.5 py-0.5 text-[11px] text-destructive hover:bg-destructive/10"
                title="从断点 Checkpoint 继续"
              >
                <RefreshCw className="size-3" /> 断点重试
              </button>
              <button
                onClick={() => {
                  resetAgentSession();
                  push({ role: 'system', text: '已放弃本次任务（checkpoint 保留），可继续输入自定义要求。' });
                }}
                className="flex shrink-0 items-center gap-1 rounded border border-input px-1.5 py-0.5 text-[11px] text-muted-foreground hover:text-foreground"
                title="关闭错误卡片，回到自由对话"
              >
                <X className="size-3" /> 放弃
              </button>
            </div>
          )}
        </div>
      )}

      <div ref={listRef} className="order-1 min-h-0 flex-1 space-y-3 overflow-y-auto p-3 text-xs">
        {messages.map((m) => (
          <div key={m.id} className={cn('flex flex-col gap-1', m.role === 'user' && 'items-end')}>
            {m.text ? (
              <div
                className={cn(
                  'max-w-[88%] rounded-lg px-2.5 py-1.5 leading-relaxed',
                  m.role === 'user' && 'bg-brand text-white',
                  m.role === 'assistant' && 'bg-secondary/70 text-foreground',
                  m.role === 'system' && 'border border-dashed border-input text-muted-foreground',
                )}
              >
                {m.text}
              </div>
            ) : null}
            {m.attachments?.length ? (
              <div className="flex max-w-[88%] flex-wrap gap-1.5">
                {m.attachments.map((a) =>
                  a.kind === 'image' ? (
                    <AttachmentImageChip key={a.path} att={a} onPreview={(src, name) => setKeyframePreview({ src, caption: name })} />
                  ) : (
                    <span key={a.path} className="flex items-center gap-1 rounded-lg border bg-background/60 px-2 py-1 text-[10px] text-muted-foreground">
                      <FileText className="size-3 shrink-0" />
                      <span className="max-w-32 truncate">{a.name}</span>
                    </span>
                  ),
                )}
              </div>
            ) : null}
            {m.record ? <RecordCard record={m.record} /> : null}
            {m.assets?.map((entry) => (
              <div key={entry.path} className="flex w-full items-center gap-2 rounded-lg border bg-background/60 p-1.5">
                {entry.thumbPath ? (
                  <img src={window.electronAPI?.toMediaUrl(entry.thumbPath)} alt={entry.name} className="size-10 shrink-0 rounded object-cover" />
                ) : (
                  <ThumbPlaceholder hue={200} className="size-10 shrink-0 rounded" />
                )}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[11px]">{entry.name}</p>
                  <p className="text-[10px] text-muted-foreground">
                    {formatTimecode(entry.durationMs || 0)} · {entry.width ?? '-'}×{entry.height ?? '-'}
                  </p>
                </div>
                <Button size="sm" variant="ghost" className="h-7 shrink-0 gap-1 px-2 text-[11px]" onClick={() => insertAsset(entry)}>
                  <Plus className="size-3" /> 入轨
                </Button>
              </div>
            ))}
          </div>
        ))}
      </div>

      {/* 确认卡片：大模型只出计划，用户点「确认应用」才真改时间线 */}
      {pending && (
        <div className="order-3 shrink-0 border-t border-primary/30 bg-primary/5 p-3">
          <p className="text-[11px] font-semibold text-primary">请确认以下改动（共 {pending.lines.length} 项）</p>
          {pending.cost ? (
            <p
              className={cn(
                'mt-1 rounded border px-2 py-1 text-[11px] leading-relaxed',
                pending.cost.yuan !== null
                  ? 'border-amber-500/40 bg-amber-500/10 text-amber-300'
                  : 'border-input bg-secondary/40 text-muted-foreground',
              )}
            >
              {pending.cost.yuan !== null
                ? `费用预估：约 ${pending.cost.yuan.toFixed(2)} 元（共 ${pending.cost.seconds}s）— ${pending.cost.note}`
                : `将调 AI 生成 ${pending.cost.seconds}s 视频 — ${pending.cost.note}`}
            </p>
          ) : null}
          <ul className="mt-1.5 space-y-1">
            {pending.lines.map((line, i) => (
              <li key={i} className="text-[11px] leading-relaxed">
                · {line}
              </li>
            ))}
          </ul>
          <div className="mt-2.5 flex gap-2">
            <Button size="sm" className="h-7 flex-1 rounded-full text-xs" onClick={() => void confirmPending()} disabled={applying}>
              {applying ? '执行中…' : '确认应用'}
            </Button>
            <Button size="sm" variant="ghost" className="h-7 flex-1 rounded-full text-xs" onClick={cancelPending} disabled={applying}>
              取消
            </Button>
          </div>
          <CardReplyBox
            placeholder="想调整计划？直接回复，如“第二段改成 3 秒”"
            onSend={(t) => {
              // 回复即是对本卡的回应：先收起旧确认卡，新计划会由大模型重新出卡
              setPending(null);
              void ask(t);
            }}
            disabled={applying || busy}
          />
        </div>
      )}

      {/* 多模态路由确认卡（P3 闸门）：展示识别到的意图，用户确认后才分派执行 */}
      {routePending && (
        <div className="order-4 shrink-0 border-t border-primary/30 bg-primary/5 p-3">
          <p className="text-[11px] font-semibold text-primary">
            识别到：{INTENT_LABEL[routePending.decision.intent] ?? routePending.decision.intent}（置信度 {Math.round(routePending.decision.confidence * 100)}%）
          </p>
          <p className="mt-1 text-[11px] leading-relaxed text-foreground/85">{routePending.decision.reply}</p>
          {routePending.decision.needsClarify && routePending.decision.clarifyQuestion ? (
            <p className="mt-1 text-[11px] text-amber-300">{routePending.decision.clarifyQuestion}</p>
          ) : null}
          <div className="mt-2.5 flex gap-2">
            <Button size="sm" className="h-7 flex-1 rounded-full text-xs" onClick={() => void confirmRoute()}>
              {routePending.decision.needsClarify ? '仍要执行' : '确认执行'}
            </Button>
            <Button size="sm" variant="ghost" className="h-7 flex-1 rounded-full text-xs" onClick={cancelRoute}>
              取消
            </Button>
          </div>
          <CardReplyBox
            placeholder="理解不对？直接回复你的真实诉求，如“只要一张分镜图，先不出片”"
            onSend={(t) => {
              // 回复代替确认：收起路由卡，按新回复重新理解意图（不再需要手动取消）
              setRoutePending(null);
              void ask(t);
            }}
            disabled={busy}
          />
        </div>
      )}

      <div className="order-5 shrink-0 border-t p-2">
        {attachments.length > 0 ? (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {attachments.map((a) => (
              <span key={a.id} className="relative flex items-center gap-1.5 rounded-lg border bg-background/60 py-1 pl-1 pr-6 text-[11px]">
                {a.kind === 'image' ? (
                  <img src={window.electronAPI?.toMediaUrl(a.path)} alt={a.name} className="size-8 rounded object-cover" />
                ) : (
                  <span className="flex size-8 items-center justify-center rounded bg-secondary text-muted-foreground">
                    <FileText className="size-4" />
                  </span>
                )}
                <span className="max-w-28 truncate">{a.name}</span>
                <button
                  onClick={() => setAttachments((prev) => prev.filter((x) => x.id !== a.id))}
                  className="absolute top-1/2 right-1 -translate-y-1/2 text-muted-foreground hover:text-destructive"
                  title="移除"
                >
                  <X className="size-3" />
                </button>
              </span>
            ))}
          </div>
        ) : null}
        <div className="flex items-end gap-2">
          <button
            onClick={() => fileInputRef.current?.click()}
            title="添加附件（图片/文档/音视频）"
            className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-input text-muted-foreground hover:text-foreground"
          >
            <Paperclip className="size-4" />
          </button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept=".png,.jpg,.jpeg,.webp,.gif,.bmp,.doc,.docx,.pdf,.txt,.md,.mp3,.wav,.m4a,.aac,.flac,.mp4,.mov,.webm,.mkv,.avi"
            className="hidden"
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []);
              e.target.value = '';
              void ingestFiles(files);
            }}
          />
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onPaste={(e) => {
              const files = Array.from(e.clipboardData?.files ?? []);
              if (!files.length) return;
              e.preventDefault();
              void ingestFiles(files);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void ask(input);
              }
            }}
            rows={1}
            placeholder="描述需求一句话成片，或粘贴图片/文档作为附件…"
            className="auto-textarea no-scrollbar max-h-40 min-h-14 flex-1 resize-none overflow-y-auto rounded-md border border-input bg-transparent px-3 py-2.5 text-sm outline-none placeholder:text-muted-foreground focus:border-ring"
          />
          <Button
            size="sm"
            className="h-8 w-8 rounded-full p-0"
            disabled={busy || (!input.trim() && attachments.length === 0)}
            onClick={() => void ask(input)}
          >
            <ArrowUp className="size-4" />
          </Button>
        </div>
        <p className="mt-1 flex items-center gap-1 text-[10px] text-muted-foreground">
          <PanelRightOpen className="size-3" /> Enter 发送 · 可粘贴图片/文档{variant === 'drawer' ? ' · Esc 收起面板' : ''}
        </p>
      </div>
      {keyframePreview ? <ImageLightbox src={keyframePreview.src} caption={keyframePreview.caption} onClose={() => setKeyframePreview(null)} /> : null}
      </div>
    </div>
  );
}
