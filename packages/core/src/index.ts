/**
 * @miaoma/video-project
 * 视频工程数据模型 DSL —— 阶段一（模块 1.2）
 *
 * 设计要点：
 * 1. 单一事实来源：所有结构以 Zod schema 定义，TypeScript 类型由 z.infer 推导；
 * 2. 判别联合：Asset / Clip / Track 均用 type 字段区分，方便 switch 收窄与 FFmpeg 构建；
 * 3. 版本可控：schemaVersion + 迁移登记表，保证老工程可升级。
 */
export * from './common';
export * from './asset';
export * from './clip';
export * from './track';
export * from './project';
export * from './factory';
export * from './timeline';
export * from './migrate';
export * from './validate';
