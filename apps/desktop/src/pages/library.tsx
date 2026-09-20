import { ArrowDownAZ, Import, Search, Sparkles } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Input } from '@/components/ui/input';
import { Badge, ThumbPlaceholder } from '@/components/ui/misc';
import type { LibrarySearchHit } from '@/preload';
import { useLibrary } from '@/hooks/use-library';
import { formatTimecode } from '@/lib/timeline-utils';
import { cn } from '@/lib/utils';

const tabs = [
  { key: 'all', label: '本地素材' },
  { key: 'video', label: '视频' },
  { key: 'audio', label: '音频' },
  { key: 'image', label: '图片' },
  { key: 'subtitle', label: '字幕' },
] as const;

/** 06 素材库：真实扫描结果 + 元数据（模块 3.1）+ 语义检索（P2） */
export default function LibraryPage() {
  const library = useLibrary();
  const [tab, setTab] = useState<(typeof tabs)[number]['key']>('all');
  const [keyword, setKeyword] = useState('');
  // 语义搜索开关（P2）：开启时走主进程特征向量检索，关闭或浏览器预览模式回退关键词匹配
  const [semantic, setSemantic] = useState(true);
  const [semanticHits, setSemanticHits] = useState<LibrarySearchHit[] | null>(null);

  useEffect(() => {
    const api = window.electronAPI;
    const q = keyword.trim();
    if (!api?.library.search || !semantic || q === '') {
      setSemanticHits(null);
      return;
    }
    let cancelled = false;
    // 防抖：输入过程中避免每个字符一次 IPC（本地检索很快，150ms 足够）
    const timer = setTimeout(() => {
      api.library
        .search(q, 60)
        .then((hits) => {
          if (!cancelled) setSemanticHits(hits);
        })
        .catch(() => {
          if (!cancelled) setSemanticHits(null);
        });
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // library.entries.length 变化（扫描/导入后）重新检索，保证新素材进入索引视图
  }, [keyword, semantic, library.entries.length]);

  const visible = useMemo(() => {
    if (semanticHits) {
      // 语义结果保留相似度排序，仅叠加类型 tab 筛选
      return semanticHits.map((h) => h.entry).filter((entry) => tab === 'all' || entry.kind === tab);
    }
    return library.entries.filter((entry) => {
      const matchKind = tab === 'all' || entry.kind === tab;
      const matchKeyword = keyword.trim() === '' || entry.name.toLowerCase().includes(keyword.trim().toLowerCase());
      return matchKind && matchKeyword;
    });
  }, [library.entries, semanticHits, tab, keyword]);

  const semanticActive = Boolean(semanticHits);
  // M4：视觉增强就绪状态（未就绪时在语义提示行说明降级原因，可观察不阻断）
  const [visionReady, setVisionReady] = useState<boolean | null>(null);
  useEffect(() => {
    const api = window.electronAPI;
    if (!api?.vision) return;
    api.vision.status().then((s) => setVisionReady(s.ready)).catch(() => setVisionReady(false));
  }, []);

  const mediaUrl = (path: string) => window.electronAPI?.toMediaUrl(path) ?? '';

  return (
    <div className="flex h-full flex-col p-4">
      {/* 工具行 */}
      <div className="flex items-center gap-3">
        <nav className="flex gap-1 rounded-lg bg-secondary/60 p-1 text-xs">
          {tabs.map(({ key, label }) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={cn(
                'rounded-md px-3 py-1.5 transition-colors',
                tab === key ? 'bg-card font-medium shadow-sm' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {label}
            </button>
          ))}
        </nav>
        <div className="relative ml-auto w-56">
          <Search className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
            placeholder={semantic ? '语义搜索：夕阳海滩、音乐…' : '搜索本地素材'}
            className="h-8 pl-8 text-xs"
          />
        </div>
        <button
          onClick={() => setSemantic((prev) => !prev)}
          title="开启后按本地特征向量 + 关键词加成排序（离线可用）"
          className={cn(
            'flex items-center gap-1 rounded-md border px-2.5 py-1.5 text-xs transition-colors',
            semantic
              ? 'border-primary/50 bg-primary/10 text-primary'
              : 'border-input text-muted-foreground hover:text-foreground',
          )}
        >
          <Sparkles className="size-3.5" /> 语义搜索
        </button>
        <button className="flex items-center gap-1 rounded-md border border-input px-2.5 py-1.5 text-xs text-muted-foreground hover:text-foreground">
          <ArrowDownAZ className="size-3.5" /> 名称排序
        </button>
        <button
          onClick={() => void library.importFiles()}
          className="bg-brand flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium text-white shadow shadow-primary/30"
        >
          <Import className="size-3.5" /> 导入素材
        </button>
      </div>

      {/* 语义检索提示（P2） */}
      {semanticActive ? (
        <p className="mt-2 flex items-center gap-1.5 text-[11px] text-primary/80">
          <Sparkles className="size-3" />
          语义搜索：按本地特征向量相似度排序，命中 {visible.length} 个素材（离线可用，关闭开关回退关键词匹配）
          {visionReady === false ? '；视觉增强未就绪（可运行 pnpm vision:warmup 启用 CLIP）' : null}
          {visionReady === true ? '；视觉增强就绪（CLIP 向量参与排序）' : null}
        </p>
      ) : null}

      {/* 状态条 */}
      <div className="mt-3 flex items-center gap-2 text-[11px] text-muted-foreground">
        <button
          onClick={() => void library.pickAndScan()}
          className="rounded border border-input px-2 py-1 hover:text-foreground"
        >
          扫描目录
        </button>
        <button
          onClick={() => void library.scan()}
          disabled={library.scanning || library.dirs.length === 0}
          className="rounded border border-input px-2 py-1 hover:text-foreground disabled:opacity-50"
        >
          {library.scanning ? '扫描中...' : '增量重扫'}
        </button>
        {library.ffmpeg ? (
          <Badge tone={library.ffmpeg.available ? 'success' : 'default'}>
            FFmpeg {library.ffmpeg.available ? '就绪' : '缺失'}
          </Badge>
        ) : null}
        <span>
          {visible.length} / {library.entries.length} 个素材
        </span>
        {library.summary ? (
          <span className="text-muted-foreground/80">
            上次扫描：新增 {library.summary.added} · 更新 {library.summary.updated} · 移除{' '}
            {library.summary.removed}
          </span>
        ) : null}
        {library.progress ? (
          <span className="ml-auto font-mono">
            {library.progress.current}/{library.progress.total}
          </span>
        ) : null}
      </div>

      {library.progress ? (
        <div className="mt-1 h-0.5 w-full bg-secondary">
          <div
            className="bg-brand h-0.5 transition-all"
            style={{
              width: `${(library.progress.current / Math.max(1, library.progress.total)) * 100}%`,
            }}
          />
        </div>
      ) : null}

      {/* 网格 */}
      <div className="mt-4 min-h-0 flex-1 overflow-y-auto">
        {visible.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 py-16 text-center">
            <p className="text-sm text-muted-foreground">
              {library.scanning ? '正在扫描素材...' : '暂无素材'}
            </p>
            <p className="text-xs text-muted-foreground/70">
              点击「扫描目录」选择素材文件夹，或用「导入素材」选择单个文件
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-6 gap-3">
            {visible.map((entry) => (
              <div key={entry.path} className="group overflow-hidden rounded-lg border bg-card/60">
                <div className="relative">
                  {entry.thumbPath ? (
                    <img
                      src={mediaUrl(entry.thumbPath)}
                      alt={entry.name}
                      loading="lazy"
                      className="aspect-video w-full object-cover"
                    />
                  ) : (
                    <ThumbPlaceholder
                      hue={(entry.name.charCodeAt(0) * 7) % 360}
                      className="aspect-video w-full"
                    />
                  )}
                  {entry.durationMs ? (
                    <span className="absolute right-1.5 bottom-1.5 rounded bg-black/60 px-1.5 py-0.5 text-[10px] text-white">
                      {formatTimecode(entry.durationMs)}
                    </span>
                  ) : null}
                </div>
                <div className="flex items-center justify-between gap-1 p-2">
                  <div className="min-w-0">
                    <p className="truncate text-[11px]">{entry.name}</p>
                    <p className="text-[10px] text-muted-foreground">
                      {entry.width && entry.height
                        ? `${entry.width}×${entry.height}`
                        : entry.error
                          ? '元数据缺失'
                          : `${(entry.size / 1024 / 1024).toFixed(1)} MB`}
                    </p>
                  </div>
                  <Badge>
                    {entry.kind === 'video'
                      ? '视频'
                      : entry.kind === 'audio'
                        ? '音频'
                        : entry.kind === 'image'
                          ? '图片'
                          : '字幕'}
                  </Badge>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
