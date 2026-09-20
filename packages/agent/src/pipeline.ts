import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  Command,
  END,
  START,
  StateGraph,
  isGraphBubbleUp,
  isInterrupted,
} from '@langchain/langgraph';
import { MemorySaver } from '@langchain/langgraph-checkpoint';
import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint';
import { createId } from '@miaoma/video-project';
import { INTERRUPT_NODE, PIPELINE_NODES } from './constants';
import type { PipelineNode } from './constants';
import { NODE_RUNNERS } from './nodes';
import type { NodeUpdate } from './nodes';
import { resolveDeps } from './deps';
import { AgentStateAnnotation, toAgentState } from './graph-state';
import type { GraphStateType } from './graph-state';
import { JsonFileCheckpointSaver } from './checkpointer';
import type { AgentDeps, AgentRunOptions, AgentRunResult, AgentState, Storyboard, StoryboardScene } from './types';

/**
 * 阶段二主入口（LangGraph 版）：基于 @langchain/langgraph StateGraph 编排 10 节点流水线。
 *
 * scan-assets → creative-brief → storyboard → storyboard-review(interrupt 人机中断)
 * → match-assets → generate-clips → speech-synthesis → assemble-timeline → validate → save-project
 *
 * 行为：
 * - autoResume=false（默认）：storyboard-review 节点调用 LangGraph 原生 interrupt() 暂停，
 *   中断 payload 随 checkpoint 持久化；外部用 result.resume(editedScenes) 经
 *   Command({ resume }) 续跑后半段（人工修改的分镜注入回节点覆盖原分镜）。
 * - autoResume=true（测试 / 非交互场景）：storyboard-review 直通，一路跑到 save-project。
 * - checkpointDir：使用 JsonFileCheckpointSaver（LangGraph Checkpoint 落盘 JSON），
 *   进程崩溃后 resumeFromCheckpoint 以原生 LangGraph 语义从中断点恢复。
 */

/** 流水线执行错误：携带失败节点，便于上层定位 */
export class PipelineError extends Error {
  readonly node: PipelineNode;
  constructor(node: PipelineNode, cause: unknown) {
    super(`[agent] 节点 ${node} 执行失败：${cause instanceof Error ? cause.message : String(cause)}`, {
      cause,
    });
    this.name = 'PipelineError';
    this.node = node;
  }
}

/** ===== LangGraph Checkpoint 的 run 元数据（threadId ↔ 业务状态快照，供崩溃恢复） ===== */

interface RunMeta {
  savedAt: string;
  threadId: string;
  requirement: string;
  sourceDirs: string[];
  state: AgentState;
}

const META_FILE = 'agent-checkpoint.json';

function writeRunMeta(dir: string, meta: RunMeta): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, META_FILE), JSON.stringify(meta, null, 2), 'utf8');
}

function readRunMeta(dir: string): RunMeta | null {
  const file = path.join(dir, META_FILE);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as RunMeta;
  } catch {
    return null;
  }
}

/** ===== 图构建 ===== */

type GraphRunner = (state: GraphStateType) => Promise<Record<string, unknown>>;

function buildGraph(deps: AgentDeps, options: AgentRunOptions, checkpointer: BaseCheckpointSaver) {
  const wrap =
    (node: PipelineNode, runner: (state: AgentState, deps: AgentDeps) => Promise<NodeUpdate>): GraphRunner =>
      async (state: GraphStateType) => {
        options.signal?.throwIfAborted?.();
        options.onProgress?.(node, toAgentState(state));
        try {
          const update = await runner(state as AgentState, deps);
          return { ...(update ?? {}), completedNodes: [node] as PipelineNode[] };
        } catch (e) {
          // interrupt() 等 GraphBubbleUp 异常必须原样抛回 LangGraph，否则人机中断失效
          if (isGraphBubbleUp(e)) throw e;
          throw new PipelineError(node, e);
        }
      };

  const graph = new StateGraph(AgentStateAnnotation)
    .addNode('scan-assets', wrap('scan-assets', NODE_RUNNERS['scan-assets']))
    .addNode('creative-brief', wrap('creative-brief', NODE_RUNNERS['creative-brief']))
    .addNode('storyboard-plan', wrap('storyboard-plan', NODE_RUNNERS['storyboard-plan']))
    .addNode(
      'storyboard-review',
      options.autoResume
        ? async () => ({ completedNodes: ['storyboard-review'] as PipelineNode[] })
        : wrap('storyboard-review', NODE_RUNNERS['storyboard-review']),
    )
    .addNode('match-assets', wrap('match-assets', NODE_RUNNERS['match-assets']))
    .addNode('generate-clips', wrap('generate-clips', NODE_RUNNERS['generate-clips']))
    .addNode('speech-synthesis', wrap('speech-synthesis', NODE_RUNNERS['speech-synthesis']))
    .addNode('assemble-timeline', wrap('assemble-timeline', NODE_RUNNERS['assemble-timeline']))
    .addNode('validate', wrap('validate', NODE_RUNNERS.validate))
    .addNode('save-project', wrap('save-project', NODE_RUNNERS['save-project']));

  graph.addEdge(START, 'scan-assets');
  graph.addEdge('scan-assets', 'creative-brief');
  graph.addEdge('creative-brief', 'storyboard-plan');
  graph.addEdge('storyboard-plan', 'storyboard-review');
  graph.addEdge('storyboard-review', 'match-assets');
  graph.addEdge('match-assets', 'generate-clips');
  graph.addEdge('generate-clips', 'speech-synthesis');
  graph.addEdge('speech-synthesis', 'assemble-timeline');
  graph.addEdge('assemble-timeline', 'validate');
  graph.addEdge('validate', 'save-project');
  graph.addEdge('save-project', END);

  return graph.compile({ checkpointer });
}

function makeSaver(options: AgentRunOptions): BaseCheckpointSaver {
  return options.checkpointDir ? new JsonFileCheckpointSaver(options.checkpointDir) : new MemorySaver();
}

/** resume 入参归一：StoryboardScene[] / Storyboard / 空值。
 * 注意：LangGraph 把 `Command({ resume: null/undefined })` 判为空命令抛 EmptyInputError，
 * 「无修改」语义必须用非空对象 {} 表达（storyboard-review 节点会把无 scenes 的 resume 原样放行）。 */
function normalizeResume(edited?: Storyboard | StoryboardScene[]): Storyboard | Record<string, unknown> {
  if (!edited) return {};
  if (Array.isArray(edited)) return { scenes: edited };
  return Array.isArray(edited.scenes) ? edited : {};
}

interface RunContext {
  app: ReturnType<typeof buildGraph>;
  config: { configurable: { thread_id: string }; recursionLimit: number; signal?: AbortSignal };
  options: AgentRunOptions;
  threadId: string;
}

async function finalize(values: unknown, ctx: RunContext): Promise<AgentRunResult> {
  const { options, threadId } = ctx;
  const state = toAgentState(values as GraphStateType);

  if (options.checkpointDir) {
    writeRunMeta(options.checkpointDir, {
      savedAt: new Date().toISOString(),
      threadId,
      requirement: options.requirement,
      sourceDirs: options.sourceDirs ?? [],
      state,
    });
  }

  if (isInterrupted(values)) {
    if (options.onInterrupt) await options.onInterrupt(state);
    const resume = async (edited?: Storyboard | StoryboardScene[]): Promise<AgentRunResult> => {
      const next = await ctx.app.invoke(new Command({ resume: normalizeResume(edited) }) as never, ctx.config);
      return finalize(next, ctx);
    };
    return { status: 'interrupted', node: INTERRUPT_NODE, state, resume };
  }

  if (!state.project) throw new Error('[agent] 流水线结束但未产出工程对象');
  return { status: 'completed', project: state.project, state };
}

export async function runPipeline(options: AgentRunOptions): Promise<AgentRunResult> {
  const deps = resolveDeps(options.deps);
  // M2：把运行级 signal 合并进 deps，节点内 invoke/stream 能实时响应取消
  const runDeps = { ...deps, signal: options.signal ?? deps.signal };
  const saver = makeSaver(options);
  const app = buildGraph(runDeps, options, saver);
  const threadId = options.threadId ?? `miaoma-${Date.now()}-${createId().slice(0, 8)}`;
  const config = {
    configurable: { thread_id: threadId },
    recursionLimit: PIPELINE_NODES.length + 6,
    signal: options.signal,
  };

  const input: Record<string, unknown> = {
    requirement: options.requirement,
    sourceDirs: options.sourceDirs ?? [],
  };
  // 二次编辑场景：沿用已有工程的素材库作为扫描起点
  if (options.project) input.scannedAssets = [...options.project.assets];

  const values = await app.invoke(input as never, config);
  return finalize(values, { app, config, options, threadId });
}

/**
 * 从磁盘断点恢复（例如应用崩溃重启后）：
 * 1. 读取 run 元数据拿到 threadId，用 JsonFileCheckpointSaver 重建 LangGraph checkpoint；
 * 2. 若线程停在 pending interrupt（分镜审批），以 Command({ resume: null }) 原生续跑；
 * 3. 若线程停在节点中途，直接 invoke(null) 让 LangGraph 重放未完成任务。
 */
export async function resumeFromCheckpoint(
  checkpointDir: string,
  options: AgentRunOptions,
): Promise<AgentRunResult> {
  const meta = readRunMeta(checkpointDir);
  if (!meta?.threadId) throw new Error('[agent] 找不到断点文件，无法恢复');
  const deps = resolveDeps(options.deps);
  const runDeps = { ...deps, signal: options.signal ?? deps.signal };
  const saver = new JsonFileCheckpointSaver(checkpointDir);
  const mergedOptions: AgentRunOptions = {
    ...options,
    requirement: options.requirement || meta.requirement,
    sourceDirs: options.sourceDirs?.length ? options.sourceDirs : meta.sourceDirs,
  };
  const app = buildGraph(runDeps, mergedOptions, saver);
  const config = {
    configurable: { thread_id: meta.threadId },
    recursionLimit: PIPELINE_NODES.length + 6,
    signal: options.signal,
  };

  const snapshot = await app.getState(config);
  const next: string[] = snapshot?.next ?? [];
  if (next.length === 0) {
    // 线程已跑完：直接产出完成结果
    const state = toAgentState((snapshot?.values ?? {}) as GraphStateType);
    if (!state.project) throw new Error('[agent] 断点线程已结束但未产出工程对象');
    return { status: 'completed', project: state.project, state };
  }

  const hasPendingInterrupt = (snapshot?.tasks ?? []).some((t) => (t.interrupts ?? []).length > 0);
  const values = await app.invoke(hasPendingInterrupt ? (new Command({ resume: {} }) as never) : null, config);
  return finalize(values, { app, config, options: mergedOptions, threadId: meta.threadId });
}

/** ===== 断点续传兼容 API（早期手写引擎的快照工具，保留给调试与旧调用点） ===== */

/** 手写状态快照落盘（非 LangGraph checkpoint，仅诊断/回溯用） */
export function saveCheckpoint(state: AgentState, dir: string): void {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, META_FILE);
  writeFileSync(file, JSON.stringify({ savedAt: new Date().toISOString(), state }, null, 2), 'utf8');
}

/** 读取手写状态快照；找不到或损坏返回 null */
export function loadCheckpoint(dir: string): AgentState | null {
  const file = path.join(dir, META_FILE);
  if (!existsSync(file)) return null;
  try {
    const json = JSON.parse(readFileSync(file, 'utf8')) as { state?: AgentState };
    return json.state ?? null;
  } catch {
    return null;
  }
}
