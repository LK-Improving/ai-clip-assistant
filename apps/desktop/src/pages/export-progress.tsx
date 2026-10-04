import { useEffect, useRef, useState } from 'react';
import { Check, FolderOpen, Loader2, Play, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { clearPendingExport, getPendingExport } from '@/lib/export-request';
import type { RenderProgress } from '../main/services/render';
import { cn } from '@/lib/utils';

type Status = 'running' | 'done' | 'cancelled' | 'error' | 'nobridge' | 'empty';

const STAGES = ['准备渲染', '视频合成', '字幕烧录', '封装输出'];

/** 09 正在导出视频（对照设计稿）：横向进度 + 阶段清单，覆盖成功/失败/取消/离线/空态出口 */
export default function ExportProgressPage() {
  const pending = getPendingExport();
  const [status, setStatus] = useState<Status>('running');
  const [percent, setPercent] = useState(0);
  const [phase, setPhase] = useState<RenderProgress['phase']>('preparing');
  const [fps, setFps] = useState(0);
  const [speed, setSpeed] = useState(0);
  const [message, setMessage] = useState('');
  const [warnings, setWarnings] = useState<string[]>([]);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    if (!pending) {
      setStatus('empty');
      return;
    }
    const api = window.electronAPI;
    if (!api?.render) {
      setStatus('nobridge');
      return;
    }
    started.current = true;
    const unsub = api.render.onProgress((p) => {
      setPercent(p.percent);
      setPhase(p.phase);
      setFps(p.fps);
      setSpeed(p.speed);
    });
    api.render
      .start({
        project: pending.project,
        outputPath: pending.outputPath,
        encoder: pending.encoder,
        quality: pending.quality,
      })
      .then((res) => {
        setPercent(100);
        setPhase('finalizing');
        setWarnings(res.warnings ?? []);
        setMessage(`已导出：${res.outputPath}`);
        setStatus('done');
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('RENDER_CANCELLED')) {
          setStatus('cancelled');
          setMessage('导出已取消');
        } else {
          setStatus('error');
          setMessage(msg);
        }
      })
      .finally(() => unsub());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const cancel = () => {
    if (status !== 'running') return;
    window.electronAPI?.render?.cancel();
  };

  const openFolder = () => {
    if (pending) window.electronAPI?.shell?.openPath(pending.dir);
  };

  /** 离开进度页：同时清掉待导出请求并导航，避免停在 done 态不跳转 */
  const backToEditor = () => {
    clearPendingExport();
    window.location.hash = '#/editor';
  };

  const retryExport = () => {
    window.location.hash = '#/export';
  };

  const stageState = (index: number): 'done' | 'running' | 'todo' => {
    if (status === 'done') return 'done';
    const activeIndex = phase === 'preparing' ? 0 : phase === 'rendering' ? 1 + (warnings.length ? 1 : 0) : 3;
    if (index < activeIndex) return 'done';
    if (index === activeIndex && status === 'running') return 'running';
    return 'todo';
  };

  const value = status === 'done' ? 100 : Math.round(percent);
  const title =
    status === 'done' ? '导出完成' : status === 'cancelled' ? '已取消' : status === 'error' ? '导出失败' : '正在导出视频';

  return (
    <div className="flex items-start justify-center p-8">
      <div className="w-full max-w-lg rounded-2xl border bg-card/70 p-6 shadow-2xl shadow-primary/10">
        {/* 头部 */}
        <div className="flex items-start gap-4">
          <span className="bg-brand flex size-14 shrink-0 items-center justify-center rounded-2xl text-white shadow-lg shadow-primary/40">
            <Play className="size-6 fill-white" />
          </span>
          <div className="min-w-0 flex-1">
            <h1 className="text-base font-semibold">{title}</h1>
            <p className="mt-1 text-xs text-muted-foreground">
              {status === 'done'
                ? '成片已生成，可打开所在文件夹查看。'
                : status === 'error' || status === 'cancelled'
                  ? message || '导出未完成。'
                  : 'AI 已完成视频生成，正在导出成片… 请稍候，不要关闭页面'}
            </p>
          </div>
        </div>

        {/* 进度条 */}
        {pending && status !== 'empty' && status !== 'nobridge' && (
          <div className="mt-5">
            <div className="h-2 overflow-hidden rounded-full bg-secondary">
              <div
                className={cn('h-full rounded-full transition-all duration-300', status === 'error' || status === 'cancelled' ? 'bg-destructive' : 'bg-brand')}
                style={{ width: `${value}%` }}
              />
            </div>
            <div className="mt-1.5 flex items-center justify-between text-[11px] text-muted-foreground">
              <span className="font-mono">
                {fps > 0 ? `${fps.toFixed(0)} fps` : ''} {speed > 0 ? `· ${speed.toFixed(1)}x` : ''}
              </span>
              <span className="font-mono text-foreground">{value}%</span>
            </div>
          </div>
        )}

        {status === 'empty' && (
          <p className="mt-6 text-center text-sm text-muted-foreground">没有待导出的工程，请先在编辑器中发起导出。</p>
        )}
        {status === 'nobridge' && (
          <p className="mt-6 text-center text-sm text-amber-300">当前为浏览器预览模式，导出需在桌面端运行。</p>
        )}

        {/* 阶段清单 */}
        {pending && status !== 'empty' && status !== 'nobridge' && (
          <ul className="mt-5 space-y-3 rounded-xl border bg-background/60 p-4">
            {STAGES.map((label, i) => {
              const s = stageState(i);
              return (
                <li key={label} className="flex items-center gap-3 text-sm">
                  {s === 'done' ? (
                    <span className="flex size-5 items-center justify-center rounded-full bg-emerald-500/20">
                      <Check className="size-3 text-emerald-400" />
                    </span>
                  ) : s === 'running' ? (
                    <Loader2 className="size-5 animate-spin text-primary" />
                  ) : (
                    <span className="size-5 rounded-full border border-input" />
                  )}
                  <span className={s === 'todo' ? 'text-muted-foreground' : undefined}>{label}</span>
                  <span
                    className={cn(
                      'ml-auto text-xs',
                      s === 'done' ? 'text-emerald-400' : s === 'running' ? 'text-primary' : 'text-muted-foreground',
                    )}
                  >
                    {s === 'done' ? '完成' : s === 'running' ? '进行中' : '等待中'}
                  </span>
                </li>
              );
            })}
          </ul>
        )}

        {message && (status === 'done' || status === 'error') && (
          <p className="mt-3 max-w-full break-all text-center text-xs text-muted-foreground">{message}</p>
        )}

        {warnings.length > 0 && (
          <div className="mt-4 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-[11px] text-amber-300">
            {warnings.map((w, i) => (
              <div key={i}>· {w}</div>
            ))}
          </div>
        )}

        {/* 交互出口：每个状态都必须给出口 */}
        <div className="mt-6 flex justify-center gap-3">
          {status === 'running' && (
            <button
              onClick={cancel}
              className="flex items-center gap-1.5 rounded-full border border-input px-5 py-1.5 text-xs text-muted-foreground hover:border-destructive/50 hover:text-destructive"
            >
              <X className="size-3.5" /> 取消导出
            </button>
          )}
          {status === 'done' && (
            <Button className="bg-brand gap-2 rounded-full hover:opacity-95" onClick={openFolder}>
              <FolderOpen className="size-4" /> 打开所在文件夹
            </Button>
          )}
          {(status === 'error' || status === 'cancelled') && pending && (
            <Button className="rounded-full" onClick={retryExport}>
              重新导出
            </Button>
          )}
          {status === 'done' && (
            <Button variant="ghost" className="rounded-full" onClick={backToEditor}>
              完成
            </Button>
          )}
          {(status === 'error' || status === 'cancelled' || status === 'empty' || status === 'nobridge') && (
            <Button variant="ghost" className="rounded-full" onClick={backToEditor}>
              返回编辑器
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
