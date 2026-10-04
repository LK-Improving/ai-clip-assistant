import {
  ArrowRight,
  ChevronDown,
  FolderOpen,
  Settings2,
  Sparkles,
  Wand2,
  X,
} from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input, Textarea } from '@/components/ui/input';
import { PageHeader } from '@/components/layout/page-header';
import { createProject } from '@/lib/active-project';
import { startAgent } from '@/lib/agent-session';

const styleTags = [
  '旅行 vlog',
  '产品介绍',
  '城市宣传',
  '美食探店',
  '知识科普',
  '节日祝福',
  '自定义风格',
];

const selectFields = [
  { label: '视频时长', value: '60 秒左右', options: ['30 秒左右', '60 秒左右', '90 秒左右', '3 分钟左右'] },
  { label: '视频风格', value: '轻快现代', options: ['轻快现代', '简约实用', '活力剪辑', '电影质感'] },
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

/** 03 新建创作：一句话需求 → AI 全流程（对照设计稿「让创意，一句话成片」） */
export default function NewProjectPage() {
  const [mode, setMode] = useState<'ai' | 'blank'>('ai');
  const [need, setNeed] = useState('');
  const [name, setName] = useState('');
  const [presetIndex, setPresetIndex] = useState(0);
  const [dirs, setDirs] = useState<string[]>([]);
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

  const handlePickDir = async () => {
    const api = window.electronAPI;
    if (!api) {
      setError('当前为浏览器预览模式，选择素材目录需在桌面端运行');
      return;
    }
    const picked = await api.library.pickDir();
    if (!picked?.length) return;
    const merged = [...new Set([...dirs, ...picked])];
    setDirs(merged);
    void api.library.scan(merged).catch(() => undefined);
  };

  /** AI 智能生成：带素材目录跑完整流水线，跑到分镜规划后中断等确认 */
  const handleCreateFromBrief = async () => {
    const brief = need.trim();
    if (!brief) return;
    setError(null);
    const ok = await startAgent(brief, dirs);
    if (!ok) {
      setError('当前为浏览器预览模式，AI 创作需在桌面端运行');
      return;
    }
    // 生成流水线在整页 AI 助手（/chat）展示进度与分镜确认
    window.location.hash = '#/chat';
  };

  const handleCreateBlank = () => {
    const preset = CANVAS_PRESETS[presetIndex] ?? CANVAS_PRESETS[0]!;
    void runCreate({ name: name.trim() || '未命名工程', width: preset.width, height: preset.height });
  };

  return (
    <div className="mx-auto max-w-3xl p-6 lg:p-8">
      <PageHeader
        title={
          <>
            让创意，
            <span className="text-brand-gradient">一句话成片</span>
          </>
        }
        subtitle="输入你的想法，AI 帮你完成脚本、分镜、配音和视频生成"
      />

      <div className="mt-6">
        {/* 创作表单 */}
        <div className="rounded-2xl border bg-card/60 p-5 shadow-xl shadow-primary/5">
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-2 text-sm font-semibold">
              <Sparkles className="size-4 text-primary" />
              {mode === 'ai' ? '输入创作需求' : '空白项目'}
            </span>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setMode(mode === 'ai' ? 'blank' : 'ai')}
                className="flex items-center gap-1.5 rounded-lg border border-input px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:border-primary/50 hover:text-primary"
              >
                {mode === 'ai' ? (
                  <>
                    <Wand2 className="size-3.5" /> 从空白开始
                  </>
                ) : (
                  <>
                    <Sparkles className="size-3.5" /> AI 智能生成
                  </>
                )}
              </button>
            </div>
          </div>

          {error ? (
            <p className="mt-4 flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              <X className="mt-0.5 size-3.5 shrink-0" /> {error}
            </p>
          ) : null}

          {mode === 'ai' ? (
            <div className="mt-4 space-y-5">
              {/* 需求输入 */}
              <div className="relative">
                <Textarea
                  rows={5}
                  maxLength={10000}
                  value={need}
                  onChange={(e) => setNeed(e.target.value)}
                  placeholder="帮我制作一个关于城市旅游的宣传视频，时长1分钟，风格轻快，包含航拍、景点介绍、字幕和背景音乐。"
                  className="min-h-32 resize-y pb-7"
                />
                <span className="pointer-events-none absolute right-3 bottom-2.5 text-[11px] text-muted-foreground">
                  {need.length}/10000
                </span>
              </div>

              {/* 风格标签 */}
              <div className="flex flex-wrap gap-2">
                {styleTags.map((s) => (
                  <button
                    key={s}
                    onClick={() => setNeed((prev) => (prev ? `${prev}，主题：${s}` : s))}
                    className="rounded-full border border-input px-3 py-1 text-xs text-muted-foreground transition-colors hover:border-primary/50 hover:text-primary"
                  >
                    {s}
                  </button>
                ))}
              </div>

              {/* 本地素材 */}
              <div className="space-y-2">
                <span className="flex items-center gap-1.5 text-xs font-semibold">
                  <FolderOpen className="size-3.5 text-primary" /> 本地素材（可选）
                </span>
                <div className="flex items-center gap-2">
                  <div className="flex-1 truncate rounded-lg border border-input bg-background/60 px-3 py-2 text-xs text-muted-foreground">
                    {dirs.length ? dirs.join('、') : '未选择素材目录，全部镜头将走 AI 视频生成（按秒计费）'}
                  </div>
                  <Button variant="ghost" size="sm" className="h-9 shrink-0 gap-1.5 text-xs" onClick={() => void handlePickDir()}>
                    <FolderOpen className="size-3.5" /> 选择文件夹
                  </Button>
                </div>
              </div>

              {/* 高级设置 */}
              <details className="group rounded-lg border border-input">
                <summary className="flex cursor-pointer list-none items-center gap-1.5 px-3 py-2.5 text-xs font-semibold text-muted-foreground marker:hidden">
                  <Settings2 className="size-3.5" /> 高级设置（可选）
                  <ChevronDown className="ml-auto size-4 transition-transform group-open:rotate-180" />
                </summary>
                <div className="grid grid-cols-3 gap-3 border-t px-3 py-3">
                  {selectFields.map(({ label, value, options }) => (
                    <label key={label} className="space-y-1.5">
                      <span className="text-[11px] text-muted-foreground">{label}</span>
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
              </details>

              {/* 开始创作 */}
              <Button
                className="bg-brand h-12 w-full gap-2 rounded-xl text-base font-semibold shadow-lg shadow-primary/30 hover:opacity-95"
                disabled={!need.trim() || creating}
                onClick={handleCreateFromBrief}
              >
                <Sparkles className="size-4" />
                {creating ? '正在启动…' : '开始创作'}
                <ArrowRight className="size-4" />
              </Button>
            </div>
          ) : (
            <div className="mt-4 space-y-5">
              <div className="grid grid-cols-2 gap-3">
                <label className="space-y-1.5">
                  <span className="text-xs text-muted-foreground">项目名称</span>
                  <Input placeholder="未命名工程" value={name} onChange={(e) => setName(e.target.value)} />
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
              <Button
                className="bg-brand h-12 w-full gap-2 rounded-xl text-base font-semibold shadow-lg shadow-primary/30 hover:opacity-95"
                disabled={creating}
                onClick={handleCreateBlank}
              >
                创建项目 <ArrowRight className="size-4" />
              </Button>
            </div>
          )}
        </div>

      </div>
    </div>
  );
}
