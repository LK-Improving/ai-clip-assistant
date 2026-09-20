import type { Brief, PipelineNode, StoryboardScene } from '@miaoma/agent';
// 仅类型引用（编译期擦除），运行时不会把主进程模块打进渲染进程
import type { AgentSnapshot } from '@/main/services/agent';

/**
 * AI 会话状态：AI 工作台页与分镜页共用同一份状态。
 *
 * 沿用 lib/active-project.ts 的模式（模块级单一事实来源 + 订阅 + bridge() 降级），
 * 因为本项目是极简 hash 路由、没有全局状态库。
 */

export interface AgentSessionState {
  status: 'idle' | 'running' | 'interrupted' | 'completed' | 'error';
  node: PipelineNode | null;
  completedNodes: PipelineNode[];
  brief: Brief | null;
  scenes: StoryboardScene[];
  projectId: string | null;
  requirement: string;
  sourceDirs: string[];
  logs: string[];
  /** M2：当前 LLM 节点的 token 流式正文（打字机展示；节点切换/终态时重置） */
  streamText: string;
  error?: string;
}

function initial(): AgentSessionState {
  return {
    status: 'idle',
    node: null,
    completedNodes: [],
    brief: null,
    scenes: [],
    projectId: null,
    requirement: '',
    sourceDirs: [],
    logs: [],
    streamText: '',
  };
}

let state: AgentSessionState = initial();
const listeners = new Set<(s: AgentSessionState) => void>();

function setState(patch: Partial<AgentSessionState>): void {
  state = { ...state, ...patch };
  for (const fn of listeners) fn(state);
}

function applySnapshot(snap: AgentSnapshot): void {
  setState({
    status: snap.status,
    node: snap.node,
    completedNodes: snap.completedNodes,
    brief: snap.brief,
    scenes: snap.scenes,
    projectId: snap.projectId,
    error: snap.error,
  });
}

export function getAgentSession(): AgentSessionState {
  return state;
}

export function subscribeAgentSession(fn: (s: AgentSessionState) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** 浏览器预览模式下 window.electronAPI 不存在，统一返回 undefined 由调用方降级 */
function bridge() {
  return typeof window === 'undefined' ? undefined : window.electronAPI;
}

/** 启动一次 AI 剪辑（跑到分镜规划后中断） */
export async function startAgent(requirement: string, sourceDirs: string[]): Promise<boolean> {
  const api = bridge();
  if (!api) {
    setState({ status: 'error', error: '当前为浏览器预览模式，无法调用 AI 引擎' });
    return false;
  }
  setState({
    ...initial(),
    status: 'running',
    node: 'scan-assets',
    requirement,
    sourceDirs,
  });
  try {
    applySnapshot(await api.agent.start({ requirement, sourceDirs }));
    return true;
  } catch (e) {
    setState({ status: 'error', error: (e as Error).message });
    return false;
  }
}

/** 分镜确认/修改后续跑 */
export async function resumeAgent(): Promise<boolean> {
  const api = bridge();
  if (!api) return false;
  setState({ status: 'running', error: undefined });
  try {
    applySnapshot(await api.agent.resume(state.scenes));
    return true;
  } catch (e) {
    setState({ status: 'error', error: (e as Error).message });
    return false;
  }
}

/** 断点重试：从主进程磁盘 LangGraph Checkpoint 恢复失败/崩溃的流水线 */
export async function retryAgent(): Promise<boolean> {
  const api = bridge();
  if (!api) return false;
  setState({ status: 'running', error: undefined });
  try {
    applySnapshot(await api.agent.retry());
    return true;
  } catch (e) {
    setState({ status: 'error', error: (e as Error).message });
    return false;
  }
}

export function updateScene(order: number, patch: Partial<StoryboardScene>): void {
  const scenes = state.scenes.map((s) => (s.order === order ? { ...s, ...patch } : s));
  setState({ scenes });
}

/** 删除分镜后重排序号，保证 order 连续（引擎按 order 匹配素材与旁白） */
export function removeScene(order: number): void {
  const scenes = state.scenes
    .filter((s) => s.order !== order)
    .map((s, i) => ({ ...s, order: i }));
  setState({ scenes });
}

export function cancelAgent(): void {
  void bridge()?.agent.cancel();
  setState({ status: 'idle', node: null });
}

export function resetAgentSession(): void {
  setState(initial());
}

/** 订阅主进程事件（进度/日志/中断/完成），返回取消订阅函数。
 * 带序号防丢：事件 seq 断档时用 agent:status 快照补偿对齐，避免丢事件导致 UI 卡在旧进度。 */
export function initAgentEvents(): () => void {
  const api = bridge();
  if (!api?.agent?.onEvent) return () => {};
  let lastSeq = 0;
  return api.agent.onEvent((ev) => {
    const seq = typeof ev.seq === 'number' ? ev.seq : 0;
    if (seq && lastSeq && seq > lastSeq + 1) {
      // 中间事件丢了：拉取主进程快照对齐状态
      void api.agent.status().then(applySnapshot).catch(() => {});
    }
    if (seq) lastSeq = seq;
    if (ev.type === 'progress' && ev.node) {
      // 进入新节点：重置流式区（token 只属于当前 LLM 节点）
      setState({ node: ev.node, streamText: '' });
    }
    // M2：token 增量追加打字机区（限长防止长输出撞爆内存，只展示尾部）
    if (ev.type === 'token' && ev.delta) {
      const next = (state.streamText + ev.delta).slice(-4000);
      setState({ streamText: next });
    }
    if (ev.type === 'log' && ev.message) setState({ logs: [...state.logs, ev.message].slice(-50) });
    // 失败事件：主进程已保留 checkpoint，展示错误与可重试入口
    if (ev.type === 'error') setState({ status: 'error', error: ev.message ?? 'AI 任务失败' });
    if ((ev.type === 'interrupted' || ev.type === 'completed') && ev.snapshot) {
      applySnapshot(ev.snapshot);
    }
  });
}
