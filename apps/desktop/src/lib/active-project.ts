import type { Project } from '@miaoma/video-project';
import { createEmptyProject } from '@miaoma/video-project';

/**
 * 当前激活工程：编辑器与导出页共用同一份 Project。
 *
 * 落盘由 main 进程 ProjectStore 负责（userData/projects/<id>.mmproj.json）。
 * 这里只做「内存中的单一事实来源 + 异步读写入口」：
 * - setActiveProject：打开 / 新建工程时用，会通知订阅者；
 * - syncActiveProject：编辑器持续编辑时用，只更新内存不广播，
 *   避免「编辑 → 广播 → 再次触发保存」的回环，落盘由调用方显式 await saveActiveProject()。
 */

/** 新建工程入参（与 ProjectStore.CreateProjectInput 结构一致） */
export interface NewProjectInput {
  name?: string;
  width?: number;
  height?: number;
  fps?: number;
  /** AI 创意简报，随工程留档 */
  brief?: string;
}

let active: Project = createEmptyProject();
const listeners = new Set<(project: Project) => void>();

export function getActiveProject(): Project {
  return active;
}

/** 切换激活工程并广播（打开 / 新建） */
export function setActiveProject(project: Project): void {
  active = project;
  for (const fn of listeners) fn(active);
}

/** 更新激活工程但不广播（编辑器编辑中） */
export function syncActiveProject(project: Project): void {
  active = project;
}

export function onActiveProjectChange(fn: (project: Project) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** 浏览器预览模式下 window.electronAPI 不存在，统一返回 undefined 由调用方降级 */
function bridge() {
  return typeof window === 'undefined' ? undefined : window.electronAPI;
}

/** 新建工程（立即落盘）并设为激活 */
export async function createProject(input: NewProjectInput = {}): Promise<Project | null> {
  const api = bridge();
  if (!api) return null;
  const project = await api.project.create(input);
  setActiveProject(project);
  return project;
}

/** 从磁盘打开工程并设为激活；文件缺失或损坏时返回 null */
export async function openProject(id: string): Promise<Project | null> {
  const api = bridge();
  if (!api) return null;
  const project = await api.project.get(id);
  if (project) setActiveProject(project);
  return project;
}

/** 落盘当前激活工程，返回刷新 updatedAt 后的最新对象 */
export async function saveActiveProject(): Promise<Project | null> {
  const api = bridge();
  if (!api) return null;
  const saved = await api.project.save(active);
  active = saved;
  return saved;
}
