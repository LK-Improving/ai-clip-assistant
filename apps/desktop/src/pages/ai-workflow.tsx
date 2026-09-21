import { useEffect, useState } from 'react';
import { Check, CircleAlert, FolderPlus, Loader2, Scissors, Sparkles, Square, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/input';
import type { PipelineNode } from '@miaoma/agent';
import { getActiveProject } from '@/lib/active-project';
import {
  cancelAgent,
  getAgentSession,
  initAgentEvents,
  retryAgent,
  startAgent,
  subscribeAgentSession,
} from '@/lib/agent-session';
import { cn } from '@/lib/utils';

/** 06 AI 创作流程（真实驱动）：左侧节点步骤条 + 右侧需求输入与 AI 产出 */
const NODE_LABELS: Record<PipelineNode, string> = {
  'scan-assets': '素材扫描',
  'creative-brief': '创意简报',
  'storyboard-plan': '分镜规划',
  'storyboard-review': '分镜审批',
  'match-assets': '素材匹配',
  'generate-clips': 'AI 视频生成',
  'speech-synthesis': '语音合成',
  'assemble-timeline': '时间线组装',
  validate: '工程校验',
  'save-project': '工程落盘',
};

const NODE_ORDER: PipelineNode[] = [
  'scan-assets',
  'creative-brief',
  'storyboard-plan',
  'storyboard-review',
  'match-assets',
  'generate-clips',
  'speech-synthesis',
  'assemble-timeline',
  'validate',
  'save-project',
];

/**
 * 当前工程里真实素材所在的目录。
 *
 * 重跑同一个工程时直接带出这些目录，match-assets 就能命中已有画面，
 * 不会给同样的镜头再烧一轮 AI 视频生成（按秒计费）。
 */
function projectAssetDirs(): string[] {
  const dirs = new Set<string>();
  for (const asset of getActiveProject().assets) {
    const p = asset.path ?? '';
    // mock:// 占位与 http(s):// 远端地址不是本地目录，跳过
    if (!p || /:\/\//.test(p)) continue;
    const dir = p.replace(/[\\/][^\\/]*$/, '');
    if (dir && dir !== p) dirs.add(dir);
  }
  return [...dirs];
}

export default function AiWorkflowPage() {
  const [session, setSession] = useState(getAgentSession());
  const [requirement, setRequirement] = useState(session.requirement);
  const [dirs, setDirs] = useState<string[]>(session.sourceDirs);
  /** 视频生成模型已配置：没挂目录时要给出计费警示，而不是轻描淡写地“可留空” */
  const [videoGenReady, setVideoGenReady] = useState(false);

  useEffect(() => {
    const un = subscribeAgentSession(setSession);
    return () => {
      un();
    };
  }, []);

  useEffect(() => initAgentEvents(), []);

  // 预填素材库已扫描目录 + 当前工程素材所在目录，并查一次视频模型配置状态
  useEffect(() => {
    void (async () => {
      const api = window.electronAPI;
      const inferred = projectAssetDirs();
      if (!api) {
        if (inferred.length) setDirs((prev) => [...new Set([...prev, ...inferred])]);
        return;
      }
      try {
        const [d, vg] = await Promise.all([api.library.dirs(), api.videoGen.status().catch(() => null)]);
        if (vg && vg.active !== 'offline' && vg.configured) setVideoGenReady(true);
        const merged = [...new Set([...(d ?? []), ...inferred])];
        if (merged.length) setDirs((prev) => (prev.length ? prev : merged));
      } catch {
        /* 忽略：素材库不可用时让用户自行选择 */
      }
    })();
  }, []);

  // 分镜规划完成（引擎中断）后自动跳到分镜页等人工确认
  useEffect(() => {
    if (session.status === 'interrupted') window.location.hash = '#/storyboard';
  }, [session.status]);

  const running = session.status === 'running';
  const busy = running;

  async function handlePickDirs() {
    const api = window.electronAPI;
    if (!api) return;
    const picked = await api.library.pickDir();
    if (!picked?.length) return;
    const merged = [...new Set([...dirs, ...picked])];
    setDirs(merged);
    // 顺手登记进素材库（directories 会落盘）：否则下次启动 AI 页又得重选一遍
    void api.library.scan(merged).catch(() => undefined);
  }

  async function handleStart() {
    if (!requirement.trim()) return;
    await startAgent(requirement.trim(), dirs);
  }

  return (
    <div className="flex h-full gap-4 p-4">
      {/* 步骤条 */}
      <aside className="w-64 shrink-0 rounded-xl border bg-card/60 p-4">
        <h2 className="mb-4 text-sm font-semibold">AI 创作流程</h2>
        <ol className="space-y-1">
          {NODE_ORDER.map((node, i) => {
            const done = session.completedNodes.includes(node);
            const active = running && session.node === node;
            return (
              <li key={node} className="flex gap-3">
                <div className="flex flex-col items-center">
                  <span
                    className={cn(
                      'flex size-7 items-center justify-center rounded-full text-xs font-semibold',
                      done && 'bg-brand text-white',
                      active && 'border-2 border-primary text-primary',
                      !done && !active && 'border border-input text-muted-foreground',
                    )}
                  >
                    {done ? <Check className="size-3.5" /> : active ? <Loader2 className="size-3.5 animate-spin" /> : String(i + 1).padStart(2, '0')}
                  </span>
                  {i < NODE_ORDER.length - 1 ? <span className="my-1 w-px flex-1 bg-border" /> : null}
                </div>
                <div className={cn('pb-4', !done && !active && 'opacity-50')}>
                  <p className={cn('text-sm font-medium', active && 'text-primary')}>{NODE_LABELS[node]}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">{node}</p>
                </div>
              </li>
            );
          })}
        </ol>
      </aside>

      {/* 主区 */}
      <section className="flex min-w-0 flex-1 flex-col rounded-xl border bg-card/60">
        <div className="flex-1 space-y-4 overflow-y-auto p-5">
          {/* 需求输入 */}
          <div className="rounded-xl border bg-background/60 p-4">
            <label className="mb-2 flex items-center gap-1.5 text-xs font-semibold">
              <Sparkles className="size-3.5 text-primary" /> 一句话需求
            </label>
            <Textarea
              value={requirement}
              disabled={busy}
              onChange={(e) => setRequirement(e.target.value)}
              placeholder="例如：做一个 30 秒的夏日旅行 vlog，节奏轻快，竖屏"
              className="min-h-24 resize-y"
            />

            <div className="mt-3">
              <div className="mb-1.5 flex items-center justify-between">
                <span className="text-xs font-semibold">素材目录</span>
                <Button variant="ghost" size="sm" className="h-6 gap-1 text-xs" disabled={busy} onClick={handlePickDirs}>
                  <FolderPlus className="size-3.5" /> 添加目录
                </Button>
              </div>
              {dirs.length === 0 ? (
                <p className={cn('text-xs', videoGenReady ? 'text-amber-400' : 'text-muted-foreground')}>
                  {videoGenReady
                    ? '未选择目录：所有场景都会走 AI 视频生成（按秒计费，6 场景约 12–19 元）。挂上本地素材目录后，命中的场景不再调模型。'
                    : '未选择目录（可留空，引擎会走纯旁白分镜；当前未配置视频生成模型，不会产生生成费用）'}
                </p>
              ) : (
                <ul className="space-y-1">
                  {dirs.map((d) => (
                    <li key={d} className="flex items-center gap-2 text-xs text-muted-foreground">
                      <span className="min-w-0 flex-1 truncate">{d}</span>
                      {!busy ? (
                        <button
                          className="hover:text-destructive"
                          onClick={() => setDirs((prev) => prev.filter((x) => x !== d))}
                        >
                          <X className="size-3" />
                        </button>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="mt-3 flex justify-end">
              <Button size="sm" className="rounded-full px-5" disabled={busy || !requirement.trim()} onClick={handleStart}>
                {running ? <Loader2 className="size-3.5 animate-spin" /> : <Scissors className="size-3.5" />}
                {running ? '生成中...' : '开始生成'}
              </Button>
            </div>
          </div>

          {/* AI 产出：创意简报 */}
          {session.brief ? (
            <div className="flex items-start gap-3">
              <span className="bg-brand mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg">
                <Scissors className="size-4 text-white" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-xs font-semibold text-primary">KK剪映 AI</p>
                <div className="mt-2 rounded-xl border bg-background/60 p-4 text-sm leading-relaxed">
                  <p className="font-medium">{session.brief.title}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {session.brief.theme} · {session.brief.tone} · 目标{' '}
                    {(session.brief.targetDurationMs / 1000).toFixed(0)}s ·{' '}
                    {session.brief.canvas.width}×{session.brief.canvas.height}@{session.brief.canvas.fps}
                  </p>
                  {session.brief.outline.length ? (
                    <ul className="mt-2 list-inside list-disc space-y-1 text-muted-foreground">
                      {session.brief.outline.map((line) => (
                        <li key={line}>{line}</li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              </div>
            </div>
          ) : null}

          {/* M2 token 级流式：LLM 节点生成中的打字机区 */}
          {session.status === 'running' && session.streamText ? (
            <div className="ml-11 max-h-40 space-y-1 overflow-y-auto rounded-xl border border-primary/30 bg-primary/5 p-3 font-mono text-[11px] text-foreground/80">
              <p className="mb-1 flex items-center gap-1.5 text-[10px] text-primary">
                <Sparkles className="size-3 animate-pulse" />
                {session.node === 'storyboard-plan' ? '分镜脚本实时生成中' : '创意简报实时生成中'}（token 流）
              </p>
              <p className="break-all whitespace-pre-wrap">
                {session.streamText}
                <span className="animate-pulse">▍</span>
              </p>
            </div>
          ) : null}

          {/* 运行日志 */}
          {session.logs.length ? (
            <div className="ml-11 space-y-1 rounded-xl border bg-background/60 p-3 font-mono text-[11px] text-muted-foreground">
              {session.logs.map((l, i) => (
                <p key={`${i}-${l}`}>{l}</p>
              ))}
            </div>
          ) : null}

          {session.error ? (
            <div className="ml-11 flex items-center gap-2 text-xs text-destructive">
              <CircleAlert className="size-3.5" /> {session.error}
              {session.status === 'error' ? (
                <button
                  onClick={() => void retryAgent()}
                  className="ml-auto shrink-0 rounded border border-destructive/40 px-2 py-0.5 text-[11px] hover:bg-destructive/10"
                  title="从主进程保留的 LangGraph Checkpoint 继续执行"
                >
                  断点重试
                </button>
              ) : null}
            </div>
          ) : null}

          {session.status === 'idle' && !session.brief ? (
            <div className="ml-11 flex items-center gap-2 text-xs text-muted-foreground">
              <CircleAlert className="size-3.5" />
              分镜规划完成后会暂停，等待你确认或修改后再继续
            </div>
          ) : null}
        </div>

        <div className="flex justify-end border-t p-3">
          <button
            className="flex items-center gap-1.5 rounded-full border border-input px-4 py-1.5 text-xs text-muted-foreground hover:border-destructive/50 hover:text-destructive disabled:opacity-40"
            disabled={!running}
            onClick={cancelAgent}
          >
            <Square className="size-3" /> 停止生成
          </button>
        </div>
      </section>
    </div>
  );
}
