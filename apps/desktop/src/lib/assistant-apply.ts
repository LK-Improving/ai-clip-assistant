import type { AssistantTimelineSnapshot, EditPlan } from '@miaoma/agent';
import type { TimelineAction, TimelineSelection } from './timeline-store';
import { createId, type TimelineClip, type TimelineTrack } from './timeline-utils';

/**
 * 把 AI 助手的改动计划落到时间线 store（渲染进程侧）。
 *
 * 模型只输出「音乐轨#2」这类 ref，uuid 的解析、字段映射、找不到目标的兜底都在这里：
 * 解析失败只跳过该条并给出人话回执，绝不猜一个片段改下去。
 */

/** 片段在轨道内的编号口径：按时间起点升序（并列时保持原序），与用户在时间线上看到的顺序一致 */
function orderedClips(track: TimelineTrack): TimelineClip[] {
  return [...track.clips].sort((a, b) => a.start - b.start);
}

export function clipRef(track: TimelineTrack, index: number): string {
  return `${track.name}#${index + 1}`;
}

export function buildTimelineSnapshot(
  tracks: TimelineTrack[],
  selection: TimelineSelection | null,
): AssistantTimelineSnapshot {
  const snapshot: AssistantTimelineSnapshot = {
    totalMs: Math.round(timelineTotalMsFor(tracks)),
    selectedRef: selection ? findRefFor(selection, tracks) : null,
    tracks: tracks.map((track) => ({
      id: track.id,
      name: track.name,
      kind: track.kind,
      clips: orderedClips(track).map((clip, index) => ({
        ref: clipRef(track, index),
        name: clip.name,
        startMs: Math.round(clip.start),
        durationMs: Math.round(clip.duration),
        volume: clip.volume,
        muted: clip.muted,
      })),
    })),
  };
  return snapshot;
}

function timelineTotalMsFor(tracks: TimelineTrack[]): number {
  return tracks.reduce(
    (max, track) => track.clips.reduce((m, clip) => Math.max(m, clip.start + clip.duration), max),
    0,
  );
}

function findRefFor(selection: TimelineSelection, tracks: TimelineTrack[]): string | null {
  const track = tracks.find((item) => item.id === selection.trackId);
  if (!track) return null;
  const index = orderedClips(track).findIndex((clip) => clip.id === selection.clipId);
  return index >= 0 ? clipRef(track, index) : null;
}

function normalize(value: string): string {
  return value.replace(/[\s　]/g, '').replace(/＃/g, '#').toLowerCase();
}

/** ref → 轨道/片段定位；找不到返回 null（调用方负责给出人话提示） */
export function resolveClipRef(
  ref: string,
  tracks: TimelineTrack[],
  selection: TimelineSelection | null,
): { trackId: string; clipId: string } | null {
  const key = normalize(ref ?? '');
  if (!key) return null;

  if (key === '选中' || key === 'selected' || key === '当前选中') {
    return selection ? { trackId: selection.trackId, clipId: selection.clipId } : null;
  }

  // 轨道名 + 序号：「音乐轨#2」/「音乐轨第2个」/「音乐轨 第 2 段」（normalize 已去空格）
  const ordinal = /^(.+?)#(\d+)$/.exec(key) ?? /^(.+?)第(\d+)(?:个|段|条)?$/.exec(key);
  if (ordinal) {
    const namePart = ordinal[1] ?? '';
    const index = Number(ordinal[2]);
    if (Number.isFinite(index) && index >= 1) {
      const track =
        tracks.find((item) => normalize(item.name) === namePart) ??
        (namePart ? tracks.find((item) => normalize(item.name).includes(namePart)) : undefined);
      if (track) {
        const clip = orderedClips(track)[index - 1];
        if (clip) return { trackId: track.id, clipId: clip.id };
      }
    }
  }

  // 纯序号：全局按时间排序取第 N 个
  const bare = /^#(\d+)$/.exec(key);
  if (bare) {
    const ordinal = Number(bare[1]);
    const all = tracks
      .flatMap((track) => orderedClips(track).map((clip) => ({ track, clip })))
      .sort((a, b) => a.clip.start - b.clip.start);
    const hit = all[ordinal - 1];
    if (hit) return { trackId: hit.track.id, clipId: hit.clip.id };
  }

  // 片段名唯一命中：「tts-7-18595d5b.wav」
  const byName = tracks
    .flatMap((track) => orderedClips(track).map((clip) => ({ track, clip })))
    .filter((item) => normalize(item.clip.name).includes(key));
  if (byName.length === 1) {
    return { trackId: byName[0]!.track.id, clipId: byName[0]!.clip.id };
  }
  return null;
}

function patchToClipFields(patch: Record<string, unknown>): Partial<TimelineClip> {
  const source = patch;
  const next: Partial<TimelineClip> = {};
  if (typeof source.startMs === 'number') next.start = Math.max(0, Math.round(source.startMs));
  if (typeof source.durationMs === 'number') next.duration = Math.max(100, Math.round(source.durationMs));
  if (typeof source.offsetMs === 'number') next.offset = Math.max(0, Math.round(source.offsetMs));
  if (typeof source.volume === 'number') next.volume = Math.min(2, Math.max(0, source.volume));
  if (typeof source.muted === 'boolean') next.muted = source.muted;
  if (typeof source.fadeInMs === 'number') next.fadeInMs = Math.max(0, Math.round(source.fadeInMs));
  if (typeof source.fadeOutMs === 'number') next.fadeOutMs = Math.max(0, Math.round(source.fadeOutMs));
  return next;
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(2)}s`;
}

export interface PlanTranslation {
  /** 可直接交给 applyTimelineActions 的动作 */
  actions: TimelineAction[];
  /** 确认卡片上的人话摘要（逐条） */
  lines: string[];
  /** 无法执行的原因（引用解析失败、没有字幕轨等） */
  notes: string[];
  /** 播放头跳转目标（不进 action 通道，走 seek 事件） */
  seekMs: number | null;
  /** 需要先去素材库检索（异步）才能变成 addClip 的插件请求 */
  inserts: PendingInsert[];
  /** 本批是否包含「撤销上一次改动」 */
  undo: boolean;
}

/** 待解析的插件：模型只说“找什么”，选件由本地检索完成 */
export interface PendingInsert {
  query: string;
  kind: 'video' | 'audio' | 'text';
  startMs: number | null;
}

/**
 * 计划 → 动作 + 人话摘要。
 *
 * 摘要与动作同源生成：确认卡片上写的和真正执行的必须是同一批东西，
 * 否则用户确认了 A 却执行了 B。
 */
export function translatePlan(
  plan: EditPlan,
  tracks: TimelineTrack[],
  selection: TimelineSelection | null,
): PlanTranslation {
  const actions: TimelineAction[] = [];
  const lines: string[] = [];
  const notes: string[] = [];
  const inserts: PendingInsert[] = [];
  let seekMs: number | null = null;
  let undo = false;

  for (const action of plan.actions ?? []) {
    if (action.type === 'seekTo') {
      seekMs = action.startMs;
      lines.push(`播放头跳到 ${seconds(action.startMs)}`);
      continue;
    }

    if (action.type === 'undo') {
      undo = true;
      lines.push('先撤销上一次批量改动（回到改动前的时间线）');
      continue;
    }

    if (action.type === 'insertAsset') {
      const kind = action.kind ?? 'video';
      const label = kind === 'video' ? '视频' : kind === 'audio' ? '音频' : '字幕';
      const track = tracks.find((item) => item.kind === kind);
      if (!track) {
        notes.push(`时间线里没有${label}轨，无法插入「${action.query}」（可先点「+ ${label}轨」）。`);
        continue;
      }
      inserts.push({ query: action.query, kind, startMs: action.startMs ?? null });
      lines.push(
        `从素材库找「${action.query}」插入到「${track.name}」${
          action.startMs !== undefined ? ` 的 ${seconds(action.startMs)}` : ' 末尾'
        }`,
      );
      continue;
    }

    if (action.type === 'addCaption') {
      const captionTrack = tracks.find((track) => track.kind === 'text');
      if (!captionTrack) {
        notes.push('时间线里没有字幕轨，无法加字幕（可先点「+ 字幕轨」）。');
        continue;
      }
      actions.push({
        type: 'addClip',
        trackId: captionTrack.id,
        clip: {
          id: createId('clip'),
          name: action.text.slice(0, 12) || '字幕',
          kind: 'text',
          start: Math.max(0, Math.round(action.startMs)),
          duration: Math.max(200, Math.round(action.durationMs)),
          offset: 0,
          hue: (action.text.charCodeAt(0) * 7) % 360,
          content: action.text,
        },
      });
      lines.push(`新增字幕「${action.text}」@ ${seconds(action.startMs)}，时长 ${seconds(action.durationMs)}`);
      continue;
    }

    const located = resolveClipRef(action.ref, tracks, selection);
    if (!located) {
      notes.push(`没找到片段「${action.ref}」，这条已跳过（请对照时间线用「轨道名#序号」，或先点选该片段）。`);
      continue;
    }
    const track = tracks.find((item) => item.id === located.trackId);
    const clip = track?.clips.find((item) => item.id === located.clipId);
    if (!track || !clip) {
      notes.push(`片段「${action.ref}」已不在时间线上。`);
      continue;
    }

    if (action.type === 'splitClip') {
      if (clip.kind === 'text') {
        notes.push(`「${clip.name}」是字幕，不需要切开（直接改时长就行）。`);
        continue;
      }
      const leftDuration = Math.round(action.atMs - clip.start);
      const rightDuration = Math.round(clip.start + clip.duration - action.atMs);
      if (leftDuration < 100 || rightDuration < 100) {
        notes.push(
          `切点 ${seconds(action.atMs)} 不在「${clip.name}」（${seconds(clip.start)}–${seconds(clip.start + clip.duration)}）内部，或两侧不足 0.1s，这条已跳过。`,
        );
        continue;
      }
      // 前段只改时长（自然保留淡入），后段新建一个片段：素材内入点往后推同样长度
      actions.push({ type: 'updateClip', trackId: located.trackId, clipId: clip.id, patch: { duration: leftDuration } });
      actions.push({
        type: 'addClip',
        trackId: located.trackId,
        clip: {
          name: clip.name,
          kind: clip.kind,
          start: Math.round(action.atMs),
          duration: rightDuration,
          offset: Math.round(clip.offset + leftDuration),
          hue: clip.hue,
          assetPath: clip.assetPath,
          volume: clip.volume,
          muted: clip.muted,
          fadeOutMs: clip.fadeOutMs,
        },
      });
      lines.push(`在 ${seconds(action.atMs)} 处把「${clip.name}」切成两段`);
      continue;
    }

    if (action.type === 'removeClip') {
      actions.push({ type: 'removeClip', trackId: located.trackId, clipId: located.clipId });
      lines.push(
        `删除 ${track.name}#${orderedClips(track).findIndex((item) => item.id === clip.id) + 1}「${clip.name}」（${seconds(clip.start)}–${seconds(clip.start + clip.duration)}）`,
      );
      continue;
    }

    const fields = patchToClipFields(action.patch);
    if (!Object.keys(fields).length) {
      notes.push(`「${action.ref}」没有可应用的改动字段。`);
      continue;
    }
    actions.push({ type: 'updateClip', trackId: located.trackId, clipId: located.clipId, patch: fields });
    const changes = Object.entries(fields)
      .map(([key, value]) => `${key}: ${typeof value === 'number' ? Math.round(value * 100) / 100 : String(value)}`)
      .join('，');
    lines.push(`修改「${clip.name}」→ ${changes}`);
  }

  return { actions, lines, notes, seekMs, inserts, undo };
}
