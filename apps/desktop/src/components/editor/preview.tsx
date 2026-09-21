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
  /** 命中播放头的音频轨片段（旁白/音乐），必须与视频一起混音，否则「时间线有声音、预览没声音」 */
  audioClips?: TimelineClip[];
  onTogglePlay: () => void;
  onSeek: (ms: number) => void;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, Number.isFinite(value) ? value : 1));
}

/**
 * 音频层：一条命中播放头的音频片段挂一个〈audio〉，与视频元素共用同一个播放头。
 *
 * 与视频同样的两个坑：
 * - 〈video〉/〈audio〉在 src 变化后会被 load 算法置为 paused，而 React 的 playing 不变，
 *   所以同步 effect 必须同时依赖 src；
 * - 元数据就绪前设 currentTime 会被浏览器忽略（duration 还是 NaN），
 *   以 loadedmetadata/canplay 再补一次 seek。
 */
function AudioLayer({ clip, currentMs, playing }: { clip: TimelineClip; currentMs: number; playing: boolean }) {
  const ref = useRef<HTMLAudioElement | null>(null);
  const src = clip.assetPath ? (window.electronAPI?.toMediaUrl(clip.assetPath) ?? '') : '';
  const targetRef = useRef(0);

  const applyTarget = useCallback(() => {
    const el = ref.current;
    if (el) el.currentTime = targetRef.current;
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el || !src) return;
    if (playing) void el.play().catch(() => undefined);
    else el.pause();
  }, [playing, src]);

  useEffect(() => {
    const el = ref.current;
    if (!el || !src) return;
    el.volume = clamp01(clip.volume ?? 1);
    el.muted = Boolean(clip.muted);
  }, [src, clip.volume, clip.muted]);

  useEffect(() => {
    const el = ref.current;
    if (!el || !src) return;
    const target = (currentMs - clip.start + clip.offset) / 1000;
    if (!Number.isFinite(target)) return;
    const max = Number.isFinite(el.duration) && el.duration > 0 ? el.duration : Number.POSITIVE_INFINITY;
    targetRef.current = Math.min(Math.max(0, target), max);
    if (Math.abs(el.currentTime - targetRef.current) > 0.3) el.currentTime = targetRef.current;
  }, [currentMs, clip.start, clip.offset, src]);

  if (!src) return null;
  return (
    <audio
      ref={ref}
      src={src}
      className="hidden"
      playsInline
      preload="auto"
      onLoadedMetadata={applyTarget}
      onCanPlay={applyTarget}
    />
  );
}

type LoadState = 'idle' | 'loading' | 'ready' | 'error';

/** 预览区（模块 3.2）：真实素材走 miaoma:// 协议播放，与播放头双向同步 */
export function Preview({ currentMs, totalMs, playing, activeClip, audioClips = [], onTogglePlay, onSeek }: PreviewProps) {
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

  // 素材切换：先问主进程「这个能播吗」，必要时拿到转码代理路径；重置强制代理重试标记
  useEffect(() => {
    forceTriedRef.current = {};
    // 切换瞬间先把上一段停住：playable() 是异步的（探测 + 可能转码），
    // 新 src 就位前元素还挂着上一段素材，不暂停就会「画面已经到下段、声音还是上段」
    videoRef.current?.pause();
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

  // 播放状态同步。src 也要进依赖：切换片段时 <video> 会重跑 load 算法被置为 paused，
  // 而 React 侧 playing 仍为 true 不会重跑本 effect，结果就是「画面在走但没声音」，
  // 必须手动暂停再播放才能恢复
  const playingRef = useRef(playing);
  playingRef.current = playing;

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (playing) void video.play().catch(() => undefined);
    else video.pause();
  }, [playing, src]);

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
    // 新资源就绪后补一次 play：覆盖上面那次 play() 被随后才执行的 load 算法重新暂停的情况
    const video = videoRef.current;
    if (video && playingRef.current && video.paused) {
      void video.play().catch(() => undefined);
    }
  }, []);

  /**
   * <video> 的 error 事件不带原因，黑屏时无从排查。
   * 处理分两层：
   *  1) 首次失败且当前用的是原文件 → 自动降级：让主进程强制转码 faststart H.264 代理重试
   *     （覆盖非 faststart 大文件、高码率、特殊 profile 等 Chromium 实际拒播场景）；
   *  2) 代理仍失败 → 回查主进程 diagnose + 报出 video.error.code 对应的真实错误类型，不再只说“编码不支持”。
   */
  const forceTriedRef = useRef<Record<string, boolean>>({});
  const handleError = useCallback(() => {
    const target = assetPathRef.current;
    const api = window.electronAPI;
    const code = videoRef.current?.error?.code ?? 0;
    const codeText =
      code === 1
        ? '加载被中断（ABORTED）'
        : code === 2
          ? '网络/协议层错误（NETWORK，含 Range 拉流失败）'
          : code === 3
            ? '解码失败（DECODE）'
            : code === 4
              ? '源不受支持（SRC_NOT_SUPPORTED）'
              : `未知错误（code=${code}）`;

    // 自动降级：未经强制代理重试过 → 转 faststart 代理重试一次（不先展示错误）
    if (target && api?.media?.playable && !resolved?.proxied && !forceTriedRef.current[target]) {
      forceTriedRef.current[target] = true;
      setLoadState('loading');
      setErrorText(null);
      setPreparing(true);
      void api.media
        .playable(target, true)
        .then((result) => {
          if (assetPathRef.current !== target) return;
          setPreparing(false);
          if (result.path) {
            setResolved(result); // src 变化自动重新加载
          } else {
            setLoadState('error');
            setErrorText(`自动转码代理失败：${result.note ?? '未知原因'}`);
          }
        })
        .catch((error) => {
          if (assetPathRef.current !== target) return;
          setPreparing(false);
          setLoadState('error');
          setErrorText(`自动转码代理失败：${(error as Error).message}`);
        });
      return;
    }

    setLoadState('error');
    if (!target || !api?.media?.diagnose) {
      setErrorText(`无法加载该素材（${codeText}）`);
      return;
    }
    void api.media
      .diagnose(target)
      .then((result) => {
        if (assetPathRef.current !== target) return; // 结果已过期
        setErrorText(
          result.ok
            ? `预览加载失败（${codeText}）${resolved?.proxied ? '，代理仍无法播放：' : '，原文件无法播放：'}建议点重试重新转码`
            : result.reason,
        );
        console.error('[preview] 素材加载失败：', result.reason, codeText, target);
      })
      .catch(() => {
        if (assetPathRef.current !== target) return;
        setErrorText(`无法加载该素材（${codeText}）`);
      });
  }, [resolved]);

  const handleRetry = useCallback(() => {
    // 用户主动重试：直接强制 faststart 代理（上次可能转码失败 / 素材被替换）
    // 同时清掉自动降级标记，让这次失败后仍能再走一次自动降级
    if (sourcePath) delete forceTriedRef.current[sourcePath];
    setLoadState('loading');
    setErrorText(null);
    const api = window.electronAPI;
    const prevPath = resolved?.path;
    if (sourcePath && api?.media?.playable) {
      setPreparing(true);
      void api.media
        .playable(sourcePath, true)
        .then((result) => {
          setResolved(result);
          setPreparing(false);
          if (!result.path) setErrorText(result.note ?? '该素材无法生成预览');
          // 命中已有代理时 src 没变，React 不会重新触发加载，手动重启一次才能重试
          else if (result.path === prevPath) videoRef.current?.load();
        })
        .catch(() => {
          setPreparing(false);
          videoRef.current?.load();
        });
    } else {
      videoRef.current?.load();
    }
  }, [sourcePath, resolved]);

  const inClip = activeClip
    ? currentMs >= activeClip.start && currentMs <= activeClip.start + activeClip.duration
    : false;
  const showPoster = !src || loadState === 'error';

  return (
    <div className="flex min-w-0 min-h-0 flex-1 flex-col">
      {/* 音频轨混音预览：旁白/音乐不渲染画面，但要能听到 */}
      {audioClips.map((clip) => (
        <AudioLayer key={clip.id} clip={clip} currentMs={currentMs} playing={playing} />
      ))}
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
