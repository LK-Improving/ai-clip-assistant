import { ArrowDownUp, CheckSquare, Ellipsis, History, RotateCcw, Search, SquarePlus, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ThumbPlaceholder } from '@/components/ui/misc';
import { formatTimecode } from '@/lib/timeline-utils';
import { hueOf } from '@/lib/project-bridge';
import { openProject } from '@/lib/active-project';
import type { ProjectDiff, ProjectVersion, RemoteConfig } from '@/preload';

type ProjectSummary = Awaited<ReturnType<NonNullable<typeof window.electronAPI>['project']['list']>>[number];

type SortMode = 'time-desc' | 'time-asc' | 'name';

const SORT_LABELS: Record<SortMode, string> = {
  'time-desc': '最近修改',
  'time-asc': '最早修改',
  name: '名称 A→Z',
};

function formatDate(iso: string | number): string {
  const date = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function toEditor() {
  window.location.hash = '#/editor';
}

/**
 * M5 版本历史面板：git 快照历史列表、任选两版 diff、一键回滚（作为新版本落盘）、
 * 云端协同（可选远端 url+token 手动 push/pull，本地历史离线完整可用）。
 */
function VersionPanel({ project, onClose }: { project: { id: string; name: string }; onClose: () => void }) {
  const [versions, setVersions] = useState<ProjectVersion[]>([]);
  const [picked, setPicked] = useState<string[]>([]);
  const [diff, setDiff] = useState<ProjectDiff | null>(null);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [remote, setRemote] = useState<RemoteConfig | null>(null);
  const [remoteUrl, setRemoteUrl] = useState('');
  const [remoteToken, setRemoteToken] = useState('');

  const refresh = useCallback(async () => {
    const api = window.electronAPI;
    if (!api) return;
    setVersions(await api.project.history(project.id));
    setRemote(await api.version.remoteGet());
    if (remoteUrl === '' && (await api.version.remoteGet())) {
      setRemoteUrl((await api.version.remoteGet())?.url ?? '');
    }
  }, [project.id, remoteUrl]);

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id]);

  const togglePick = (oid: string) => {
    setPicked((prev) => (prev.includes(oid) ? prev.filter((o) => o !== oid) : [...prev.slice(-1), oid]));
    setDiff(null);
  };

  async function compare() {
    const api = window.electronAPI;
    if (!api || picked.length !== 2) return;
    // 新→旧列表里按时间顺序比较：后选为起点
    const [from, to] = picked[0] === versions[0]?.oid ? [picked[1]!, picked[0]!] : [picked[0]!, picked[1]!];
    setDiff(await api.project.diffVersions(project.id, from, to));
  }

  async function restore(oid: string) {
    const api = window.electronAPI;
    if (!api) return;
    if (!window.confirm('回滚将以该版本内容落盘为新版本（不丢失现有历史），继续？')) return;
    setBusy(true);
    try {
      await api.project.restoreVersion(project.id, oid);
      setMsg(`已回滚到 ${oid.slice(0, 7)} 并作为新版本保存`);
      await refresh();
    } catch (e) {
      setMsg(`回滚失败：${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  async function push() {
    const api = window.electronAPI;
    if (!api) return;
    setBusy(true);
    try {
      setMsg(await api.version.push());
    } catch (e) {
      setMsg(`推送失败：${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  async function pull() {
    const api = window.electronAPI;
    if (!api) return;
    setBusy(true);
    try {
      setMsg(await api.version.pull());
      await refresh();
    } catch (e) {
      setMsg(`拉取失败：${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  async function saveRemote() {
    const api = window.electronAPI;
    if (!api) return;
    if (!remoteUrl.trim()) {
      setRemote(await api.version.remoteSet(null));
      setMsg('已清除远端配置');
      return;
    }
    setRemote(await api.version.remoteSet({ url: remoteUrl.trim(), token: remoteToken.trim() || undefined }));
    setMsg('远端已保存（token 仅存本机 userData，不随工程上报）');
  }

  return (
    <div className="rounded-xl border bg-card/70 p-4">
      <div className="flex items-center justify-between">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold">
          <History className="size-4 text-primary" /> 版本历史 · {project.name}
        </h3>
        <button onClick={onClose} className="rounded p-1 text-muted-foreground hover:text-foreground" title="关闭">
          <X className="size-4" />
        </button>
      </div>

      {versions.length === 0 ? (
        <p className="mt-2 text-xs text-muted-foreground">尚无版本记录：在编辑器里保存一次工程即自动生成首个快照。</p>
      ) : (
        <ul className="mt-2 max-h-56 space-y-1 overflow-y-auto">
          {versions.map((v, i) => (
            <li key={v.oid} className="flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-xs">
              <input
                type="checkbox"
                checked={picked.includes(v.oid)}
                onChange={() => togglePick(v.oid)}
                title="勾选两个版本进行对比"
              />
              <span className="min-w-0 flex-1 truncate">{v.message}{i === 0 ? '（当前）' : ''}</span>
              <span className="font-mono text-[10px] text-muted-foreground">{v.oid.slice(0, 7)}</span>
              <span className="shrink-0 text-[10px] text-muted-foreground">{formatDate(v.timestampMs)}</span>
              <button
                onClick={() => void restore(v.oid)}
                disabled={busy || i === 0}
                className="flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground disabled:opacity-40"
                title="回滚到此版本"
              >
                <RotateCcw className="size-3" /> 回滚
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-2 flex items-center gap-2 text-xs">
        <button
          onClick={() => void compare()}
          disabled={picked.length !== 2}
          className="rounded-md border border-input px-2.5 py-1 text-[11px] hover:border-primary/40 disabled:opacity-40"
        >
          对比所选两版
        </button>
        {diff ? (
          <span className="text-muted-foreground">
            {diff.changed
              ? `名称${diff.nameChanged ? '变' : '同'} · 轨道 +${diff.tracksAdded}/-${diff.tracksRemoved} · 片段 +${diff.clipsAdded}/-${diff.clipsRemoved} · 素材 +${diff.assetsAdded}/-${diff.assetsRemoved} · 时长${diff.durationDeltaMs >= 0 ? '+' : ''}${(diff.durationDeltaMs / 1000).toFixed(1)}s`
              : '两版内容一致'}
          </span>
        ) : null}
      </div>

      {/* 云端协同（可选） */}
      <div className="mt-3 space-y-2 border-t pt-3">
        <p className="text-[11px] font-medium text-muted-foreground">云端协同（可选，GitHub/Gitee https 仓库；离线时本地历史完整可用）</p>
        <div className="flex flex-wrap items-center gap-2">
          <input
            value={remoteUrl}
            onChange={(e) => setRemoteUrl(e.target.value)}
            placeholder="远端仓库 URL（如 https://gitee.com/you/kk-projects.git）"
            className="h-7 min-w-56 flex-1 rounded border border-input bg-card/60 px-2 text-[11px] outline-none focus:border-ring"
          />
          <input
            type="password"
            value={remoteToken}
            onChange={(e) => setRemoteToken(e.target.value)}
            placeholder={remote?.token ? 'token（已保存，留空不修改）' : '访问 token（可选）'}
            className="h-28 w-40 rounded border border-input bg-card/60 px-2 text-[11px] outline-none focus:border-ring"
          />
          <button onClick={() => void saveRemote()} className="rounded-md border border-input px-2.5 py-1 text-[11px] hover:border-primary/40">保存远端</button>
          <button onClick={() => void push()} disabled={busy || !remote} className="rounded-md border border-input px-2.5 py-1 text-[11px] hover:border-primary/40 disabled:opacity-40">推送</button>
          <button onClick={() => void pull()} disabled={busy || !remote} className="rounded-md border border-input px-2.5 py-1 text-[11px] hover:border-primary/40 disabled:opacity-40">拉取</button>
        </div>
        {msg ? <p className="text-[11px] text-muted-foreground">{msg}</p> : null}
      </div>
    </div>
  );
}

/** 12 项目管理：工程网格（搜索 + 排序筛选 + 批量删除 + 空状态引导） */
export default function ProjectsPage() {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [sortMode, setSortMode] = useState<SortMode>('time-desc');
  const [batchMode, setBatchMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [batchBusy, setBatchBusy] = useState(false);
  // M5：当前展开版本面板的工程
  const [versionsFor, setVersionsFor] = useState<{ id: string; name: string } | null>(null);

  const refresh = useCallback(async () => {
    const api = window.electronAPI;
    if (!api) {
      setLoading(false);
      return;
    }
    try {
      setProjects(await api.project.list());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const visible = useMemo(() => {
    const kw = query.trim().toLowerCase();
    let list = kw ? projects.filter((p) => p.name.toLowerCase().includes(kw)) : [...projects];
    list = list.sort((a, b) => {
      if (sortMode === 'name') return a.name.localeCompare(b.name, 'zh-Hans-CN');
      const ta = Date.parse(a.updatedAt);
      const tb = Date.parse(b.updatedAt);
      return sortMode === 'time-desc' ? tb - ta : ta - tb;
    });
    return list;
  }, [projects, query, sortMode]);

  const handleOpen = useCallback(async (id: string) => {
    const project = await openProject(id);
    if (project) toEditor();
    else setError('工程打开失败：文件可能已损坏或被删除');
  }, []);

  const handleRemove = useCallback(
    async (id: string, name: string) => {
      const api = window.electronAPI;
      if (!api) return;
      if (!window.confirm(`确定删除项目「${name}」？该操作不可恢复。`)) return;
      await api.project.remove(id);
      setSelected((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      await refresh();
    },
    [refresh],
  );

  const toggleSelect = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const exitBatch = useCallback(() => {
    setBatchMode(false);
    setSelected(new Set());
  }, []);

  const handleBatchDelete = useCallback(async () => {
    const api = window.electronAPI;
    if (!api || selected.size === 0) return;
    const ids = [...selected];
    if (!window.confirm(`确定删除选中的 ${ids.length} 个项目？该操作不可恢复。`)) return;
    setBatchBusy(true);
    try {
      // 逐个删除：单个失败不中断批量流程，最后统一刷新
      for (const id of ids) {
        try {
          await api.project.remove(id);
        } catch {
          /* 已不存在的工程视为删除成功 */
        }
      }
    } finally {
      setBatchBusy(false);
      exitBatch();
      await refresh();
    }
  }, [selected, exitBatch, refresh]);

  const allVisibleSelected = visible.length > 0 && visible.every((p) => selected.has(p.id));

  return (
    <div className="space-y-4 p-6">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-bold">项目管理</h1>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {loading ? '加载中…' : `共 ${projects.length} 个项目${query.trim() ? ` · 匹配 ${visible.length} 个` : ''}`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {/* 搜索 */}
          <div className="relative">
            <Search className="absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索项目名称"
              className="h-8 w-48 rounded-md border border-input bg-card/60 pl-7 pr-7 text-xs outline-none placeholder:text-muted-foreground focus:border-ring"
            />
            {query ? (
              <button
                onClick={() => setQuery('')}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                title="清空搜索"
              >
                <X className="size-3.5" />
              </button>
            ) : null}
          </div>
          {/* 排序 / 筛选 */}
          <div className="flex items-center gap-1.5">
            <ArrowDownUp className="size-3.5 text-muted-foreground" />
            <select
              value={sortMode}
              onChange={(event) => setSortMode(event.target.value as SortMode)}
              className="h-8 rounded-md border border-input bg-card/60 px-1.5 text-xs outline-none focus:border-ring"
            >
              {(Object.keys(SORT_LABELS) as SortMode[]).map((mode) => (
                <option key={mode} value={mode}>
                  {SORT_LABELS[mode]}
                </option>
              ))}
            </select>
          </div>
          {/* 批量管理 */}
          {batchMode ? (
            <>
              <button
                onClick={() =>
                  setSelected(allVisibleSelected ? new Set() : new Set(visible.map((p) => p.id)))
                }
                className="flex h-8 items-center gap-1.5 rounded-md border border-input px-2.5 text-xs hover:border-primary/40"
              >
                <CheckSquare className="size-3.5" />
                {allVisibleSelected ? '取消全选' : '全选'}
              </button>
              <button
                onClick={() => void handleBatchDelete()}
                disabled={selected.size === 0 || batchBusy}
                className="flex h-8 items-center gap-1.5 rounded-md border border-destructive/40 bg-destructive/10 px-2.5 text-xs text-destructive hover:bg-destructive/20 disabled:opacity-50"
              >
                <Trash2 className="size-3.5" />
                {batchBusy ? '删除中…' : `删除选中（${selected.size}）`}
              </button>
              <button
                onClick={exitBatch}
                className="flex h-8 items-center gap-1.5 rounded-md border border-input px-2.5 text-xs text-muted-foreground hover:text-foreground"
              >
                完成
              </button>
            </>
          ) : (
            <button
              onClick={() => setBatchMode(true)}
              disabled={projects.length === 0}
              className="flex h-8 items-center gap-1.5 rounded-md border border-input px-2.5 text-xs hover:border-primary/40 disabled:opacity-50"
            >
              <CheckSquare className="size-3.5" /> 批量管理
            </button>
          )}
          <a
            href="#/new"
            className="bg-brand inline-flex h-8 items-center gap-1.5 rounded-md px-3.5 text-xs font-medium text-white shadow shadow-primary/30"
          >
            <SquarePlus className="size-3.5" /> 新建项目
          </a>
        </div>
      </div>

      {error ? (
        <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </p>
      ) : null}

      {!loading && projects.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed py-16 text-center">
          <Ellipsis className="size-5 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">还没有项目</p>
          <a href="#/new" className="text-xs text-primary hover:underline">
            创建第一个项目 →
          </a>
        </div>
      ) : null}

      {!loading && projects.length > 0 && visible.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed py-12 text-center">
          <Search className="size-5 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">没有匹配「{query.trim()}」的项目</p>
          <button onClick={() => setQuery('')} className="text-xs text-primary hover:underline">
            清空搜索条件
          </button>
        </div>
      ) : null}

      {versionsFor ? (
        <VersionPanel project={versionsFor} onClose={() => setVersionsFor(null)} />
      ) : null}

      <div className="grid grid-cols-5 gap-4">
        {visible.map((p) => {
          const checked = selected.has(p.id);
          return (
            <div
              key={p.id}
              onClick={() => {
                if (batchMode) toggleSelect(p.id);
                else void handleOpen(p.id);
              }}
              className={`group cursor-pointer overflow-hidden rounded-xl border bg-card/60 transition-all hover:-translate-y-0.5 hover:shadow-lg hover:shadow-primary/10 ${
                checked ? 'border-primary/60 ring-1 ring-primary/40' : 'hover:border-primary/40'
              }`}
            >
              <div className="relative">
                <ThumbPlaceholder hue={hueOf(p.id)} className="aspect-video w-full" />
                <span className="absolute right-1.5 bottom-1.5 rounded bg-black/60 px-1.5 py-0.5 text-[10px] text-white">
                  {formatTimecode(p.durationMs)}
                </span>
                {batchMode ? (
                  <span
                    className={`absolute top-1.5 left-1.5 flex size-5 items-center justify-center rounded border text-[10px] ${
                      checked
                        ? 'bg-brand border-primary text-white'
                        : 'border-white/70 bg-black/40 text-transparent'
                    }`}
                  >
                    ✓
                  </span>
                ) : null}
                {!batchMode ? (
                  <>
                    <button
                      onClick={(event) => {
                        event.stopPropagation();
                        setVersionsFor({ id: p.id, name: p.name });
                      }}
                      className="absolute top-1.5 right-10 rounded-md bg-black/50 p-1 opacity-0 transition-opacity hover:bg-primary/80 group-hover:opacity-100"
                      title="版本历史（M5）"
                    >
                      <History className="size-3.5 text-white" />
                    </button>
                    <button
                      onClick={(event) => {
                        event.stopPropagation();
                        void handleRemove(p.id, p.name);
                      }}
                      className="absolute top-1.5 right-1.5 rounded-md bg-black/50 p-1 opacity-0 transition-opacity hover:bg-destructive/80 group-hover:opacity-100"
                      title="删除项目"
                    >
                      <Trash2 className="size-3.5 text-white" />
                    </button>
                  </>
                ) : null}
              </div>
              <div className="space-y-0.5 p-2.5">
                <p className="truncate text-xs font-medium group-hover:text-primary">{p.name}</p>
                <p className="text-[10px] text-muted-foreground">{formatDate(p.updatedAt)}</p>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
