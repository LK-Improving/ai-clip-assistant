import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { app } from 'electron';
import { cosine, embedText, preprocessAssetSemantic } from '@miaoma/agent';
import { FfmpegNotFoundError } from '../ffmpeg';
import { addAllowedPath } from '../protocol';
import { probeMedia } from './probe';
import { generateThumbnail } from './thumbnail';
import { describeImage, embedImage, embedQueryText } from './vision';

export type AssetKind = 'video' | 'audio' | 'image' | 'subtitle';

export interface LibraryEntry {
  path: string;
  name: string;
  kind: AssetKind;
  size: number;
  mtimeMs: number;
  durationMs?: number;
  width?: number | null;
  height?: number | null;
  fps?: number | null;
  bitrate?: number | null;
  codec?: string | null;
  hasAudio?: boolean;
  /** 本地缩略图绝对路径（渲染侧转 miaoma:// 后使用） */
  thumbPath?: string;
  /** 由「导入」按钮单独加入的素材：不隶属于任何扫描目录，重扫时需保留 */
  imported?: boolean;
  /** 语义预处理（P2）：启发式描述；M4 配了方舟视觉模型时替换为画面描述（model 前缀标注） */
  description?: string;
  /** 本地确定性特征向量（@miaoma/agent semantic embedText，96 维），供语义检索/匹配 */
  embedding?: number[];
  /** M4：CLIP 视觉向量（512 维，仅存素材库缓存，不进工程 JSON） */
  visionEmbedding?: number[];
  /** M4：描述是否来自视觉模型（区别于启发式描述） */
  descriptionFromVision?: boolean;
  error?: string;
}

/** 语义检索命中：条目 + 余弦得分（含关键词命中加成） */
export interface LibrarySearchHit {
  entry: LibraryEntry;
  score: number;
}

export interface ScanSummary {
  total: number;
  added: number;
  updated: number;
  removed: number;
  ffmpegMissing: boolean;
}

const EXT_KIND: Record<string, AssetKind> = {
  '.mp4': 'video',
  '.mov': 'video',
  '.mkv': 'video',
  '.avi': 'video',
  '.webm': 'video',
  '.m4v': 'video',
  '.flv': 'video',
  '.mp3': 'audio',
  '.wav': 'audio',
  '.m4a': 'audio',
  '.aac': 'audio',
  '.flac': 'audio',
  '.ogg': 'audio',
  '.jpg': 'image',
  '.jpeg': 'image',
  '.png': 'image',
  '.webp': 'image',
  '.gif': 'image',
  '.bmp': 'image',
  '.srt': 'subtitle',
  '.ass': 'subtitle',
  '.vtt': 'subtitle',
};

export function kindOf(filePath: string): AssetKind | null {
  return EXT_KIND[path.extname(filePath).toLowerCase()] ?? null;
}

const CACHE_VERSION = 1;

/** 对单条目做语义预处理（幂等：已有 embedding 则跳过）；纯本地计算，无 IO */
function ensureSemantic(entry: LibraryEntry): void {
  if (entry.embedding && entry.embedding.length > 0) return;
  const s = preprocessAssetSemantic({
    name: entry.name,
    type: entry.kind,
    durationMs: entry.durationMs,
    width: entry.width,
    height: entry.height,
    fps: entry.fps,
    hasAudio: entry.hasAudio,
    codec: entry.codec,
  });
  entry.description = s.description;
  entry.embedding = s.embedding;
}

/**
 * M4 视觉增强（幂等，全部可降级）：用关键帧图算 CLIP 视觉向量，可选方舟视觉模型生成画面描述。
 * transformers/模型未就绪时 embedImage/describeImage 返回 null，条目保持词法向量原样。
 * 仅对带缩略图的 video/image 条目执行（视频关键帧代表首屏内容，成本可控）。
 */
async function attachVision(entry: LibraryEntry): Promise<void> {
  if (entry.visionEmbedding || !entry.thumbPath) return;
  if (entry.kind !== 'video' && entry.kind !== 'image') return;
  const ve = await embedImage(entry.thumbPath);
  if (ve) entry.visionEmbedding = ve;
  if (!entry.descriptionFromVision) {
    const caption = await describeImage(entry.thumbPath);
    if (caption) {
      entry.description = caption;
      entry.descriptionFromVision = true;
    }
  }
}

function storageFile() {
  const dir = app.getPath('userData');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return path.join(dir, 'library-cache.json');
}

async function walk(dir: string, depth = 0, out: string[] = []): Promise<string[]> {
  if (depth > 4) return out;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(full, depth + 1, out);
    } else if (kindOf(full)) {
      out.push(full);
    }
  }
  return out;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index]!, index);
    }
  });
  await Promise.all(workers);
  return results;
}

/** 本地素材库：目录扫描 + 增量缓存（对比 size / mtime） */
export class LibraryStore {
  private entries = new Map<string, LibraryEntry>();
  private directories: string[] = [];

  constructor() {
    this.load();
  }

  private load() {
    try {
      const raw = JSON.parse(readFileSync(storageFile(), 'utf8')) as {
        version?: number;
        entries?: LibraryEntry[];
        directories?: string[];
      };
      if (raw.version === CACHE_VERSION) {
        for (const entry of raw.entries ?? []) this.entries.set(entry.path, entry);
        this.directories = raw.directories ?? [];
        for (const dir of this.directories) addAllowedPath(dir);

        // 关键：手动「导入」的素材只登记了其父目录，并不会写进 directories，
        // 若只靠 directories 恢复白名单，重启后这些素材一律被 miaoma:// 判 403，
        // 表现为预览区黑屏（但 userData 下的缩略图仍能显示）。这里从条目反推补登记。
        for (const entry of this.entries.values()) {
          try {
            addAllowedPath(path.dirname(entry.path));
          } catch {
            // 非法路径忽略：单条素材失效不应影响整个素材库恢复
          }
        }
      }
    } catch {
      // 首次启动无缓存，忽略
    }
  }

  private save() {
    writeFileSync(
      storageFile(),
      JSON.stringify({ version: CACHE_VERSION, entries: [...this.entries.values()], directories: this.directories }),
      'utf8',
    );
  }

  get dirs(): string[] {
    return [...this.directories];
  }

  list(): LibraryEntry[] {
    return [...this.entries.values()];
  }

  /**
   * 语义检索：词法向量（P2）+ M4 视觉向量双空间融合，取 max 余弦 + 关键词加成。
   * 视觉查询只在「索引含视觉向量且本地模型已就绪」时发起（绝不因一次搜索触发模型下载）；
   * 视觉链路任何一环不可用都自动回退纯词法，行为与 P2 完全一致。
   */
  async search(query: string, topK = 24): Promise<LibrarySearchHit[]> {
    const q = query.trim();
    if (!q) return [];
    const all = [...this.entries.values()];
    const qEmb = embedText(q);
    const lower = q.toLowerCase();
    let visionQuery: number[] | null = null;
    if (all.some((e) => e.visionEmbedding?.length)) {
      visionQuery = await embedQueryText(q);
    }
    const hits: LibrarySearchHit[] = [];
    for (const entry of all) {
      let score = cosine(qEmb, entry.embedding?.length ? entry.embedding : embedText(preprocessQueryName(entry)));
      if (visionQuery && entry.visionEmbedding?.length) {
        score = Math.max(score, cosine(visionQuery, entry.visionEmbedding));
      }
      // 关键词直接命中文件名：确定性加成（不依赖向量稀疏碰撞）
      if (entry.name.toLowerCase().includes(lower)) score += 0.35;
      if ((entry.description ?? '').toLowerCase().includes(lower)) score += 0.15;
      hits.push({ entry, score: Number(score.toFixed(4)) });
    }
    return hits
      .filter((h) => h.score > 0)
      .sort((a, b) => b.score - a.score || a.entry.path.localeCompare(b.entry.path))
      .slice(0, topK);
  }

  /** 增量扫描：仅对新增或变更（size/mtime 变化）的文件重新探测 */
  async scan(
    dirs: string[],
    onProgress?: (info: { current: number; total: number; file: string }) => void,
  ): Promise<ScanSummary> {
    this.directories = dirs;
    for (const dir of dirs) addAllowedPath(dir);

    const files: string[] = [];
    for (const dir of dirs) files.push(...(await walk(dir)));
    const unique = [...new Set(files)];

    let added = 0;
    let updated = 0;
    let ffmpegMissing = false;

    let done = 0;
    const results = await mapWithConcurrency(unique, 4, async (file) => {
      const entry = await this.buildEntry(file);
      done += 1;
      onProgress?.({ current: done, total: unique.length, file });
      return entry;
    });

    for (const entry of results) {
      if (!entry) continue;
      const prev = this.entries.get(entry.path);
      // buildEntry 命中变更会重建对象，这里把「手动导入」标记带过来，避免重扫后丢失
      if (prev?.imported) entry.imported = true;
      if (!prev) added += 1;
      else if (prev.mtimeMs !== entry.mtimeMs || prev.size !== entry.size) updated += 1;
      if (entry.error?.includes('FFmpeg')) ffmpegMissing = true;
      this.entries.set(entry.path, entry);
    }

    // 清理：已移除或不再位于扫描目录中的条目；
    // 手动导入的素材不属于任何扫描目录，必须保留，否则用户一按「扫描目录」就会丢素材
    const known = new Set(unique);
    let removed = 0;
    for (const [key, entry] of [...this.entries.entries()]) {
      if (entry.imported) continue;
      if (!known.has(key)) {
        this.entries.delete(key);
        removed += 1;
      }
    }

    this.save();
    return { total: unique.length, added, updated, removed, ffmpegMissing };
  }

  /** 手动导入单个文件（不经目录扫描） */
  async addFiles(files: string[]): Promise<LibraryEntry[]> {
    const result: LibraryEntry[] = [];
    for (const file of files) {
      const entry = await this.buildEntry(file);
      if (entry) {
        entry.imported = true;
        this.entries.set(entry.path, entry);
        addAllowedPath(path.dirname(file));
        result.push(entry);
      }
    }
    this.save();
    return result;
  }

  remove(filePath: string) {
    this.entries.delete(filePath);
    this.save();
  }

  clear() {
    this.entries.clear();
    this.directories = [];
    this.save();
  }

  private async buildEntry(file: string): Promise<LibraryEntry | null> {
    const kind = kindOf(file);
    if (!kind) return null;

    let size = 0;
    let mtimeMs = 0;
    try {
      const stat = statSync(file);
      size = stat.size;
      mtimeMs = Math.round(stat.mtimeMs);
    } catch {
      return null;
    }

    const cached = this.entries.get(file);
    if (cached && cached.size === size && cached.mtimeMs === mtimeMs && !cached.error) {
      // 旧版本缓存增量补齐语义字段（不重新探测，只补本地计算）；M4 同步补视觉向量
      ensureSemantic(cached);
      await attachVision(cached);
      return cached;
    }

    const entry: LibraryEntry = { path: file, name: path.basename(file), kind, size, mtimeMs };

    try {
      if (kind === 'subtitle') {
        // 字幕无需解码，直接读取文本长度做粗略展示
        entry.durationMs = 0;
      } else {
        const probe = await probeMedia(file);
        entry.durationMs = probe.durationMs;
        entry.width = probe.width;
        entry.height = probe.height;
        entry.fps = probe.fps;
        entry.bitrate = probe.bitrate;
        entry.codec = probe.videoCodec ?? probe.audioCodec;
        entry.hasAudio = probe.hasAudio;

        if (kind === 'video' && probe.durationMs > 0) {
          const at = Math.min(1000, Math.max(0, probe.durationMs / 3));
          try {
            entry.thumbPath = await generateThumbnail(file, { atMs: at });
          } catch {
            // 缩略图失败不影响主流程
          }
        } else if (kind === 'image') {
          try {
            entry.thumbPath = await generateThumbnail(file, { atMs: 0, width: 320 });
          } catch {
            // 同上
          }
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      entry.error = error instanceof FfmpegNotFoundError ? `FFmpeg 缺失：${message}` : message;
    }

    // 语义预处理：扫描即产出描述 + 特征向量（损坏条目也能按名称/类型检索）
    ensureSemantic(entry);
    // M4 视觉增强：关键帧就绪后算视觉向量/可选画面描述（全部可降级）
    await attachVision(entry);

    return entry;
  }
}

/** 无 embedding 旧条目的现算特征文本（与 ensureSemantic 口径一致） */
function preprocessQueryName(entry: LibraryEntry): string {
  const s = preprocessAssetSemantic({
    name: entry.name,
    type: entry.kind,
    durationMs: entry.durationMs,
    width: entry.width,
    height: entry.height,
    fps: entry.fps,
    hasAudio: entry.hasAudio,
    codec: entry.codec,
  });
  return [entry.name, s.description].join(' ');
}

let instance: LibraryStore | null = null;

/** 懒加载：确保 app.getPath('userData') 在 ready 之后才被调用 */
export function getLibraryStore(): LibraryStore {
  if (!instance) instance = new LibraryStore();
  return instance;
}
