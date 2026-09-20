import { ArrowRight, Scissors } from 'lucide-react';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/** 01 启动页：品牌极光 + 单一行动点 */
export default function LaunchPage() {
  return (
    <div className="bg-aurora relative flex h-screen flex-col items-center justify-center overflow-hidden">
      {/* 装饰光带 */}
      <div className="absolute -top-32 left-1/4 h-96 w-96 rounded-full bg-fuchsia-500/20 blur-3xl" />
      <div className="absolute top-1/3 -right-24 size-80 rounded-full bg-sky-400/10 blur-3xl" />

      <div className="relative flex flex-col items-center gap-6 text-center">
        <span className="bg-brand flex size-20 items-center justify-center rounded-3xl shadow-2xl shadow-primary/40">
          <Scissors className="size-9 text-white" />
        </span>
        <div>
          <h1 className="text-5xl font-bold tracking-wide">
            KK<span className="text-brand-gradient">剪映</span>
          </h1>
          <p className="mt-4 text-lg text-muted-foreground">用 AI 让视频创作更简单</p>
        </div>
        <a
          href="#/home"
          className={cn(buttonVariants({ size: 'lg' }), 'mt-4 h-12 gap-2 rounded-full px-10 text-base')}
        >
          开始创作 <ArrowRight className="size-4" />
        </a>
      </div>

      <p className="absolute bottom-8 text-xs text-muted-foreground/70">
        让每个人都成为视频创作的魔术师 · Magic Video Creative
      </p>
    </div>
  );
}
