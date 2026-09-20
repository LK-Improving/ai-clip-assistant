import { Pause, Play, SkipBack, SkipForward, Volume2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ThumbPlaceholder } from '@/components/ui/misc';
import { formatTimecode } from '@/lib/timeline-utils';
import type { TimelineClip } from '@/lib/timeline-utils';
import type { PlayableResult } from '@/main/services/preview';
import { cn } from '@/lib/utils';

interface PreviewProps {
  currentMs: number;
  totalMs: number;
  playing: boolean;
  activeClip: TimelineClip | null;
  onTogglePlay: () => void;
  onSeek: (ms: number) => void;
}

type LoadState = 'idle' | 'loading' | 'ready' | 'error';

/** 预览区（模块 3.2）：真实素材走 miaoma:// 协议播放，与播放头双向同步 */
export function Preview({ currentMs, totalMs, playing, activeClip, onTogglePlay, onSeek }: PreviewProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const sourcePath = activeClip?.assetPath;

  // 可播放性解析：不支持的编码会在主进程转码成 H.264 代理后再播放
  const [resolved, setResolved] = useState<PlayableResult | null>(null);
  const [preparing, setPreparing] = useState(false);
  const resolveTokenRef = useRef(0);

  const src = resolved?.path ? (window.electronAPI?.toMediaUrl(resolved.path) ?? '') : '';
  const posterUrl = resolved?.poster ? (window.electronAPI?.toMediaUrl(resolved.poster) ?? '') : '';

  const [loadState, setLoadState] = useState<LoadState>('idle');
  const [errorText, setErrorText] = useState<string | null>(null);
  // 用于丢弃过期诊断结果（用户快速切换片段时）
  const assetPathRef = useRef<string | undefined>(undefined);
  assetPathRef.current = sourcePath;

  // 素材切换：先问主进程「这个能播吗」，必要时拿到转码代理路径
  useEffect(() => {
    if (!sourcePath) {
      setResolved(null);
      setPreparing(false);
      return;
    }
    const api = window.electronAPI;
    const token = ++resolveTokenRef.current;
    if (!api?.media?.playable) {
      // 浏览器预览模式：直接用原路径
      setResolved({ path: sourcePath, proxied: false, codec: null, poster: null });
      setPreparing(false);
      return;
    }
    setPreparing(true);
    void api.media
      .playable(sourcePath)
      .then((result) => {
        if (resolveTokenRef.current !== token) return;
        setResolved(result);
        setPreparing(false);
        if (result.note) console.warn('[preview] 预览准备提示：', result.note);
        if (!result.path) setErrorText(result.note ?? '该素材无法生成预览');
      })
      .catch((error) => {
        if (resolveTokenRef.current !== token) return;
        setResolved({ path: sourcePath, proxied: false, codec: null, poster: null });
        setPreparing(false);
        console.warn('[preview] 预览准备失败，回退原文件：', error);
      });
  }, [sourcePath]);

  // src 变化：重新进入加载态
  useEffect(() => {
    if (!src) {
      setLoadState('idle');
      return;
    }
    setLoadState('loading');
    setErrorText(null);
  }, [src]);

  // 播放状态同步
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (playing) void video.play().catch(() => undefined);
    else video.pause();
  }, [playing]);

  // 播放头 → 视频时间（偏差超过 300ms 才 seek，避免频繁跳转卡顿）
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !activeClip) return;
    const target = (currentMs - activeClip.start + activeClip.offset) / 1000;
    if (!Number.isFinite(target)) return;
    // 素材时长未就绪时 duration 为 NaN，此时不做越界裁剪
    const max = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : Number.POSITIVE_INFINITY;
    const clamped = Math.min(Math.max(0, target), max);
    if (Math.abs(video.currentTime - clamped) > 0.3) {
      video.currentTime = clamped;
    }
  }, [currentMs, activeClip]);

  const handleReady = useCallback(() => {
    setLoadState('ready');
    setErrorText(null);
  }, []);

  /**
   * <video> 的 error 事件不带原因，黑屏时无从排查。
   * 这里回查主进程，区分「文件不存在」与「路径未授权（miaoma:// 403）」。
   */
  const handleError = useCallback(() => {
    const target = assetPathRef.current;
    setLoadState('error');
    const api = window.electronAPI;
    if (!target || !api?.media?.diagnose) {
      setErrorText('无法加载该素材，请检查文件是否仍存在');
      return;
    }
    void api.media
      .diagnose(target)
      .then((result) => {
        if (assetPathRef.current !== target) return; // 结果已过期
        setErrorText(result.ok ? '预览加载失败：编码格式可能不被支持' : result.reason);
        console.error('[preview] 素材加载失败：', result.reason, target);
      })
      .catch(() => {
        if (assetPathRef.current !== target) return;
        setErrorText('无法加载该素材，请检查文件是否仍存在');
      });
  }, []);

  const handleRetry = useCallback(() => {
    // 重新走一次可播放性解析（可能上次转码失败 / 素材被替换）
    setLoadState('loading');
    setErrorText(null);
    const api = window.electronAPI;
    if (sourcePath && api?.media?.playable) {
      setPreparing(true);
      void api.media
        .playable(sourcePath)
        .then((result) => {
          setResolved(result);
          setPreparing(false);
          if (!result.path) setErrorText(result.note ?? '该素材无法生成预览');
        })
        .catch(() => {
          setPreparing(false);
          videoRef.current?.load();
        });
    } else {
      videoRef.current?.load();
    }
  }, [sourcePath]);

  const inClip = activeClip
    ? currentMs >= activeClip.start && currentMs <= activeClip.start + activeClip.duration
    : false;
  const showPoster = !src || loadState === 'error';

  return (
    <div className="flex min-w-0 min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden p-5">
        <div className="relative aspect-video max-h-full w-full max-w-2xl overflow-hidden rounded-lg border bg-black/70">
          {src ? (
            <video
              ref={videoRef}
              src={src}
              className="size-full object-contain"
              playsInline
              preload="auto"
              onLoadedMetadata={handleReady}
              onLoadedData={handleReady}
              onError={handleError}
            />
          ) : null}

          {/* 静帧兜底：转码 / 加载失败时展示素材关键帧，至少看得到画面 */}
          {showPoster ? (
            posterUrl ? (
              <img
                src={posterUrl}
                alt={activeClip?.name ?? '预览'}
                className="absolute inset-0 size-full object-contain"
              />
            ) : (
              <div className="absolute inset-0">
                <ThumbPlaceholder hue={activeClip?.hue ?? 330} className="size-full rounded-none opacity-90" />
                <p className="absolute inset-x-0 bottom-6 text-center text-lg font-semibold text-white drop-shadow-lg">
                  {activeClip?.name ?? '导入素材后即可预览'}
                </p>
              </div>
            )
          ) : null}

          {activeClip && !activeClip.assetPath ? (
            <p className="absolute top-3 left-3 rounded bg-black/50 px-2 py-0.5 text-[10px] text-white/70">
              占位预览（演示数据无真实文件）
            </p>
          ) : null}

          {preparing ? (
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/55 text-xs text-white/80">
              <span className="size-5 animate-spin rounded-full border-2 border-white/30 border-t-white/90" />
              正在准备预览（首次播放可能需转码）…
            </div>
          ) : src && loadState === 'loading' ? (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/50 text-xs text-white/70">
              正在加载预览…
            </div>
          ) : null}

          {!preparing && resolved && !resolved.path ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/85 p-6 text-center">
              <p className="text-sm font-medium text-red-400">无法预览该素材</p>
              <p className="max-w-md text-[11px] leading-relaxed text-white/70">
                {errorText ?? '未知原因'}
              </p>
              {activeClip?.assetPath ? (
                <p className="max-w-full truncate text-[10px] text-white/40" title={activeClip.assetPath}>
                  {activeClip.assetPath}
                </p>
              ) : null}
              <button
                onClick={handleRetry}
                className="mt-1 rounded-md border border-white/20 px-3 py-1 text-[11px] text-white/80 hover:bg-white/10"
              >
                重试
              </button>
            </div>
          ) : src && loadState === 'error' ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/85 p-6 text-center">
              <p className="text-sm font-medium text-red-400">预览加载失败</p>
              <p className="max-w-md text-[11px] leading-relaxed text-white/70">
                {errorText ?? '未知原因'}
              </p>
              {activeClip?.assetPath ? (
                <p className="max-w-full truncate text-[10px] text-white/40" title={activeClip.assetPath}>
                  {activeClip.assetPath}
                </p>
              ) : null}
              <button
                onClick={handleRetry}
                className="mt-1 rounded-md border border-white/20 px-3 py-1 text-[11px] text-white/80 hover:bg-white/10"
              >
                重试
              </button>
            </div>
          ) : null}

          {inClip && src && loadState !== 'error' && !preparing ? (
            <span className="absolute top-3 left-3 rounded bg-black/50 px-2 py-0.5 text-[10px] text-white/80">
              {activeClip?.name}
              {resolved?.proxied ? ' · 代理预览' : ''}
            </span>
          ) : null}
        </div>
      </div>

      <div className="flex h-10 shrink-0 items-center gap-3 border-t px-4 text-xs text-muted-foreground">
        <div className="mx-auto flex items-center gap-4">
          <SkipBack
            className="size-4 cursor-pointer hover:text-primary"
            onClick={() => onSeek(0)}
          />
          <button
            onClick={onTogglePlay}
            className={cn(
              'flex size-8 items-center justify-center rounded-full transition-colors',
              playing ? 'bg-brand text-white' : 'bg-secondary text-foreground hover:bg-accent',
            )}
            title={playing ? '暂停' : '播放'}
          >
            {playing ? <Pause className="size-4" /> : <Play className="size-4" />}
          </button>
          <SkipForward
            className="size-4 cursor-pointer hover:text-primary"
            onClick={() => onSeek(totalMs)}
          />
          <span className="font-mono">
            {formatTimecode(currentMs)} / {formatTimecode(totalMs)}
          </span>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Volume2 className="size-3.5" />
          <div className="h-1 w-16 rounded-full bg-secondary">
            <div className="bg-brand h-1 w-2/3 rounded-full" />
          </div>
        </div>
      </div>
    </div>
  );
}
