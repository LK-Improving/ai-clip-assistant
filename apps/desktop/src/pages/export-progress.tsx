import { useEffect, useRef, useState } from 'react';
import { Check, FolderOpen, Loader2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ProgressRing } from '@/components/ui/misc';
import { clearPendingExport, getPendingExport } from '@/lib/export-request';
import type { RenderProgress } from '../main/services/render';

type Status = 'running' | 'done' | 'cancelled' | 'error' | 'nobridge' | 'empty';

const STAGES = ['准备渲染', '视频合成', '字幕烧录', '封装输出'];

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
    // 仅在挂载时启动一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const cancel = () => {
    if (status !== 'running') return;
    window.electronAPI?.render?.cancel();
  };

  const openFolder = () => {
    if (pending) window.electronAPI?.shell?.openPath(pending.dir);
  };

  const stageState = (index: number): 'done' | 'running' | 'todo' => {
    if (status === 'done') return 'done';
    const activeIndex =
      phase === 'preparing' ? 0 : phase === 'rendering' ? 1 + (warnings.length ? 1 : 0) : 3;
    if (index < activeIndex) return 'done';
    if (index === activeIndex && status === 'running') return 'running';
    return 'todo';
  };

  const ringValue = status === 'done' ? 100 : Math.round(percent);

  return (
    <div className="flex items-start justify-center p-8">
      <div className="w-full max-w-md rounded-2xl border bg-card/70 p-8 shadow-xl shadow-primary/5">
        <div className="flex flex-col items-center">
          <ProgressRing value={ringValue} size={148} strokeWidth={12}>
            <span className="text-3xl font-bold">{ringValue}%</span>
          </ProgressRing>
          <h1 className="mt-5 text-base font-semibold">
            {status === 'done' ? '渲染完成' : status === 'cancelled' ? '已取消' : status === 'error' ? '导出失败' : '正在渲染视频'}
          </h1>
          {(status === 'running' || status === 'done') && (
            <p className="mt-1 font-mono text-xs text-muted-foreground">
              {fps > 0 ? `${fps.toFixed(0)} fps` : ''} {speed > 0 ? `· ${speed.toFixed(1)}x` : ''}
            </p>
          )}
          {message && (
            <p className="mt-2 max-w-full break-all text-center text-xs text-muted-foreground">{message}</p>
          )}
        </div>

        {status === 'empty' && (
          <p className="mt-6 text-center text-sm text-muted-foreground">没有待导出的工程，请先在编辑器中发起导出。</p>
        )}
        {status === 'nobridge' && (
          <p className="mt-6 text-center text-sm text-amber-300">当前为浏览器预览模式，导出需在桌面端运行。</p>
        )}

        {pending && status !== 'empty' && status !== 'nobridge' && (
          <ul className="mt-7 space-y-3 rounded-xl border bg-background/60 p-4">
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
                  {s === 'running' ? (
                    <span className="ml-auto text-xs text-primary">进行中</span>
                  ) : s === 'done' ? (
                    <span className="ml-auto text-xs text-emerald-400">完成</span>
                  ) : (
                    <span className="ml-auto text-xs text-muted-foreground">等待</span>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {warnings.length > 0 && (
          <div className="mt-4 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-[11px] text-amber-300">
            {warnings.map((w, i) => (
              <div key={i}>· {w}</div>
            ))}
          </div>
        )}

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
            <Button className="gap-2 rounded-full" onClick={openFolder}>
              <FolderOpen className="size-4" /> 打开所在文件夹
            </Button>
          )}
          {status === 'done' && (
            <Button variant="ghost" className="rounded-full" onClick={() => clearPendingExport()}>
              完成
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
