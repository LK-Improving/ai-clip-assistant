import { z } from 'zod';
import { AudioClipSchema, ImageClipSchema, TextClipSchema, VideoClipSchema } from './clip';
import { UuidSchema } from './common';

/**
 * 轨道（Track）＝ 承载同类型片段的容器。
 * 渲染时（模块 4.1）按轨道顺序自下而上叠加：order 越大层级越靠上。
 *
 * 判别字段：type
 */
const TrackBaseSchema = z.object({
  id: UuidSchema,
  name: z.string().default(''),
  /** 层级顺序，数字越大越靠上 */
  order: z.number().int().default(0),
  muted: z.boolean().default(false),
  locked: z.boolean().default(false),
  visible: z.boolean().default(true),
});

export const VideoTrackSchema = TrackBaseSchema.extend({
  type: z.literal('video'),
  /** 视频轨可同时容纳视频片段与图片片段 */
  clips: z.array(z.union([VideoClipSchema, ImageClipSchema])).default([]),
});

export const AudioTrackSchema = TrackBaseSchema.extend({
  type: z.literal('audio'),
  clips: z.array(AudioClipSchema).default([]),
});

export const TextTrackSchema = TrackBaseSchema.extend({
  type: z.literal('text'),
  clips: z.array(TextClipSchema).default([]),
});

export const TrackSchema = z.discriminatedUnion('type', [
  VideoTrackSchema,
  AudioTrackSchema,
  TextTrackSchema,
]);

export type VideoTrack = z.infer<typeof VideoTrackSchema>;
export type AudioTrack = z.infer<typeof AudioTrackSchema>;
export type TextTrack = z.infer<typeof TextTrackSchema>;
export type Track = z.infer<typeof TrackSchema>;
export type TrackType = Track['type'];
