/**
 * 素材语义预处理与检索（P2，PDF「素材语义预处理与索引存储」的本地落地）。
 *
 * 设计取舍：
 * - 不引入外部 embedding 服务/大模型权重：用「中英文分词 + FNV-1a 哈希词袋 + L2 归一化」
 *   产出 96 维确定性特征向量，离线可用、跨进程/跨重启结果一致，也保证冒烟可断言；
 * - 中文按字符 bigram 切分（无需分词库，对「夕阳海滩」这类短语检索有效），
 *   英文/数字按词切分；
 * - 该向量供 match-assets 语义匹配与素材库语义检索共用；接入 CLIP/文本 embedding
 *   服务时只需替换 embedText 的实现，字段协议（Asset.embedding: number[]）不变。
 */

/** 特征维度：96 维 × float 在工程 JSON 里体积可控（每素材 <1KB） */
export const EMBED_DIMS = 96;

const CJK = /[㐀-䶿一-鿿぀-ヿ]/;

/** 中英文混合分词：英文数字成词，CJK 连续段产出 unigram + bigram */
export function tokenize(text: string): string[] {
  const lower = text.toLowerCase();
  const tokens: string[] = [];
  const latinMatches = lower.match(/[a-z0-9]+/g) ?? [];
  tokens.push(...latinMatches);
  // CJK 连续段
  let run = '';
  const flush = () => {
    if (!run) return;
    for (const ch of run) tokens.push(ch);
    const chars = [...run];
    for (let i = 0; i < chars.length - 1; i++) tokens.push(`${chars[i] ?? ''}${chars[i + 1] ?? ''}`);
    run = '';
  };
  for (const ch of lower) {
    if (CJK.test(ch)) run += ch;
    else flush();
  }
  flush();
  return tokens;
}

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** 文本 → 96 维 L2 归一化哈希词袋向量（确定性，同输入必同输出） */
export function embedText(text: string, dims: number = EMBED_DIMS): number[] {
  const vec = new Array<number>(dims).fill(0);
  const counts = new Map<string, number>();
  for (const token of tokenize(text)) counts.set(token, (counts.get(token) ?? 0) + 1);
  for (const [token, tf] of counts) {
    const bucket = fnv1a(token) % dims;
    vec[bucket] = (vec[bucket] ?? 0) + 1 + Math.log(tf);
  }
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  if (norm === 0) return vec;
  return vec.map((v) => Number((v / norm).toFixed(4)));
}

/** 余弦相似度（两向量已由 embedText 归一化，点积即余弦） */
export function cosine(a: readonly number[], b: readonly number[]): number {
  const n = Math.min(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < n; i++) sum += (a[i] ?? 0) * (b[i] ?? 0);
  return sum;
}

/** 参与语义特征的素材最小字段面（core Asset 与 desktop LibraryEntry 都满足） */
export interface SemanticAssetLike {
  name: string;
  type?: string;
  kind?: string;
  tags?: string[];
  description?: string;
  embedding?: number[];
}

const KIND_WORD: Record<string, string> = {
  video: '视频 footage video',
  image: '图片照片 image photo',
  audio: '音频音乐配乐 audio music',
  subtitle: '字幕 subtitle',
};

function baseName(name: string): string {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(0, i) : name;
}

/** 素材 → 特征文本（名称 + 标签 + 类型词 + 描述），用于无缓存 embedding 时现算 */
export function assetSemanticText(asset: SemanticAssetLike): string {
  const kind = asset.type ?? asset.kind ?? '';
  return [
    baseName(asset.name).replace(/[_-]+/g, ' '),
    (asset.tags ?? []).join(' '),
    KIND_WORD[kind] ?? kind,
    asset.description ?? '',
  ]
    .filter(Boolean)
    .join(' ');
}

/** 素材 embedding：仅复用同空间（EMBED_DIMS 维）向量，否则按特征文本现算（确定性）。
 * M4：外部来源可能携带不同维度的视觉向量（如 CLIP 512 维），维度不符时必须重算词法向量，
 * 否则与 embedText 查询做余弦会产生无意义的截断比较。 */
export function embedAsset(asset: SemanticAssetLike): number[] {
  if (asset.embedding && asset.embedding.length === EMBED_DIMS) return asset.embedding;
  return embedText(assetSemanticText(asset));
}

export interface AssetMediaLite {
  type?: string;
  kind?: string;
  durationMs?: number;
  width?: number | null;
  height?: number | null;
  fps?: number | null;
  hasAudio?: boolean;
  codec?: string | null;
}

/** 扫描期启发式语义摘要：无模型依赖、确定产出（「素材语义预处理」的最小可信形态） */
export function describeAssetLite(a: AssetMediaLite): string {
  const kind = KIND_WORD[a.type ?? a.kind ?? '']?.split(' ')[0] ?? '素材';
  const parts: string[] = [kind];
  if (a.width && a.height) {
    const orient = a.height > a.width ? '竖屏' : a.width === a.height ? '方形' : '横屏';
    parts.push(`${orient} ${a.width}x${a.height}`);
  }
  if (a.durationMs && a.durationMs > 0) parts.push(`约${(a.durationMs / 1000).toFixed(1)}秒`);
  if (a.fps) parts.push(`${Math.round(a.fps)}帧`);
  if (a.hasAudio) parts.push('含音轨');
  if (a.codec) parts.push(String(a.codec));
  return parts.join(' ');
}

/** 扫描产物的语义预处理结果（desktop library 缓存与 agent Asset 共用） */
export interface AssetSemantic {
  description: string;
  embedding: number[];
}

export function preprocessAssetSemantic(
  meta: AssetMediaLite & { name: string; tags?: string[]; description?: string },
): AssetSemantic {
  const description = meta.description?.trim() || describeAssetLite(meta);
  return {
    description,
    embedding: embedText(
      [meta.name, (meta.tags ?? []).join(' '), assetSemanticText({ ...meta, description })].join(' '),
    ),
  };
}
