import { z } from 'zod';
import {
  ColorSchema,
  DurationSchema,
  MillisecondsSchema,
  ParamsSchema,
  RatioSchema,
  SpeedSchema,
  UuidSchema,
  VolumeSchema,
} from './common';

/**
 * 片段（Clip）＝ 素材在时间线上的一次摆放，或者一段自动生成的内容（字幕 / AI 配音）。
 *
 * 判别字段：type
 * 时间语义：
 *  - start   ：片段在时间线上的入点（毫秒）
 *  - duration：片段在时间线上占据的时长（毫秒）
 *  - offset  ：素材内部入点（毫秒），即从素材的第几毫秒开始取内容
 */

const TransformFieldsSchema = z.object({
  x: z.number().default(0),
  y: z.number().default(0),
  scale: z.number().positive().max(20).default(1),
  rotation: z.number().min(-360).max(360).default(0),
  opacity: RatioSchema.default(1),
});

export type Transform2D = z.infer<typeof TransformFieldsSchema>;

export const DEFAULT_TRANSFORM: Transform2D = {
  x: 0,
  y: 0,
  scale: 1,
  rotation: 0,
  opacity: 1,
};

/** 2D 变换：以画布中心为原点的像素偏移 */
export const Transform2DSchema = TransformFieldsSchema.default(DEFAULT_TRANSFORM);

/** 效果占位：滤镜 / LUT / 转场等由 FFmpeg 构建器（模块 4.1）消费 */
export const EffectSchema = z.object({
  id: UuidSchema,
  kind: z.enum(['filter', 'lut', 'transition', 'animation']),
  name: z.string(),
  params: ParamsSchema.default({}),
  enabled: z.boolean().default(true),
});

/** 淡入淡出（毫秒） */
const FadeSchema = z.object({
  fadeIn: MillisecondsSchema.default(0),
  fadeOut: MillisecondsSchema.default(0),
});

const ClipBaseSchema = z.object({
  id: UuidSchema,
  name: z.string().optional(),
  start: MillisecondsSchema,
  duration: DurationSchema,
  offset: MillisecondsSchema.default(0),
  speed: SpeedSchema.default(1),
  locked: z.boolean().default(false),
  enabled: z.boolean().default(true),
  effects: z.array(EffectSchema).default([]),
});

export const VideoClipSchema = ClipBaseSchema.extend({
  type: z.literal('video'),
  assetId: UuidSchema,
  transform: Transform2DSchema,
  volume: VolumeSchema.default(1),
  muted: z.boolean().default(false),
});

export const ImageClipSchema = ClipBaseSchema.extend({
  type: z.literal('image'),
  assetId: UuidSchema,
  transform: Transform2DSchema,
});

export const AudioClipSchema = ClipBaseSchema.extend({
  type: z.literal('audio'),
  assetId: UuidSchema,
  volume: VolumeSchema.default(1),
  muted: z.boolean().default(false),
  fade: FadeSchema,
});

const TextStyleFieldsSchema = z.object({
  fontFamily: z.string().default('Microsoft YaHei'),
  fontSize: z.number().int().positive().default(48),
  fontWeight: z.enum(['normal', 'bold']).default('normal'),
  color: ColorSchema.default('#ffffff'),
  backgroundColor: ColorSchema.default('transparent'),
  strokeColor: ColorSchema.default('transparent'),
  strokeWidth: z.number().nonnegative().default(0),
  align: z.enum(['left', 'center', 'right']).default('center'),
  /** 归一化位置，{ x: 0.5, y: 0.9 } 表示水平居中、靠近底部 */
  x: RatioSchema.default(0.5),
  y: RatioSchema.default(0.9),
});

export type TextStyle = z.infer<typeof TextStyleFieldsSchema>;

export const DEFAULT_TEXT_STYLE: TextStyle = {
  fontFamily: 'Microsoft YaHei',
  fontSize: 48,
  fontWeight: 'normal',
  color: '#ffffff',
  backgroundColor: 'transparent',
  strokeColor: 'transparent',
  strokeWidth: 0,
  align: 'center',
  x: 0.5,
  y: 0.9,
};

/** 字幕 / 花字样式 */
export const TextStyleSchema = TextStyleFieldsSchema.default(DEFAULT_TEXT_STYLE);

export const TextClipSchema = ClipBaseSchema.extend({
  type: z.literal('text'),
  content: z.string().default(''),
  style: TextStyleSchema,
  /** 关联 TTS 音频片段（AI 配音与字幕联动） */
  audioClipId: UuidSchema.optional(),
});

export const ClipSchema = z.discriminatedUnion('type', [
  VideoClipSchema,
  ImageClipSchema,
  AudioClipSchema,
  TextClipSchema,
]);

export type Effect = z.infer<typeof EffectSchema>;
export type VideoClip = z.infer<typeof VideoClipSchema>;
export type ImageClip = z.infer<typeof ImageClipSchema>;
export type AudioClip = z.infer<typeof AudioClipSchema>;
export type TextClip = z.infer<typeof TextClipSchema>;
export type Clip = z.infer<typeof ClipSchema>;
export type ClipType = Clip['type'];
