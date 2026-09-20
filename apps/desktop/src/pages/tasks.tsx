import { Clapperboard, Film } from 'lucide-react';
import { Badge, ProgressRing } from '@/components/ui/misc';
import { cn } from '@/lib/utils';

const tabs = ['进行中 (1)', '已完成 (2)', '失败 (0)'] as const;

const tasks = [
  {
    icon: Film,
    title: 'AI 成片 · 深夜食堂.mp4',
    desc: '视频合成 · 剩余约 1 分钟',
    progress: 68,
    state: 'running' as const,
  },
  {
    icon: Clapperboard,
    title: '分镜合成 · 城市旅行 Vlog',
    desc: '5 个分镜已生成',
    progress: 100,
    state: 'done' as const,
  },
  {
    icon: Film,
    title: '导出 · 产品介绍视频',
    desc: '1080P · MP4',
    progress: 100,
    state: 'done' as const,
  },
];

/** 11 任务中心 / 通知 */
export default function TasksPage() {
  return (
    <div className="mx-auto max-w-3xl space-y-4 p-6">
      <div className="flex items-center gap-3">
        <h1 className="text-lg font-bold">任务中心</h1>
        <nav className="flex gap-1 rounded-lg bg-secondary/60 p-1 text-xs">
          {tabs.map((t, i) => (
            <button
              key={t}
              className={cn(
                'rounded-md px-3 py-1.5 transition-colors',
                i === 0 ? 'bg-card font-medium shadow-sm' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {t}
            </button>
          ))}
        </nav>
      </div>

      <div className="space-y-3">
        {tasks.map(({ icon: Icon, title, desc, progress, state }) => (
          <div key={title} className="flex items-center gap-4 rounded-xl border bg-card/60 p-4">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/15 text-primary">
              <Icon className="size-5" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <p className="truncate text-sm font-medium">{title}</p>
                {state === 'running' ? (
                  <Badge tone="brand">进行中</Badge>
                ) : (
                  <Badge tone="success">已完成</Badge>
                )}
              </div>
              <p className="mt-0.5 text-xs text-muted-foreground">{desc}</p>
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-secondary">
                <div
                  className={cn('h-full rounded-full', state === 'done' ? 'bg-emerald-500' : 'bg-brand')}
                  style={{ width: `${progress}%` }}
                />
              </div>
            </div>
            {state === 'running' ? (
              <ProgressRing value={progress} size={44} strokeWidth={5}>
                <span className="text-[10px] font-semibold">{progress}%</span>
              </ProgressRing>
            ) : (
              <span className="w-11 text-center font-mono text-xs text-emerald-400">100%</span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
