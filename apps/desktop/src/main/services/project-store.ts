import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { snapshotProject } from './versioning';
import {
  createEmptyProject,
  migrateProject,
  nowIso,
  ProjectSchema,
  type Project,
} from '@miaoma/video-project';

/**
 * 工程持久化（userData/projects/<id>.mmproj.json）
 *
 * 设计要点：
 * 1. 一份工程一个 JSON 文件，id 即文件名 —— 无需额外索引，避免索引与磁盘不一致；
 * 2. 读盘一律先 migrateProject 再 ProjectSchema.parse：老工程自动升级，坏文件返回 null 而不是崩主进程；
 * 3. save 时统一刷新 meta.updatedAt 并回填 schema 默认值，保证落盘内容始终是合法工程。
 */

export interface ProjectSummary {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  width: number;
  height: number;
  fps: number;
  assetCount: number;
  clipCount: number;
  /** 时间线总时长（毫秒） */
  durationMs: number;
}

export interface CreateProjectInput {
  name?: string;
  width?: number;
  height?: number;
  fps?: number;
  /** AI 创意简报，随工程留档（阶段二 AI 引擎产出后回填） */
  brief?: string;
}

const FILE_SUFFIX = '.mmproj.json';

function projectsDir(): string {
  const dir = path.join(app.getPath('userData'), 'projects');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function fileFor(id: string): string {
  return path.join(projectsDir(), `${id}${FILE_SUFFIX}`);
}

function durationOf(project: Project): number {
  let max = 0;
  for (const track of project.tracks) {
    for (const clip of track.clips) {
      max = Math.max(max, clip.start + clip.duration);
    }
  }
  return max;
}

function toSummary(project: Project): ProjectSummary {
  return {
    id: project.id,
    name: project.name,
    createdAt: project.meta.createdAt,
    updatedAt: project.meta.updatedAt,
    width: project.canvas.width,
    height: project.canvas.height,
    fps: project.canvas.fps,
    assetCount: project.assets.length,
    clipCount: project.tracks.reduce((sum, track) => sum + track.clips.length, 0),
    durationMs: durationOf(project),
  };
}

export class ProjectStore {
  /** 按更新时间倒序返回全部工程摘要；单个文件损坏时跳过而不影响其余 */
  list(): ProjectSummary[] {
    const dir = projectsDir();
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return [];
    }
    const summaries: ProjectSummary[] = [];
    for (const name of names) {
      if (!name.endsWith(FILE_SUFFIX)) continue;
      const project = this.read(path.join(dir, name));
      if (project) summaries.push(toSummary(project));
    }
    summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return summaries;
  }

  get(id: string): Project | null {
    return this.read(fileFor(id));
  }

  create(input: CreateProjectInput = {}): Project {
    const project = createEmptyProject({
      name: input.name,
      canvas: { width: input.width, height: input.height, fps: input.fps },
    });
    if (input.brief) project.meta.brief = input.brief;
    return this.save(project);
  }

  /** 落盘：刷新 updatedAt，经 schema 校验补齐默认值后写入 */
  save(project: Project): Project {
    const next = ProjectSchema.parse({
      ...project,
      meta: { ...project.meta, updatedAt: nowIso() },
    });
    writeFileSync(fileFor(next.id), JSON.stringify(next, null, 2), 'utf8');
    // M5 版本快照：保存成功后异步提交到 project-repo（内部全捕获，绝不阻断/拖慢保存）
    void snapshotProject(next);
    return next;
  }

  remove(id: string): boolean {
    const file = fileFor(id);
    if (!existsSync(file)) return false;
    try {
      rmSync(file);
      return true;
    } catch {
      return false;
    }
  }

  private read(file: string): Project | null {
    if (!existsSync(file)) return null;
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown;
      return ProjectSchema.parse(migrateProject(raw));
    } catch {
      // 坏文件 / 版本不兼容：跳过，交由上层提示
      return null;
    }
  }
}

let instance: ProjectStore | null = null;

/** 懒加载：确保 app.getPath('userData') 在 app ready 之后才被调用 */
export function getProjectStore(): ProjectStore {
  if (!instance) instance = new ProjectStore();
  return instance;
}
