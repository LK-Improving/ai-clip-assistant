import {
  Bell,
  Clapperboard,
  FolderOpen,
  Layers,
  Search,
  Settings,
  Scissors,
  Sparkles,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

const navItems = [
  { to: '/home', label: '项目', icon: FolderOpen },
  { to: '/library', label: '素材', icon: Layers },
  { to: '/storyboard', label: '分镜', icon: Clapperboard },
  { to: '/editor', label: '剪辑', icon: Scissors },
  { to: '/ai', label: 'AI 工具', icon: Sparkles },
];

const bottomItems = [
  { to: '/tasks', label: '任务中心', icon: Bell },
  { to: '/settings', label: '设置中心', icon: Settings },
];

/** 应用外壳：左侧图标导航 + 顶栏（对照设计稿 02/06/10 等页面） */
export function AppShell({ route, children }: { route: string; children: ReactNode }) {
  return (
    <div className="flex h-screen overflow-hidden">
      {/* 左侧导航 */}
      <aside className="flex w-16 shrink-0 flex-col items-center border-r py-4">
        <a href="#/home" className="mb-6 flex flex-col items-center gap-1" title="KK剪映">
          <span className="flex size-9 items-center justify-center rounded-xl bg-brand shadow-lg shadow-primary/30">
            <Scissors className="size-4.5 text-white" />
          </span>
        </a>
        <nav className="flex flex-1 flex-col items-center gap-1.5">
          {navItems.map(({ to, label, icon: Icon }) => {
            const active = route === to;
            return (
              <a
                key={to}
                href={`#${to}`}
                title={label}
                className={cn(
                  'flex w-12 flex-col items-center gap-1 rounded-lg py-2 text-[10px] transition-colors',
                  active
                    ? 'bg-primary/15 text-primary'
                    : 'text-muted-foreground hover:bg-secondary hover:text-foreground',
                )}
              >
                <Icon className="size-4.5" />
                {label}
              </a>
            );
          })}
        </nav>
        <div className="flex flex-col items-center gap-1.5">
          {bottomItems.map(({ to, label, icon: Icon }) => {
            const active = route === to;
            return (
              <a
                key={to}
                href={`#${to}`}
                title={label}
                className={cn(
                  'flex w-12 flex-col items-center gap-1 rounded-lg py-2 text-[10px] transition-colors',
                  active
                    ? 'bg-primary/15 text-primary'
                    : 'text-muted-foreground hover:bg-secondary hover:text-foreground',
                )}
              >
                <Icon className="size-4.5" />
                {label}
              </a>
            );
          })}
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* 顶栏 */}
        <header className="flex h-12 shrink-0 items-center gap-3 border-b px-4">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <span className="bg-brand size-5 rounded-md" />
            KK<span className="text-brand-gradient">剪映</span>
          </div>
          <div className="relative mx-auto w-72">
            <Search className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              placeholder="搜索项目、素材..."
              className="h-8 w-full rounded-md border border-input bg-card/60 pr-3 pl-8 text-xs outline-none placeholder:text-muted-foreground focus:border-ring"
            />
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="bg-brand flex size-7 items-center justify-center rounded-full text-[11px] font-semibold text-white">
              M
            </span>
            <span>KK剪映创作</span>
          </div>
        </header>

        <main
          className={cn('min-h-0 flex-1', route === '/editor' ? 'overflow-hidden' : 'overflow-y-auto')}
        >
          {children}
        </main>
      </div>
    </div>
  );
}
