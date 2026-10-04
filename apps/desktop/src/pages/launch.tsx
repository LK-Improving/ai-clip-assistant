import {
  ArrowRight,
  ChevronRight,
  Cloud,
  Crown,
  FolderOpen,
  HelpCircle,
  Home,
  Layers,
  Play,
  Scissors,
  Settings,
  Sparkles,
  User,
  Wand2,
  Zap,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { buttonVariants } from '@/components/ui/button';
import { BrandMark } from '@/components/layout/brand';
import { cn } from '@/lib/utils';

/** 01 启动页：侧边导航 + 沉浸式极光 Hero + 单一行动点（对照设计稿 VideoFlow 首页） */

const mainNav: { to: string; label: string; icon: LucideIcon; active?: boolean }[] = [
  { to: '/home', label: '首页', icon: Home, active: true },
  { to: '/new', label: '创作', icon: Wand2 },
  { to: '/projects', label: '项目', icon: FolderOpen },
  { to: '/library', label: '素材库', icon: Layers },
  { to: '/new', label: 'AI 工具', icon: Sparkles },
];

const footNav: { to: string; label: string; icon: LucideIcon }[] = [
  { to: '/settings', label: '帮助中心', icon: HelpCircle },
  { to: '/settings', label: '设置', icon: Settings },
];

const features: { icon: LucideIcon; title: string; desc: string }[] = [
  { icon: Zap, title: 'AI 智能创作', desc: '一段文字生成完整视频' },
  { icon: Layers, title: '海量素材资源', desc: '视频 / 音频 / 模板' },
  { icon: Scissors, title: '专业剪辑能力', desc: '精细化编辑调整' },
  { icon: Cloud, title: '本地安全存储', desc: '你的数据只属于你' },
];

export default function LaunchPage() {
  return (
    <div className="bg-hero flex h-screen overflow-hidden text-foreground">
      {/* 左侧品牌导航栏 */}
      <aside className="z-10 flex w-60 shrink-0 flex-col border-r border-white/10 bg-black/25 px-4 py-6 backdrop-blur-xl">
        <a href="#/home" className="flex items-center gap-3 px-1">
          <BrandMark className="size-11" />
          <span className="leading-tight">
            <span className="block text-[15px] font-semibold">智剪 AI · VideoFlow</span>
            <span className="block text-[11px] text-muted-foreground">AI 视频创作提效平台</span>
          </span>
        </a>

        <nav className="mt-8 flex flex-col gap-1">
          {mainNav.map(({ to, label, icon: Icon, active }) => (
            <a
              key={label}
              href={`#${to}`}
              className={cn(
                'flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition-colors',
                active
                  ? 'bg-primary/20 font-medium text-white ring-1 ring-primary/40'
                  : 'text-muted-foreground hover:bg-white/5 hover:text-foreground',
              )}
            >
              <Icon className="size-4.5" />
              {label}
            </a>
          ))}
        </nav>

        <div className="mt-auto flex flex-col gap-4">
          <a
            href="#/settings"
            className="flex items-center gap-3 rounded-xl border border-amber-400/25 bg-gradient-to-r from-amber-400/15 to-fuchsia-500/10 px-3 py-2.5 transition-colors hover:border-amber-400/40"
          >
            <Crown className="size-5 shrink-0 text-amber-400" />
            <span className="leading-tight">
              <span className="block text-[13px] font-medium text-amber-200">升级专业版</span>
              <span className="block text-[11px] text-muted-foreground">解锁更多 AI 能力</span>
            </span>
            <ChevronRight className="ml-auto size-4 text-muted-foreground" />
          </a>

          <div className="flex flex-col gap-1">
            {footNav.map(({ to, label, icon: Icon }) => (
              <a
                key={label}
                href={`#${to}`}
                className="flex items-center gap-3 rounded-xl px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-white/5 hover:text-foreground"
              >
                <Icon className="size-4.5" />
                {label}
              </a>
            ))}
          </div>
        </div>
      </aside>

      {/* 主区域 */}
      <main className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
        {/* 装饰：流动光带 */}
        <div className="hero-ribbon pointer-events-none absolute -left-24 top-1/3 h-72 w-[130%] -rotate-6 opacity-70" />
        <div className="hero-ribbon pointer-events-none absolute left-0 top-1/2 h-56 w-[120%] rotate-3 opacity-40" />

        {/* 装饰：右侧传送门 + 地面倒影 */}
        <div className="pointer-events-none absolute right-16 top-1/2 hidden -translate-y-1/2 lg:block">
          <div className="hero-portal h-[26rem] w-40 rounded-t-[2rem] rounded-b-md" />
          <div className="hero-portal hero-reflection mx-auto h-24 w-40 -scale-y-100 opacity-40" />
        </div>

        {/* 手写批注 */}
        <p className="pointer-events-none absolute right-24 top-24 hidden -rotate-6 text-right text-lg italic text-fuchsia-200/70 lg:block">
          用 AI 放大
          <br />
          每一个创意的可能
        </p>

        {/* 顶部：登录 / 注册 */}
        <div className="relative z-10 flex justify-end px-8 pt-6">
          <a
            href="#/home"
            className={cn(
              buttonVariants({ variant: 'outline' }),
              'h-9 gap-2 rounded-full border-white/15 bg-white/5 px-5 text-sm text-foreground/90 hover:bg-white/10',
            )}
          >
            <User className="size-4" />
            登录 / 注册
          </a>
        </div>

        {/* 居中 Hero */}
        <div className="relative z-10 flex flex-1 flex-col items-center justify-center px-8 text-center">
          <BrandMark className="size-20 rounded-[1.6rem] shadow-2xl shadow-primary/50" />

          <h1 className="mt-7 text-5xl font-bold tracking-wide">
            智剪 AI · <span className="text-brand-gradient">VideoFlow</span>
          </h1>
          <p className="mt-5 text-xl font-medium text-foreground/90">
            让 AI 接管繁琐，让创作专注表达
          </p>
          <p className="mt-3 text-base text-muted-foreground">
            从想法到成片，一句话完成视频创作
          </p>

          <a
            href="#/new"
            className={cn(
              buttonVariants({ size: 'lg' }),
              'bg-brand mt-9 h-14 gap-2.5 rounded-2xl px-10 text-base font-semibold shadow-xl shadow-primary/40 hover:opacity-95',
            )}
          >
            <span className="flex size-6 items-center justify-center rounded-full bg-white/20">
              <Play className="size-3 fill-white text-white" />
            </span>
            开始创作
            <ArrowRight className="size-4" />
          </a>
        </div>

        {/* 特性卡片 */}
        <div className="relative z-10 mx-auto grid w-full max-w-3xl grid-cols-2 gap-x-8 gap-y-7 px-8 pb-6 sm:grid-cols-4">
          {features.map(({ icon: Icon, title, desc }) => (
            <div key={title} className="flex flex-col items-center gap-2 text-center">
              <span className="flex size-12 items-center justify-center rounded-full border border-white/10 bg-white/5">
                <Icon className="size-5 text-fuchsia-200" />
              </span>
              <span className="text-sm font-medium">{title}</span>
              <span className="text-xs text-muted-foreground">{desc}</span>
            </div>
          ))}
        </div>

        {/* 页脚 */}
        <p className="relative z-10 flex items-center justify-center gap-3 pb-6 text-[11px] tracking-[0.3em] text-muted-foreground/70">
          <span className="h-px w-10 bg-muted-foreground/30" />
          VIDEOFLOW · AI EMPOWERS CREATION
          <span className="h-px w-10 bg-muted-foreground/30" />
        </p>
      </main>
    </div>
  );
}
