import { ArrowUp, Eraser, PanelRightClose, PanelRightOpen, Plus, Sparkles, Undo2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { ThumbPlaceholder } from '@/components/ui/misc';
import { useApplyTimeline, useCanUndo, useTimelineSelection, useTimelineTracks, undoTimeline } from '@/hooks/use-timeline';
import { getAgentSession, subscribeAgentSession } from '@/lib/agent-session';
import type { AgentSessionState } from '@/lib/agent-session';
import { buildTimelineSnapshot, translatePlan, type PendingInsert } from '@/lib/assistant-apply';
import { nextFreeStart, requestSeek, trackForKind, type TimelineAction } from '@/lib/timeline-store';
import { formatTimecode, timelineTotalMs, type TimelineClip, type TimelineTrack } from '@/lib/timeline-utils';
import type { LibraryEntry } from '@/preload';
import { cn } from '@/lib/utils';

/**
 * AI 助手常驻面板（R0）：右缘浮层，展开时盖在内容上不挤压编辑器布局。
 *
 * 定位：把「AI 成片进度/日志」从一次性页面变成跨页面常驻的会话流，
 * 并提供只读的素材语义检索与工程摘要。真正「用对话改时间线」是 R2，
 * 但插入动作已经走 R1 的 applyTimelineActions 统一通道，R2 不用再改地基。
 */

interface DockMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  text: string;
  /** 素材检索结果卡片（可一键入轨） */
  assets?: LibraryEntry[];
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
  undo: boolean;
}

/**
 * AI 创作类页面（一句话成片 / 分镜审批）默认展开助手浮层，
 * 剪辑 / 素材等生产页面默认收起 —— 视线焦点在预览与时间线，不被面板挤占。
 *
 * 形态完全由路由决定，不再存 localStorage：一旦记住“上次展开过”，
 * 剪辑页就会因为之前在 AI 页展开过而默认弹出来，正好与这条规则相冲。
 */
const AUTO_OPEN_ROUTES = new Set(['/ai', '/storyboard']);

let seq = 0;
const nextId = () => `m${Date.now().toString(36)}-${seq++}`;

function summaryText(tracks: TimelineTrack[]): string {
  const totalMs = timelineTotalMs(tracks);
  const clips = tracks.reduce((n, t) => n + t.clips.length, 0);
  return clips === 0
    ? '时间线还是空的。你可以说「找一段猫的视频」查素材库，或去 AI 工具页一句话成片。'
    : `当前工程：${tracks.length} 条轨道 / ${clips} 个片段，总时长 ${formatTimecode(totalMs)}。试试「找一段猫的视频」。`;
}

/** 极简意图路由：本地能秒回的（检索/摘要/跳转）不花 token，其余交给大模型规划 */
function routeIntent(input: string): string {
  const text = input.trim();
  if (/^找|^搜|检索|有没有|查一下/.test(text)) return 'search';
  if (/^现在多长|工程摘要|几个片段|总时长/.test(text)) return 'summary';
  if (/成片|一键|做个视频|剪一个/.test(text) && !/删|去掉|剪掉|改|加字幕|音量/.test(text)) return 'workflow';
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

export function AssistantDock({ route }: { route: string }) {
  const [open, setOpen] = useState(() => AUTO_OPEN_ROUTES.has(route));
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [session, setSession] = useState<AgentSessionState>(getAgentSession);
  const tracks = useTimelineTracks();
  const [selection] = useTimelineSelection();
  const applyActions = useApplyTimeline();
  const [messages, setMessages] = useState<DockMessage[]>([]);
  const [pending, setPending] = useState<PendingPlan | null>(null);
  const [applying, setApplying] = useState(false);
  const undoable = useCanUndo();
  const listRef = useRef<HTMLDivElement | null>(null);
  const greeted = useRef(false);

  const push = useCallback((message: Omit<DockMessage, 'id'>) => {
    setMessages((prev) => [...prev.slice(-59), { ...message, id: nextId() }]);
  }, []);

  // 切页时按页面类型回到默认形态（用户仍可在当页手动展开/收起，下次切页重置）
  useEffect(() => {
    setOpen(AUTO_OPEN_ROUTES.has(route));
  }, [route]);
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  // AI 事件流：只把终态（失败/完成/等确认）写进会话，进度做成底部状态行，避免刷屏
  useEffect(() => {
    const un = subscribeAgentSession((next) => {
      setSession(next);
      if (next.status === 'error' && next.error) {
        push({ role: 'system', text: `AI 任务失败：${next.error}` });
      } else if (next.status === 'completed') {
        push({ role: 'system', text: 'AI 成片完成，可以去编辑器精修或导出。' });
      } else if (next.status === 'interrupted') {
        push({ role: 'system', text: `分镜已生成（${next.scenes.length} 场），在分镜页确认后续跑。` });
      }
    });
    return un;
  }, [push]);

  // 首次展开时补一条当前工程摘要（之后不重复刷）
  useEffect(() => {
    if (!open || greeted.current) return;
    greeted.current = true;
    push({ role: 'assistant', text: summaryText(tracks) });
  }, [open, push, tracks]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  const ask = useCallback(
    async (raw: string) => {
      const text = raw.trim();
      if (!text) return;
      push({ role: 'user', text });
      setInput('');
      setBusy(true);
      try {
        const intent = routeIntent(text);
        if (intent === 'summary') {
          push({ role: 'assistant', text: summaryText(tracks) });
        } else if (intent === 'workflow') {
          window.location.hash = '#/ai';
          push({ role: 'assistant', text: '已切到 AI 工具页，在那里描述需求即可启动一键成片，进度会同步到这里。' });
        } else if (intent === 'search') {
          const api = window.electronAPI;
          const query = text.replace(/帮我|找一段|找|搜索|查一下|有没有|的(视频|素材|图片|音频)|请问|一下/g, ' ').trim();
          if (!api?.library?.search || !query) {
            push({ role: 'assistant', text: '需要桌面端并给出关键词，例如「找一段猫的视频」。' });
          } else {
            const hits = await api.library.search(query, 8);
            const entries = hits.map((hit) => hit.entry);
            push(
              entries.length
                ? { role: 'assistant', text: `素材库找到 ${entries.length} 条与「${query}」相近的素材：`, assets: entries }
                : { role: 'assistant', text: `素材库里没有匹配「${query}」的素材（可先在素材页扫描目录）。` },
            );
          }
        } else {
          // 大模型规划：只出计划，不直接改时间线（用户确认后才执行）
          const api = window.electronAPI;
          if (!api?.assistant?.plan) {
            push({ role: 'system', text: '需在桌面端使用：浏览器预览模式无法调用大模型。' });
          } else {
            const plan = await api.assistant.plan({
              message: text,
              snapshot: buildTimelineSnapshot(tracks, selection),
            });
            const translated = translatePlan(plan, tracks, selection);
            push({ role: 'assistant', text: plan.reply });
            for (const note of translated.notes) push({ role: 'system', text: note });
            if (translated.actions.length > 0 || translated.seekMs !== null || translated.inserts.length > 0 || translated.undo) {
              setPending({
                reply: plan.reply,
                lines: translated.lines,
                notes: translated.notes,
                actions: translated.actions,
                seekMs: translated.seekMs,
                inserts: translated.inserts,
                undo: translated.undo,
              });
            } else if (!translated.lines.length) {
              push({ role: 'system', text: '本次没有可执行的改动，时间线未变。' });
            }
          }
        }
      } catch (error) {
        push({ role: 'system', text: `出错了：${(error as Error).message}` });
      } finally {
        setBusy(false);
      }
    },
    [push, tracks, selection],
  );

  /**
   * 确认应用：先按需回退，再把 insertAsset 异步解析成 addClip，最后走统一 action 通道。
   *
   * 顺序有意为之：undo 先执行，同批的后续动作才能落在回退后的真实片段上；
   * 目标已不存在的动作会被 store 逐条跳过并回 reason，不会静默改错东西。
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

  const statusLine = useMemo(() => {
    if (session.status === 'running') {
      const log = session.logs[session.logs.length - 1];
      return `进行中：${session.node ?? '-'}${log ? ` · ${log.slice(0, 40)}` : ''}`;
    }
    if (session.status === 'interrupted') return '等待分镜确认';
    if (session.status === 'error') return '上一次 AI 任务失败';
    if (session.status === 'completed') return 'AI 成片已完成';
    return null;
  }, [session]);

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        title="展开 AI 助手（Esc 收起）"
        className="fixed top-1/2 right-0 z-40 flex -translate-y-1/2 flex-col items-center gap-2 rounded-l-xl border border-r-0 bg-card/95 px-2 py-3 text-[10px] text-muted-foreground shadow-lg backdrop-blur hover:text-primary"
      >
        <Sparkles className="size-4" />
        <span className="tracking-wide [writing-mode:vertical-rl]">AI 助手</span>
      </button>
    );
  }

  return (
    <aside className="fixed top-12 right-0 bottom-0 z-40 flex w-[340px] flex-col border-l bg-card/97 shadow-2xl shadow-black/40 backdrop-blur">
      <header className="flex h-11 shrink-0 items-center gap-2 border-b px-3">
        <Sparkles className="size-4 text-primary" />
        <span className="text-sm font-semibold">AI 助手</span>
        {statusLine ? (
          <span className="ml-1 truncate rounded bg-secondary px-1.5 py-0.5 text-[10px] text-muted-foreground">
            {statusLine}
          </span>
        ) : null}
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
          <button
            title="收起面板"
            onClick={() => setOpen(false)}
            className="rounded p-1 text-muted-foreground hover:bg-secondary hover:text-foreground"
          >
            <PanelRightClose className="size-4" />
          </button>
        </div>
      </header>

      <div ref={listRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3 text-xs">
        {messages.map((m) => (
          <div key={m.id} className={cn('flex flex-col gap-1', m.role === 'user' && 'items-end')}>
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
            {m.assets?.map((entry) => (
              <div
                key={entry.path}
                className="flex w-full items-center gap-2 rounded-lg border bg-background/60 p-1.5"
              >
                {entry.thumbPath ? (
                  <img
                    src={window.electronAPI?.toMediaUrl(entry.thumbPath)}
                    alt={entry.name}
                    className="size-10 shrink-0 rounded object-cover"
                  />
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
        <div className="shrink-0 border-t border-primary/30 bg-primary/5 p-3">
          <p className="text-[11px] font-semibold text-primary">请确认以下改动（共 {pending.lines.length} 项）</p>
          <ul className="mt-1.5 space-y-1">
            {pending.lines.map((line, i) => (
              <li key={i} className="text-[11px] leading-relaxed">
                · {line}
              </li>
            ))}
          </ul>
          <div className="mt-2.5 flex gap-2">
            <Button
              size="sm"
              className="h-7 flex-1 rounded-full text-xs"
              onClick={() => void confirmPending()}
              disabled={applying}
            >
              {applying ? '执行中…' : '确认应用'}
            </Button>
            <Button size="sm" variant="ghost" className="h-7 flex-1 rounded-full text-xs" onClick={cancelPending} disabled={applying}>
              取消
            </Button>
          </div>
        </div>
      )}

      <div className="shrink-0 border-t p-2">
        <div className="flex items-end gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void ask(input);
              }
            }}
            rows={2}
            placeholder="例：删掉音乐轨第 2 段 / 旁白音量降到 0.6 / 找一段猫的视频"
            className="min-h-14 flex-1 resize-y rounded-md border border-input bg-transparent px-2 py-1.5 text-xs outline-none placeholder:text-muted-foreground focus:border-ring"
          />
          <Button size="sm" className="h-8 w-8 rounded-full p-0" disabled={busy || !input.trim()} onClick={() => void ask(input)}>
            <ArrowUp className="size-4" />
          </Button>
        </div>
        <p className="mt-1 flex items-center gap-1 text-[10px] text-muted-foreground">
          <PanelRightOpen className="size-3" /> Enter 发送 · Esc 收起面板
        </p>
      </div>
    </aside>
  );
}
