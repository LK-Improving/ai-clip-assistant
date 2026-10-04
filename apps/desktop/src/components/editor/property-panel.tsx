import { Image, Mic, Music2, Sparkles, Subtitles, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { LibraryAsset } from './asset-panel';
import { cn } from '@/lib/utils';
import { Badge, Switch } from '@/components/ui/misc';
import { formatTimecodeMs, taskForTrack, type SubtitleStyle, type TimelineClip, type TimelineTrack } from '@/lib/timeline-utils';

const tasks = [
  { key: 'video', label: '画面', icon: Image },
  { key: 'voice', label: '口播', icon: Mic },
  { key: 'text', label: '字幕', icon: Subtitles },
  { key: 'music', label: '音乐', icon: Music2 },
] as const;
type EditorTask = (typeof tasks)[number]['key'];

interface PropertyPanelProps {
  clip: TimelineClip | null;
  trackKind: 'video' | 'audio' | 'text' | null;
  tracks: TimelineTrack[];
  selectedTrackId: string | null;
  onSelectClip: (trackId: string, clipId: string) => void;
  musicAssets: LibraryAsset[];
  onAddMusic: (asset: LibraryAsset) => void;
  onImportMusic: () => void;
  onClipChange: (patch: Partial<TimelineClip>) => void;
  onDeleteClip: () => void;
  /** AI 配音（模块 3.3） */
  ttsText: string;
  onTtsTextChange: (text: string) => void;
  onSynthesize: () => void;
  ttsBusy: boolean;
  ttsMessage: string | null;
}

/** 与 core DEFAULT_TEXT_STYLE 对齐的兜底样式（新建字幕片段可能没有样式） */
const FALLBACK_TEXT_STYLE: SubtitleStyle = {
  fontFamily: 'Microsoft YaHei',
  fontSize: 48,
  fontWeight: 'normal',
  color: '#ffffff',
  backgroundColor: 'transparent',
  strokeColor: 'transparent',
  strokeWidth: 0,
  align: 'center',
  x: 0.5,
  y: 0.9,
};

/** 真实受控滑块：写入片段字段并经 onClipChange → bridge → 工程/渲染生效 */
function LiveSlider({
  label,
  min,
  max,
  step,
  value,
  display,
  onChange,
}: {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  display: string;
  onChange: (v: number) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-12 shrink-0 text-[11px] text-muted-foreground">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        aria-label={label}
        className="flex-1 accent-primary"
      />
      <span className="w-12 shrink-0 text-right font-mono text-[10px]">{display}</span>
    </div>
  );
}

const fieldLabel = 'mb-2 text-[11px] font-medium text-muted-foreground';

/** 右侧属性面板（模块 3.2 + 3.3）：片段属性、字幕编辑、变换、AI 配音 */
export function PropertyPanel({
  clip: selectedClip,
  trackKind,
  tracks,
  selectedTrackId,
  onSelectClip,
  musicAssets,
  onAddMusic,
  onImportMusic,
  onClipChange,
  onDeleteClip,
  ttsText,
  onTtsTextChange,
  onSynthesize,
  ttsBusy,
  ttsMessage,
}: PropertyPanelProps) {
  const selectedTrack = tracks.find((track) => track.id === selectedTrackId);
  const inferredTask = selectedTrack ? taskForTrack(selectedTrack) : 'video';
  const selectionKey = `${selectedTrackId ?? ''}:${selectedClip?.id ?? ''}`;
  const [choice, setChoice] = useState<{ selectionKey: string; task: EditorTask } | null>(null);
  const task = choice?.selectionKey === selectionKey ? choice.task : inferredTask;
  const clip = task === inferredTask ? selectedClip : null;
  const taskTracks = tracks.filter((track) => taskForTrack(track) === task);
  const taskLabel = tasks.find((item) => item.key === task)!.label;
  const isText = trackKind === 'text';
  const style: SubtitleStyle = clip?.textStyle ?? FALLBACK_TEXT_STYLE;
  const patchStyle = (patch: Partial<SubtitleStyle>) => {
    if (!clip) return;
    onClipChange({ textStyle: { ...style, ...patch } });
  };

  return (
    <aside aria-label="编辑任务设置" className="flex w-72 shrink-0 flex-col border-l">
      <div role="tablist" aria-label="编辑任务" className="grid grid-cols-4 border-b">
        {tasks.map(({ key, label, icon: Icon }) => (
          <button key={key} id={`task-${key}`} role="tab" aria-selected={task === key}
            aria-controls="editor-task-panel" tabIndex={task === key ? 0 : -1}
            onClick={() => setChoice({ selectionKey, task: key })}
            onKeyDown={(event) => {
              const index = tasks.findIndex((item) => item.key === key);
              const next = event.key === 'ArrowRight' ? (index + 1) % tasks.length
                : event.key === 'ArrowLeft' ? (index + tasks.length - 1) % tasks.length
                  : event.key === 'Home' ? 0 : event.key === 'End' ? tasks.length - 1 : null;
              if (next === null) return;
              event.preventDefault();
              const nextTask = tasks[next]!;
              setChoice({ selectionKey, task: nextTask.key });
              document.getElementById(`task-${nextTask.key}`)?.focus();
            }}
            className={cn('flex flex-col items-center gap-1 border-b-2 py-3 text-xs transition-colors',
              task === key ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground')}>
            <Icon className="size-4" />{label}
          </button>
        ))}
      </div>
      <div className="flex items-center justify-between border-b p-3">
        <h2 className="truncate text-xs font-semibold">{clip ? `${taskLabel} · ${clip.name}` : `${taskLabel}设置`}</h2>
        {clip ? (
          <Badge tone="brand">{trackKind === 'audio' ? '音频' : trackKind === 'text' ? '字幕' : '视频'}</Badge>
        ) : null}
      </div>

      <div id="editor-task-panel" role="tabpanel" aria-labelledby={`task-${task}`} className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3">
        {taskTracks.some((track) => track.clips.length > 0) ? (
          <label className="block space-y-2 text-xs">
            <span className="text-muted-foreground">选择{taskLabel}片段</span>
            <select aria-label={`选择${taskLabel}片段`} value={clip ? JSON.stringify([selectedTrackId, clip.id]) : ''}
              onChange={(event) => {
                if (!event.target.value) return;
                const [trackId, clipId] = JSON.parse(event.target.value) as [string, string];
                onSelectClip(trackId, clipId);
              }} className="h-9 w-full rounded-md border border-input bg-card px-2">
              <option value="">请选择片段</option>
              {taskTracks.flatMap((track) => track.clips.map((item) => (
                <option key={item.id} value={JSON.stringify([track.id, item.id])}>{track.name} · {item.name}</option>
              )))}
            </select>
          </label>
        ) : null}
        {!clip ? (
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            {task === 'video' ? '选择画面片段，调整时长、变换和原声音量。'
              : task === 'voice' ? '选择口播片段调整音量，或输入文案生成配音。'
                : task === 'text' ? '选择字幕片段，编辑文字、样式与位置。'
                  : '选择音乐片段调整音量和淡入淡出，或从素材库添加配乐。'}
          </p>
        ) : (
          <>
            <details className="rounded-lg border p-2.5">
              <summary className="cursor-pointer text-xs font-medium text-muted-foreground">时间与裁剪</summary>
              <div className="mt-3 space-y-1.5 text-[11px]">
                <label className="flex items-center justify-between gap-2">
                  <span className="text-muted-foreground">入点（秒）</span>
                  <input
                    type="number"
                    min={0}
                    step={0.1}
                    value={(clip.start / 1000).toFixed(2)}
                    onChange={(event) =>
                      onClipChange({ start: Math.max(0, Number(event.target.value) * 1000) })
                    }
                    className="h-6 w-16 rounded border border-input bg-card/60 px-1 text-right font-mono text-[10px]"
                  />
                </label>
                <label className="flex items-center justify-between gap-2">
                  <span className="text-muted-foreground">时长（秒）</span>
                  <input
                    type="number"
                    min={0.1}
                    step={0.1}
                    value={(clip.duration / 1000).toFixed(2)}
                    onChange={(event) =>
                      onClipChange({ duration: Math.max(100, Number(event.target.value) * 1000) })
                    }
                    className="h-6 w-16 rounded border border-input bg-card/60 px-1 text-right font-mono text-[10px]"
                  />
                </label>
                <div className="flex justify-between pt-1 text-muted-foreground">
                  <span>出点</span>
                  <span className="font-mono">{formatTimecodeMs(clip.start + clip.duration)}</span>
                </div>
                {!isText ? (
                  <label className="flex items-center justify-between gap-2 pt-0.5">
                    <span className="text-muted-foreground">裁剪起点（秒）</span>
                    <input
                      type="number"
                      min={0}
                      step={0.1}
                      value={(clip.offset / 1000).toFixed(1)}
                      onChange={(event) =>
                        onClipChange({ offset: Math.max(0, Number(event.target.value) * 1000) })
                      }
                      className="h-6 w-16 rounded border border-input bg-card/60 px-1 text-right font-mono text-[10px]"
                    />
                  </label>
                ) : null}
              </div>
            </details>

            {isText ? (
              <div className="space-y-2.5">
                <p className={fieldLabel}>字幕内容</p>
                <textarea
                  value={clip.content ?? clip.name}
                  onChange={(event) =>
                    onClipChange({ content: event.target.value, name: event.target.value })
                  }
                  rows={3}
                  placeholder="输入字幕文字"
                  className="w-full resize-none rounded border border-input bg-card/60 px-2 py-1.5 text-[11px] leading-relaxed outline-none placeholder:text-muted-foreground focus:border-ring"
                />

                <div className="flex items-center gap-2">
                  <span className="w-14 shrink-0 text-[11px] text-muted-foreground">字号</span>
                  <input
                    type="range"
                    min={12}
                    max={140}
                    step={1}
                    value={style.fontSize}
                    onChange={(event) => patchStyle({ fontSize: Number(event.target.value) })}
                    className="flex-1 accent-[hsl(var(--brand))]"
                  />
                  <span className="w-8 text-right font-mono text-[10px]">{style.fontSize}</span>
                </div>

                <div className="flex items-center gap-2">
                  <span className="w-14 shrink-0 text-[11px] text-muted-foreground">颜色</span>
                  <input
                    type="color"
                    value={style.color === 'transparent' ? '#ffffff' : style.color}
                    onChange={(event) => patchStyle({ color: event.target.value })}
                    className="h-6 w-10 rounded border border-input bg-card/60"
                  />
                  <span className="w-12 shrink-0 text-[11px] text-muted-foreground">描边</span>
                  <input
                    type="color"
                    value={style.strokeColor === 'transparent' ? '#000000' : style.strokeColor}
                    onChange={(event) =>
                      patchStyle({
                        strokeColor: event.target.value,
                        strokeWidth: style.strokeWidth > 0 ? style.strokeWidth : 2,
                      })
                    }
                    className="h-6 w-10 rounded border border-input bg-card/60"
                  />
                  <input
                    type="number"
                    min={0}
                    max={12}
                    step={1}
                    value={style.strokeWidth}
                    onChange={(event) => patchStyle({ strokeWidth: Number(event.target.value) })}
                    className="h-6 w-12 rounded border border-input bg-card/60 px-1 text-right font-mono text-[10px]"
                  />
                </div>

                <div className="flex items-center gap-3">
                  <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                    <input
                      type="checkbox"
                      checked={style.fontWeight === 'bold'}
                      onChange={(event) =>
                        patchStyle({ fontWeight: event.target.checked ? 'bold' : 'normal' })
                      }
                    />
                    加粗
                  </label>
                  <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                    <input
                      type="checkbox"
                      checked={style.backgroundColor !== 'transparent'}
                      onChange={(event) =>
                        patchStyle({ backgroundColor: event.target.checked ? '#000000' : 'transparent' })
                      }
                    />
                    背景底
                  </label>
                  <select
                    value={style.align}
                    onChange={(event) => patchStyle({ align: event.target.value as SubtitleStyle['align'] })}
                    className="ml-auto h-6 rounded border border-input bg-card/60 px-1 text-[10px]"
                  >
                    <option value="left">左对齐</option>
                    <option value="center">居中</option>
                    <option value="right">右对齐</option>
                  </select>
                </div>

                <div className="flex items-center gap-2">
                  <span className="w-14 shrink-0 text-[11px] text-muted-foreground">垂直位</span>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.01}
                    value={style.y}
                    onChange={(event) => patchStyle({ y: Number(event.target.value) })}
                    className="flex-1 accent-[hsl(var(--brand))]"
                  />
                  <span className="w-8 text-right font-mono text-[10px]">{style.y.toFixed(2)}</span>
                </div>
              </div>
            ) : null}

            {!isText ? (
              <>
                <details className="rounded-lg border p-2.5">
                  <summary className="cursor-pointer text-xs font-medium text-muted-foreground">{task === 'video' ? '转场' : '淡入淡出'}</summary>
                  <div className="mt-3 space-y-1.5 text-[11px]">
                    <label className="flex items-center justify-between gap-2">
                      <span className="text-muted-foreground">淡入（秒）</span>
                      <input
                        type="number"
                        min={0}
                        max={10}
                        step={0.1}
                        value={((clip.fadeInMs ?? 0) / 1000).toFixed(1)}
                        onChange={(event) =>
                          onClipChange({ fadeInMs: Math.max(0, Number(event.target.value) * 1000) })
                        }
                        className="h-6 w-16 rounded border border-input bg-card/60 px-1 text-right font-mono text-[10px]"
                      />
                    </label>
                    <label className="flex items-center justify-between gap-2">
                      <span className="text-muted-foreground">淡出（秒）</span>
                      <input
                        type="number"
                        min={0}
                        max={10}
                        step={0.1}
                        value={((clip.fadeOutMs ?? 0) / 1000).toFixed(1)}
                        onChange={(event) =>
                          onClipChange({ fadeOutMs: Math.max(0, Number(event.target.value) * 1000) })
                        }
                        className="h-6 w-16 rounded border border-input bg-card/60 px-1 text-right font-mono text-[10px]"
                      />
                    </label>
                    <p className="text-[10px] leading-relaxed text-muted-foreground">
                      {task === 'video' ? '淡入淡出将在导出时应用到画面。' : '淡入淡出将在导出时应用到音频。'}
                    </p>
                  </div>
                </details>

                {trackKind === 'video' ? (
                  <div>
                    <p className={fieldLabel}>变换</p>
                    <div className="space-y-2">
                      <LiveSlider
                        label="缩放"
                        min={0.1}
                        max={3}
                        step={0.05}
                        value={clip.scale ?? 1}
                        display={`${Math.round((clip.scale ?? 1) * 100)}%`}
                        onChange={(v) => onClipChange({ scale: v })}
                      />
                      <LiveSlider
                        label="旋转"
                        min={-180}
                        max={180}
                        step={1}
                        value={clip.rotation ?? 0}
                        display={`${clip.rotation ?? 0}°`}
                        onChange={(v) => onClipChange({ rotation: v })}
                      />
                      <LiveSlider
                        label="不透明"
                        min={0}
                        max={1}
                        step={0.05}
                        value={clip.opacity ?? 1}
                        display={`${Math.round((clip.opacity ?? 1) * 100)}%`}
                        onChange={(v) => onClipChange({ opacity: v })}
                      />
                    </div>
                  </div>
                ) : null}

                <div>
                  <p className={fieldLabel}>音频</p>
                  <LiveSlider
                    label="音量"
                    min={0}
                    max={2}
                    step={0.05}
                    value={clip.volume ?? 1}
                    display={`${Math.round((clip.volume ?? 1) * 100)}%`}
                    onChange={(v) => onClipChange({ volume: v })}
                  />
                  <div className="mt-2 flex items-center justify-between rounded-lg border p-2.5">
                    <span className="text-[11px]">静音</span>
                    <button
                      type="button"
                      onClick={() => onClipChange({ muted: !(clip.muted ?? false) })}
                      aria-pressed={clip.muted ?? false}
                      title={clip.muted ? '取消静音' : '静音该片段'}
                    >
                      <Switch checked={clip.muted ?? false} />
                    </button>
                  </div>
                </div>
              </>
            ) : null}

            <button
              onClick={onDeleteClip}
              className="flex w-full items-center justify-center gap-1.5 rounded-md border border-input py-1.5 text-[11px] text-muted-foreground hover:border-destructive/50 hover:text-destructive"
            >
              <Trash2 className="size-3.5" /> 删除片段（Delete）
            </button>
          </>
        )}

        {/* AI 配音 */}
        {task === 'voice' ? <div className="space-y-2 rounded-lg border border-primary/30 bg-primary/5 p-3">
          <div className="flex items-center gap-1.5 text-[11px] font-medium text-primary">
            <Sparkles className="size-3.5" /> AI 配音
          </div>
          <textarea
            value={ttsText}
            onChange={(event) => onTtsTextChange(event.target.value)}
            rows={3}
            placeholder="输入要配音的文案，生成后自动加入音频轨"
            className="w-full resize-none rounded border border-input bg-card/60 px-2 py-1.5 text-[11px] outline-none placeholder:text-muted-foreground focus:border-ring"
          />
          <button
            onClick={onSynthesize}
            disabled={ttsBusy || !ttsText.trim()}
            className="bg-brand w-full rounded-md py-1.5 text-[11px] font-medium text-white disabled:opacity-50"
          >
            {ttsBusy ? '合成中...' : '生成语音'}
          </button>
          {ttsMessage ? (
            <p role="status" className="text-[11px] leading-relaxed text-muted-foreground">{ttsMessage}</p>
          ) : null}
        </div> : null}
        {task === 'music' ? (
          <section className="space-y-3">
            <div className="flex items-center justify-between text-xs">
              <h3 className="font-medium">素材库配乐</h3>
              <button onClick={onImportMusic} className="text-primary hover:underline">导入音频</button>
            </div>
            {musicAssets.length ? musicAssets.map((asset) => (
              <button key={asset.path} onClick={() => onAddMusic(asset)}
                className="flex w-full items-center gap-2 rounded-lg border p-2 text-left text-xs hover:border-primary/50">
                <Music2 className="size-4 shrink-0 text-primary" />
                <span className="min-w-0 flex-1 truncate">{asset.name}</span><span className="text-primary">添加</span>
              </button>
            )) : <p className="text-xs leading-relaxed text-muted-foreground">还没有音频素材。导入后可添加到音乐轨。</p>}
          </section>
        ) : null}
      </div>
    </aside>
  );
}
