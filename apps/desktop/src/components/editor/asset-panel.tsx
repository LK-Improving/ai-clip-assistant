import { Clapperboard, Image as ImageIcon, Layers, Music2, RefreshCw, Trash2, Upload } from 'lucide-react';
import { useState } from 'react';
import { Badge, ThumbPlaceholder } from '@/components/ui/misc';
import type { AssetDropPayload } from '@/components/editor/timeline';
import { formatTimecode } from '@/lib/timeline-utils';
import { cn } from '@/lib/utils';

export interface LibraryAsset {
  path: string;
  name: string;
  kind: 'video' | 'audio' | 'image' | 'subtitle';
  size: number;
  durationMs?: number;
  width?: number | null;
  height?: number | null;
  hasAudio?: boolean | null;
  thumbPath?: string;
  error?: string;
}

const tabs = [
  { key: 'all', label: '全部', icon: Layers },
  { key: 'video', label: '视频', icon: Clapperboard },
  { key: 'audio', label: '音频', icon: Music2 },
  { key: 'image', label: '图片', icon: ImageIcon },
] as const;

interface AssetPanelProps {
  assets: LibraryAsset[];
  scanning: boolean;
  progress: { current: number; total: number } | null;
  ffmpeg: { available: boolean } | null;
  onPickDir: () => void;
  onImport: () => void;
  onRescan: () => void;
  onClear: () => void;
  onAddToTimeline: (asset: LibraryAsset) => void;
}

/** 左侧素材面板（模块 3.1）：真实扫描结果 + 元数据 + 拖拽入轨 */
export function AssetPanel({
  assets,
  scanning,
  progress,
  ffmpeg,
  onPickDir,
  onImport,
  onRescan,
  onClear,
  onAddToTimeline,
}: AssetPanelProps) {
  const [tab, setTab] = useState<(typeof tabs)[number]['key']>('all');
  const visible = tab === 'all' ? assets : assets.filter((a) => a.kind === tab);

  const mediaUrl = (path: string) => window.electronAPI?.toMediaUrl(path) ?? '';

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r">
      {/* 分类 */}
      <div className="grid grid-cols-4 border-b text-[11px]">
        {tabs.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={cn(
              'flex flex-col items-center gap-1 py-2 transition-colors',
              tab === key
                ? 'border-b-2 border-primary text-primary'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <Icon className="size-3.5" />
            {label}
          </button>
        ))}
      </div>

      {/* 操作 */}
      <div className="flex flex-wrap gap-1.5 border-b p-2 text-[11px]">
        <button
          onClick={onPickDir}
          className="flex items-center gap-1 rounded border border-input px-2 py-1 hover:text-foreground"
        >
          <Layers className="size-3" /> 扫描目录
        </button>
        <button
          onClick={onImport}
          className="flex items-center gap-1 rounded border border-input px-2 py-1 hover:text-foreground"
        >
          <Upload className="size-3" /> 导入
        </button>
        <button
          onClick={onRescan}
          disabled={scanning}
          className="flex items-center gap-1 rounded border border-input px-2 py-1 hover:text-foreground disabled:opacity-50"
          title="按修改时间增量重扫"
        >
          <RefreshCw className={cn('size-3', scanning && 'animate-spin')} /> 增量
        </button>
        <button
          onClick={onClear}
          className="flex items-center gap-1 rounded border border-input px-2 py-1 text-muted-foreground hover:text-destructive"
        >
          <Trash2 className="size-3" /> 清空
        </button>
      </div>

      {/* 状态 */}
      <div className="flex items-center gap-2 border-b px-2 py-1.5 text-[10px] text-muted-foreground">
        {ffmpeg ? (
          <Badge tone={ffmpeg.available ? 'success' : 'default'}>
            FFmpeg {ffmpeg.available ? '就绪' : '缺失'}
          </Badge>
        ) : null}
        <span>{assets.length} 个素材</span>
        {progress ? (
          <span className="ml-auto font-mono">
            {progress.current}/{progress.total}
          </span>
        ) : null}
      </div>

      {progress ? (
        <div className="h-0.5 w-full bg-secondary">
          <div
            className="bg-brand h-0.5 transition-all"
            style={{ width: `${(progress.current / Math.max(1, progress.total)) * 100}%` }}
          />
        </div>
      ) : null}

      {/* 网格 */}
      <div className="grid flex-1 grid-cols-2 content-start gap-2 overflow-y-auto p-2">
        {visible.length === 0 ? (
          <p className="col-span-2 p-4 text-center text-[11px] leading-relaxed text-muted-foreground">
            {scanning ? '正在扫描素材...' : '暂无素材，点击「扫描目录」选择本地素材文件夹'}
          </p>
        ) : null}

        {visible.map((asset) => (
          <div
            key={asset.path}
            draggable
            onDragStart={(event) => {
              const payload: AssetDropPayload = {
                name: asset.name,
                kind: asset.kind === 'subtitle' ? 'text' : asset.kind,
                durationMs: asset.durationMs ?? 5000,
                path: asset.path,
                hue: (asset.name.charCodeAt(0) * 7) % 360,
              };
              event.dataTransfer.setData('application/x-miaoma-asset', JSON.stringify(payload));
              event.dataTransfer.effectAllowed = 'copy';
            }}
            onDoubleClick={() => onAddToTimeline(asset)}
            className="group cursor-grab overflow-hidden rounded-md border bg-card/60 hover:border-primary/50"
            title={`${asset.name}\n双击加入时间线 · 拖拽到轨道`}
          >
            <div className="relative">
              {asset.thumbPath ? (
                <img
                  src={mediaUrl(asset.thumbPath)}
                  alt={asset.name}
                  className="aspect-video w-full object-cover"
                  loading="lazy"
                />
              ) : (
                <ThumbPlaceholder
                  hue={(asset.name.charCodeAt(0) * 7) % 360}
                  className="aspect-video w-full"
                />
              )}
              {asset.durationMs ? (
                <span className="absolute right-1 bottom-1 rounded bg-black/60 px-1 py-0.5 text-[9px] text-white">
                  {formatTimecode(asset.durationMs)}
                </span>
              ) : null}
            </div>
            <div className="p-1.5">
              <p className="truncate text-[10px]">{asset.name}</p>
              {asset.width && asset.height ? (
                <p className="text-[9px] text-muted-foreground">
                  {asset.width}×{asset.height}
                </p>
              ) : asset.error ? (
                <p className="truncate text-[9px] text-amber-400" title={asset.error}>
                  元数据缺失
                </p>
              ) : null}
            </div>
          </div>
        ))}
      </div>
    </aside>
  );
}
