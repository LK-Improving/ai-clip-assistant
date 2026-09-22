import { Download, Import, Scissors, Sparkles } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AssetPanel, type LibraryAsset } from '@/components/editor/asset-panel';
import { Preview } from '@/components/editor/preview';
import { PropertyPanel } from '@/components/editor/property-panel';
import { Timeline, type AssetDropPayload } from '@/components/editor/timeline';
import { useLibrary } from '@/hooks/use-library';
import {
  useApplyTimeline,
  useTimelineAssetHints,
  useTimelineSaveState,
  useTimelineSelection,
  useTimelineTracks,
} from '@/hooks/use-timeline';
import { nextFreeStart, onSeekRequest, reportPlayhead, undoTimeline } from '@/lib/timeline-store';
import {
  formatTimecode,
  timelineTotalMs,
  type TimelineClip,
  type TimelineTrack,
} from '@/lib/timeline-utils';
import { getActiveProject } from '@/lib/active-project';
import type { AssetMetaHint } from '@/lib/project-bridge';
import { cn } from '@/lib/utils';

/** 07 视频编辑器：五区布局 + 真实素材 + 时间线交互（模块 3.1 / 3.2 / 3.3） */
export default function EditorPage() {
  const library = useLibrary();
  // 时间线状态与防抖落盘都在 lib/timeline-store（AI 助手面板共用同一份），
  // 页面只留播放态；所有改动经 applyActions 走统一 action 通道
  const tracks = useTimelineTracks();
  const applyActions = useApplyTimeline();
  const [selected, setSelected] = useTimelineSelection();
  const saveState = useTimelineSaveState();
  const [currentMs, setCurrentMs] = useState(0);
  const [playing, setPlaying] = useState(false);

  const [ttsText, setTtsText] = useState('');
  const [ttsBusy, setTtsBusy] = useState(false);
  const [ttsMessage, setTtsMessage] = useState<string | null>(null);

  // 与时间线底部「总时长」同一个口径（之前这里硬兜底 30s，导致预览区比实际作品长一截）
  const totalMs = useMemo(() => timelineTotalMs(tracks), [tracks]);

  // 播放头低频上报给 store：AI 助手要把「在这里切开」「从当前位置」翻译成毫秒。
  // 只在停止播放时立即上报，播放中每 400ms 最多一次（reportPlayhead 不广播，不影响渲染循环）
  const lastReportRef = useRef(0);
  useEffect(() => {
    const now = performance.now();
    if (playing && now - lastReportRef.current < 400) return;
    lastReportRef.current = now;
    reportPlayhead(currentMs);
  }, [currentMs, playing]);

  // 外部（AI 助手）发起的播放头跳转：currentMs 是高频值不进 store，走事件通道
  useEffect(
    () => onSeekRequest((ms) => setCurrentMs(Math.min(Math.max(0, ms), totalMs))),
    [totalMs],
  );

  // 播放循环：以播放头为准，预览区视频跟随
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const delta = now - last;
      last = now;
      setCurrentMs((prev) => {
        const next = prev + delta;
        if (next >= totalMs) {
          setPlaying(false);
          return totalMs;
        }
        return next;
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, totalMs]);

  const assets: LibraryAsset[] = useMemo(
    () =>
      library.entries.map((entry) => ({
        path: entry.path,
        name: entry.name,
        kind: entry.kind,
        size: entry.size,
        durationMs: entry.durationMs,
        width: entry.width,
        height: entry.height,
        hasAudio: entry.hasAudio,
        thumbPath: entry.thumbPath,
        error: entry.error,
      })),
    [library.entries],
  );

  /** 新建素材时用它补全时长 / 分辨率（取自素材库探测结果） */
  const assetHints = useMemo(() => {
    const map = new Map<string, AssetMetaHint>();
    for (const asset of assets) {
      if (asset.path && !asset.path.startsWith('mock://')) {
        map.set(asset.path, {
          durationMs: asset.durationMs,
          width: asset.width,
          height: asset.height,
          hasAudio: asset.hasAudio,
        });
      }
    }
    return map;
  }, [assets]);

  /** 把素材元数据交给 store：落盘由 store 统一做，避免“只有编辑器页挂着时改动才会被保存” */
  const hintsProvider = useCallback(() => assetHints, [assetHints]);
  useTimelineAssetHints(hintsProvider);

  const selectedClip: TimelineClip | null = useMemo(() => {
    if (!selected) return null;
    return (
      tracks.find((t) => t.id === selected.trackId)?.clips.find((c) => c.id === selected.clipId) ?? null
    );
  }, [selected, tracks]);

  /** 播放头命中的片段（优先视频轨，用于预览播放） */
  const activeClip = useMemo(() => {
    const inRange = tracks.flatMap((track) =>
      track.clips
        .filter((clip) => currentMs >= clip.start && currentMs < clip.start + clip.duration)
        .map((clip) => ({ track, clip })),
    );
    return (inRange.find((item) => item.track.kind === 'video') ?? inRange[0])?.clip ?? null;
  }, [tracks, currentMs]);

  /**
   * 命中播放头的音频轨片段（旁白/音乐）：预览要一起混音。
   * 之前预览区只有一个 〈video〉，只出当前视频片段原声，
   * 时间线里音乐轨再满也听不到东西。
   */
  const activeAudioClips = useMemo(
    () =>
      tracks
        .filter((track) => track.kind === 'audio')
        .flatMap((track) => track.clips)
        .filter(
          (clip) =>
            clip.assetPath && currentMs >= clip.start && currentMs < clip.start + clip.duration,
        ),
    [tracks, currentMs],
  );

  const addClipToTrack = useCallback(
    (trackId: string, clip: Omit<TimelineClip, 'id'>) => {
      applyActions([{ type: 'addClip', trackId, clip }]);
    },
    [applyActions],
  );

  const handleAddAsset = useCallback(
    (asset: LibraryAsset) => {
      const targetKind: TimelineTrack['kind'] =
        asset.kind === 'audio' ? 'audio' : asset.kind === 'subtitle' ? 'text' : 'video';
      const track = tracks.find((t) => t.kind === targetKind) ?? tracks[0];
      if (!track) return;
      addClipToTrack(track.id, {
        name: asset.name,
        kind: targetKind,
        start: nextFreeStart(track),
        duration: asset.durationMs || 5000,
        offset: 0,
        hue: (asset.name.charCodeAt(0) * 7) % 360,
        assetPath: asset.path.startsWith('mock://') ? undefined : asset.path,
      });
    },
    [tracks, addClipToTrack],
  );

  const handleDropAsset = useCallback(
    (trackId: string, payload: AssetDropPayload) => {
      const track = tracks.find((t) => t.id === trackId);
      if (!track) return;
      addClipToTrack(trackId, {
        name: payload.name,
        kind: track.kind,
        start: nextFreeStart(track),
        duration: payload.durationMs || 5000,
        offset: 0,
        hue: payload.hue,
        assetPath: payload.path?.startsWith('mock://') ? undefined : payload.path,
      });
    },
    [tracks, addClipToTrack],
  );

  const handleClipChange = useCallback(
    (trackId: string, clipId: string, patch: Partial<TimelineClip>) => {
      applyActions([{ type: 'updateClip', trackId, clipId, patch }]);
    },
    [applyActions],
  );

  const handleDeleteClip = useCallback(
    (trackId: string, clipId: string) => {
      applyActions([{ type: 'removeClip', trackId, clipId }]);
      setSelected(null);
    },
    [applyActions, setSelected],
  );

  const handleAddTrack = useCallback(
    (kind: TimelineTrack['kind']) => {
      applyActions([{ type: 'addTrack', kind }]);
    },
    [applyActions],
  );

  const handleRemoveTrack = useCallback(
    (trackId: string) => {
      applyActions([{ type: 'removeTrack', trackId }]);
    },
    [applyActions],
  );

  // Delete 键删除选中片段；Ctrl/Cmd+Z 撤销上一次时间线改动（含 AI 助手批量改）
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      // 正在输入文本时不抢快捷键：Ctrl+Z 应该是输入框自己的撤销
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;

      if ((event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === 'z') {
        if (undoTimeline()) event.preventDefault();
        return;
      }
      if (event.key !== 'Delete' && event.key !== 'Backspace') return;
      if (!selected) return;
      event.preventDefault();
      handleDeleteClip(selected.trackId, selected.clipId);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [selected, handleDeleteClip]);

  const handleSynthesize = useCallback(async () => {
    const api = window.electronAPI;
    if (!api) {
      setTtsMessage('AI 配音需运行在桌面端（当前为浏览器预览模式）');
      return;
    }
    setTtsBusy(true);
    setTtsMessage(null);
    try {
      const result = await api.tts.synthesize({ text: ttsText });
      const audioTrack = tracks.find((t) => t.kind === 'audio');
      if (audioTrack) {
        addClipToTrack(audioTrack.id, {
          name: `配音_${ttsText.slice(0, 8)}`,
          kind: 'audio',
          start: nextFreeStart(audioTrack),
          duration: result.durationMs || 3000,
          offset: 0,
          hue: 265,
          assetPath: result.audioPath,
        });
      }
      setTtsMessage(
        `已生成 ${formatTimecode(result.durationMs)} 音频${result.cached ? '（命中缓存）' : ''}，已加入音频轨`,
      );
    } catch (error) {
      setTtsMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setTtsBusy(false);
    }
  }, [ttsText, tracks, addClipToTrack]);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* 顶部工具栏 */}
      <header className="flex h-11 shrink-0 items-center gap-2 border-b px-3">
        <div className="flex items-center gap-1.5 text-xs font-semibold">
          <Scissors className="size-3.5 text-primary" />
          {getActiveProject().name}
        </div>
        <span
          className={cn(
            'text-[10px]',
            saveState === 'error' ? 'text-destructive' : 'text-muted-foreground',
          )}
        >
          {saveState === 'saving'
            ? '保存中…'
            : saveState === 'saved'
              ? '已保存'
              : saveState === 'error'
                ? '保存失败'
                : ''}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={() => void library.importFiles()}
            className="flex h-7 items-center gap-1 rounded-md border border-input px-2.5 text-xs hover:text-foreground"
          >
            <Import className="size-3.5" /> 导入素材
          </button>
          <a
            href="#/ai"
            className="flex h-7 items-center gap-1 rounded-md border border-input px-2.5 text-xs hover:text-foreground"
          >
            <Sparkles className="size-3.5" /> AI 一键成片
          </a>
          <a
            href="#/export"
            className="bg-brand inline-flex h-7 items-center gap-1.5 rounded-md px-3 text-xs font-medium text-white shadow shadow-primary/30"
          >
            <Download className="size-3.5" /> 导出
          </a>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <AssetPanel
          assets={assets}
          scanning={library.scanning}
          progress={library.progress}
          ffmpeg={library.ffmpeg}
          onPickDir={() => void library.pickAndScan()}
          onImport={() => void library.importFiles()}
          onRescan={() => void library.scan()}
          onClear={() => void library.clear()}
          onAddToTimeline={handleAddAsset}
        />

        <Preview
          currentMs={currentMs}
          totalMs={totalMs}
          playing={playing}
          activeClip={activeClip}
          audioClips={activeAudioClips}
          onTogglePlay={() => setPlaying((p) => !p)}
          onSeek={(ms) => setCurrentMs(Math.min(ms, totalMs))}
        />

        <PropertyPanel
          clip={selectedClip}
          trackKind={selected ? (tracks.find((t) => t.id === selected.trackId)?.kind ?? null) : null}
          onClipChange={(patch) => {
            if (selected) handleClipChange(selected.trackId, selected.clipId, patch);
          }}
          onDeleteClip={() => {
            if (selected) handleDeleteClip(selected.trackId, selected.clipId);
          }}
          ttsText={ttsText}
          onTtsTextChange={setTtsText}
          onSynthesize={() => void handleSynthesize()}
          ttsBusy={ttsBusy}
          ttsMessage={ttsMessage}
        />
      </div>

      <footer className="h-56 shrink-0 border-t">
        <Timeline
          tracks={tracks}
          currentMs={currentMs}
          selected={selected}
          onSeek={(ms) => setCurrentMs(Math.min(ms, totalMs))}
          onSelect={setSelected}
          onClipChange={handleClipChange}
          onDeleteClip={handleDeleteClip}
          onAddTrack={handleAddTrack}
          onRemoveTrack={handleRemoveTrack}
          onDropAsset={handleDropAsset}
        />
      </footer>
    </div>
  );
}
