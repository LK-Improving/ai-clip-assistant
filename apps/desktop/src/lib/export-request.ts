import type { Project } from '@miaoma/video-project';

export interface ExportRequest {
  project: Project;
  /** 完整输出路径，含文件名与 .mp4 后缀 */
  outputPath: string;
  /** 导出目录（用于导出完成后打开文件夹） */
  dir: string;
  fileName: string;
  quality: ExportQuality;
  /** 强制编码器；不传则交给能力探测自动选择 */
  encoder?: string;
}

export type ExportQuality = 'standard' | 'high' | 'super';

export const QUALITY_LABELS: Record<ExportQuality, string> = {
  standard: '普通 (8 Mbps)',
  high: '高清 (16 Mbps)',
  super: '超清 (24 Mbps)',
};

/** 质量 → 视频码率映射，作为导出时的 -b:v 取值 */
export const QUALITY_BITRATE: Record<ExportQuality, string> = {
  standard: '8M',
  high: '16M',
  super: '24M',
};

/** 暂存一次导出请求：hash 路由无状态，导出设置页写入、导出进度页读取 */
let pending: ExportRequest | null = null;

export function setPendingExport(req: ExportRequest): void {
  pending = req;
}

export function getPendingExport(): ExportRequest | null {
  return pending;
}

export function clearPendingExport(): void {
  pending = null;
}
