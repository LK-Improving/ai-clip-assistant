import {
  createId,
  DEFAULT_TEXT_STYLE,
  DEFAULT_TRANSFORM,
  nowIso,
  type Asset,
  type AudioClip,
  type Clip,
  type Effect,
  type ImageClip,
  type Project,
  type TextClip,
  type Track,
  type VideoClip,
} from '@miaoma/video-project';
import type { SubtitleStyle, TimelineClip, TimelineTrack } from './timeline-utils';

/**
 * 编辑器时间线（UI 模型） ↔ 工程文档（core Project，渲染/导出的唯一事实来源）双向桥接。
 *
 * 两边的差异：
 * - 编辑器 TimelineClip 只关心摆放（start/duration/offset）与展示（name/hue/assetPath）；
 * - core Clip 还要求 assetId 指向 project.assets，且 video/image/audio 素材带时长与分辨率。
 *
 * 因此转换时：
 * - 工程 → 时间线：assetId 反查素材路径；
 * - 时间线 → 工程：按路径复用已有素材，缺失时按扩展名新建素材（时长/分辨率取自素材库探测结果 hints，
 *   探测不到时退回默认值，保证 schema 合法而不是抛错）。
 */

const VIDEO_EXT = new Set(['.mp4', '.mov', '.mkv', '.avi', '.webm', '.m4v', '.flv']);
const AUDIO_EXT = new Set(['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg']);
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp']);

type CoreAssetType = 'video' | 'audio' | 'image';

function basename(target: string): string {
  const parts = target.split(/[\\/]/);
  return parts[parts.length - 1] || target;
}

function extOf(target: string): string {
  const name = basename(target);
  const index = name.lastIndexOf('.');
  return index < 0 ? '' : name.slice(index).toLowerCase();
}

function assetTypeOf(path: string, fallback: TimelineClip['kind']): CoreAssetType {
  const ext = extOf(path);
  if (VIDEO_EXT.has(ext)) return 'video';
  if (AUDIO_EXT.has(ext)) return 'audio';
  if (IMAGE_EXT.has(ext)) return 'image';
  return fallback === 'audio' ? 'audio' : 'video';
}

/** 由 id 稳定推导色相：同一片段多次加载颜色一致（纯 UI 用途，不落盘） */
export function hueOf(id: string): number {
  let sum = 0;
  for (let i = 0; i < id.length; i += 1) sum = (sum + id.charCodeAt(i) * (i + 1)) % 360;
  return sum;
}

function defaultTrackName(kind: TimelineTrack['kind'], index: number): string {
  const label = kind === 'video' ? '视频' : kind === 'audio' ? '音频' : '字幕';
  return `${label} ${index + 1}`;
}

// 轨道的 clips 是具体子类型数组，用类型守卫收窄，避免强制断言
const isTextClip = (clip: Clip): clip is TextClip => clip.type === 'text';
const isAudioClip = (clip: Clip): clip is AudioClip => clip.type === 'audio';
const isVisualClip = (clip: Clip): clip is VideoClip | ImageClip =>
  clip.type === 'video' || clip.type === 'image';

/**
 * core → UI：读片段淡入/淡出。
 * 音频取 fade 字段；视频/图片从 effects 里的 transition 条目（fade-in / fade-out / fade）解析。
 */
function readFade(clip: Clip): { fadeInMs?: number; fadeOutMs?: number } {
  if (clip.type === 'audio') {
    return {
      fadeInMs: clip.fade?.fadeIn > 0 ? clip.fade.fadeIn : undefined,
      fadeOutMs: clip.fade?.fadeOut > 0 ? clip.fade.fadeOut : undefined,
    };
  }
  if (clip.type === 'video' || clip.type === 'image') {
    let fadeIn: number | undefined;
    let fadeOut: number | undefined;
    for (const fx of clip.effects) {
      if (fx.kind !== 'transition' || fx.enabled === false) continue;
      const name = String(fx.name ?? '').toLowerCase();
      const d = typeof fx.params?.durationMs === 'number' ? fx.params.durationMs : 0;
      if (d <= 0) continue;
      if (name === 'fade-in' || name === 'fade' || name === 'fade-both') fadeIn = Math.max(fadeIn ?? 0, d);
      if (name === 'fade-out' || name === 'fade' || name === 'fade-both') fadeOut = Math.max(fadeOut ?? 0, d);
    }
    return { fadeInMs: fadeIn, fadeOutMs: fadeOut };
  }
  return {};
}

/**
 * UI → core：把淡入/淡出字段回写为 transition effects（保留非 fade 类效果）。
 * 两个字段均未提供（undefined）时原样保留既有 effects，避免覆盖 Agent/导入工程里的转场。
 */
function writeFadeEffects(base: Effect[], fadeInMs?: number, fadeOutMs?: number): Effect[] {
  if (fadeInMs === undefined && fadeOutMs === undefined) return base;
  const kept = base.filter(
    (fx) => !(fx.kind === 'transition' && /^fade/i.test(String(fx.name ?? ''))),
  );
  const out = [...kept];
  if (fadeInMs && fadeInMs > 0) {
    out.push({ id: createId(), kind: 'transition', name: 'fade-in', params: { durationMs: Math.round(fadeInMs) }, enabled: true });
  }
  if (fadeOutMs && fadeOutMs > 0) {
    out.push({ id: createId(), kind: 'transition', name: 'fade-out', params: { durationMs: Math.round(fadeOutMs) }, enabled: true });
  }
  return out;
}

/** 工程 → 编辑器时间线 */
export function projectToTimeline(project: Project): TimelineTrack[] {
  const assetById = new Map(project.assets.map((asset) => [asset.id, asset]));

  return project.tracks.map((track, index) => {
    const kind: TimelineTrack['kind'] =
      track.type === 'audio' ? 'audio' : track.type === 'text' ? 'text' : 'video';

    const clips: TimelineClip[] = track.clips.map((clip) => {
      const asset = 'assetId' in clip ? assetById.get(clip.assetId) : undefined;
      const textStyle: SubtitleStyle | undefined =
        clip.type === 'text'
          ? {
              fontFamily: clip.style.fontFamily,
              fontSize: clip.style.fontSize,
              fontWeight: clip.style.fontWeight,
              color: clip.style.color,
              backgroundColor: clip.style.backgroundColor,
              strokeColor: clip.style.strokeColor,
              strokeWidth: clip.style.strokeWidth,
              align: clip.style.align,
              x: clip.style.x,
              y: clip.style.y,
            }
          : undefined;
      return {
        id: clip.id,
        name:
          clip.type === 'text'
            ? clip.content || clip.name || '字幕'
            : clip.name || asset?.name || '片段',
        // 图片片段在编辑器里与视频同轨展示
        kind: clip.type === 'image' ? 'video' : clip.type,
        start: clip.start,
        duration: clip.duration,
        offset: clip.offset,
        hue: hueOf(clip.id),
        assetPath: asset?.path,
        content: clip.type === 'text' ? clip.content : undefined,
        textStyle,
        ...readFade(clip),
      };
    });

    return { id: track.id, kind, name: track.name || defaultTrackName(kind, index), clips };
  });
}

/** 新建素材时的元数据提示（来自素材库探测），缺项用兜底值保证 schema 合法 */
export interface AssetMetaHint {
  durationMs?: number;
  width?: number | null;
  height?: number | null;
  hasAudio?: boolean | null;
}

function buildAsset(
  path: string,
  type: CoreAssetType,
  hint: AssetMetaHint | undefined,
): Asset {
  // tags 虽在 schema 中有默认值，但 z.infer 的输出类型仍要求显式给出
  const base = { id: createId(), name: basename(path), path, addedAt: nowIso(), tags: [] };
  if (type === 'image') {
    return { ...base, type: 'image', width: hint?.width ?? 1920, height: hint?.height ?? 1080 };
  }
  const duration = hint?.durationMs ?? 5000;
  if (type === 'audio') {
    return { ...base, type: 'audio', duration };
  }
  return {
    ...base,
    type: 'video',
    duration,
    width: hint?.width ?? 1920,
    height: hint?.height ?? 1080,
    // 探测不到时默认有音轨（多数视频素材都带声音），比一律 false 更贴近真实，避免渲染丢音
    hasAudio: hint?.hasAudio ?? true,
  };
}

/**
 * 编辑器时间线 → 工程（回写改动）。
 * 已有同 id 片段会保留 transform / volume / fade / style 等编辑器未覆盖的字段。
 */
export function timelineToProject(
  project: Project,
  tracks: TimelineTrack[],
  hints?: Map<string, AssetMetaHint>,
): Project {
  const assets: Asset[] = [...project.assets];
  const assetIdByPath = new Map(assets.map((asset) => [asset.path, asset.id]));

  const existingClipById = new Map<string, Clip>(
    project.tracks.flatMap((track) => track.clips.map((clip) => [clip.id, clip] as [string, Clip])),
  );
  const existingTrackById = new Map(project.tracks.map((track) => [track.id, track]));

  const nextTracks: Track[] = [];

  tracks.forEach((track, index) => {
    const clips: Clip[] = [];

    for (const clip of track.clips) {
      const prev = existingClipById.get(clip.id);
      const common = {
        id: clip.id,
        name: clip.name,
        start: Math.max(0, Math.round(clip.start)),
        duration: Math.max(1, Math.round(clip.duration)),
        offset: Math.max(0, Math.round(clip.offset)),
      };

      if (track.kind === 'text') {
        const prevText = prev && prev.type === 'text' ? prev : undefined;
        clips.push({
          ...common,
          name: clip.content ?? clip.name,
          type: 'text',
          content: clip.content ?? clip.name,
          speed: prevText?.speed ?? 1,
          locked: prevText?.locked ?? false,
          enabled: prevText?.enabled ?? true,
          effects: prevText?.effects ?? [],
          style: { ...(prevText?.style ?? DEFAULT_TEXT_STYLE), ...(clip.textStyle ?? {}) },
          audioClipId: prevText?.audioClipId,
        });
        continue;
      }

      // 无真实素材的占位片段无法渲染，跳过而不是产出非法工程
      if (!clip.assetPath) continue;

      const type = assetTypeOf(clip.assetPath, track.kind);
      // 轨道类型与素材类型不兼容时跳过（例如音频素材落在视频轨）
      if (track.kind === 'audio' && type !== 'audio') continue;
      if (track.kind === 'video' && type === 'audio') continue;

      let assetId = assetIdByPath.get(clip.assetPath);
      if (!assetId) {
        const asset = buildAsset(clip.assetPath, type, hints?.get(clip.assetPath));
        assets.push(asset);
        assetId = asset.id;
        assetIdByPath.set(asset.path, asset.id);
      }

      const prevMedia =
        prev && (prev.type === 'video' || prev.type === 'image' || prev.type === 'audio')
          ? prev
          : undefined;
      const carried = {
        speed: prevMedia?.speed ?? 1,
        locked: prevMedia?.locked ?? false,
        enabled: prevMedia?.enabled ?? true,
        effects: prevMedia?.effects ?? [],
      };

      if (type === 'audio') {
        const prevAudio = prev && prev.type === 'audio' ? prev : undefined;
        clips.push({
          ...common,
          ...carried,
          type: 'audio',
          assetId,
          volume: prevAudio?.volume ?? 1,
          muted: prevAudio?.muted ?? false,
          // 音频淡入淡出走原生 fade 字段；UI 未提供时保留既有值
          fade: {
            fadeIn: Math.max(0, Math.round(clip.fadeInMs ?? prevAudio?.fade?.fadeIn ?? 0)),
            fadeOut: Math.max(0, Math.round(clip.fadeOutMs ?? prevAudio?.fade?.fadeOut ?? 0)),
          },
        });
      } else if (type === 'image') {
        const prevImage = prev && prev.type === 'image' ? prev : undefined;
        clips.push({
          ...common,
          ...carried,
          effects: writeFadeEffects(carried.effects, clip.fadeInMs, clip.fadeOutMs),
          type: 'image',
          assetId,
          transform: prevImage?.transform ?? DEFAULT_TRANSFORM,
        });
      } else {
        const prevVideo = prev && prev.type === 'video' ? prev : undefined;
        clips.push({
          ...common,
          ...carried,
          effects: writeFadeEffects(carried.effects, clip.fadeInMs, clip.fadeOutMs),
          type: 'video',
          assetId,
          transform: prevVideo?.transform ?? DEFAULT_TRANSFORM,
          volume: prevVideo?.volume ?? 1,
          muted: prevVideo?.muted ?? false,
        });
      }
    }

    // muted / locked / visible 在 schema 里有默认值，但输出类型要求显式给出；同 id 轨道保留原值
    const prevTrack = existingTrackById.get(track.id);
    const flags = {
      muted: prevTrack?.muted ?? false,
      locked: prevTrack?.locked ?? false,
      visible: prevTrack?.visible ?? true,
    };

    if (track.kind === 'audio') {
      nextTracks.push({
        id: track.id,
        type: 'audio',
        name: track.name,
        order: index,
        ...flags,
        clips: clips.filter(isAudioClip),
      });
    } else if (track.kind === 'text') {
      nextTracks.push({
        id: track.id,
        type: 'text',
        name: track.name,
        order: index,
        ...flags,
        clips: clips.filter(isTextClip),
      });
    } else {
      nextTracks.push({
        id: track.id,
        type: 'video',
        name: track.name,
        order: index,
        ...flags,
        clips: clips.filter(isVisualClip),
      });
    }
  });

  // 清理孤儿素材：时间线上已无任何 clip 引用的资产从 project.assets 移除，
  // 避免删除片段后素材元数据无限膨胀，保持工程「精确自包含」。
  const usedAssetIds = new Set<string>();
  for (const track of nextTracks) {
    for (const clip of track.clips) {
      if ('assetId' in clip) usedAssetIds.add(clip.assetId);
    }
  }
  const prunedAssets = assets.filter((asset) => usedAssetIds.has(asset.id));

  return { ...project, assets: prunedAssets, tracks: nextTracks };
}
