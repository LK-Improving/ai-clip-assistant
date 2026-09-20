import { CanvasSchema, ProjectSchema, type Canvas, type Project } from './project';
import { SCHEMA_VERSION } from './common';
import { IsoDateTimeSchema, UuidSchema } from './common';

/**
 * 生成 UUID。Node 18+ / Electron 主进程与渲染进程均有 globalThis.crypto，
 * 这里保留一个降级实现，避免在非安全上下文（file:// 等）下崩溃。
 */
export function createId(): string {
  const globalCrypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (typeof globalCrypto?.randomUUID === 'function') return globalCrypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    const v = ch === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export function nowIso(): string {
  return new Date().toISOString();
}

export interface CreateProjectOptions {
  id?: string;
  name?: string;
  canvas?: Partial<Canvas>;
}

/** 创建一个合法的空工程（含默认 1920x1080@30 画布） */
export function createEmptyProject(options: CreateProjectOptions = {}): Project {
  const timestamp = nowIso();
  return ProjectSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    id: UuidSchema.parse(options.id ?? createId()),
    name: options.name ?? '未命名工程',
    canvas: CanvasSchema.parse(options.canvas ?? {}),
    assets: [],
    tracks: [],
    meta: {
      createdAt: IsoDateTimeSchema.parse(timestamp),
      updatedAt: IsoDateTimeSchema.parse(timestamp),
    },
  });
}
