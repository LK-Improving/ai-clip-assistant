import { ArrowRight, Sparkles, X } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input, Textarea } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { createProject } from '@/lib/active-project';
import { startAgent } from '@/lib/agent-session';

const suggestions = ['旅行 vlog', '产品介绍', '知识科普', '美食探店', '企业文化', '教程演示'];

const selectFields = [
  { label: '视频时长', value: '60 秒左右', options: ['30 秒左右', '60 秒左右', '90 秒左右', '3 分钟左右'] },
  { label: '视频风格', value: '简约实用', options: ['简约实用', '活力剪辑', '电影质感', '轻松幽默'] },
  { label: '画面画质', value: '1080P 高清', options: ['720P', '1080P 高清', '4K 超清'] },
];

const CANVAS_PRESETS = [
  { label: '1920 × 1080（16:9）', width: 1920, height: 1080 },
  { label: '1080 × 1920（9:16）', width: 1080, height: 1920 },
  { label: '1080 × 1080（1:1）', width: 1080, height: 1080 },
];

function toEditor() {
  window.location.hash = '#/editor';
}

/** 03 新建项目 / 输入需求（AI 智能生成） */
export default function NewProjectPage() {
  const [tab, setTab] = useState<'ai' | 'blank'>('ai');
  const [need, setNeed] = useState('');
  const [name, setName] = useState('');
  const [presetIndex, setPresetIndex] = useState(0);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const runCreate = async (input: Parameters<typeof createProject>[0]) => {
    setCreating(true);
    setError(null);
    try {
      const project = await createProject(input);
      if (!project) {
        setError('当前为浏览器预览模式，工程创建需运行在桌面端');
        return;
      }
      toEditor();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  };

  /**
   * AI 智能生成：直接调用 AI 引擎跑完整流水线（扫描素材 → 创意简报 → 分镜 →
   * 匹配素材 → 语音合成 → 组装时间线），跑到分镜规划后中断等用户确认，
   * 确认后续跑完并把成片工程落到本地，再进入编辑器。
   */
  const handleCreateFromBrief = async () => {
    const brief = need.trim();
    if (!brief) return;
    setError(null);
    const ok = await startAgent(brief, []);
    if (!ok) {
      setError('当前为浏览器预览模式，AI 创作需在桌面端运行');
      return;
    }
    // 进入 AI 创作流程页，引擎跑到分镜规划后会自动跳到分镜确认页
    window.location.hash = '#/ai';
  };

  const handleCreateBlank = () => {
    const preset = CANVAS_PRESETS[presetIndex] ?? CANVAS_PRESETS[0]!;
    void runCreate({
      name: name.trim() || '未命名工程',
      width: preset.width,
      height: preset.height,
    });
  };

  return (
    <div className="flex items-start justify-center p-8">
      <div className="w-full max-w-2xl rounded-2xl border bg-card/70 p-6 shadow-xl shadow-primary/5">
        <div className="flex items-center justify-between">
          <h1 className="text-lg font-bold">新建项目</h1>
          <a href="#/home" className="text-muted-foreground hover:text-foreground">
            <X className="size-4" />
          </a>
        </div>

        {/* Tab */}
        <div className="mt-4 grid grid-cols-2 gap-1 rounded-lg bg-secondary/60 p-1 text-sm">
          {(
            [
              { key: 'ai', label: 'AI 智能生成', icon: Sparkles },
              { key: 'blank', label: '空白项目', icon: undefined },
            ] as const
          ).map(({ key, label, icon: Icon }) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={cn(
                'flex items-center justify-center gap-1.5 rounded-md py-1.5 transition-colors',
                tab === key ? 'bg-brand text-white shadow' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {Icon ? <Icon className="size-4" /> : null}
              {label}
            </button>
          ))}
        </div>

        {error ? (
          <p className="mt-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {error}
          </p>
        ) : null}

        {tab === 'ai' ? (
          <div className="mt-5 space-y-5">
            <div>
              <p className="mb-2 text-xs text-muted-foreground">
                请输入你的创作需求或主题，KK剪映将自动完成从脚本到成片的完整流程
              </p>
              <Textarea
                rows={4}
                value={need}
                onChange={(e) => setNeed(e.target.value)}
                placeholder="例如：制作一条 1 分钟的日本旅行 Vlog，包含富士山、樱花与街头美食画面，节奏轻快..."
              />
            </div>

            <div className="grid grid-cols-3 gap-3">
              {selectFields.map(({ label, value, options }) => (
                <label key={label} className="space-y-1.5">
                  <span className="text-xs text-muted-foreground">{label}</span>
                  <select
                    defaultValue={value}
                    className="h-9 w-full rounded-md border border-input bg-card/60 px-2 text-xs outline-none focus:border-ring"
                  >
                    {options.map((o) => (
                      <option key={o} value={o}>
                        {o}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
            </div>

            <div>
              <p className="mb-2 text-xs text-muted-foreground">智能推荐</p>
              <div className="flex flex-wrap gap-2">
                {suggestions.map((s) => (
                  <button
                    key={s}
                    onClick={() => setNeed((prev) => (prev ? `${prev}，主题：${s}` : s))}
                    className="rounded-full border border-input px-3 py-1 text-xs text-muted-foreground transition-colors hover:border-primary/50 hover:text-primary"
                  >
                    # {s}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex justify-end">
              <Button
                className="gap-2 rounded-full px-6"
                disabled={!need.trim() || creating}
                onClick={handleCreateFromBrief}
              >
                开始生成 <ArrowRight className="size-4" />
              </Button>
            </div>
          </div>
        ) : (
          <div className="mt-5 space-y-5">
            <div className="grid grid-cols-2 gap-3">
              <label className="space-y-1.5">
                <span className="text-xs text-muted-foreground">项目名称</span>
                <Input
                  placeholder="未命名工程"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </label>
              <label className="space-y-1.5">
                <span className="text-xs text-muted-foreground">画布规格</span>
                <select
                  value={presetIndex}
                  onChange={(e) => setPresetIndex(Number(e.target.value))}
                  className="h-9 w-full rounded-md border border-input bg-card/60 px-2 text-xs outline-none focus:border-ring"
                >
                  {CANVAS_PRESETS.map((preset, index) => (
                    <option key={preset.label} value={index}>
                      {preset.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="flex justify-end">
              <Button
                className="gap-2 rounded-full px-6"
                disabled={creating}
                onClick={handleCreateBlank}
              >
                创建项目 <ArrowRight className="size-4" />
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
