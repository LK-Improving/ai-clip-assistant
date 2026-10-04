import { Play } from 'lucide-react';
import { cn } from '@/lib/utils';

/** 品牌标识：渐变圆角方块 + 播放三角（对照设计稿 VideoFlow logo），全站复用 */
export function BrandMark({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        'bg-brand flex items-center justify-center rounded-2xl shadow-lg shadow-primary/40',
        className,
      )}
    >
      <Play className="size-1/2 translate-x-[6%] fill-white text-white" />
    </span>
  );
}

/** 品牌文字组合：主名 + 副标题 */
export function BrandWordmark({ className }: { className?: string }) {
  return (
    <span className={cn('leading-tight', className)}>
      <span className="block text-[15px] font-semibold">智剪 AI · VideoFlow</span>
      <span className="block text-[11px] text-muted-foreground">AI 视频创作提效平台</span>
    </span>
  );
}
