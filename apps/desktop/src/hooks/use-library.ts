import { assetLibrary } from '@/lib/mock';
import type { LibraryEntry, ScanSummary } from '@/preload';
import { useCallback, useEffect, useState } from 'react';

interface LibraryProgress {
  current: number;
  total: number;
  file: string;
}

const hasBridge = () => typeof window !== 'undefined' && Boolean(window.electronAPI);

/** 浏览器预览（无 Electron bridge）时的降级数据 */
/** 无缩略图时按名称派生色相，保证占位色稳定 */
export function hueFromName(name: string): number {
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) hash = (hash * 31 + name.charCodeAt(i)) % 360;
  return hash;
}

const fallbackEntries: LibraryEntry[] = assetLibrary.map((a) => ({
  path: `mock://${a.name}`,
  name: a.name,
  kind: a.kind === '视频' ? 'video' : a.kind === '图片' ? 'image' : 'audio',
  size: 0,
  mtimeMs: 0,
  durationMs: 0,
}));

/**
 * 本地素材库状态（模块 3.1）：
 * 桌面端走真实扫描 + 增量缓存；浏览器预览模式退化为静态数据，保证 UI 仍可演示。
 */
export function useLibrary() {
  const [entries, setEntries] = useState<LibraryEntry[]>(() =>
    hasBridge() ? [] : fallbackEntries,
  );
  const [dirs, setDirs] = useState<string[]>([]);
  const [progress, setProgress] = useState<LibraryProgress | null>(null);
  const [scanning, setScanning] = useState(false);
  const [summary, setSummary] = useState<ScanSummary | null>(null);
  const [ffmpeg, setFfmpeg] = useState<{ path: string | null; available: boolean } | null>(null);

  const refresh = useCallback(async () => {
    const api = window.electronAPI;
    if (!api) return;
    const [list, dirList, status] = await Promise.all([
      api.library.list(),
      api.library.dirs(),
      api.ffmpegStatus(),
    ]);
    setEntries(list);
    setDirs(dirList);
    setFfmpeg(status);
  }, []);

  useEffect(() => {
    void refresh();
    const api = window.electronAPI;
    if (!api) return;
    return api.library.onProgress(setProgress);
  }, [refresh]);

  const scan = useCallback(
    async (targetDirs?: string[]) => {
      const api = window.electronAPI;
      if (!api) return null;
      const list = targetDirs ?? dirs;
      if (list.length === 0) return null;
      setScanning(true);
      setProgress(null);
      try {
        const result = await api.library.scan(list);
        setSummary(result);
        await refresh();
        return result;
      } finally {
        setScanning(false);
        setProgress(null);
      }
    },
    [dirs, refresh],
  );

  const pickAndScan = useCallback(async () => {
    const api = window.electronAPI;
    if (!api) return;
    const picked = await api.library.pickDir();
    if (picked.length === 0) return;
    setDirs(picked);
    await scan(picked);
  }, [scan]);

  const importFiles = useCallback(async () => {
    const api = window.electronAPI;
    if (!api) return;
    const files = await api.library.pickFiles();
    if (files.length === 0) return;
    setScanning(true);
    try {
      await api.library.add(files);
      await refresh();
    } finally {
      setScanning(false);
    }
  }, [refresh]);

  const remove = useCallback(
    async (filePath: string) => {
      const api = window.electronAPI;
      if (!api) return;
      await api.library.remove(filePath);
      await refresh();
    },
    [refresh],
  );

  const clear = useCallback(async () => {
    const api = window.electronAPI;
    if (!api) return;
    await api.library.clear();
    setSummary(null);
    await refresh();
  }, [refresh]);

  return {
    entries,
    dirs,
    progress,
    scanning,
    summary,
    ffmpeg,
    desktop: hasBridge(),
    scan,
    pickAndScan,
    importFiles,
    remove,
    clear,
    refresh,
  };
}
