import type {
  Asset,
  AudioClip,
  Effect,
  ImageClip,
  Project,
  TextClip,
  VideoClip,
} from '@miaoma/video-project';
import { projectDurationMs } from '@miaoma/video-project';
import {
  escapeFilterText,
  fontRefToOption,
  hexToFfmpegColor,
  msToSec,
  resolveFontRef,
} from './fonts';

export interface RenderCapabilities {
  videoEncoder: string;
  audioEncoder: string;
  pixelFormat: string;
  drawtext: boolean;
  subtitles: boolean;
  /**
   * 该 ffmpeg 实际列出的 H.264 系编码器（按优先级排序）。
   * 预览代理只认 H.264（Chromium 可解码），首选编码器在真实素材上失败时可依次回退，
   * 因此与 videoEncoder 分开暴露。老缓存/老调用方可不填。
   */
  videoEncoderCandidates?: string[];
}

export interface BuildOptions {
  drawtextAvailable: boolean;
  subtitlesAvailable: boolean;
  videoEncoder: string;
  audioEncoder: string;
  pixelFormat: string;
  /** 视频码率，如 '16M'；不传则由调用方决定（默认不限制） */
  videoBitrate?: string;
  fontFile?: string | null;
}

export interface BuiltInput {
  index: number;
  assetId: string;
  filePath: string;
  isImage: boolean;
  hasVideo: boolean;
  hasAudio: boolean;
}

export interface RenderPlan {
  outputPath: string;
  args: string[];
  filterComplex: string;
  inputs: BuiltInput[];
  totalMs: number;
  warnings: string[];
}

interface MediaFlags {
  hasVideo: boolean;
  hasAudio: boolean;
  isImage: boolean;
}

/** ===== 效果消费（模块 4.1 P1：filter-builder 真正消费 EffectSchema） ===== */

interface ClipEffectResult {
  /** 片段内部时间基准的淡入/淡出秒数（fade 滤镜在 setpts 平移前插入） */
  fadeInSec: number;
  fadeOutSec: number;
  /** 已消毒的滤镜链片段（eq/hue/boxblur），拼在 format=rgba 之后 */
  videoFilters: string[];
}

function sanitizeNum(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clampNum(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

/**
 * 解析 clip.effects（kind: transition / filter）为 FFmpeg 滤镜片段。
 *
 * 安全：只接受固定滤镜白名单 + 有限数字参数，绝不把工程文件里的任意字符串
 * 直接拼进 filter_complex（防止工程 JSON 成为注入面）；未知项只告警跳过。
 */
function collectClipEffects(clip: { effects?: Effect[] }, warnings: string[]): ClipEffectResult {
  let fadeInSec = 0;
  let fadeOutSec = 0;
  const videoFilters: string[] = [];

  for (const fx of clip.effects ?? []) {
    if (fx.enabled === false) continue;
    // durationMs 缺省 500ms，上限 10s（防非法值撞大渲染成本）
    const d = clampNum(sanitizeNum(fx.params?.durationMs, 500), 0, 10_000) / 1000;
    const name = String(fx.name ?? '').toLowerCase();

    switch (fx.kind) {
      case 'transition':
        if (name === 'fade-in' || name === 'fadein') fadeInSec = Math.max(fadeInSec, d);
        else if (name === 'fade-out' || name === 'fadeout') fadeOutSec = Math.max(fadeOutSec, d);
        else if (name === 'fade' || name === 'fade-both') {
          fadeInSec = Math.max(fadeInSec, d);
          fadeOutSec = Math.max(fadeOutSec, d);
        } else {
          warnings.push(`转场「${fx.name}」暂不支持渲染：当前支持 fade-in / fade-out / fade`);
        }
        break;
      case 'filter':
        if (name === 'blackwhite' || name === 'black-and-white' || name === 'grayscale') {
          videoFilters.push('hue=s=0');
        } else if (name === 'blur') {
          const radius = clampNum(Math.round(sanitizeNum(fx.params?.radius, 5)), 1, 20);
          videoFilters.push(`boxblur=${radius}:1`);
        } else if (name === 'eq' || name === 'adjust') {
          const brightness = clampNum(sanitizeNum(fx.params?.brightness, 0), -1, 1);
          const contrast = clampNum(sanitizeNum(fx.params?.contrast, 1), 0, 3);
          const saturation = clampNum(sanitizeNum(fx.params?.saturation, 1), 0, 3);
          videoFilters.push(`eq=brightness=${brightness}:contrast=${contrast}:saturation=${saturation}`);
        } else {
          warnings.push(`滤镜「${fx.name}」不在支持白名单（eq / blackwhite / blur），已跳过`);
        }
        break;
      case 'lut':
        warnings.push(`LUT 效果「${fx.name}」当前版本未接入渲染`);
        break;
      case 'animation':
        warnings.push(`动画效果「${fx.name}」当前版本未接入渲染`);
        break;
    }
  }
  return { fadeInSec, fadeOutSec, videoFilters };
}

function assetMediaFlags(asset: Asset): MediaFlags {
  switch (asset.type) {
    case 'video':
      return { hasVideo: true, hasAudio: asset.hasAudio, isImage: false };
    case 'image':
      return { hasVideo: true, hasAudio: false, isImage: true };
    case 'audio':
      return { hasVideo: false, hasAudio: true, isImage: false };
    case 'subtitle':
      return { hasVideo: false, hasAudio: false, isImage: false };
    default:
      return { hasVideo: false, hasAudio: false, isImage: false };
  }
}

/**
 * 将时间线工程转换为 FFmpeg 渲染方案。
 *
 * 设计：
 *  - 视频轨自下而上叠加（track.order 越大层级越靠上），每条片段经 trim/scale/pad/opacity
 *    处理后用 overlay 合成到画布上；片段的 effects（transition fade-in/out、eq/blackwhite/blur）
 *    在此消费，未知效果降级为 warnings；
 *  - 音频：视频自带音轨 + 音频轨片段统一 atrim→adelay→volume→afade 后 amix；
 *  - 字幕：TextClip 用 drawtext 烧录（需 ffmpeg 编译 drawtext），缺失时降级并告警；
 *  - 外挂字幕素材用 subtitles 滤镜，缺失时降级告警；
 *  - 背景为 color 源，时长 = 工程总时长，保证输出长度恒定。
 */
export function buildRenderPlan(
  project: Project,
  outputPath: string,
  opts: BuildOptions,
): RenderPlan {
  const canvas = project.canvas;
  const W = canvas.width;
  const H = canvas.height;
  const fps = canvas.fps;
  const totalMs = Math.max(1000, projectDurationMs(project));
  const totalSec = totalMs / 1000;

  const assetById = new Map<string, Asset>();
  for (const a of project.assets) assetById.set(a.id, a);

  const inputs: BuiltInput[] = [];
  const inputIndexByAsset = new Map<string, number>();

  const ensureInput = (assetId: string): BuiltInput | null => {
    const asset = assetById.get(assetId);
    if (!asset) return null;
    const existing = inputIndexByAsset.get(assetId);
    if (existing !== undefined) return inputs[existing]!;
    const flags = assetMediaFlags(asset);
    const idx = inputs.length;
    const built: BuiltInput = {
      index: idx,
      assetId,
      filePath: asset.path,
      isImage: flags.isImage,
      hasVideo: flags.hasVideo,
      hasAudio: flags.hasAudio,
    };
    inputs.push(built);
    inputIndexByAsset.set(assetId, idx);
    return built;
  };

  const warnings: string[] = [];

  // ---- 收集片段 ----
  interface VideoItem {
    input: BuiltInput;
    clip: VideoClip | ImageClip;
    order: number;
  }
  interface AudioItem {
    input: BuiltInput;
    clip: AudioClip;
    fromVideo: boolean;
  }
  const videoItems: VideoItem[] = [];
  const audioItems: AudioItem[] = [];
  const textItems: TextClip[] = [];

  for (const track of project.tracks) {
    if (track.type === 'text') {
      for (const clip of track.clips) {
        if (clip.enabled !== false) textItems.push(clip);
      }
      continue;
    }
    if (track.type === 'audio') {
      for (const clip of track.clips) {
        if (clip.enabled === false) continue;
        const input = ensureInput(clip.assetId);
        if (!input) {
          warnings.push(`音频片段「${clip.name ?? clip.id}」引用的素材缺失，已跳过`);
          continue;
        }
        audioItems.push({ input, clip, fromVideo: false });
      }
      continue;
    }
    // video track: 视频片段 + 图片片段
    const order = track.order;
    for (const clip of track.clips) {
      if (clip.enabled === false) continue;
      const input = ensureInput(clip.assetId);
      if (!input) {
        warnings.push(`视频片段「${clip.name ?? clip.id}」引用的素材缺失，已跳过`);
        continue;
      }
      videoItems.push({ input, clip, order });
    }
  }

  // video/图片按层级（order 小在下）再按 start 排序，保证叠放顺序正确
  videoItems.sort((a, b) => a.order - b.order || a.clip.start - b.clip.start);

  // 视频自带音轨：仅当素材 hasAudio 且片段未静音
  for (const item of videoItems) {
    const asset = assetById.get(item.input.assetId);
    if (asset && asset.type === 'video' && asset.hasAudio) {
      const vc = item.clip as VideoClip;
      if (!vc.muted) {
        const audioClip: AudioClip = {
          type: 'audio',
          id: `${vc.id}__audio`,
          name: vc.name,
          start: vc.start,
          duration: vc.duration,
          offset: vc.offset,
          speed: vc.speed,
          locked: vc.locked,
          enabled: vc.enabled,
          effects: [],
          assetId: vc.assetId,
          volume: vc.volume,
          muted: false,
          fade: { fadeIn: 0, fadeOut: 0 },
        };
        audioItems.push({ input: item.input, clip: audioClip, fromVideo: true });
      }
    }
  }

  // ---- filter 图 ----
  const segments: string[] = [];
  const bg = hexToFfmpegColor(canvas.backgroundColor || '#000000');
  segments.push(`color=c=${bg}:s=${W}x${H}:r=${fps}:d=${totalSec},format=rgba[base]`);

  let acc = '[base]';
  let videoCount = 0;

  for (const item of videoItems) {
    const clip = item.clip;
    const i = item.input.index;
    const srcLabel = `[${i}:v]`;
    const inLabel = `${srcLabel}trim=start=${msToSec(clip.offset)}:end=${msToSec(
      clip.offset + clip.duration,
    )},setpts=PTS-STARTPTS`;
    const chain: string[] = [inLabel];

    // 适配画布（contain）：force_divisible_by=2 保证缩放后边长为偶数，
    // AI 生成素材尺寸五花八门（实测 MiniMax H3 会回 1344x768），竖屏画布 contain 后会得到
    // 1080x617 这种奇数高，部分滤镜/编码器组合会直接报「not divisible by 2」
    chain.push(`scale=w=${W}:h=${H}:force_original_aspect_ratio=decrease:force_divisible_by=2`);
    chain.push(`setsar=1`);

    // 旋转（仅非零时）
    const rot = clip.transform.rotation ?? 0;
    if (rot) {
      const angle = ((rot * Math.PI) / 180).toFixed(4);
      chain.push(
        `rotate=angle=${angle}:ow=${W}:oh=${H}:c=none:fillcolor=black@0`,
      );
    }

    // 用户缩放 + 居中到画布
    const scale = Math.max(0.01, clip.transform.scale);
    chain.push(`scale=w=iw*${scale}:h=ih*${scale}`);
    chain.push(`pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black@0`);
    chain.push(`format=rgba`);
    const opacity = clip.transform.opacity ?? 1;
    if (opacity < 1) chain.push(`colorchannelmixer=aa=${opacity}`);

    // 效果消费：滤镜白名单 + fade 转场（alpha 淡入淡出，叠加在画布上视觉等同于淡入自背景）
    // 注意：以下滤镜均基于片段内部时间（setpts 尚未平移），必须在 setpts=PTS+start 之前插入
    const fx = collectClipEffects(clip, warnings);
    for (const f of fx.videoFilters) chain.push(f);
    const clipDurSec = clip.duration / 1000;
    const fadeIn = Number(Math.min(fx.fadeInSec, clipDurSec).toFixed(3));
    const fadeOut = Number(Math.min(fx.fadeOutSec, clipDurSec).toFixed(3));
    if (fadeIn > 0) chain.push(`fade=t=in:st=0:d=${fadeIn}:alpha=1`);
    if (fadeOut > 0) {
      const outStart = Math.max(0, Number((clipDurSec - fadeOut).toFixed(3)));
      chain.push(`fade=t=out:st=${outStart}:d=${fadeOut}:alpha=1`);
    }

    // 把片段移动到时间线入点
    chain.push(`setpts=PTS+${msToSec(clip.start)}/TB`);

    const vlabel = `[vc${videoCount}]`;
    segments.push(`${chain.join(',')}${vlabel}`);

    // 叠加到画布
    const t = clip.transform;
    const tx = t.x;
    const ty = t.y;
    const startSec = msToSec(clip.start);
    const endSec = msToSec(clip.start + clip.duration);
    const nextAcc = acc === '[base]' ? '[ov0]' : `[ov${videoCount + 1}]`;
    segments.push(
      `${acc}[vc${videoCount}]overlay=x=(W-w)/2+${tx}:y=(H-h)/2+${ty}:repeatlast=0:enable='between(t,${startSec},${endSec}')${nextAcc}`,
    );
    acc = nextAcc;
    videoCount++;
  }

  // ---- 音频 ----
  let audioLabel: string | null = null;
  if (audioItems.length > 0) {
    const acLabels: string[] = [];
    audioItems.forEach((item, k) => {
      const clip = item.clip;
      const i = item.input.index;
      const src = item.fromVideo ? `[${i}:a]` : `[${i}:a]`;
      const startSec = msToSec(clip.start);
      const offSec = msToSec(clip.offset);
      const endOffSec = msToSec(clip.offset + clip.duration);
      const vol = clip.muted ? 0 : clip.volume;
      const fade = clip.fade ?? { fadeIn: 0, fadeOut: 0 };
      const parts: string[] = [
        `${src}atrim=start=${offSec}:end=${endOffSec},asetpts=PTS-STARTPTS`,
        `adelay=${clip.start}:all=1`,
        `volume=${vol}`,
      ];
      if (fade.fadeIn > 0) {
        parts.push(`afade=t=in:st=${startSec}:d=${msToSec(fade.fadeIn)}`);
      }
      if (fade.fadeOut > 0) {
        const outStart = Math.max(0, clip.start + clip.duration - fade.fadeOut);
        parts.push(`afade=t=out:st=${msToSec(outStart)}:d=${msToSec(fade.fadeOut)}`);
      }
      const label = `[ac${k}]`;
      segments.push(`${parts.join(',')}${label}`);
      acLabels.push(label);
    });
    if (acLabels.length === 1) {
      audioLabel = acLabels[0]!;
    } else {
      audioLabel = '[aud]';
      segments.push(`${acLabels.join('')}amix=inputs=${acLabels.length}:duration=longest:normalize=0${audioLabel}`);
    }
  }

  // ---- 字幕烧录 ----
  textItems.forEach((clip, k) => {
    const startSec = msToSec(clip.start);
    const endSec = msToSec(clip.start + clip.duration);
    const style = clip.style;
    if (opts.drawtextAvailable && clip.content.trim().length > 0) {
      const fontRef =
        opts.fontFile && opts.fontFile.trim().length > 0
          ? { kind: 'file' as const, path: opts.fontFile }
          : resolveFontRef(style.fontFamily);
      const fontOpt = fontRefToOption(fontRef);
      const color = hexToFfmpegColor(style.color === 'transparent' ? '#ffffff' : style.color);
      const bgColor =
        style.backgroundColor && style.backgroundColor !== 'transparent'
          ? `:box=1:boxcolor=${hexToFfmpegColor(style.backgroundColor)}@1`
          : '';
      const stroke =
        style.strokeColor && style.strokeColor !== 'transparent' && style.strokeWidth > 0
          ? `:borderw=${style.strokeWidth}:bordercolor=${hexToFfmpegColor(style.strokeColor)}`
          : '';
      const xExpr =
        style.align === 'left'
          ? `(w*${style.x})`
          : style.align === 'right'
            ? `(w*${style.x})-text_w`
            : `(w*${style.x})-text_w/2`;
      const yExpr = `(h*${style.y})-text_h/2`;
      const fontOptStr = fontOpt ? `${fontOpt}:` : '';
      const chain = `drawtext=${fontOptStr}text=${escapeFilterText(
        clip.content,
      )}:fontcolor=${color}:fontsize=${style.fontSize}:x=${xExpr}:y=${yExpr}${bgColor}${stroke}:alpha=1:enable='between(t,${startSec},${endSec})'`;
      const label = `[dt${k}]`;
      segments.push(`${acc}${chain}${label}`);
      acc = label;
    } else if (clip.content.trim().length > 0) {
      warnings.push(
        `字幕「${clip.content.slice(0, 12)}…」未烧录：当前 FFmpeg 未编译 drawtext，请使用完整版 FFmpeg（见模块 5.1 打包配置）`,
      );
    }
  });

  // ---- 收尾：色彩空间转换 + map ----
  const outLabel = '[outv]';
  segments.push(`${acc}format=${opts.pixelFormat}${outLabel}`);

  // ---- 组装命令行参数 ----
  const args: string[] = ['-hide_banner', '-y'];
  for (const input of inputs) {
    if (input.isImage) args.push('-loop', '1');
    args.push('-i', input.filePath);
  }
  args.push('-filter_complex', segments.join(';'));
  args.push('-map', outLabel);
  if (audioLabel) args.push('-map', audioLabel);
  args.push('-c:v', opts.videoEncoder, '-pix_fmt', opts.pixelFormat, '-r', String(fps));
  if (opts.videoBitrate) {
    const m = /^\s*(\d+)\s*([kKMG]?)\s*$/.exec(opts.videoBitrate);
    if (m) {
      const num = Number(m[1]);
      const suffix = m[2] ?? '';
      // VBV 约束：限制峰值码率，缓冲设为码率 2 倍，避免码率失控
      args.push('-b:v', opts.videoBitrate, '-maxrate', opts.videoBitrate, '-bufsize', `${num * 2}${suffix}`);
    } else {
      args.push('-b:v', opts.videoBitrate);
    }
  }
  if (audioLabel) args.push('-c:a', opts.audioEncoder, '-b:a', '192k');
  args.push('-t', totalSec.toFixed(3), '-movflags', '+faststart', outputPath);

  return {
    outputPath,
    args,
    filterComplex: segments.join(';'),
    inputs,
    totalMs,
    warnings,
  };
}
