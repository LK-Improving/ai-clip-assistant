import { SCHEMA_VERSION } from './common';

/**
 * 工程格式版本迁移。
 *
 * 约定：任何破坏性 schema 变更都必须 +1 版本号，并在此登记一条迁移函数，
 * 保证老工程能被自动升级后再进入 Zod 校验。
 */
export interface Migration {
  from: number;
  to: number;
  /** 接收旧版本原始对象，返回新版本原始对象（不做校验，纯结构变换） */
  up: (project: Record<string, unknown>) => Record<string, unknown>;
}

/** 迁移登记表：按 from 升序排列 */
export const migrations: Migration[] = [
  // 示例（schemaVersion 2 时启用）：
  // {
  //   from: 1,
  //   to: 2,
  //   up: (project) => ({ ...project, tracks: project.tracks ?? [] }),
  // },
];

export const CURRENT_SCHEMA_VERSION = SCHEMA_VERSION;

function readVersion(raw: unknown): number {
  if (raw && typeof raw === 'object' && 'schemaVersion' in raw) {
    const version = (raw as { schemaVersion?: unknown }).schemaVersion;
    if (typeof version === 'number' && Number.isFinite(version)) return version;
  }
  return 1;
}

/**
 * 把任意版本的工程对象升级到当前版本。
 * 找不到迁移函数时原样返回，交由后续校验报错，避免静默丢数据。
 */
export function migrateProject(raw: unknown): unknown {
  let current = raw;
  let version = readVersion(current);

  while (version < CURRENT_SCHEMA_VERSION) {
    const migration = migrations.find((item) => item.from === version);
    if (!migration) break;
    if (typeof current !== 'object' || current === null) break;
    current = migration.up(current as Record<string, unknown>);
    current = {
      ...(current as Record<string, unknown>),
      schemaVersion: migration.to,
    };
    version = migration.to;
  }

  return current;
}
