import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { interrupt } from '@langchain/langgraph';
import {
  createEmptyProject,
  createId,
  DEFAULT_TEXT_STYLE,
  DEFAULT_TRANSFORM,
  nowIso,
  ProjectSchema,
} from '@miaoma/video-project';
import type {
  AudioAsset,
  AudioClip,
  AudioTrack,
  ImageAsset,
  ImageClip,
  SubtitleAsset,
  TextClip,
  TextTrack,
  VideoAsset,
  VideoClip,
  VideoTrack,
} from '@miaoma/video-project';
import { PIPELINE_NODES } from './constants';
import { offlineBriefJson, offlineStoryboardJson } from './llm';
import { cosine, embedAsset, embedText, preprocessAssetSemantic } from './semantic';
import { invokeStructured } from './structured';
import type {
  AgentDeps,
  AgentState,
  Asset,
  Brief,
  SceneAssetType,
  SpeechSegment,
  Storyboard,
  StoryboardScene,
} from './types';

/** 节点返回值：对 LangGraph 状态通道的增量更新（completedNodes 由 pipeline 包装器统一追加） */
export type NodeUpdate = Partial<AgentState>;

const VIDEO_EXTS = ['mp4', 'mov', 'webm', 'mkv', 'avi', 'm4v'];
const IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'];
const AUDIO_EXTS = ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg'];
const SUBTITLE_EXTS = ['srt', 'ass', 'vtt', 'json'];
const ALL_EXTS = [...VIDEO_EXTS, ...IMAGE_EXTS, ...AUDIO_EXTS, ...SUBTITLE_EXTS];

/** ===== 节点 1：素材扫描 ===== */

export async function scanAssets(state: AgentState, deps: AgentDeps): Promise<NodeUpdate> {
  const assets: Asset[] = [];
  for (const dir of state.sourceDirs) {
    if (!existsSync(dir)) {
      deps.logger?.(`[scan] 目录不存在，跳过：${dir}`);
      continue;
    }
    for (const file of collectFiles(dir)) {
      const ext = path.extname(file).toLowerCase().replace(/^\./, '');
      if (!ALL_EXTS.includes(ext)) continue;
      try {
        const probe = await deps.probe(file);
        const asset = buildAsset(file, ext, probe);
        if (asset) assets.push(asset);
      } catch (e) {
        deps.logger?.(`[scan] 探测失败，跳过 ${file}：${(e as Error).message}`);
      }
    }
  }
  deps.logger?.(`[scan] 扫描到 ${assets.length} 个素材`);
  return { scannedAssets: assets };
}

function collectFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    let entries: Dirent[];
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) out.push(full);
    }
  };
  walk(dir);
  return out;
}

function buildAsset(file: string, ext: string, probe: { durationMs: number; width: number | null; height: number | null; hasAudio: boolean }): Asset | null {
  const id = createId();
  const name = path.basename(file);
  const addedAt = nowIso();
  const common = { id, name, path: file, addedAt, tags: [] as string[] };
  // 语义预处理（P2）：扫描即产出启发式描述 + 确定性特征向量，入工程后供匹配与检索复用
  const attachSemantic = <T extends Asset>(asset: T): T => {
    const s = preprocessAssetSemantic({
      name,
      type: asset.type,
      durationMs: 'duration' in asset ? asset.duration : undefined,
      width: 'width' in asset ? asset.width : undefined,
      height: 'height' in asset ? asset.height : undefined,
      hasAudio: 'hasAudio' in asset ? asset.hasAudio : undefined,
    });
    asset.description = s.description;
    asset.embedding = s.embedding;
    return asset;
  };
  if (IMAGE_EXTS.includes(ext)) {
    return attachSemantic({ ...common, type: 'image', width: probe.width ?? 1920, height: probe.height ?? 1080 } as ImageAsset);
  }
  if (AUDIO_EXTS.includes(ext)) {
    return attachSemantic({ ...common, type: 'audio', duration: Math.max(1, probe.durationMs || 5000) } as AudioAsset);
  }
  if (SUBTITLE_EXTS.includes(ext)) {
    const format = (SUBTITLE_EXTS.includes(ext) ? ext : 'srt') as 'srt' | 'ass' | 'vtt' | 'json';
    return attachSemantic({ ...common, type: 'subtitle', format, duration: probe.durationMs || 0 } as SubtitleAsset);
  }
  if (VIDEO_EXTS.includes(ext)) {
    return attachSemantic({
      ...common,
      type: 'video',
      duration: Math.max(1, probe.durationMs || 5000),
      width: probe.width ?? 1920,
      height: probe.height ?? 1080,
      hasAudio: probe.hasAudio,
    } as VideoAsset);
  }
  return null;
}

/** ===== 节点 2：创意简报（Function Calling + Zod + 自动重试） ===== */

/** emit_creative_brief 工具的 JSON Schema（手写，避免 zod→JSON Schema 版本兼容问题） */
const BRIEF_TOOL_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    theme: { type: 'string' },
    tone: { type: 'string' },
    targetDurationMs: { type: 'number' },
    canvas: {
      type: 'object',
      properties: { width: { type: 'number' }, height: { type: 'number' }, fps: { type: 'number' } },
      required: ['width', 'height', 'fps'],
    },
    style: { type: 'array', items: { type: 'string' } },
    outline: { type: 'array', items: { type: 'string' } },
  },
  required: ['title', 'theme', 'tone', 'targetDurationMs', 'canvas', 'style', 'outline'],
} as const;

export async function creativeBrief(state: AgentState, deps: AgentDeps): Promise<NodeUpdate> {
  const sys =
    '你是创意简报生成器（creative-brief）。根据用户的剪辑需求，输出 JSON：' +
    '{title, theme, tone, targetDurationMs, canvas:{width,height,fps}, style:[字符串], outline:[字符串]}';
  const brief = await invokeStructured({
    model: deps.llm,
    system: sys,
    user: state.requirement,
    tool: { name: 'emit_creative_brief', description: '输出创意简报 JSON', schema: BRIEF_TOOL_SCHEMA },
    parse: parseBrief,
    signal: deps.signal,
    logger: deps.logger,
    onToken: deps.onToken ? (delta) => deps.onToken?.('creative-brief', delta) : undefined,
    // 重试耗尽后的确定性降级：离线生成器保证链路不中断
    fallback: () => parseBrief(offlineBriefJson(state.requirement)),
  });
  deps.logger?.(`[brief] ${brief.title} / 目标 ${(brief.targetDurationMs / 1000).toFixed(0)}s`);
  return { brief };
}

const BriefSchema = z.object({
  title: z.string().default('未命名作品'),
  theme: z.string().default('生活记录'),
  tone: z.string().default('轻松'),
  targetDurationMs: z.number().int().nonnegative().default(30_000),
  canvas: z
    .object({ width: z.number().int().positive(), height: z.number().int().positive(), fps: z.number().positive() })
    .default({ width: 1920, height: 1080, fps: 30 }),
  style: z.array(z.string()).default([]),
  outline: z.array(z.string()).default([]),
});

function parseBrief(raw: unknown): Brief {
  let obj: unknown = raw;
  if (typeof raw === 'string') {
    try {
      obj = JSON.parse(raw);
    } catch {
      obj = {};
    }
  }
  const parsed = BriefSchema.parse(obj);
  return parsed as Brief;
}

/** ===== 节点 3：分镜规划（Function Calling + Zod + 自动重试） ===== */

/** emit_storyboard 工具的 JSON Schema：scenes 数组 */
const STORYBOARD_TOOL_SCHEMA = {
  type: 'object',
  properties: {
    scenes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          order: { type: 'number' },
          title: { type: 'string' },
          description: { type: 'string' },
          narration: { type: 'string' },
          assetType: { type: 'string', enum: ['video', 'image', 'audio', 'any'] },
          durationMs: { type: 'number' },
        },
        required: ['order', 'title', 'description', 'narration', 'assetType', 'durationMs'],
      },
    },
  },
  required: ['scenes'],
} as const;

export async function storyboardNode(state: AgentState, deps: AgentDeps): Promise<NodeUpdate> {
  const assetsSummary = state.scannedAssets.map((a) => ({
    id: a.id,
    name: a.name,
    type: a.type,
    durationMs: 'duration' in a ? a.duration : 0,
  }));
  const payload = JSON.stringify({
    requirement: state.requirement,
    brief: state.brief,
    assets: assetsSummary,
  });
  const sys =
    '你是分镜脚本生成器（storyboard）。根据需求、简报与素材清单，输出 JSON 数组：' +
    '[{order, title, description, narration, assetType:"video"|"image"|"audio"|"any", durationMs}]';
  const storyboard = await invokeStructured({
    model: deps.llm,
    system: sys,
    user: payload,
    tool: { name: 'emit_storyboard', description: '输出分镜场景数组（scenes）', schema: STORYBOARD_TOOL_SCHEMA },
    parse: parseStoryboard,
    signal: deps.signal,
    logger: deps.logger,
    onToken: deps.onToken ? (delta) => deps.onToken?.('storyboard-plan', delta) : undefined,
    fallback: () => parseStoryboard(offlineStoryboardJson(payload)),
  });
  deps.logger?.(`[storyboard] ${storyboard.scenes.length} 个场景`);
  return { storyboard };
}

const SceneSchema = z.object({
  order: z.number().int().nonnegative(),
  title: z.string().default(''),
  description: z.string().default(''),
  narration: z.string().default(''),
  assetType: z.enum(['video', 'image', 'audio', 'any']).default('any'),
  durationMs: z.number().int().positive(),
});

function parseStoryboard(raw: unknown): Storyboard {
  let arr: unknown = raw;
  if (typeof raw === 'string') {
    try {
      arr = JSON.parse(raw);
    } catch {
      arr = null;
    }
  }
  let scenesRaw: Array<Record<string, unknown>> = [];
  if (Array.isArray(arr)) scenesRaw = arr as Array<Record<string, unknown>>;
  else if (arr && typeof arr === 'object' && Array.isArray((arr as { scenes?: unknown }).scenes)) {
    scenesRaw = (arr as { scenes: Array<Record<string, unknown>> }).scenes;
  }
  if (scenesRaw.length === 0) {
    scenesRaw = [{ order: 0, title: '默认段落', description: '自动分镜', narration: '', assetType: 'any', durationMs: 5000 }];
  }
  const scenes: StoryboardScene[] = scenesRaw.map((s, i) =>
    SceneSchema.parse({ ...s, order: typeof s.order === 'number' ? s.order : i, durationMs: typeof s.durationMs === 'number' ? s.durationMs : 5000 }) as StoryboardScene,
  );
  return { scenes };
}

/** ===== 节点 4：素材匹配（P2 语义升级：余弦得分贪心分配，无信号时等价于原轮转） ===== */

export async function matchAssets(state: AgentState, deps: AgentDeps): Promise<NodeUpdate> {
  const storyboard = state.storyboard!;
  const assets = state.scannedAssets;
  const sceneAssets: Record<number, string | null> = {};
  const poolOf = (want: SceneAssetType) => assets.filter((a) => matchType(a.type, want));
  const assetIndex = new Map(assets.map((a, i) => [a.id, i]));

  // 全局 (scene, asset) 配对按语义得分降序贪心分配：每场景最多一次、每素材最多用一次；
  // 得分并列按场景序→素材库序，无信号时（分数全 0）结果与原类型轮转完全一致（确定性）。
  interface Pair { order: number; asset: Asset; score: number; assetIdx: number }
  const pairs: Pair[] = [];
  for (const scene of storyboard.scenes) {
    const query = embedText(`${scene.title} ${scene.description} ${scene.narration}`);
    for (const asset of poolOf(scene.assetType)) {
      pairs.push({
        order: scene.order,
        asset,
        score: cosine(query, embedAsset(asset)),
        assetIdx: assetIndex.get(asset.id) ?? 0,
      });
    }
  }
  pairs.sort((a, b) => b.score - a.score || a.order - b.order || a.assetIdx - b.assetIdx);

  const usedAssetIds = new Set<string>();
  const pickedScenes = new Set<number>();
  for (const p of pairs) {
    if (pickedScenes.has(p.order) || usedAssetIds.has(p.asset.id)) continue;
    sceneAssets[p.order] = p.asset.id;
    usedAssetIds.add(p.asset.id);
    pickedScenes.add(p.order);
  }

  // 场景数超过可用素材：剩余场景按类型轮回复用（保持原语义）
  const cursors: Record<SceneAssetType, number> = { video: 0, image: 0, audio: 0, any: 0 };
  for (const scene of storyboard.scenes) {
    if (pickedScenes.has(scene.order)) continue;
    const pool = poolOf(scene.assetType);
    if (pool.length === 0) {
      sceneAssets[scene.order] = null;
      continue;
    }
    const idx = cursors[scene.assetType] % pool.length;
    sceneAssets[scene.order] = pool[idx]?.id ?? null;
    cursors[scene.assetType] += 1;
  }

  const matched = Object.values(sceneAssets).filter(Boolean).length;
  deps.logger?.(`[match] ${matched}/${storyboard.scenes.length} 个场景匹配到素材（语义优先贪心）`);
  return { matchResult: { sceneAssets } };
}

function matchType(assetType: Asset['type'], want: SceneAssetType): boolean {
  if (want === 'any') return assetType === 'video' || assetType === 'image';
  if (want === 'audio') return assetType === 'audio';
  return assetType === want;
}

/** ===== 节点 4.5：AI 视频生成（补全无素材场景） ===== */

/**
 * 为「分镜里没有匹配到真实素材」的场景生成 AI 视频片段（MiniMax H3 等）。
 *
 * - 仅在视频生成 Provider 已配置（isConfigured）时工作；离线/未配置则直接跳过，
 *   保证无网络/无密钥时整条链路仍端到端跑通（与 TTS 降级策略一致）。
 * - 生成结果作为 video Asset 追加到 state.scannedAssets，并把 matchResult 指回去，
 *   后续 speech-synthesis / assemble-timeline 无需感知「这段是 AI 生成的」——统一走普通视频素材逻辑。
 * - 单段失败只记日志跳过，不中断整条流水线（抽卡失败不应拖垮成片）。
 */
export async function generateClips(state: AgentState, deps: AgentDeps): Promise<NodeUpdate> {
  const vg = deps.videoGen;
  if (!vg || !vg.isConfigured()) {
    deps.logger?.('[gen-clips] 未配置视频生成 Provider，跳过 AI 生成素材（场景将退化为字幕/标题）');
    return {};
  }

  const storyboard = state.storyboard!;
  const matchResult = state.matchResult!;
  const sceneAssets = { ...matchResult.sceneAssets };
  const addedAssets: Asset[] = [];
  const canvas = state.brief?.canvas;
  const ratio: '16:9' | '9:16' | '1:1' =
    canvas && canvas.height > canvas.width ? '9:16' : canvas && canvas.width === canvas.height ? '1:1' : '16:9';

  let generated = 0;
  for (const scene of storyboard.scenes) {
    const existing = sceneAssets[scene.order];
    if (existing) continue; // 已有真实素材，不必 AI 生成

    const prompt = (scene.description || scene.title || scene.narration || state.requirement).trim().slice(0, 800);
    if (!prompt) continue;

    try {
      const res = await vg.generate({
        prompt,
        durationSec: scene.durationMs / 1000,
        ratio,
      });
      const asset: Asset = {
        id: createId(),
        name: `AI生成-${scene.order + 1}.${res.ext}`,
        path: res.videoPath,
        addedAt: nowIso(),
        type: 'video',
        duration: Math.max(1, res.durationMs),
        width: res.width ?? 1920,
        height: res.height ?? 1080,
        hasAudio: true,
        tags: ['ai-generated'],
        // 语义预处理：把场景画面描述写进素材，二次编辑时检索/匹配可命中
        description: (scene.description || scene.title).slice(0, 200),
      };
      asset.embedding = embedAsset(asset);
      sceneAssets[scene.order] = asset.id;
      addedAssets.push(asset);
      generated += 1;
      deps.logger?.(`[gen-clips] 场景 ${scene.order} 生成视频：${res.videoPath}`);
    } catch (e) {
      deps.logger?.(`[gen-clips] 场景 ${scene.order} 生成失败，跳过：${(e as Error).message}`);
    }
  }

  deps.logger?.(`[gen-clips] 共生成 ${generated} 段 AI 视频`);
  return {
    scannedAssets: [...state.scannedAssets, ...addedAssets],
    matchResult: { sceneAssets },
  };
}

/** ===== 节点 5：语音合成 ===== */

export async function speechSynthesis(state: AgentState, deps: AgentDeps): Promise<NodeUpdate> {
  const storyboard = state.storyboard!;
  mkdirSync(deps.workDir, { recursive: true });
  const segments: SpeechSegment[] = [];

  for (const scene of storyboard.scenes) {
    const text = (scene.narration ?? '').trim();
    if (!text) continue;
    // M3：场景指定了音色库 id 时透传给适配层（零样本克隆链；不可用自动降级常规音色）
    const res = await deps.tts.synthesize({ text, voiceId: scene.voiceId });
    const fileName = `tts-${scene.order}-${createId().slice(0, 8)}.${res.ext}`;
    const outPath = path.join(deps.workDir, fileName);
    writeFileSync(outPath, res.data);
    segments.push({
      sceneOrder: scene.order,
      text,
      audioAssetId: createId(),
      audioPath: outPath,
      durationMs: res.durationMs,
    });
  }

  deps.logger?.(`[tts] 合成 ${segments.length} 段旁白`);
  return { speechSegments: segments };
}

/** ===== 节点 6：时间线组装 ===== */

/**
 * AI 智能转场（M4，确定性规则，仅补空缺不覆盖已有配置）：
 * - 首段淡入 800ms、末段淡出 1200ms（开场交代/收尾呼吸，剪映式成片惯例）；
 * - 相邻连续片段（间隙 ≤100ms）且任一段时长 <4s 视为快切换场 → 前段淡出/后段淡入 400ms 成对；
 * - 用户/上游已设同名 transition 效果时跳过，幂等可重跑。
 */
export function applyAutoTransitions(clips: Array<VideoClip | ImageClip>): void {
  if (clips.length === 0) return;
  const sorted = [...clips].sort((a, b) => a.start - b.start);
  const hasFade = (clip: VideoClip | ImageClip, name: string): boolean =>
    clip.effects.some((e) => e.kind === 'transition' && String(e.name).toLowerCase() === name);
  const addFade = (clip: VideoClip | ImageClip, name: 'fade-in' | 'fade-out', durationMs: number): void => {
    if (hasFade(clip, name)) return;
    clip.effects.push({ id: createId(), kind: 'transition', name, params: { durationMs }, enabled: true });
  };
  const first = sorted[0]!;
  const last = sorted[sorted.length - 1]!;
  addFade(first, 'fade-in', 800);
  addFade(last, 'fade-out', 1200);
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i]!;
    const b = sorted[i + 1]!;
    const contiguous = b.start - (a.start + a.duration) <= 100;
    if (contiguous && Math.min(a.duration, b.duration) < 4000) {
      addFade(a, 'fade-out', 400);
      addFade(b, 'fade-in', 400);
    }
  }
}

/**
 * 把旁白拆成较短的字幕行：优先按中英文标点断句，再按最大长度硬切，
 * 让字幕呈现更接近剪映的「一句一行、随旁白推进」的效果。
 */
export function splitCaption(text: string, maxLen = 16): string[] {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (!cleaned) return [];
  const parts = cleaned
    .split(/(?<=[。！？!?；;])|(?<=[，,、])/)
    .map((s) => s.trim())
    .filter(Boolean);
  const lines: string[] = [];
  let buf = '';
  const flush = () => {
    if (buf.trim()) lines.push(buf.trim());
    buf = '';
  };
  for (const part of parts) {
    if ((buf + part).length <= maxLen) {
      buf += part;
      continue;
    }
    flush();
    if (part.length <= maxLen) {
      buf = part;
      continue;
    }
    for (let i = 0; i < part.length; i += maxLen) {
      const slice = part.slice(i, i + maxLen);
      if (slice.length === maxLen) lines.push(slice);
      else buf = slice;
    }
  }
  flush();
  return lines.length ? lines : [cleaned];
}

export async function assembleTimeline(state: AgentState, deps: AgentDeps): Promise<NodeUpdate> {
  const brief = state.brief!;
  const storyboard = state.storyboard!;
  const matchResult = state.matchResult!;

  const project = createEmptyProject({
    name: brief.title || '未命名作品',
    canvas: { width: brief.canvas.width, height: brief.canvas.height, fps: brief.canvas.fps },
  });
  project.assets = [...state.scannedAssets];
  project.meta.brief = JSON.stringify({
    brief,
    storyboard,
    match: matchResult.sceneAssets,
  });

  const videoClips: VideoClip[] = [];
  const imageClips: ImageClip[] = [];
  const audioClips: AudioClip[] = [];
  const textClips: TextClip[] = [];
  const musicClips: AudioClip[] = [];
  const usedAudioAssetIds = new Set<string>();

  // 字幕样式：底部居中、白字黑描边，保证在任意画面上都可读
  const captionStyle = {
    ...DEFAULT_TEXT_STYLE,
    fontSize: 42,
    y: 0.86,
    strokeColor: '#000000',
    strokeWidth: 3,
  };

  let cursor = 0;
  for (const scene of storyboard.scenes) {
    const assetId = matchResult.sceneAssets[scene.order] ?? null;
    const asset = assetId ? state.scannedAssets.find((a) => a.id === assetId) ?? null : null;

    // 片段时长：视频素材不够长时以素材为准，避免 FFmpeg trim 越界导致渲染出现黑尾
    const assetDurationMs =
      asset && (asset.type === 'video' || asset.type === 'audio') ? asset.duration : null;
    let seg = Math.max(800, scene.durationMs);
    if (asset?.type === 'video' && assetDurationMs) {
      seg = Math.min(seg, Math.max(1000, assetDurationMs));
    }

    if (asset) {
      if (asset.type === 'video') {
        // AI 生成的 B-roll 自带原生立体声音轨（MiniMax H3 等），为避免与旁白轨（TTS）互相打架，
        // 把其音量压低到 0.35，让旁白成为场景主声；真实素材保持原音量。
        const isAiGen = asset.tags?.includes('ai-generated') ?? false;
        videoClips.push({
          id: createId(),
          type: 'video',
          assetId: asset.id,
          start: cursor,
          duration: Math.min(seg, assetDurationMs ?? seg),
          offset: 0,
          speed: 1,
          locked: false,
          enabled: true,
          effects: [],
          transform: DEFAULT_TRANSFORM,
          volume: isAiGen ? 0.35 : 1,
          muted: false,
        });
      } else if (asset.type === 'image') {
        imageClips.push({
          id: createId(),
          type: 'image',
          assetId: asset.id,
          start: cursor,
          duration: seg,
          offset: 0,
          speed: 1,
          locked: false,
          enabled: true,
          effects: [],
          transform: DEFAULT_TRANSFORM,
        });
      }
    }

    const text = (scene.narration ?? '').trim();
    if (text) {
      // 旁白拆成多行短字幕，按行等分本场时长
      const lines = splitCaption(text);
      const per = seg / lines.length;
      lines.forEach((line, i) => {
        textClips.push({
          id: createId(),
          type: 'text',
          content: line,
          start: cursor + Math.round(i * per),
          duration: Math.max(500, Math.round(per)),
          offset: 0,
          speed: 1,
          locked: false,
          enabled: true,
          effects: [],
          style: { ...captionStyle },
        });
      });

      const speech = state.speechSegments.find((s) => s.sceneOrder === scene.order);
      if (speech) {
        const audioAsset: AudioAsset = {
          id: speech.audioAssetId,
          name: `旁白 ${scene.order + 1}`,
          path: speech.audioPath,
          addedAt: nowIso(),
          type: 'audio',
          duration: speech.durationMs,
          tags: ['tts'],
        };
        if (!project.assets.some((a) => a.id === audioAsset.id)) project.assets.push(audioAsset);
        usedAudioAssetIds.add(audioAsset.id);
        audioClips.push({
          id: createId(),
          type: 'audio',
          assetId: audioAsset.id,
          start: cursor,
          duration: Math.min(speech.durationMs, seg),
          offset: 0,
          speed: 1,
          locked: false,
          enabled: true,
          effects: [],
          volume: 1,
          muted: false,
          fade: { fadeIn: 0, fadeOut: 0 },
        });
      }
    }

    cursor += seg;
  }
  const total = cursor;

  // 开场标题：叠加在最前面，快速交代主题（剪映式片头字）
  if (brief.title && total > 0) {
    textClips.unshift({
      id: createId(),
      type: 'text',
      content: brief.title,
      start: 0,
      duration: Math.min(2600, total),
      offset: 0,
      speed: 1,
      locked: false,
      enabled: true,
      effects: [],
      style: {
        ...DEFAULT_TEXT_STYLE,
        fontSize: 68,
        fontWeight: 'bold',
        y: 0.4,
        strokeColor: '#000000',
        strokeWidth: 5,
      },
    });
  }

  // 背景音乐：未被当作旁白的音频素材，压低音量并做淡入淡出
  for (const a of state.scannedAssets) {
    if (a.type === 'audio' && !usedAudioAssetIds.has(a.id)) {
      musicClips.push({
        id: createId(),
        type: 'audio',
        assetId: a.id,
        start: 0,
        duration: Math.max(total, a.duration),
        offset: 0,
        speed: 1,
        locked: false,
        enabled: true,
        effects: [],
        volume: 0.25,
        muted: false,
        fade: { fadeIn: 800, fadeOut: 1200 },
      });
    }
  }

  const videoTrack: VideoTrack = {
    id: createId(),
    type: 'video',
    name: '视频轨',
    order: 0,
    muted: false,
    locked: false,
    visible: true,
    clips: [...videoClips, ...imageClips],
  };
  const audioTrack: AudioTrack = {
    id: createId(),
    type: 'audio',
    name: '旁白轨',
    order: 1,
    muted: false,
    locked: false,
    visible: true,
    clips: audioClips,
  };
  const musicTrack: AudioTrack = {
    id: createId(),
    type: 'audio',
    name: '音乐轨',
    order: 2,
    muted: false,
    locked: false,
    visible: true,
    clips: musicClips,
  };
  const textTrack: TextTrack = {
    id: createId(),
    type: 'text',
    name: '字幕轨',
    order: 3,
    muted: false,
    locked: false,
    visible: true,
    clips: textClips,
  };

  project.tracks = [videoTrack, audioTrack, musicTrack, textTrack];

  // M4 AI 智能转场：对视频轨（含图片）片段按节奏规则补全淡入淡出；
  // clip 对象与 track.clips 同引用，mutate 即反映到工程；已有用户配置的转场不被覆盖
  applyAutoTransitions([...videoClips, ...imageClips]);

  // 组装产物作为状态增量返回；最终合法性校验交由独立的 validate 节点（Zod parse）完成，
  // 使「校验」成为 10 节点流水线中一个显式、可被监控的环节。
  deps.logger?.(
    `[assemble] 工程组装完成：${project.assets.length} 素材 / ${project.tracks.length} 轨道 / ${(total / 1000).toFixed(1)}s / 字幕 ${textClips.length} 行`,
  );
  return { project };
}

/** ===== 节点 9：工程校验（Zod） ===== */

/**
 * 对 assemble-timeline 产出的工程做最终合法性校验（ID 必须为 UUID、字段齐全、轨道结构合法）。
 * 校验失败直接抛错，由 pipeline 包装成 PipelineError。这是 10 节点流水线中独立的一个校验节点，
 * 与早期把 Zod.parse 内联在 assemble 里不同，现在它是一个显式、可被监控/重试的环节。
 */
export async function validateProject(state: AgentState, deps: AgentDeps): Promise<NodeUpdate> {
  if (!state.project) throw new Error('[validate] 尚无工程对象可校验');
  const project = ProjectSchema.parse(state.project);
  deps.logger?.(`[validate] 工程通过 Zod 校验：${project.tracks.length} 轨道`);
  return { project };
}

/** ===== 节点 10：工程落盘 ===== */

/**
 * 把最终工程序列化为 project.json 落盘到工作目录（与桌面端的工程库持久化解耦：
 * 这里是流水线自身的产物存档，桌面端 store 保存仍是规范来源）。
 */
export async function saveProject(state: AgentState, deps: AgentDeps): Promise<NodeUpdate> {
  if (!state.project) throw new Error('[save-project] 尚无工程对象可落盘');
  const file = path.join(deps.workDir, 'project.json');
  mkdirSync(deps.workDir, { recursive: true });
  writeFileSync(file, JSON.stringify(state.project), 'utf8');
  deps.logger?.(`[save-project] 工程已落盘：${file}`);
  return {};
}

/** ===== 节点 4（人机中断）：分镜审批（LangGraph interrupt） ===== */

/**
 * 分镜规划完成后暂停，等待人工确认/修改。
 *
 * 节点内先调用 LangGraph 原生 `interrupt()`：首次执行抛 GraphInterrupt 暂停整图，
 * 中断 payload（当前分镜）随 checkpoint 持久化；外部用 `Command({ resume })` 续跑时，
 * 本节点从头重放、interrupt() 返回 resume 值：
 * - resume 为人工修改后的 scenes → 覆盖分镜后续跑；
 * - resume 为空（直接确认/崩溃恢复） → 保留原分镜。
 */
export async function storyboardReview(state: AgentState): Promise<NodeUpdate> {
  const decision = interrupt({
    type: 'storyboard-review',
    scenes: state.storyboard?.scenes ?? [],
  }) as Storyboard | StoryboardScene[] | null | undefined;

  const scenes = Array.isArray(decision)
    ? decision
    : decision && Array.isArray((decision as Storyboard).scenes)
      ? (decision as Storyboard).scenes
      : null;

  if (scenes && scenes.length > 0) {
    const normalized = scenes.map((s, i) => ({ ...s, order: typeof s.order === 'number' ? s.order : i }));
    return { storyboard: { scenes: normalized } };
  }
  return {};
}

/** ===== 节点注册表（10 节点：8 个业务 runner + storyboard-review 中断节点（LangGraph interrupt）+ validate/save） ===== */

export const NODE_RUNNERS: Record<
  (typeof PIPELINE_NODES)[number],
  (state: AgentState, deps: AgentDeps) => Promise<NodeUpdate>
> = {
  'scan-assets': scanAssets,
  'creative-brief': creativeBrief,
  'storyboard-plan': storyboardNode,
  'storyboard-review': (state) => storyboardReview(state),
  'match-assets': matchAssets,
  'generate-clips': generateClips,
  'speech-synthesis': speechSynthesis,
  'assemble-timeline': assembleTimeline,
  validate: validateProject,
  'save-project': saveProject,
};
