import type * as React from 'react';
import { cn } from '@/lib/utils';

interface ProgressRingProps {
  /** 0 ~ 100 */
  value: number;
  size?: number;
  strokeWidth?: number;
  className?: string;
  children?: React.ReactNode;
}

function ProgressRing({ value, size = 128, strokeWidth = 10, className, children }: ProgressRingProps) {
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const clamped = Math.min(100, Math.max(0, value));
  const offset = circumference * (1 - clamped / 100);

  return (
    <div className={cn('relative inline-flex items-center justify-center', className)}>
      <svg width={size} height={size} className="-rotate-90">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          strokeWidth={strokeWidth}
          className="stroke-secondary"
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          stroke="url(#progress-ring-gradient)"
        />
        <defs>
          <linearGradient id="progress-ring-gradient" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#7c3aed" />
            <stop offset="100%" stopColor="#c084fc" />
          </linearGradient>
        </defs>
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">{children}</div>
    </div>
  );
}

function Switch({ checked, className }: { checked?: boolean; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex h-5 w-9 items-center rounded-full p-0.5 transition-colors',
        checked ? 'bg-brand justify-end' : 'bg-secondary justify-start',
        className,
      )}
    >
      <span className="size-4 rounded-full bg-white shadow" />
    </span>
  );
}

function Badge({
  children,
  tone = 'default',
  className,
}: {
  children: React.ReactNode;
  tone?: 'default' | 'brand' | 'success';
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium',
        tone === 'brand' && 'bg-primary/20 text-primary',
        tone === 'success' && 'bg-emerald-500/15 text-emerald-400',
        tone === 'default' && 'bg-secondary text-secondary-foreground',
        className,
      )}
    >
      {children}
    </span>
  );
}

/** 素材/项目缩略图占位：按色相生成渐变，后续替换为真实关键帧 */
function ThumbPlaceholder({
  hue,
  label,
  className,
}: {
  hue: number;
  label?: string;
  className?: string;
}) {
  return (
    <div
      className={cn('flex items-end overflow-hidden rounded-md', className)}
      style={{
        backgroundImage: `linear-gradient(150deg, hsl(${hue} 70% 32% / 0.9), hsl(${(hue + 40) % 360} 65% 18% / 0.95))`,
      }}
    >
      {label ? <span className="p-1.5 text-[10px] text-white/80">{label}</span> : null}
    </div>
  );
}

export { Badge, ProgressRing, Switch, ThumbPlaceholder };
