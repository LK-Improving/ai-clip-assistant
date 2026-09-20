import { existsSync } from 'node:fs';
import path from 'node:path';

/** 毫秒 → 秒（保留 3 位小数，避免 ffmpeg 解析歧义） */
export function msToSec(ms: number): string {
  return (ms / 1000).toFixed(3);
}

/** #RRGGBB → 0xRRGGBB（ffmpeg 颜色语法） */
export function hexToFfmpegColor(hex: string): string {
  const clean = hex.replace(/^#/, '');
  const rgb = clean.length >= 6 ? clean.slice(0, 6) : '000000';
  return `0x${rgb}`;
}

/**
 * ffmpeg filtergraph 文本转义：整体用单引号包裹，内部单引号转义为 '\''
 * （filtergraph 解析器在单引号内只认 '\'' 表示单引号，反斜杠按字面处理）。
 */
export function escapeFilterText(text: string): string {
  const safe = text.replace(/[\r\n]+/g, ' ').replace(/'/g, "'\\''");
  return `'${safe}'`;
}

/**
 * 路径转义：统一为正斜杠、转义盘符冒号（C: → C\:）并包裹单引号。
 * ffmpeg 的 filtergraph 解析器把未转义的冒号当作选项分隔符，Windows 盘符冒号
 * 必须写成 C\: 才能被当作字面量；单引号用于保护空格与中文。
 */
export function escapeFilterPath(p: string): string {
  const norm = p.replace(/\\/g, '/');
  return `'${norm.replace(/:/g, '\\:')}'`;
}

export type FontRef =
  | { kind: 'file'; path: string }
  | { kind: 'name'; name: string }
  | { kind: 'default' };

const WINDOWS_FONT_MAP: Record<string, string> = {
  'microsoft yahei': 'C:/Windows/Fonts/msyh.ttc',
  '微软雅黑': 'C:/Windows/Fonts/msyh.ttc',
  simhei: 'C:/Windows/Fonts/simhei.ttf',
  '黑体': 'C:/Windows/Fonts/simhei.ttf',
  simsun: 'C:/Windows/Fonts/simsun.ttc',
  '宋体': 'C:/Windows/Fonts/simsun.ttc',
  'pingfang sc': 'C:/Windows/Fonts/msyh.ttc',
  arial: 'C:/Windows/Fonts/arial.ttf',
  'times new roman': 'C:/Windows/Fonts/times.ttf',
};

/**
 * 解析字体引用：优先映射到本机中文字体文件（保证 drawtext 能渲染中文），
 * 非 Windows 或未知字体则退回 fontconfig 字体名，找不到则退回默认字体。
 */
export function resolveFontRef(fontFamily: string): FontRef {
  const key = (fontFamily || '').trim().toLowerCase();
  if (process.platform === 'win32') {
    const mapped = WINDOWS_FONT_MAP[key];
    if (mapped && existsSync(mapped)) return { kind: 'file', path: mapped };
    // 兜底：尝试常见微软雅黑
    const fallback = 'C:/Windows/Fonts/msyh.ttc';
    if (existsSync(fallback)) return { kind: 'file', path: fallback };
    return { kind: 'default' };
  }
  if (key) return { kind: 'name', name: fontFamily };
  return { kind: 'default' };
}

/** 把 FontRef 拼成 drawtext 的字体参数片段 */
export function fontRefToOption(ref: FontRef): string {
  if (ref.kind === 'file') return `fontfile=${escapeFilterPath(ref.path)}`;
  if (ref.kind === 'name') return `font=${escapeFilterText(ref.name)}`;
  return '';
}

export function basenameNoExt(p: string): string {
  const base = path.basename(p);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}
