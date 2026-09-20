import { createId as createUuid } from '@miaoma/video-project';

/** 毫秒 → 00:00 / 00:00:00 时间码 */
export function formatTimecode(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${String(h).padStart(2, '0')}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** 毫秒 → 00:00:00.000（时间线精确显示） */
export function formatTimecodeMs(ms: number): string {
  const base = formatTimecode(ms);
  const fraction = String(Math.max(0, Math.floor(ms)) % 1000).padStart(3, '0');
  return `${base}.${fraction}`;
}

/** 字幕 / 文本样式（编辑器可调整的子集，映射 core TextClip.style） */
export interface SubtitleStyle {
  fontFamily: string;
  fontSize: number;
  fontWeight: 'normal' | 'bold';
  color: string;
  backgroundColor: string;
  strokeColor: string;
  strokeWidth: number;
  align: 'left' | 'center' | 'right';
  /** 归一化位置，{ x: 0.5, y: 0.9 } 表示水平居中、靠近底部 */
  x: number;
  y: number;
}

export interface TimelineClip {
  id: string;
  name: string;
  kind: 'video' | 'audio' | 'text';
  /** 时间线入点（毫秒） */
  start: number;
  /** 片段时长（毫秒） */
  duration: number;
  /** 素材内入点（毫秒） */
  offset: number;
  hue: number;
  /** 真实素材路径（存在时用 miaoma:// 播放） */
  assetPath?: string;
  /** 淡入时长（毫秒）：视频/图片写入 effects 转场，音频写入 fade 字段 */
  fadeInMs?: number;
  /** 淡出时长（毫秒）：同 fadeInMs，按轨道类型分写 */
  fadeOutMs?: number;
  /** 字幕 / 文本内容（仅 kind === 'text' 时有效） */
  content?: string;
  /** 字幕 / 文本样式（仅 kind === 'text' 时有效） */
  textStyle?: SubtitleStyle;
}

export interface TimelineTrack {
  id: string;
  kind: 'video' | 'audio' | 'text';
  name: string;
  clips: TimelineClip[];
}

export function totalDuration(tracks: TimelineTrack[]): number {
  return tracks.reduce(
    (max, track) =>
      track.clips.reduce((m, clip) => Math.max(m, clip.start + clip.duration), max),
    0,
  );
}

/** 拖拽吸附：贴近 0 点或邻居片段边缘时对齐（阈值 200ms 屏幕时间） */
export function snapStart(
  start: number,
  duration: number,
  track: TimelineTrack,
  selfId: string,
  thresholdMs: number,
): number {
  const candidates = [0];
  for (const clip of track.clips) {
    if (clip.id === selfId) continue;
    candidates.push(clip.start, clip.start + clip.duration, clip.start - duration);
  }
  let best = Math.max(0, start);
  let bestDelta = thresholdMs;
  for (const candidate of candidates) {
    const delta = Math.abs(candidate - start);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = Math.max(0, candidate);
    }
  }
  return best;
}

/** 标尺刻度间隔（毫秒），随缩放自适应 */
export function tickInterval(visibleMs: number): number {
  const candidates = [100, 250, 500, 1000, 2000, 5000, 10_000, 30_000, 60_000, 300_000];
  return candidates.find((c) => visibleMs / c <= 12) ?? 600_000;
}

/**
 * 生成片段 / 轨道 id。
 *
 * 必须与工程模型一致使用 UUID：编辑器的 id 会直接作为 core Clip / Track 的 id 落盘，
 * 非 UUID 会在 ProjectSchema 校验（保存）时抛错。
 * prefix 仅保留调用点的可读性，不参与生成。
 */
export function createId(_prefix = 'id'): string {
  return createUuid();
}
