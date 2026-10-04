import { Magnet, Plus, Trash2, ZoomIn, ZoomOut } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Badge } from '@/components/ui/misc';
import {
  formatTimecode,
  snapStart,
  tickInterval,
  timelineTotalMs,
  type TimelineClip,
  type TimelineTrack,
} from '@/lib/timeline-utils';
import { cn } from '@/lib/utils';

export interface AssetDropPayload {
  name: string;
  kind: 'video' | 'audio' | 'image' | 'text';
  durationMs: number;
  path?: string;
  hue: number;
}

interface TimelineProps {
  tracks: TimelineTrack[];
  currentMs: number;
  selected: { trackId: string; clipId: string } | null;
  onSeek: (ms: number) => void;
  onSelect: (selection: { trackId: string; clipId: string } | null) => void;
  onClipChange: (trackId: string, clipId: string, patch: Partial<TimelineClip>) => void;
  onDeleteClip: (trackId: string, clipId: string) => void;
  onAddTrack: (kind: TimelineTrack['kind']) => void;
  onRemoveTrack: (trackId: string) => void;
  onDropAsset: (trackId: string, payload: AssetDropPayload) => void;
}

const KIND_STYLE: Record<TimelineTrack['kind'], string> = {
  video: 'text-sky-300',
  audio: 'text-emerald-300',
  text: 'text-fuchsia-300',
};

/** 时间线（模块 3.2）：标尺 seek、片段拖拽、缩放、轨道管理、素材拖入 */
export function Timeline({
  tracks,
  currentMs,
  selected,
  onSeek,
  onSelect,
  onClipChange,
  onDeleteClip,
  onAddTrack,
  onRemoveTrack,
  onDropAsset,
}: TimelineProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const laneRef = useRef<HTMLDivElement | null>(null);
  const indicatorRef = useRef<HTMLDivElement | null>(null);
  const scrollDragging = useRef(false);
  const [laneWidth, setLaneWidth] = useState(800);
  const [zoom, setZoom] = useState(1);
  const [scrollInfo, setScrollInfo] = useState({ left: 0, client: 0, content: 0 });

  // 以滚动容器可见宽度（减去左侧轨道头 6rem = 96px）为基准换算像素比例，
  // 这样即便横向放大、内容超出视口，pxPerMs 仍稳定，不会出现循环依赖。
  const HEADER_W = 96;
  // 总时长与预览控制条共用单一口径（timelineTotalMs），避免两处数字对不上
  const totalMs = timelineTotalMs(tracks);
  const visibleMs = Math.max(2000, totalMs / zoom);
  const pxPerMs = laneWidth / visibleMs;
  const msToPx = (ms: number) => ms * pxPerMs;
  const contentWidthPx = msToPx(totalMs);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const update = () => setLaneWidth(Math.max(320, el.clientWidth - HEADER_W));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // 同步横向滚动位置给自定义指示器（替代原生滚动条）
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const on = () => setScrollInfo({ left: el.scrollLeft, client: el.clientWidth, content: el.scrollWidth });
    on();
    el.addEventListener('scroll', on, { passive: true });
    return () => el.removeEventListener('scroll', on);
  }, []);

  // 内容宽度变化（缩放 / 轨道增减）时重算指示器
  useEffect(() => {
    const el = scrollRef.current;
    if (el) setScrollInfo({ left: el.scrollLeft, client: el.clientWidth, content: el.scrollWidth });
  }, [contentWidthPx, zoom]);

  const scrollFromPointer = (clientX: number) => {
    const el = scrollRef.current;
    const track = indicatorRef.current;
    if (!el || !track) return;
    const rect = track.getBoundingClientRect();
    if (rect.width <= 0) return;
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    el.scrollLeft = ratio * Math.max(0, el.scrollWidth - el.clientWidth);
  };

  // 播放头跟随：播放过程中自动横向滚动，保证播放头始终落在可视区内
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const cx = HEADER_W + msToPx(currentMs);
    const screenX = cx - el.scrollLeft;
    if (screenX < HEADER_W) {
      el.scrollLeft = Math.max(0, cx - HEADER_W - 48);
    } else if (screenX > el.clientWidth) {
      el.scrollLeft = cx - el.clientWidth + 48;
    }
  }, [currentMs, pxPerMs, HEADER_W]);

  // 标尺拖拽 seek
  const seekingRef = useRef(false);
  const seekFromEvent = (clientX: number) => {
    const el = laneRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    onSeek(Math.max(0, Math.round((clientX - rect.left) / pxPerMs)));
  };

  useEffect(() => {
    const move = (event: PointerEvent) => {
      if (!seekingRef.current) return;
      seekFromEvent(event.clientX);
    };
    const up = () => {
      seekingRef.current = false;
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
  });

  // 片段拖拽移动
  const dragRef = useRef<{ trackId: string; clipId: string; startX: number; origStart: number } | null>(
    null,
  );
  useEffect(() => {
    const move = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const track = tracks.find((t) => t.id === drag.trackId);
      const clip = track?.clips.find((c) => c.id === drag.clipId);
      if (!track || !clip) return;
      const raw = Math.max(0, drag.origStart + (event.clientX - drag.startX) / pxPerMs);
      const snapped = snapStart(raw, clip.duration, track, clip.id, 8 / pxPerMs);
      onClipChange(drag.trackId, drag.clipId, { start: Math.round(snapped) });
    };
    const up = () => {
      dragRef.current = null;
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
  }, [tracks, pxPerMs, onClipChange]);

  const interval = tickInterval(visibleMs);
  const ticks = Array.from({ length: Math.floor(totalMs / interval) + 1 }, (_, i) => i * interval);

  return (
    <div className="flex h-full flex-col">
      {/* 工具行 */}
      <div className="flex h-9 shrink-0 items-center gap-2 border-b px-3 text-[11px] text-muted-foreground">
        <span className="font-medium text-foreground">时间线</span>
        <span className="font-mono">{formatTimecode(currentMs)}</span>
        <Magnet className="ml-2 size-3.5 cursor-pointer hover:text-primary" />
        <div className="ml-auto flex items-center gap-1.5">
          <button
            className="rounded border border-input p-1 hover:text-foreground"
            onClick={() => setZoom((z) => Math.max(0.5, z / 1.3))}
            title="缩小"
          >
            <ZoomOut className="size-3.5" />
          </button>
          <span className="w-10 text-center font-mono">{zoom.toFixed(1)}x</span>
          <button
            className="rounded border border-input p-1 hover:text-foreground"
            onClick={() => setZoom((z) => Math.min(8, z * 1.3))}
            title="放大"
          >
            <ZoomIn className="size-3.5" />
          </button>
          <div className="mx-1 h-4 w-px bg-border" />
          {(['video', 'audio', 'text'] as const).map((kind) => (
            <button
              key={kind}
              onClick={() => onAddTrack(kind)}
              className="flex items-center gap-1 rounded border border-input px-1.5 py-0.5 hover:text-foreground"
            >
              <Plus className="size-3" />
              {kind === 'video' ? '视频轨' : kind === 'audio' ? '音频轨' : '字幕轨'}
            </button>
          ))}
        </div>
      </div>

      <div className="relative min-h-0 flex-1 overflow-hidden">
        <div
          ref={scrollRef}
          className="no-scrollbar h-full overflow-auto"
          onWheel={(event) => {
            // 无纵向溢出时，把纵向滚轮映射为横向浏览（隐藏滚动条后的优雅替代）
            const el = scrollRef.current;
            if (el && el.scrollHeight <= el.clientHeight && event.deltaY !== 0) {
              el.scrollLeft += event.deltaY;
            }
          }}
        >
          <div className="flex min-h-full" style={{ width: `calc(6rem + ${contentWidthPx}px)` }}>
            {/* 轨道头（横向滚动时粘性固定在左侧） */}
            <div className="sticky left-0 z-20 w-24 shrink-0 bg-card">
              <div className="h-6 border-b border-r" />
              {tracks.map((track) => (
                <div
                  key={track.id}
                  className="flex h-14 flex-col justify-center gap-0.5 border-b border-r px-2"
                >
                  <span className={cn('text-[11px] font-medium', KIND_STYLE[track.kind])}>{track.name}</span>
                  <span className="text-[10px] text-muted-foreground">{track.clips.length} 个片段</span>
                  {track.clips.length === 0 && tracks.length > 1 ? (
                    <button
                      onClick={() => onRemoveTrack(track.id)}
                      className="mt-0.5 flex items-center gap-1 text-[10px] text-muted-foreground hover:text-destructive"
                    >
                      <Trash2 className="size-3" /> 删除
                    </button>
                  ) : null}
                </div>
              ))}
            </div>

            {/* 轨道区（可横向滚动；内容超出视口时滚动查看，不再看不见片段） */}
            <div className="relative flex-1">
              {/* 标尺 */}
              <div
                ref={laneRef}
                className="relative h-6 cursor-col-resize border-b"
                onPointerDown={(event) => {
                  seekingRef.current = true;
                  seekFromEvent(event.clientX);
                }}
              >
                {ticks.map((ms) => (
                  <div key={ms} className="absolute top-0 bottom-0" style={{ left: msToPx(ms) }}>
                    <span className="block h-2 w-px bg-border" />
                    <span className="ml-1 font-mono text-[10px] text-muted-foreground">
                      {formatTimecode(ms)}
                    </span>
                  </div>
                ))}
              </div>

              {/* 轨道列表 */}
              {tracks.map((track) => (
                <div
                  key={track.id}
                  className="relative h-14 border-b border-border/60 bg-secondary/20"
                  onDragOver={(event) => {
                    event.preventDefault();
                    event.dataTransfer.dropEffect = 'copy';
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    const raw = event.dataTransfer.getData('application/x-miaoma-asset');
                    if (!raw) return;
                    try {
                      onDropAsset(track.id, JSON.parse(raw) as AssetDropPayload);
                    } catch {
                      // 忽略非法数据
                    }
                  }}
                  onPointerDown={() => onSelect(null)}
                >
                  {track.clips.map((clip) => {
                    const active = selected?.clipId === clip.id;
                    return (
                      <div
                        key={clip.id}
                        onPointerDown={(event) => {
                          event.stopPropagation();
                          dragRef.current = {
                            trackId: track.id,
                            clipId: clip.id,
                            startX: event.clientX,
                            origStart: clip.start,
                          };
                          onSelect({ trackId: track.id, clipId: clip.id });
                        }}
                        className={cn(
                          'absolute inset-y-1.5 flex cursor-grab items-center gap-1 overflow-hidden rounded border px-1.5 text-[10px] text-white/90 active:cursor-grabbing',
                          active ? 'ring-2 ring-primary' : 'border-white/10',
                        )}
                        style={{
                          left: msToPx(clip.start),
                          width: Math.max(24, msToPx(clip.duration)),
                          backgroundImage: `linear-gradient(150deg, hsl(${clip.hue} 65% 40% / 0.95), hsl(${clip.hue} 60% 24% / 0.95))`,
                        }}
                        title={`${clip.name} · ${formatTimecode(clip.duration)}`}
                      >
                        {track.kind === 'audio' ? <span className="bg-wave absolute inset-0 opacity-40" /> : null}
                        <span className="relative truncate">{clip.name}</span>
                        {active ? (
                          <button
                            className="relative ml-auto rounded p-0.5 hover:bg-black/40"
                            onPointerDown={(event) => event.stopPropagation()}
                            onClick={() => onDeleteClip(track.id, clip.id)}
                            title="删除片段"
                          >
                            <Trash2 className="size-3" />
                          </button>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              ))}

              {/* 播放头（随内容横向滚动；缩放下也始终可见） */}
              <div
                className="pointer-events-none absolute top-0 bottom-0 z-30 w-px bg-red-400"
                style={{ left: msToPx(currentMs) }}
              >
                <span className="absolute -top-1 -left-1 size-2 rounded-full bg-red-400" />
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* 自定义横向滚动指示器（替代丑陋的原生滚动条）：可拖拽、随缩放/滚动实时更新 */}
      {scrollInfo.content > scrollInfo.client + 1 ? (
        <div
          ref={indicatorRef}
          title="拖动浏览时间线"
          onPointerDown={(event) => {
            scrollDragging.current = true;
            event.currentTarget.setPointerCapture(event.pointerId);
            scrollFromPointer(event.clientX);
          }}
          onPointerMove={(event) => {
            if (scrollDragging.current) scrollFromPointer(event.clientX);
          }}
          onPointerUp={(event) => {
            scrollDragging.current = false;
            event.currentTarget.releasePointerCapture(event.pointerId);
          }}
          className="flex h-4 shrink-0 cursor-pointer items-center px-3"
        >
          {(() => {
            const max = scrollInfo.content - scrollInfo.client;
            const w = Math.max(8, (scrollInfo.client / scrollInfo.content) * 100);
            const left = max > 0 ? (scrollInfo.left / max) * (100 - w) : 0;
            return (
              <div className="relative h-1 w-full rounded-full bg-secondary">
                <div
                  className="absolute top-1/2 h-2.5 -translate-y-1/2 rounded-full bg-primary/50 transition-colors hover:bg-primary"
                  style={{ width: `${w}%`, left: `${left}%` }}
                />
              </div>
            );
          })()}
        </div>
      ) : null}

      <div className="flex h-6 shrink-0 items-center gap-2 border-t px-3 text-[10px] text-muted-foreground">
        <Badge>拖拽片段移动 · 点击标尺跳转 · 素材拖入轨道</Badge>
        <span className="ml-auto">总时长 {formatTimecode(totalMs)}</span>
      </div>
    </div>
  );
}
