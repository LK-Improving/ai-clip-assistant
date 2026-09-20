import { Download, Import, Scissors, Sparkles } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AssetPanel, type LibraryAsset } from '@/components/editor/asset-panel';
import { Preview } from '@/components/editor/preview';
import { PropertyPanel } from '@/components/editor/property-panel';
import { Timeline, type AssetDropPayload } from '@/components/editor/timeline';
import { useLibrary } from '@/hooks/use-library';
import {
  createId,
  formatTimecode,
  totalDuration,
  type TimelineClip,
  type TimelineTrack,
} from '@/lib/timeline-utils';
import { getActiveProject, saveActiveProject, syncActiveProject } from '@/lib/active-project';
import { projectToTimeline, timelineToProject, type AssetMetaHint } from '@/lib/project-bridge';
import { cn } from '@/lib/utils';

/** 空工程的默认轨道：视频 / 音频 / 字幕各一条 */
function defaultTracks(): TimelineTrack[] {
  return [
    { id: createId('track'), kind: 'video', name: '视频 1', clips: [] },
    { id: createId('track'), kind: 'audio', name: '音频 1', clips: [] },
    { id: createId('track'), kind: 'text', name: '字幕', clips: [] },
  ];
}

/** 07 视频编辑器：五区布局 + 真实素材 + 时间线交互（模块 3.1 / 3.2 / 3.3） */
export default function EditorPage() {
  const library = useLibrary();
  // 从激活工程恢复时间线；空工程则给出默认轨道
  const [tracks, setTracks] = useState<TimelineTrack[]>(() => {
    const restored = projectToTimeline(getActiveProject());
    return restored.length > 0 ? restored : defaultTracks();
  });
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const firstRender = useRef(true);
  const [currentMs, setCurrentMs] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [selected, setSelected] = useState<{ trackId: string; clipId: string } | null>(null);

  const [ttsText, setTtsText] = useState('');
  const [ttsBusy, setTtsBusy] = useState(false);
  const [ttsMessage, setTtsMessage] = useState<string | null>(null);

  const totalMs = useMemo(() => Math.max(totalDuration(tracks), 30_000), [tracks]);

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

  /** 时间线改动 → 回写工程 → 防抖落盘（首次渲染只做恢复，不触发保存） */
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    const timer = setTimeout(async () => {
      setSaveState('saving');
      try {
        syncActiveProject(timelineToProject(getActiveProject(), tracks, assetHints));
        const saved = await saveActiveProject();
        setSaveState(saved ? 'saved' : 'idle');
      } catch {
        setSaveState('error');
      }
    }, 800);
    return () => clearTimeout(timer);
  }, [tracks, assetHints]);

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

  const appendClip = useCallback((trackId: string, clip: Omit<TimelineClip, 'id'>) => {
    setTracks((prev) =>
      prev.map((track) =>
        track.id === trackId ? { ...track, clips: [...track.clips, { ...clip, id: createId('clip') }] } : track,
      ),
    );
  }, []);

  const handleAddAsset = useCallback(
    (asset: LibraryAsset) => {
      const targetKind: TimelineTrack['kind'] =
        asset.kind === 'audio' ? 'audio' : asset.kind === 'subtitle' ? 'text' : 'video';
      const track = tracks.find((t) => t.kind === targetKind) ?? tracks[0];
      if (!track) return;
      const start = track.clips.reduce((max, clip) => Math.max(max, clip.start + clip.duration), 0);
      appendClip(track.id, {
        name: asset.name,
        kind: targetKind,
        start: start === 0 ? 0 : start + 200,
        duration: asset.durationMs || 5000,
        offset: 0,
        hue: (asset.name.charCodeAt(0) * 7) % 360,
        assetPath: asset.path.startsWith('mock://') ? undefined : asset.path,
      });
    },
    [tracks, appendClip],
  );

  const handleDropAsset = useCallback(
    (trackId: string, payload: AssetDropPayload) => {
      const track = tracks.find((t) => t.id === trackId);
      if (!track) return;
      const start = track.clips.reduce((max, clip) => Math.max(max, clip.start + clip.duration), 0);
      appendClip(trackId, {
        name: payload.name,
        kind: track.kind,
        start: start === 0 ? 0 : start + 200,
        duration: payload.durationMs || 5000,
        offset: 0,
        hue: payload.hue,
        assetPath: payload.path?.startsWith('mock://') ? undefined : payload.path,
      });
    },
    [tracks, appendClip],
  );

  const handleClipChange = useCallback(
    (trackId: string, clipId: string, patch: Partial<TimelineClip>) => {
      setTracks((prev) =>
        prev.map((track) =>
          track.id === trackId
            ? {
                ...track,
                clips: track.clips.map((clip) => (clip.id === clipId ? { ...clip, ...patch } : clip)),
              }
            : track,
        ),
      );
    },
    [],
  );

  const handleDeleteClip = useCallback((trackId: string, clipId: string) => {
    setTracks((prev) =>
      prev.map((track) =>
        track.id === trackId ? { ...track, clips: track.clips.filter((clip) => clip.id !== clipId) } : track,
      ),
    );
    setSelected(null);
  }, []);

  const handleAddTrack = useCallback((kind: TimelineTrack['kind']) => {
    setTracks((prev) => {
      const index = prev.filter((t) => t.kind === kind).length + 1;
      const label = kind === 'video' ? '视频' : kind === 'audio' ? '音频' : '字幕';
      return [...prev, { id: createId('track'), kind, name: `${label} ${index}`, clips: [] }];
    });
  }, []);

  const handleRemoveTrack = useCallback((trackId: string) => {
    setTracks((prev) => prev.filter((track) => track.id !== trackId));
  }, []);

  // Delete 键删除选中片段
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Delete' && event.key !== 'Backspace') return;
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
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
        const start = audioTrack.clips.reduce((max, c) => Math.max(max, c.start + c.duration), 0);
        appendClip(audioTrack.id, {
          name: `配音_${ttsText.slice(0, 8)}`,
          kind: 'audio',
          start: start === 0 ? 0 : start + 200,
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
  }, [ttsText, tracks, appendClip]);

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
