import { app, BrowserWindow } from 'electron';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, extname } from 'node:path';
import path from 'node:path';
import {
  createLlmProvider,
  INTERRUPT_NODE,
  MiniMaxH3VideoProvider,
  OfflineTtsProvider,
  OfflineVideoGenProvider,
  resumeFromCheckpoint,
  runPipeline,
  type AgentChatModel,
  type AgentDeps,
  type AgentRunOptions,
  type AgentRunResult,
  type AgentState,
  type AgentTtsProvider,
  type AgentTtsRequest,
  type AgentTtsResult,
  type Brief,
  type MediaProbe,
  type PipelineNode,
  type StoryboardScene,
  type VideoGenProvider,
} from '@miaoma/agent';
import type { Project } from '@miaoma/video-project';
import { addAllowedPath } from '../protocol';
import { probeMedia } from './probe';
import { getProjectStore } from './project-store';
import { synthesizeSpeech, ttsStatus, zeroShotFallbackReason } from './tts';
import { loadLlmConfig } from './llm/config';
import { loadVideoGenConfig } from './video-gen/config';

/**
 * 阶段二：把 AI 智能体引擎（LangGraph 版）接进桌面端。
 *
 * 职责：
 * 1. 把桌面端的真实能力（probeMedia / synthesizeSpeech / env 注入的 LLM）装配成引擎需要的 AgentDeps；
 * 2. 管理运行时会话 —— 引擎在 storyboard-review 节点经 LangGraph 原生 interrupt 暂停，
 *    这里保存 resume 闭包，等用户在分镜页改完后续跑（修改经 Command({ resume }) 回注）；
 * 3. 通过 agent:event 向渲染进程广播带序号（seq）的进度事件。
 */

/** TTS 适配器：优先用桌面端真实 TTS；未配置密钥时降级为离线静音占位，保证整条链路仍可跑通 */
class DesktopTtsAdapter implements AgentTtsProvider {
  readonly id = 'desktop';
  private readonly fallback = new OfflineTtsProvider();
  private readonly logger?: (msg: string) => void;

  constructor(logger?: (msg: string) => void) {
    this.logger = logger;
  }

  isConfigured(): boolean {
    const s = ttsStatus();
    return Boolean(s.configured[s.active]);
  }

  /**
   * 优先用桌面端真实 TTS；未配置或合成失败（服务不可达 / 密钥无效）时降级为离线静音占位。
   * 降级而非中断，是为了让「没配 TTS 也想先跑通整条 AI 剪辑链路」成为可能。
   */
  async synthesize(req: AgentTtsRequest): Promise<AgentTtsResult> {
    if (this.isConfigured() || req.voiceId) {
      try {
        const res = await synthesizeSpeech({
          text: req.text,
          voice: req.voice,
          speed: req.speed,
          voiceId: req.voiceId,
        });
        if (req.voiceId && res.provider !== 'zero-shot') {
          this.logger?.(`[agent] 音色零样本链未命中：${zeroShotFallbackReason(req.voiceId) ?? '已回退常规音色'}`);
        }
        const data = readFileSync(res.audioPath);
        const ext = extname(res.audioPath).replace(/^\./, '') || 'wav';
        return { data, ext, durationMs: res.durationMs };
      } catch (e) {
        this.logger?.(`[agent] TTS 合成失败，降级为静音占位：${(e as Error).message}`);
      }
    } else {
      this.logger?.('[agent] TTS 未配置，使用静音占位音频（可在设置中心配置后获得真实配音）');
    }
    return this.fallback.synthesize(req);
  }
}

/** 媒体探测适配器：desktop probeMedia → 引擎 MediaProbe */
async function probeAdapter(filePath: string): Promise<MediaProbe> {
  const r = await probeMedia(filePath);
  return { durationMs: r.durationMs, width: r.width, height: r.height, fps: r.fps, hasAudio: r.hasAudio };
}

function workDir(): string {
  const dir = path.join(app.getPath('userData'), 'agent-tts');
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * LangGraph Checkpoint 目录（失败断点重试的依据）：
 * 每次 start 前清空，避免旧线程残留；全链路成功后删除，中断/失败时保留供 retryAgentRun 恢复。
 */
function runCheckpointDir(): string {
  return path.join(app.getPath('userData'), 'agent-runs');
}

function resetRunCheckpoint(): string {
  const dir = runCheckpointDir();
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

function clearRunCheckpoint(): void {
  try {
    rmSync(runCheckpointDir(), { recursive: true, force: true });
  } catch {
    /* 清理失败不影响主流程 */
  }
}

/** 装配真实依赖；LLM 由 env 决定（AGENT_LLM_PROVIDER=ark + ARK_API_KEY，缺省离线 Provider） */
/**
 * 解析 LLM Provider：优先用设置中心的配置，配置里的 apiKey 为空时仍允许 env 注入。
 * 选了 ark 但没填密钥时回退离线 Provider —— 与 TTS 同一策略，
 * 保证「没配好也想先跑通链路」，而不是直接把整条流水线打挂。
 */
function resolveLlm(logger?: (msg: string) => void): AgentChatModel {
  const cfg = loadLlmConfig();
  if (cfg.active === 'ollama') {
    // 本地 Ollama（M1 三模型引擎）：服务可达性无法静态判断，连接失败由
    // invokeStructured 的重试/降级兜底接住，不会打挂流水线
    const provider = createLlmProvider({
      type: 'ollama',
      baseUrl: cfg.ollama?.baseUrl || process.env.OLLAMA_BASE_URL,
      model: cfg.ollama?.model || process.env.OLLAMA_MODEL,
    });
    logger?.(`[agent] 使用本地 Ollama：${provider.label}`);
    return provider;
  }
  if (cfg.active === 'ark') {
    const provider = createLlmProvider({
      type: 'ark',
      apiKey: cfg.ark.apiKey || process.env.ARK_API_KEY || '',
      model: cfg.ark.model,
      baseUrl: cfg.ark.baseUrl,
    });
    if (provider.isConfigured()) return provider;
    logger?.('[agent] 已选择火山方舟但未填写 apiKey，本次回退离线 Provider');
  }
  return createLlmProvider({ type: 'offline' });
}

export function createAgentDeps(logger?: (msg: string) => void): AgentDeps {
  return {
    llm: resolveLlm(logger),
    tts: new DesktopTtsAdapter(logger),
    videoGen: resolveVideoGen(logger),
    probe: probeAdapter,
    workDir: workDir(),
    logger,
    // M2：LLM token 级流式→带序号广播 type='token'，渲染层据此打关键区域打字机效果
    onToken: (node, delta) => broadcast({ type: 'token', node, delta }),
  };
}

/**
 * 解析视频生成 Provider：优先用「设置中心 → AI 设置 → 视频生成模型」的配置。
 * 选了 MiniMax H3 但没填密钥时回退离线 Provider —— 与 LLM/TTS 同一策略，
 * 保证「没配好也想先跑通链路」，而不是直接把整条流水线打挂。
 */
function resolveVideoGen(logger?: (msg: string) => void): VideoGenProvider {
  const cfg = loadVideoGenConfig();
  if (cfg.active === 'minimax') {
    const apiKey = cfg.minimax.apiKey || process.env.MINIMAX_API_KEY || '';
    if (apiKey) {
      const dir = path.join(app.getPath('userData'), 'agent-video');
      mkdirSync(dir, { recursive: true });
      return new MiniMaxH3VideoProvider({
        apiKey,
        baseUrl: cfg.minimax.baseUrl || undefined,
        model: cfg.minimax.model || 'minimax-h3',
        workDir: dir,
        logger,
      });
    }
    logger?.('[agent] 已选择 MiniMax H3 但未填写 apiKey，本次不生成 AI 视频');
  }
  return new OfflineVideoGenProvider();
}

/** ===== 运行时会话 ===== */

interface AgentSession {
  state: AgentState;
  resume: (edited?: StoryboardScene[]) => Promise<AgentRunResult>;
  controller: AbortController;
}

let session: AgentSession | null = null;

export interface AgentSnapshot {
  status: 'idle' | 'running' | 'interrupted' | 'completed' | 'error';
  node: PipelineNode | null;
  completedNodes: PipelineNode[];
  brief: Brief | null;
  scenes: StoryboardScene[];
  projectId: string | null;
  error?: string;
}

let eventSeq = 0;

/** 带序号防丢事件上报：每条广播携带自增 seq，渲染进程检测断档时用 agent:status 快照补偿对齐 */
function broadcast(payload: unknown): void {
  const enriched = { seq: ++eventSeq, ...(payload as Record<string, unknown>) };
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send('agent:event', enriched);
}

/** 失败语义：广播 error 事件（保留 checkpoint，前端可发起断点重试）后继续向上抛 */
function broadcastError(message: string): void {
  broadcast({ type: 'error', message });
}

function snapshot(
  state: AgentState,
  status: AgentSnapshot['status'],
  node: PipelineNode | null,
  projectId: string | null = null,
  error?: string,
): AgentSnapshot {
  return {
    status,
    node,
    completedNodes: [...state.completedNodes],
    brief: state.brief,
    scenes: state.storyboard?.scenes ?? [],
    projectId,
    error,
  };
}

/** 落盘并把素材目录登记进 miaoma:// 白名单（否则编辑器预览会黑屏） */
async function persist(project: Project): Promise<string> {
  for (const asset of project.assets) {
    if (asset.path && !asset.path.includes('://')) addAllowedPath(dirname(asset.path));
  }
  const saved = await getProjectStore().save(project);
  return saved.id;
}

/** 启动一次 AI 剪辑：跑到 storyboard-review 后中断，返回可分镜编辑的快照 */
export async function startAgentRun(input: {
  requirement: string;
  sourceDirs: string[];
}): Promise<AgentSnapshot> {
  const controller = new AbortController();
  const options: AgentRunOptions = {
    requirement: input.requirement,
    sourceDirs: input.sourceDirs,
    deps: createAgentDeps((msg) => broadcast({ type: 'log', message: msg })),
    autoResume: false,
    signal: controller.signal,
    checkpointDir: resetRunCheckpoint(),
    onProgress: (node) => broadcast({ type: 'progress', node }),
  };

  broadcast({ type: 'progress', node: 'scan-assets' });
  let result: AgentRunResult;
  try {
    result = await runPipeline(options);
  } catch (e) {
    // 失败回滚：内存会话不保留，磁盘 checkpoint 保留供断点重试
    broadcastError((e as Error).message);
    throw e;
  }

  if (result.status === 'interrupted') {
    session = { state: result.state, resume: result.resume, controller };
    const snap = snapshot(result.state, 'interrupted', result.node);
    broadcast({ type: 'interrupted', snapshot: snap });
    return snap;
  }
  const projectId = await persist(result.project);
  clearRunCheckpoint();
  const snap = snapshot(result.state, 'completed', 'save-project', projectId);
  broadcast({ type: 'completed', snapshot: snap });
  return snap;
}

/**
 * 用户在分镜页确认/修改后续跑。
 * 传入 scenes 时经 LangGraph `Command({ resume })` 注入回 storyboard-review 节点，
 * 覆盖 AI 原始分镜后继续执行后半段。
 */
export async function resumeAgentRun(scenes?: StoryboardScene[]): Promise<AgentSnapshot> {
  if (!session) throw new Error('当前没有可继续的 AI 任务，请先在 AI 工作台启动一次生成');
  const current = session;
  let resumed: AgentRunResult;
  try {
    resumed = await current.resume(scenes && scenes.length > 0 ? scenes : undefined);
  } catch (e) {
    // 后半段失败：保留内存会话与 checkpoint，用户可修好后再次续跑或断点重试
    broadcastError((e as Error).message);
    throw e;
  }
  session = null;

  if (resumed.status !== 'completed') {
    session = { state: resumed.state, resume: resumed.resume, controller: current.controller };
    const snap = snapshot(resumed.state, 'interrupted', resumed.node);
    broadcast({ type: 'interrupted', snapshot: snap });
    return snap;
  }
  const projectId = await persist(resumed.project);
  clearRunCheckpoint();
  const snap = snapshot(resumed.state, 'completed', 'save-project', projectId);
  broadcast({ type: 'completed', snapshot: snap });
  return snap;
}

/**
 * 断点重试：从磁盘 LangGraph Checkpoint 恢复上次失败/崩溃的流水线（PDF「失败回滚 + 断点续跑」）。
 * - 内存中还有可续会话（停在分镜审批）时等价于直接续跑；
 * - 否则用 resumeFromCheckpoint 以原生 LangGraph 语义从失败节点继续执行到完成。
 */
export async function retryAgentRun(): Promise<AgentSnapshot> {
  if (session) {
    return resumeAgentRun(session.state.storyboard?.scenes);
  }
  const dir = runCheckpointDir();
  const controller = new AbortController();
  let result: AgentRunResult;
  try {
    result = await resumeFromCheckpoint(dir, {
      requirement: '',
      sourceDirs: [],
      deps: createAgentDeps((msg) => broadcast({ type: 'log', message: msg })),
      signal: controller.signal,
      onProgress: (node) => broadcast({ type: 'progress', node }),
    });
  } catch (e) {
    broadcastError((e as Error).message);
    throw e;
  }

  if (result.status !== 'completed') {
    session = { state: result.state, resume: result.resume, controller };
    const snap = snapshot(result.state, 'interrupted', result.node);
    broadcast({ type: 'interrupted', snapshot: snap });
    return snap;
  }
  const projectId = await persist(result.project);
  clearRunCheckpoint();
  const snap = snapshot(result.state, 'completed', 'save-project', projectId);
  broadcast({ type: 'completed', snapshot: snap });
  return snap;
}

/** 查询当前会话快照（供页面刷新后恢复 UI） */
export function getAgentStatus(): AgentSnapshot {
  if (!session) {
    return { status: 'idle', node: null, completedNodes: [], brief: null, scenes: [], projectId: null };
  }
  return snapshot(session.state, 'interrupted', INTERRUPT_NODE);
}

/** 取消当前任务 */
export function cancelAgentRun(): boolean {
  if (!session) return false;
  session.controller.abort();
  session = null;
  return true;
}
