import { Clock, FolderOpen, Import, Sparkles, SquarePlus } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { ThumbPlaceholder } from '@/components/ui/misc';
import { formatTimecode } from '@/lib/timeline-utils';
import { hueOf } from '@/lib/project-bridge';
import { openProject } from '@/lib/active-project';

type ProjectSummary = Awaited<ReturnType<NonNullable<typeof window.electronAPI>['project']['list']>>[number];

const quickActions = [
  { label: '开始新项目', icon: SquarePlus, to: '/new', tone: 'bg-violet-500/15 text-violet-400' },
  { label: 'AI 智能创作', icon: Sparkles, to: '/ai', tone: 'bg-fuchsia-500/15 text-fuchsia-400' },
  { label: '导入素材', icon: Import, to: '/library', tone: 'bg-sky-500/15 text-sky-400' },
  { label: '打开项目', icon: FolderOpen, to: '/projects', tone: 'bg-emerald-500/15 text-emerald-400' },
];

function toEditor() {
  window.location.hash = '#/editor';
}

/** 02 工作台 / 项目首页 */
export default function HomePage() {
  const [recent, setRecent] = useState<ProjectSummary[]>([]);

  useEffect(() => {
    const api = window.electronAPI;
    if (!api) return;
    void api.project
      .list()
      .then((list) => setRecent(list.slice(0, 5)))
      .catch(() => setRecent([]));
  }, []);

  const handleOpen = useCallback(async (id: string) => {
    const project = await openProject(id);
    if (project) toEditor();
  }, []);

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-bold">欢迎回来！👋</h1>
        <p className="mt-1 text-sm text-muted-foreground">用 AI，让视频创作更简单</p>
      </div>

      {/* 四个快捷入口 */}
      <div className="grid grid-cols-4 gap-4">
        {quickActions.map(({ label, icon: Icon, to, tone }) => (
          <a
            key={label}
            href={`#${to}`}
            className="group flex flex-col items-center gap-3 rounded-xl border bg-card/60 py-7 transition-all hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-lg hover:shadow-primary/10"
          >
            <span className={`flex size-12 items-center justify-center rounded-xl ${tone}`}>
              <Icon className="size-6" />
            </span>
            <span className="text-sm font-medium">{label}</span>
          </a>
        ))}
      </div>

      {/* 最近项目 */}
      <section>
        <div className="mb-3 flex items-center gap-2">
          <Clock className="size-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">最近项目</h2>
          <a href="#/projects" className="ml-auto text-xs text-muted-foreground hover:text-primary">
            查看全部 →
          </a>
        </div>

        {recent.length === 0 ? (
          <div className="rounded-xl border border-dashed py-10 text-center text-xs text-muted-foreground">
            还没有项目，
            <a href="#/new" className="text-primary hover:underline">
              立即创建
            </a>
          </div>
        ) : (
          <div className="grid grid-cols-5 gap-4">
            {recent.map((p) => (
              <div
                key={p.id}
                onClick={() => void handleOpen(p.id)}
                className="group cursor-pointer overflow-hidden rounded-xl border bg-card/60 transition-all hover:border-primary/40 hover:shadow-lg hover:shadow-primary/10"
              >
                <div className="relative">
                  <ThumbPlaceholder hue={hueOf(p.id)} className="aspect-video w-full" />
                  <span className="absolute right-1.5 bottom-1.5 rounded bg-black/60 px-1.5 py-0.5 text-[10px] text-white">
                    {formatTimecode(p.durationMs)}
                  </span>
                </div>
                <div className="space-y-0.5 p-2.5">
                  <p className="truncate text-xs font-medium group-hover:text-primary">{p.name}</p>
                  <p className="text-[10px] text-muted-foreground">
                    {p.clipCount} 个片段 · {p.width}×{p.height}
                  </p>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
