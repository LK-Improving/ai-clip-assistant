import { createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { app } from 'electron';

/** 固定容量的内存 LRU：避免相同文案重复请求 TTS */
export class LruCache<V> {
  private map = new Map<string, V>();

  constructor(private readonly max: number) {}

  get(key: string): V | undefined {
    const value = this.map.get(key);
    if (value === undefined) return undefined;
    // 命中后移到最新
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  set(key: string, value: V): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  get size(): number {
    return this.map.size;
  }
}

function cacheDir(): string {
  const dir = path.join(app.getPath('userData'), 'tts-cache');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

/** 缓存键：文本 + 音色 + 语速 + 供应商 */
export function ttsCacheKey(text: string, voice: string, speed: number, provider: string): string {
  return createHash('md5').update(`${provider}|${voice}|${speed}|${text}`).digest('hex');
}

export function ttsCachePath(key: string, ext: string): string {
  return path.join(cacheDir(), `${key}.${ext}`);
}
