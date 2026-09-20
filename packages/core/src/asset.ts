import { z } from 'zod';
import {
  DurationSchema,
  FpsSchema,
  IsoDateTimeSchema,
  MillisecondsSchema,
  SizeSchema,
  UuidSchema,
} from './common';

/**
 * 素材（Asset）＝ 磁盘上的真实文件在工程中的登记信息。
 * 一个素材可以被多个片段（Clip）引用，因此素材与片段必须分开存。
 *
 * 判别字段：type
 */
const AssetBaseSchema = z.object({
  id: UuidSchema,
  /** 文件名，用于素材库展示 */
  name: z.string().min(1),
  /** 本地绝对路径；运行时通过 miaoma:// 协议转换为可播放地址 */
  path: z.string().min(1),
  /** 文件大小（字节），增量扫描时用于快速比对 */
  size: z.number().int().nonnegative().optional(),
  /** 内容哈希，跨机器/重命名后仍能复用元数据与缓存 */
  hash: z.string().optional(),
  /** 素材入库时间 */
  addedAt: IsoDateTimeSchema,
  /** 文件最后修改时间，用于增量扫描（模块 3.1） */
  modifiedAt: IsoDateTimeSchema.optional(),
  /** 关键帧缩略图路径（FFmpeg 截图，模块 3.1 生成） */
  thumbnailPath: z.string().optional(),
  tags: z.array(z.string()).default([]),
  /** 语义预处理（P2）：扫描/生成时产出的人类可读摘要（类型·分辨率·时长·关键词） */
  description: z.string().optional(),
  /** 本地确定性特征向量（@miaoma/agent semantic.ts 的 embedText 产出，96 维）；
   * 供 match-assets 语义匹配与素材检索使用，旧工程可缺省（用时无 embedding 现算） */
  embedding: z.array(z.number()).optional(),
});

export const VideoAssetSchema = AssetBaseSchema.extend({
  type: z.literal('video'),
  duration: DurationSchema,
  width: SizeSchema,
  height: SizeSchema,
  fps: FpsSchema.optional(),
  codec: z.string().optional(),
  bitrate: z.number().int().nonnegative().optional(),
  /** 是否自带音轨，决定拖入时间线时是否拆出音频 */
  hasAudio: z.boolean().default(false),
});

export const AudioAssetSchema = AssetBaseSchema.extend({
  type: z.literal('audio'),
  duration: DurationSchema,
  codec: z.string().optional(),
  sampleRate: z.number().int().positive().optional(),
  channels: z.number().int().positive().optional(),
  bitrate: z.number().int().nonnegative().optional(),
});

export const ImageAssetSchema = AssetBaseSchema.extend({
  type: z.literal('image'),
  width: SizeSchema,
  height: SizeSchema,
});

export const SubtitleAssetSchema = AssetBaseSchema.extend({
  type: z.literal('subtitle'),
  /** 外挂字幕格式；AI 生成的字幕直接以 Clip 形式存在，无需素材 */
  format: z.enum(['srt', 'ass', 'vtt', 'json']),
  duration: MillisecondsSchema.optional(),
  language: z.string().optional(),
});

export const AssetSchema = z.discriminatedUnion('type', [
  VideoAssetSchema,
  AudioAssetSchema,
  ImageAssetSchema,
  SubtitleAssetSchema,
]);

export type AssetBase = z.infer<typeof AssetBaseSchema>;
export type VideoAsset = z.infer<typeof VideoAssetSchema>;
export type AudioAsset = z.infer<typeof AudioAssetSchema>;
export type ImageAsset = z.infer<typeof ImageAssetSchema>;
export type SubtitleAsset = z.infer<typeof SubtitleAssetSchema>;
export type Asset = z.infer<typeof AssetSchema>;
export type AssetType = Asset['type'];
