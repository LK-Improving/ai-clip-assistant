import { useEffect, useState } from 'react';
import { Download, Folder, MonitorPlay, ShieldAlert, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PageHeader } from '@/components/layout/page-header';
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

/** 08 视频生成与导出（设置）：成片预览 + 导出参数（对照设计稿） */
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
    setPendingExport({ project, outputPath, dir, fileName: safeName, quality });
    window.location.hash = '#/exporting';
  };

  const meta: { label: string; value: string }[] = [
    { label: '时长', value: formatTimecodeMs(durationMs) },
    { label: '轨道 / 片段', value: `${project.tracks.length} 条 · ${clipCount} 个` },
    { label: '分辨率', value: `${project.canvas.width} × ${project.canvas.height}` },
    { label: '帧率', value: `${project.canvas.fps} fps` },
  ];

  return (
    <div className="mx-auto max-w-6xl p-6">
      <PageHeader
        title="视频生成与导出"
        subtitle="AI 已完成视频生成，确认导出参数后即可输出成片"
      />

      {!hasBridge && (
        <div className="mt-4 flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-300">
          <ShieldAlert className="size-4 shrink-0" />
          当前为浏览器预览模式，导出需在桌面端运行。下方表单可正常填写，但点击导出会提示不可用。
        </div>
      )}

      <div className="mt-5 grid items-start gap-5 lg:grid-cols-[1fr_380px]">
        {/* 成片预览 */}
        <section className="rounded-2xl border bg-card/60 p-4">
          <div className="relative aspect-video overflow-hidden rounded-xl border">
            <ThumbPlaceholder hue={330} className="h-full w-full rounded-none" />
            <span className="bg-brand absolute left-1/2 top-1/2 flex size-14 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full text-white shadow-xl shadow-primary/40">
              <MonitorPlay className="size-6" />
            </span>
            <p className="absolute inset-x-0 bottom-4 text-center text-lg font-semibold text-white drop-shadow">
              {project.name || '未命名工程'}
            </p>
          </div>
          <div className="mt-4 grid grid-cols-4 gap-3">
            {meta.map((m) => (
              <div key={m.label} className="rounded-lg border bg-background/60 px-3 py-2.5">
                <p className="text-[11px] text-muted-foreground">{m.label}</p>
                <p className="mt-0.5 truncate font-mono text-sm text-foreground">{m.value}</p>
              </div>
            ))}
          </div>
        </section>

        {/* 导出设置 */}
        <section className="rounded-2xl border bg-card/60 p-5">
          <p className="flex items-center gap-2 text-sm font-semibold">
            <Sparkles className="size-4 text-primary" /> 导出设置
          </p>

          <div className="mt-4 space-y-4">
            <label className="block space-y-1.5">
              <span className="text-xs text-muted-foreground">文件名称</span>
              <Input value={fileName} onChange={(e) => setFileName(e.target.value)} className="bg-card/60" />
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
                <Button variant="ghost" size="sm" className="h-9 shrink-0 text-xs text-muted-foreground" onClick={pickDir}>
                  浏览
                </Button>
              </div>
              {dirStatus && <p className="text-[11px] text-emerald-400">{dirStatus}</p>}
            </label>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <span className="text-xs text-muted-foreground">导出格式</span>
                <div className="flex h-9 items-center rounded-md border border-input bg-card/40 px-3 text-xs">MP4（H.264）</div>
              </div>
              <div className="space-y-1.5">
                <span className="text-xs text-muted-foreground">分辨率</span>
                <div className="flex h-9 items-center rounded-md border border-input bg-card/40 px-3 text-xs">
                  {project.canvas.width} × {project.canvas.height}
                </div>
              </div>
            </div>

            <div className="space-y-1.5">
              <span className="text-xs text-muted-foreground">画质 / 码率</span>
              <div className="grid grid-cols-3 gap-2">
                {QUALITY_OPTIONS.map((value) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => setQuality(value)}
                    className={`rounded-lg border p-2.5 text-left text-xs transition ${
                      quality === value
                        ? 'border-primary bg-primary/10 text-foreground'
                        : 'border-input bg-card/40 text-muted-foreground hover:border-primary/40'
                    }`}
                  >
                    <div className="font-semibold">{QUALITY_LABELS[value]}</div>
                    <div className="mt-0.5 text-[10px] opacity-70">{QUALITY_BITRATE[value]}</div>
                  </button>
                ))}
              </div>
            </div>

            <div className="flex items-center gap-2 rounded-lg border border-primary/30 bg-primary/5 p-3 text-[11px] text-muted-foreground">
              <MonitorPlay className="size-4 shrink-0 text-primary" />
              导出完成后将自动打开所在文件夹，可直接发布到社交平台。
            </div>

            <Button className="bg-brand h-12 w-full gap-2 rounded-xl text-base font-semibold shadow-lg shadow-primary/30 hover:opacity-95" disabled={!dir} onClick={start}>
              <Download className="size-4" /> 开始导出
            </Button>
          </div>
        </section>
      </div>
    </div>
  );
}
