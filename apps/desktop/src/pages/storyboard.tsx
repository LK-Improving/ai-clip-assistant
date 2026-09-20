import { useEffect, useState } from 'react';
import { ChevronLeft, Loader2, PencilLine, Sparkles, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input, Textarea } from '@/components/ui/input';
import type { StoryboardScene } from '@miaoma/agent';
import type { VoiceProfile } from '@/preload';
import {
  getAgentSession,
  initAgentEvents,
  removeScene,
  resumeAgent,
  retryAgent,
  subscribeAgentSession,
  updateScene,
} from '@/lib/agent-session';
import { openProject } from '@/lib/active-project';
import { cn } from '@/lib/utils';

/** 07 分镜规划（可编辑 + 续跑）：左侧分镜列表 + 右侧单场编辑 */
const ASSET_TYPE_LABEL: Record<StoryboardScene['assetType'], string> = {
  video: '视频',
  image: '图片',
  audio: '音频',
  any: '任意',
};

export default function StoryboardPage() {
  const [session, setSession] = useState(getAgentSession());
  const [selected, setSelected] = useState(0);
  const [busy, setBusy] = useState(false);
  // M3：音色库列表，供每场选择克隆配音（缺省走常规 TTS 音色）
  const [voices, setVoices] = useState<VoiceProfile[]>([]);

  useEffect(() => {
    const api = window.electronAPI;
    if (!api?.voice) return;
    api.voice.list().then(setVoices).catch(() => setVoices([]));
  }, []);

  useEffect(() => {
    const un = subscribeAgentSession(setSession);
    return () => {
      un();
    };
  }, []);

  useEffect(() => initAgentEvents(), []);

  const { scenes } = session;
  const current: StoryboardScene | undefined =
    scenes.find((s) => s.order === selected) ?? scenes[0];

  async function handleConfirm() {
    setBusy(true);
    const ok = await resumeAgent();
    const projectId = getAgentSession().projectId;
    // 关键：编辑器读的是 activeProject，必须先把 AI 生成的工程设为激活，
    // 否则跳过去看到的是上一个（或默认空）工程。
    if (ok && projectId) await openProject(projectId);
    setBusy(false);
    if (ok && projectId) window.location.hash = '#/editor';
  }

  const totalMs = scenes.reduce((n, s) => n + s.durationMs, 0);

  if (scenes.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <div className="max-w-sm text-center">
          <Sparkles className="mx-auto size-8 text-muted-foreground/50" />
          <p className="mt-3 text-sm font-medium">还没有分镜</p>
          <p className="mt-1 text-xs text-muted-foreground">
            请先在 AI 工作台输入需求并启动生成，分镜规划完成后会自动跳转到这里。
          </p>
          <Button
            size="sm"
            className="mt-4 rounded-full px-5"
            onClick={() => {
              window.location.hash = '#/ai';
            }}
          >
            去 AI 工作台
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full gap-4 p-4">
      {/* 分镜列表 */}
      <aside className="flex w-72 shrink-0 flex-col rounded-xl border bg-card/60">
        <div className="flex items-center justify-between border-b p-3">
          <h2 className="text-sm font-semibold">分镜</h2>
          <span className="text-xs text-muted-foreground">
            {scenes.length} 个镜头 · {(totalMs / 1000).toFixed(1)}s
          </span>
        </div>
        <div className="flex-1 space-y-2 overflow-y-auto p-3">
          {scenes.map((sb) => (
            <button
              key={sb.order}
              onClick={() => setSelected(sb.order)}
              className={cn(
                'flex w-full items-center gap-3 rounded-lg border p-2 text-left transition-colors',
                sb.order === selected
                  ? 'border-primary/60 bg-primary/10'
                  : 'border-transparent hover:border-input hover:bg-secondary/50',
              )}
            >
              <span className="flex size-8 shrink-0 items-center justify-center rounded bg-secondary text-[10px] font-semibold">
                {String(sb.order + 1).padStart(2, '0')}
              </span>
              <div className="min-w-0">
                <p className="truncate text-xs font-medium">{sb.title || `分镜 ${sb.order + 1}`}</p>
                <p className="text-[10px] text-muted-foreground">
                  {ASSET_TYPE_LABEL[sb.assetType]} · {(sb.durationMs / 1000).toFixed(1)}s
                </p>
              </div>
              {sb.order === selected ? <PencilLine className="ml-auto size-3.5 text-primary" /> : null}
            </button>
          ))}
        </div>
      </aside>

      {/* 编辑区 */}
      <section className="flex min-w-0 flex-1 flex-col rounded-xl border bg-card/60">
        <div className="border-b p-3">
          <h2 className="text-sm font-semibold">编辑分镜</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            核对每场的旁白与时长，可直接修改；确认后续跑剩余的素材匹配、语音合成与时间线组装。
          </p>
        </div>

        {current ? (
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
            <div className="space-y-1.5">
              <label className="text-xs font-semibold">标题</label>
              <Input
                value={current.title}
                onChange={(e) => updateScene(current.order, { title: e.target.value })}
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-semibold">旁白文案</label>
              <Textarea
                value={current.narration}
                onChange={(e) => updateScene(current.order, { narration: e.target.value })}
                placeholder="留空则该场不生成旁白与字幕"
                className="min-h-24"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label className="text-xs font-semibold">时长（秒）</label>
                <Input
                  type="number"
                  min={0.5}
                  step={0.5}
                  value={(current.durationMs / 1000).toFixed(1)}
                  onChange={(e) => {
                    const sec = Number(e.target.value);
                    if (Number.isFinite(sec) && sec > 0) {
                      updateScene(current.order, { durationMs: Math.round(sec * 1000) });
                    }
                  }}
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-semibold">期望素材</label>
                <select
                  className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
                  value={current.assetType}
                  onChange={(e) =>
                    updateScene(current.order, {
                      assetType: e.target.value as StoryboardScene['assetType'],
                    })
                  }
                >
                  {(['video', 'image', 'audio', 'any'] as const).map((t) => (
                    <option key={t} value={t}>
                      {ASSET_TYPE_LABEL[t]}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-semibold">旁白音色</label>
              <select
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
                value={current.voiceId ?? ''}
                onChange={(e) =>
                  updateScene(current.order, { voiceId: e.target.value || undefined })
                }
              >
                <option value="">默认（按设置中心 TTS 音色）</option>
                {voices.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name}（零样本克隆）
                  </option>
                ))}
              </select>
              {voices.length === 0 ? (
                <p className="text-[10px] text-muted-foreground">可在设置中心→AI 设置导入参考音频启用克隆音色</p>
              ) : null}
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-semibold">画面描述</label>
              <Textarea
                value={current.description}
                onChange={(e) => updateScene(current.order, { description: e.target.value })}
                className="min-h-16"
              />
            </div>
          </div>
        ) : null}

        <div className="flex items-center justify-between border-t p-3">
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              className="gap-1 text-muted-foreground hover:text-destructive"
              disabled={scenes.length <= 1}
              onClick={() => {
                if (!current) return;
                removeScene(current.order);
                setSelected(0);
              }}
            >
              <Trash2 className="size-3.5" /> 删除本场
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="gap-1 text-muted-foreground"
              onClick={() => {
                window.location.hash = '#/ai';
              }}
            >
              <ChevronLeft className="size-3.5" /> 返回
            </Button>
          </div>

          <div className="flex items-center gap-3">
            {session.error ? (
              <>
                <span className="text-xs text-destructive">{session.error}</span>
                <button
                  onClick={() => void retryAgent()}
                  disabled={busy}
                  className="shrink-0 rounded-full border border-destructive/40 px-3 py-1 text-[11px] text-destructive hover:bg-destructive/10 disabled:opacity-50"
                  title="从主进程保留的 LangGraph Checkpoint 继续执行"
                >
                  断点重试
                </button>
              </>
            ) : null}
            <Button size="sm" className="rounded-full px-5" disabled={busy} onClick={handleConfirm}>
              {busy ? <Loader2 className="size-3.5 animate-spin" /> : null}
              {busy ? '正在生成时间线...' : '确认分镜并继续'}
            </Button>
          </div>
        </div>
      </section>
    </div>
  );
}
