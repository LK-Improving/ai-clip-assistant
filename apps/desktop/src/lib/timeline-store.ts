import { getActiveProject, onActiveProjectChange, saveActiveProject, syncActiveProject } from './active-project';
import type { AssetMetaHint } from './project-bridge';
import { projectToTimeline, timelineToProject } from './project-bridge';
import { createId, type TimelineClip, type TimelineTrack } from './timeline-utils';

/**
 * 时间线单一事实来源（R1：状态提升）。
 *
 * 之前 tracks 是编辑器组件内的 useState，AI 助手 / 快捷键 / 命令面板都无从下手，
 * 只能靠 props 往页面里钻。提升成「模块级状态 + 订阅 + action 通道」后：
 * - 拖拽、删除、加轨、素材入轨全部经 applyTimelineActions 这一个入口，
 *   可审计、可撤销，也为 R2 的对话式剪辑预留了唯一的落地面；
 * - 防抖落盘与保存状态从页面搬进 store，任何来源（含不在编辑器页时的对话插入）都会自动保存；
 * - 播放头 currentMs / playing 仍留在编辑器本地：rAF 每帧都要写，放进全局 store
 *   会让所有订阅者（含 AI 助手面板）跟着 60fps 重渲染。
 */

/** 空工程的默认轨道：视频 / 音频 / 字幕各一条 */
export function defaultTracks(): TimelineTrack[] {
  return [
    { id: createId('track'), kind: 'video', name: '视频 1', clips: [] },
    { id: createId('track'), kind: 'audio', name: '音频 1', clips: [] },
    { id: createId('track'), kind: 'text', name: '字幕', clips: [] },
  ];
}

/** 选中片段（属性面板与对话式「把这条…」共用） */
export interface TimelineSelection {
  trackId: string;
  clipId: string;
}

/**
 * 时间线动作：编辑器交互与 AI 助手的共同语言。
 * 每个动作都必须能被单独跳过（目标不存在时记 reason 而不是整批失败），
 * 这样 LLM 幻觉出错误 clipId 时只会丢一条改动，不会打挂用户的时间线。
 */
export type TimelineAction =
  | { type: 'addClip'; trackId: string; clip: Omit<TimelineClip, 'id'> & { id?: string } }
  | { type: 'updateClip'; trackId: string; clipId: string; patch: Partial<TimelineClip> }
  | { type: 'removeClip'; trackId: string; clipId: string }
  | { type: 'addTrack'; kind: TimelineTrack['kind'] }
  | { type: 'removeTrack'; trackId: string }
  | { type: 'replaceTracks'; tracks: TimelineTrack[] };

export type SaveState = 'idle' | 'saving' | 'saved' | 'error';

let tracks: TimelineTrack[] = [];
let selection: TimelineSelection | null = null;
let saveState: SaveState = 'idle';
let loaded = false;

const listeners = new Set<() => void>();

/** 素材元数据来源（编辑器挂载时注入素材库探测结果）；缺省时桥接层用兜底值保证工程合法 */
let hintsProvider: (() => Map<string, AssetMetaHint>) | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function emit(): void {
  for (const fn of listeners) fn();
}

/** 从当前激活工程载入时间线（打开 / 新建工程后调用） */
export function loadTimelineFromProject(): void {
  const restored = projectToTimeline(getActiveProject());
  tracks = restored.length > 0 ? restored : defaultTracks();
  selection = null;
  loaded = true;
  // 切工程后旧快照已不属于当前时间线，继续保留会「撤销」到另一个工程的状态
  undoStack.length = 0;
  emit();
}

export function ensureTimelineLoaded(): void {
  if (!loaded) loadTimelineFromProject();
}

export function getTracks(): TimelineTrack[] {
  ensureTimelineLoaded();
  return tracks;
}

export function getSelection(): TimelineSelection | null {
  return selection;
}

export function setSelection(next: TimelineSelection | null): void {
  const same =
    (next === null && selection === null) ||
    (next !== null && selection !== null && next.trackId === selection.trackId && next.clipId === selection.clipId);
  if (same) return;
  selection = next;
  emit();
}

export function getSaveState(): SaveState {
  return saveState;
}

export function setAssetHintsProvider(fn: (() => Map<string, AssetMetaHint>) | null): void {
  hintsProvider = fn;
}

export function subscribeTimeline(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** 轨道末尾（默认留 200ms 间隙）的入点：素材入轨与对话插入共用同一套排布规则 */
export function nextFreeStart(track: TimelineTrack, gapMs = 200): number {
  const end = track.clips.reduce((max, clip) => Math.max(max, clip.start + clip.duration), 0);
  return end === 0 ? 0 : end + gapMs;
}

/** 按 kind 找落点轨道（找不到则退回第一条同 kind 之外的首轨），供「加入时间线」统一使用 */
export function trackForKind(kind: TimelineTrack['kind']): TimelineTrack | null {
  const list = getTracks();
  return list.find((track) => track.kind === kind) ?? list[0] ?? null;
}

function labelForKind(kind: TimelineTrack['kind'], list: TimelineTrack[]): string {
  const index = list.filter((track) => track.kind === kind).length + 1;
  const word = kind === 'video' ? '视频' : kind === 'audio' ? '音频' : '字幕';
  return `${word} ${index}`;
}

/** 单个动作的归约：失败只回 reason，不改状态 */
function reduce(current: TimelineTrack[], action: TimelineAction): { next: TimelineTrack[]; reason?: string } {
  switch (action.type) {
    case 'replaceTracks':
      return { next: action.tracks };

    case 'addTrack':
      return {
        next: [...current, { id: createId('track'), kind: action.kind, name: labelForKind(action.kind, current), clips: [] }],
      };

    case 'removeTrack':
      if (!current.some((track) => track.id === action.trackId)) {
        return { next: current, reason: `轨道不存在：${action.trackId}` };
      }
      return { next: current.filter((track) => track.id !== action.trackId) };

    case 'addClip': {
      const exists = current.some((track) => track.id === action.trackId);
      if (!exists) return { next: current, reason: `轨道不存在：${action.trackId}` };
      const clip: TimelineClip = { ...action.clip, id: action.clip.id ?? createId('clip') };
      return {
        next: current.map((track) =>
          track.id === action.trackId ? { ...track, clips: [...track.clips, clip] } : track,
        ),
      };
    }

    case 'updateClip': {
      const track = current.find((item) => item.id === action.trackId);
      if (!track) return { next: current, reason: `轨道不存在：${action.trackId}` };
      if (!track.clips.some((clip) => clip.id === action.clipId)) {
        return { next: current, reason: `片段不存在：${action.clipId}` };
      }
      return {
        next: current.map((item) =>
          item.id !== action.trackId
            ? item
            : {
                ...item,
                clips: item.clips.map((clip) =>
                  clip.id === action.clipId ? { ...clip, ...action.patch, id: clip.id } : clip,
                ),
              },
        ),
      };
    }

    case 'removeClip': {
      const track = current.find((item) => item.id === action.trackId);
      if (!track) return { next: current, reason: `轨道不存在：${action.trackId}` };
      if (!track.clips.some((clip) => clip.id === action.clipId)) {
        return { next: current, reason: `片段不存在：${action.clipId}` };
      }
      return {
        next: current.map((item) =>
          item.id === action.trackId ? { ...item, clips: item.clips.filter((clip) => clip.id !== action.clipId) } : item,
        ),
      };
    }
  }
}

export interface ApplyResult {
  applied: number;
  skipped: string[];
  /** 本批改动已压入撤销栈，可回退（对话式批量改动的安全网） */
  undoable: boolean;
}

/**
 * 撤销栈：每批成功改动前压入上一份 tracks。
 *
 * 用内存快照而不是走 M5 的 git 版本仓：对话式剪辑的「撤销刚才那步」要的是
 * 毫秒级回退到上一个编辑态，跟「回到昨天那个版本」是两个不同的需求；
 * 跨会话的版本回滚仍由 services/versioning 负责。
 */
const undoStack: TimelineTrack[][] = [];
const UNDO_LIMIT = 50;

function pushUndo(previous: TimelineTrack[]): void {
  undoStack.push(previous.map((track) => ({ ...track, clips: track.clips.map((clip) => ({ ...clip })) })));
  if (undoStack.length > UNDO_LIMIT) undoStack.shift();
}

export function canUndo(): boolean {
  return undoStack.length > 0;
}

/** 回退一步；返回回退后的片段数供调用方提示，栈空时返回 null */
export function undoTimeline(): { clips: number; remaining: number } | null {
  const previous = undoStack.pop();
  if (!previous) return null;
  tracks = previous;
  selection = null;
  emit();
  persistSoon();
  return { clips: tracks.reduce((n, track) => n + track.clips.length, 0), remaining: undoStack.length };
}

/** 应用一批动作：整批只通知一次订阅者、只排一次落盘。
 * 目标不存在的动作被逐条跳过并回报原因（R2 的确认卡片与失败回执依赖这个信息）。 */
export function applyTimelineActions(actions: TimelineAction[]): ApplyResult {
  ensureTimelineLoaded();
  const skipped: string[] = [];
  let next = tracks;
  for (const action of actions) {
    const result = reduce(next, action);
    if (result.reason) {
      skipped.push(result.reason);
      continue;
    }
    next = result.next;
  }
  const applied = actions.length - skipped.length;
  if (applied > 0) {
    pushUndo(tracks);
    tracks = next;
    if (selection && !tracks.some((track) => track.id === selection?.trackId && track.clips.some((c) => c.id === selection?.clipId))) {
      selection = null;
    }
    emit();
    persistSoon();
  }
  return { applied, skipped, undoable: applied > 0 };
}

/** 立即落盘（导出前、页面卸载前调用），防抖窗口内的改动不会丢 */
export async function flushTimelineSave(): Promise<boolean> {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  return persistNow();
}

function persistSoon(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void persistNow();
  }, 800);
}

async function persistNow(): Promise<boolean> {
  saveState = 'saving';
  emit();
  try {
    syncActiveProject(timelineToProject(getActiveProject(), tracks, hintsProvider?.() ?? undefined));
    const saved = await saveActiveProject();
    saveState = saved ? 'saved' : 'error';
  } catch {
    saveState = 'error';
  }
  emit();
  return saveState === 'saved';
}

/** 打开 / 新建工程时由 AppShell 调用：切工程 → 重载时间线 */
export function bindTimelineToActiveProject(): () => void {
  loadTimelineFromProject();
  return onActiveProjectChange(() => loadTimelineFromProject());
}

/**
 * 播放头跳转请求（AI 助手、外部面板都能发起）。
 *
 * 走 window 事件而不是 store 状态：currentMs 是 rAF 每帧写的高频值，
 * 放进全局 store 会让所有订阅者跟着 60fps 重渲染；只有编辑器关心“跳去哪”。
 */
export const SEEK_EVENT = 'miaoma:seek';

export function requestSeek(ms: number): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<{ ms: number }>(SEEK_EVENT, { detail: { ms } }));
}

export function onSeekRequest(fn: (ms: number) => void): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const handler = (event: Event) => fn((event as CustomEvent<{ ms: number }>).detail?.ms ?? 0);
  window.addEventListener(SEEK_EVENT, handler);
  return () => window.removeEventListener(SEEK_EVENT, handler);
}
