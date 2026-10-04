import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { app } from 'electron';

/**
 * AI 助手会话持久化（userData/chats.json）：支持多会话列表、切换、删除、重启不丢。
 *
 * 设计：消息内容对主进程是**不透明 JSON**（渲染层拥有 DockMessage 结构），store 只负责
 * 读写与排序，避免主进程耦合渲染层消息类型。每条会话可绑定一个 projectId 作为对话上下文。
 */

export interface ChatThread {
  id: string;
  title: string;
  /** 绑定的工程 id；null 表示未绑定（自由创作） */
  projectId: string | null;
  createdAt: number;
  updatedAt: number;
  /** 不透明消息数组（渲染层结构） */
  messages: unknown[];
}

/** 最多保留的会话数，超出按更新时间裁尾 */
const MAX_THREADS = 60;

function file(): string {
  const dir = app.getPath('userData');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return path.join(dir, 'chats.json');
}

function readAll(): ChatThread[] {
  try {
    const raw = JSON.parse(readFileSync(file(), 'utf8')) as { threads?: unknown };
    return Array.isArray(raw.threads) ? (raw.threads as ChatThread[]) : [];
  } catch {
    return [];
  }
}

function writeAll(threads: ChatThread[]): void {
  try {
    writeFileSync(file(), JSON.stringify({ threads }, null, 2), 'utf8');
  } catch {
    /* 落盘失败不阻断（内存态仍在） */
  }
}

/** 按更新时间倒序返回全部会话 */
export function listThreads(): ChatThread[] {
  return readAll().sort((a, b) => b.updatedAt - a.updatedAt);
}

/** upsert：按 id 覆盖或插入，刷新 updatedAt；限制总量 */
export function saveThread(thread: ChatThread): ChatThread {
  const all = readAll();
  const next: ChatThread = { ...thread, updatedAt: Date.now() };
  const idx = all.findIndex((t) => t.id === thread.id);
  if (idx >= 0) all[idx] = next;
  else all.unshift(next);
  writeAll(all.slice(0, MAX_THREADS));
  return next;
}

export function deleteThread(id: string): boolean {
  const all = readAll();
  const next = all.filter((t) => t.id !== id);
  if (next.length === all.length) return false;
  writeAll(next);
  return true;
}
