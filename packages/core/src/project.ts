import { z } from 'zod';
import { AssetSchema } from './asset';
import { ColorSchema, FpsSchema, SizeSchema, UuidSchema } from './common';
import { IsoDateTimeSchema } from './common';
import { SCHEMA_VERSION } from './common';
import { TrackSchema } from './track';

const CanvasFieldsSchema = z.object({
  width: SizeSchema.default(1920),
  height: SizeSchema.default(1080),
  fps: FpsSchema.default(30),
  sampleRate: z.number().int().positive().default(48000),
  channels: z.number().int().positive().default(2),
  backgroundColor: ColorSchema.default('#000000'),
  /** 背景素材（垫图/垫视频），可选 */
  backgroundAssetId: UuidSchema.optional(),
});

export type Canvas = z.infer<typeof CanvasFieldsSchema>;

export const DEFAULT_CANVAS: Canvas = {
  width: 1920,
  height: 1080,
  fps: 30,
  sampleRate: 48000,
  channels: 2,
  backgroundColor: '#000000',
};

/** 画布 / 序列设置，决定导出视频的基准参数 */
export const CanvasSchema = CanvasFieldsSchema.default(DEFAULT_CANVAS);

export const ProjectMetaSchema = z.object({
  author: z.string().optional(),
  description: z.string().optional(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
  /** AI 生成的创意简报与分镜脚本留档，便于回溯与二次编辑 */
  brief: z.string().optional(),
  tags: z.array(z.string()).default([]),
});

/**
 * 视频工程根节点。
 * schemaVersion 用 number 而非 literal，保证旧工程读入时先迁移再校验（见 migrate.ts）。
 */
export const ProjectSchema = z.object({
  schemaVersion: z.number().int().positive().default(SCHEMA_VERSION),
  id: UuidSchema,
  name: z.string().min(1).default('未命名工程'),
  canvas: CanvasSchema,
  assets: z.array(AssetSchema).default([]),
  tracks: z.array(TrackSchema).default([]),
  meta: ProjectMetaSchema,
});

export type ProjectMeta = z.infer<typeof ProjectMetaSchema>;
export type Project = z.infer<typeof ProjectSchema>;
