import { useEffect, useState } from 'react';
import { Download, Folder, MonitorPlay, ShieldAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ThumbPlaceholder } from '@/components/ui/misc';
import { formatTimecodeMs } from '@/lib/timeline-utils';
import { getActiveProject } from '@/lib/active-project';
import {
  type ExportQuality,
  QUALITY_BITRATE,
  QUALITY_LABELS,
  setPendingExport,
} from '@/lib/export-request';
import { projectDurationMs } from '@miaoma/video-project';

const QUALITY_OPTIONS: ExportQuality[] = ['standard', 'high', 'super'];

export default function ExportSettingsPage() {
  const project = getActiveProject();
  const durationMs = projectDurationMs(project);
  const clipCount = project.tracks.reduce((n, t) => n + t.clips.length, 0);
  const hasBridge = typeof window !== 'undefined' && Boolean(window.electronAPI);

  const [fileName, setFileName] = useState(project.name || '未命名工程');
  const [dir, setDir] = useState('');
  const [quality, setQuality] = useState<ExportQuality>('high');
  const [dirStatus, setDirStatus] = useState<string>('');

  useEffect(() => {
    if (!hasBridge) return;
    window.electronAPI?.export
      ?.defaultDir()
      .then((d) => {
        if (d) {
          setDir(d);
          setDirStatus('默认导出目录');
        }
      })
      .catch(() => undefined);
  }, [hasBridge]);

  const pickDir = async () => {
    const d = await window.electronAPI?.export?.pickDir();
    if (d) {
      setDir(d);
      setDirStatus('已选择');
    }
  };

  const start = () => {
    if (!dir) return;
    const safeName = (fileName.trim() || '未命名工程').replace(/[\\/:*?"<>|]/g, '_');
    const outputPath = `${dir.replace(/[/\\]$/, '')}/${safeName}.mp4`;
    setPendingExport({
      project,
      outputPath,
      dir,
      fileName: safeName,
      quality,
    });
    window.location.hash = '#/exporting';
  };

  return (
    <div className="flex items-start justify-center p-8">
      <div className="w-full max-w-3xl rounded-2xl border bg-card/70 p-6 shadow-xl shadow-primary/5">
        <h1 className="text-lg font-bold">导出设置</h1>

        {!hasBridge && (
          <div className="mt-4 flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-300">
            <ShieldAlert className="size-4 shrink-0" />
            当前为浏览器预览模式，导出需在桌面端运行。下方表单可正常填写，但点击导出会提示不可用。
          </div>
        )}

        <div className="mt-5 grid grid-cols-[280px_1fr] gap-6">
          <div className="space-y-3">
            <div className="relative aspect-video overflow-hidden rounded-lg border">
              <ThumbPlaceholder hue={330} className="h-full w-full rounded-none" />
              <p className="absolute inset-x-0 bottom-4 text-center text-sm font-semibold text-white drop-shadow">
                {project.name || '未命名工程'}
              </p>
            </div>
            <div className="rounded-lg border bg-background/60 p-3 text-xs text-muted-foreground">
              <div className="flex justify-between py-0.5">
                <span>时长</span>
                <span className="font-mono text-foreground">{formatTimecodeMs(durationMs)}</span>
              </div>
              <div className="flex justify-between py-0.5">
                <span>轨道</span>
                <span className="text-foreground">
                  {project.tracks.length} 条 · {clipCount} 个片段
                </span>
              </div>
              <div className="flex justify-between py-0.5">
                <span>画布</span>
                <span className="text-foreground">
                  {project.canvas.width}×{project.canvas.height}@{project.canvas.fps}fps
                </span>
              </div>
            </div>
          </div>

          <div className="space-y-4">
            <label className="block space-y-1.5">
              <span className="text-xs text-muted-foreground">文件名称</span>
              <Input
                value={fileName}
                onChange={(e) => setFileName(e.target.value)}
                className="bg-card/60"
              />
            </label>

            <label className="block space-y-1.5">
              <span className="text-xs text-muted-foreground">存储路径</span>
              <div className="flex items-center gap-2">
                <div className="relative flex-1">
                  <Folder className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    readOnly
                    value={dir}
                    placeholder={hasBridge ? '点击右侧按钮选择目录' : '桌面端导出目录（预览模式不可选）'}
                    className="bg-card/60 pl-8 text-xs"
                  />
                </div>
                <Button variant="ghost" size="sm" className="h-9 text-xs text-muted-foreground" onClick={pickDir}>
                  浏览
                </Button>
              </div>
              {dirStatus && <p className="text-[11px] text-emerald-400">{dirStatus}</p>}
            </label>

            <div className="grid grid-cols-3 gap-3">
              {QUALITY_OPTIONS.map((value) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setQuality(value)}
                  className={`rounded-lg border p-3 text-left text-xs transition ${
                    quality === value
                      ? 'border-primary bg-primary/10 text-foreground'
                      : 'border-input bg-card/40 text-muted-foreground hover:border-primary/40'
                  }`}
                >
                  <div className="font-semibold">{QUALITY_LABELS[value]}</div>
                  <div className="mt-1 text-[11px] opacity-70">码率 {QUALITY_BITRATE[value]}</div>
                </button>
              ))}
            </div>

            <div className="flex items-center gap-2 rounded-lg border border-primary/30 bg-primary/5 p-3 text-xs text-muted-foreground">
              <MonitorPlay className="size-4 shrink-0 text-primary" />
              导出完成后将自动打开所在文件夹，可直接发布到社交平台。
            </div>

            <div className="flex justify-end pt-1">
              <Button
                className="gap-2 rounded-full px-8"
                disabled={!dir}
                onClick={start}
              >
                <Download className="size-4" /> 开始导出
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
