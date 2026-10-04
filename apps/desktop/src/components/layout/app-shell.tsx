import {
  Bell,
  ChevronRight,
  Crown,
  FolderOpen,
  Layers,
  PanelLeftClose,
  PanelLeftOpen,
  Scissors,
  Settings,
  Sparkles,
  User,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { AssistantPanel } from '@/components/assistant/assistant-dock';
import { BrandMark, BrandWordmark } from '@/components/layout/brand';
import { cn } from '@/lib/utils';

/** 侧栏页面导航：分镜/生成已收进整页 AI 助手（/chat）；剪辑页另以抽屉展示助手 */
const navItems: { to: string; label: string; icon: LucideIcon }[] = [
  { to: '/new', label: '创作', icon: Sparkles },
  { to: '/projects', label: '我的项目', icon: FolderOpen },
  { to: '/library', label: '素材库', icon: Layers },
  { to: '/editor', label: '剪辑', icon: Scissors },
];

const bottomItems: { to: string; label: string; icon: LucideIcon }[] = [
  { to: '/chat', label: '创作对话', icon: Sparkles },
  { to: '/tasks', label: '任务中心', icon: Bell },
  { to: '/settings', label: '设置', icon: Settings },
];

function NavLink({
  to,
  label,
  icon: Icon,
  active,
  collapsed,
}: {
  to: string;
  label: string;
  icon: LucideIcon;
  active: boolean;
  collapsed: boolean;
}) {
  return (
    <a
      href={`#${to}`}
      title={label}
      className={cn(
        'flex items-center gap-3 rounded-xl py-2.5 text-sm transition-colors',
        collapsed ? 'justify-center px-0' : 'px-3',
        active
          ? 'bg-primary/15 font-medium text-white ring-1 ring-primary/30'
          : 'text-muted-foreground hover:bg-white/5 hover:text-foreground',
      )}
    >
      <Icon className="size-4.5 shrink-0" />
      {!collapsed ? label : null}
    </a>
  );
}

/** 应用外壳：可收起的宽文字侧栏 + 顶部用户区 + 右缘常驻 AI 助手浮层 */
export function AppShell({ route, children }: { route: string; children: ReactNode }) {
  const [navigation, setNavigation] = useState({ route, collapsed: route === '/editor' });
  const collapsed = navigation.route === route ? navigation.collapsed : route === '/editor';
  const toggleNavigation = () => setNavigation({ route, collapsed: !collapsed });
  useEffect(() => {
    setNavigation({ route, collapsed: route === '/editor' });
  }, [route]);

  return (
    <div className="flex h-screen overflow-hidden">
      {/* 左侧导航（可收起） */}
      <aside
        className={cn(
          'relative flex shrink-0 flex-col overflow-hidden border-r border-white/10 bg-black/25 py-6 transition-[width] duration-200',
          collapsed ? 'w-[68px] px-3' : 'w-60 px-4',
        )}
      >
        <div className="hero-portal pointer-events-none absolute -bottom-24 -left-16 h-64 w-40 rounded-full opacity-30 blur-2xl" />

        <a href="#/new" title="返回创作" className={cn('relative flex items-center gap-3', collapsed && 'justify-center')}>
          <BrandMark className="size-11 shrink-0" />
          {!collapsed ? <BrandWordmark /> : null}
        </a>

        {route === '/editor' ? (
          <button onClick={toggleNavigation} aria-label={collapsed ? '展开导航' : '收起导航'} aria-expanded={!collapsed}
            className="mt-4 flex h-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-white/5 hover:text-foreground">
            {collapsed ? <PanelLeftOpen className="size-5" /> : <PanelLeftClose className="size-5" />}
          </button>
        ) : null}

        <nav className="relative mt-5 flex flex-col gap-1">
          {navItems.map((item) => (
            <NavLink key={item.to} {...item} collapsed={collapsed} active={route === item.to} />
          ))}
        </nav>

        <div className="relative mt-auto flex flex-col gap-4">
          <a
            href="#/settings"
            title="升级专业版"
            className={cn(
              'flex items-center gap-3 rounded-xl border border-amber-400/25 bg-gradient-to-r from-amber-400/15 to-fuchsia-500/10 py-2.5 transition-colors hover:border-amber-400/40',
              collapsed ? 'justify-center px-0' : 'px-3',
            )}
          >
            <Crown className="size-5 shrink-0 text-amber-400" />
            {!collapsed ? (
              <>
                <span className="leading-tight">
                  <span className="block text-[13px] font-medium text-amber-200">升级专业版</span>
                  <span className="block text-[11px] text-muted-foreground">解锁更多 AI 能力</span>
                </span>
                <ChevronRight className="ml-auto size-4 text-muted-foreground" />
              </>
            ) : null}
          </a>

          <div className="flex flex-col gap-1">
            {bottomItems.map((item) => (
              <NavLink key={item.to} {...item} collapsed={collapsed} active={route === item.to} />
            ))}
          </div>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* 顶栏：左侧收起开关 + 右侧消息与用户区 */}
        {route !== '/editor' ? <header className="flex h-14 shrink-0 items-center justify-between gap-4 border-b px-4 lg:px-6">
          <button
            onClick={toggleNavigation}
            title={collapsed ? '展开侧栏' : '收起侧栏'}
            className="flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-white/5 hover:text-foreground"
          >
            {collapsed ? <PanelLeftOpen className="size-5" /> : <PanelLeftClose className="size-5" />}
          </button>
          <div className="flex items-center gap-4">
            <button className="relative text-muted-foreground transition-colors hover:text-foreground" title="通知">
              <Bell className="size-5" />
              <span className="absolute -top-0.5 -right-0.5 size-2 rounded-full bg-rose-500 ring-2 ring-background" />
            </button>
            <div className="flex items-center gap-2.5">
              <span className="bg-brand flex size-8 items-center justify-center rounded-full text-white">
                <User className="size-4" />
              </span>
              <span className="hidden leading-tight sm:block">
                <span className="block text-xs font-medium">创意永不设限</span>
                <span className="block text-[10px] text-muted-foreground">个人版</span>
              </span>
            </div>
          </div>
        </header> : null}

        <main
          className={cn(
            'min-h-0 flex-1',
            route === '/editor' || route === '/chat' ? 'overflow-hidden' : 'overflow-y-auto',
          )}
        >
          {children}
        </main>
      </div>

      {/* AI 助手抽屉仅在剪辑页出现（对话式改时间线）；创作流程在整页 /chat */}
      {route === '/editor' ? <AssistantPanel variant="drawer" /> : null}
    </div>
  );
}
