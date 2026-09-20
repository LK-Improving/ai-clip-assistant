import { z } from 'zod';

/**
 * 工程文件格式版本。
 * 每当我们修改 schema 且破坏向后兼容时 +1，并在 src/migrate.ts 中登记一条迁移函数。
 */
export const SCHEMA_VERSION = 1;

/** 全局唯一 ID（UUID v4） */
export const UuidSchema = z.uuid().describe('全局唯一 ID (UUID)');

/** ISO 8601 时间字符串，允许带时区偏移 */
export const IsoDateTimeSchema = z
  .iso.datetime({ offset: true })
  .describe('ISO 8601 时间字符串');

/** 时间线时间单位统一为毫秒（整数），渲染层再除以 1000 交给 FFmpeg */
export const MillisecondsSchema = z
  .number()
  .int()
  .nonnegative()
  .describe('毫秒（非负整数）');

/** 片段时长等必须为正的时间 */
export const DurationSchema = z
  .number()
  .int()
  .positive()
  .describe('时长（毫秒，正整数）');

/** 0~1 的归一化比例 */
export const RatioSchema = z.number().min(0).max(1).describe('归一化比例 0~1');

/** 音量：0 静音，1 原始音量，最大允许 2 倍增益 */
export const VolumeSchema = z.number().min(0).max(2).describe('音量倍率');

/** 倍速 */
export const SpeedSchema = z
  .number()
  .min(0.1)
  .max(16)
  .describe('播放倍速');

/** #RGB / #RRGGBB / #RRGGBBAA 或 transparent */
export const ColorSchema = z
  .string()
  .regex(/^(#[0-9a-fA-F]{3}|#[0-9a-fA-F]{6}|#[0-9a-fA-F]{8}|transparent)$/)
  .describe('颜色值');

/** 正整数尺寸 */
export const SizeSchema = z.number().int().positive().describe('像素尺寸');

/** 帧率 */
export const FpsSchema = z.number().positive().max(120).describe('帧率 fps');

/** 通用键值参数（滤镜 / 转场等扩展点） */
export const ParamsSchema = z.record(z.string(), z.unknown());

export type Uuid = z.infer<typeof UuidSchema>;
export type Milliseconds = z.infer<typeof MillisecondsSchema>;
export type Color = z.infer<typeof ColorSchema>;
export type Params = z.infer<typeof ParamsSchema>;
