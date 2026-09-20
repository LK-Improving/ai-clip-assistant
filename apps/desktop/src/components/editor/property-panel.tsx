import { Sparkles, Trash2 } from 'lucide-react';
import { Badge, Switch } from '@/components/ui/misc';
import { formatTimecodeMs, type SubtitleStyle, type TimelineClip } from '@/lib/timeline-utils';

interface PropertyPanelProps {
  clip: TimelineClip | null;
  trackKind: 'video' | 'audio' | 'text' | null;
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

const sliderRow = (label: string, value: string, fill = 'w-2/3') => (
  <div className="flex items-center gap-2">
    <span className="w-8 shrink-0 text-[11px] text-muted-foreground">{label}</span>
    <div className="h-1 flex-1 rounded-full bg-secondary">
      <div className={`bg-brand h-1 rounded-full ${fill}`} />
    </div>
    <span className="w-12 shrink-0 text-right font-mono text-[10px]">{value}</span>
  </div>
);

const fieldLabel = 'mb-2 text-[11px] font-medium text-muted-foreground';

/** 右侧属性面板（模块 3.2 + 3.3）：片段属性、字幕编辑、变换、AI 配音 */
export function PropertyPanel({
  clip,
  trackKind,
  onClipChange,
  onDeleteClip,
  ttsText,
  onTtsTextChange,
  onSynthesize,
  ttsBusy,
  ttsMessage,
}: PropertyPanelProps) {
  const isText = trackKind === 'text';
  const style: SubtitleStyle = clip?.textStyle ?? FALLBACK_TEXT_STYLE;
  const patchStyle = (patch: Partial<SubtitleStyle>) => {
    if (!clip) return;
    onClipChange({ textStyle: { ...style, ...patch } });
  };

  return (
    <aside className="flex w-64 shrink-0 flex-col border-l">
      <div className="flex items-center justify-between border-b p-3">
        <h2 className="truncate text-xs font-semibold">{clip ? `属性 · ${clip.name}` : '属性'}</h2>
        {clip ? (
          <Badge tone="brand">{trackKind === 'audio' ? '音频' : trackKind === 'text' ? '字幕' : '视频'}</Badge>
        ) : null}
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto p-3">
        {!clip ? (
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            在时间线中选中片段后可调整入点、时长与音量；选中字幕可编辑文字与样式。
          </p>
        ) : (
          <>
            <div>
              <p className={fieldLabel}>时间信息</p>
              <div className="space-y-1.5 text-[11px]">
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
            </div>

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
                <div>
                  <p className={fieldLabel}>转场</p>
                  <div className="space-y-1.5 text-[11px]">
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
                      导出时生效：视频/图片写为 fade 转场，音频写为音量淡变。
                    </p>
                  </div>
                </div>

                <div>
                  <p className={fieldLabel}>变换</p>
                  <div className="space-y-2">
                    {sliderRow('缩放', '100%')}
                    {sliderRow('旋转', '0°', 'w-1/2')}
                    {sliderRow('不透明', '100%')}
                  </div>
                </div>

                <div>
                  <p className={fieldLabel}>音频</p>
                  <div className="space-y-2">{sliderRow('音量', '100%')}</div>
                  <div className="mt-2 flex items-center justify-between rounded-lg border p-2.5">
                    <span className="text-[11px]">静音</span>
                    <Switch />
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
        <div className="space-y-2 rounded-lg border border-primary/30 bg-primary/5 p-3">
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
            <p className="text-[10px] leading-relaxed text-muted-foreground">{ttsMessage}</p>
          ) : null}
        </div>
      </div>
    </aside>
  );
}
