import type { Asset, Project } from '@miaoma/video-project';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { PipelineNode } from './constants';
import type { VideoGenProvider } from './video-gen';

export type { Asset } from '@miaoma/video-project';
export type { VideoGenProvider, VideoGenRequest, VideoGenResult } from './video-gen';

/** ===== LLM Provider 接口（2.1，LangChain 模型抽象） ===== */

/**
 * 引擎使用的聊天模型：在 LangChain `BaseChatModel` 的模型抽象之上补充供应商元信息，
 * 让离线确定性模型（OfflineChatModel）、火山方舟（ChatOpenAI 兼容端点）与本地 Ollama
 * （ChatOllama）共用同一套注入面；结构化输出统一走 invokeStructured（Function Calling + Zod + 重试）。
 */
export type AgentChatModel = BaseChatModel & {
  /** 供应商标识：offline / ark / ollama */
  readonly providerId: string;
  /** 展示名（设置中心 / 日志用） */
  readonly label: string;
  /** 配置是否齐全（缺密钥时上层给出明确提示，而非静默失败） */
  isConfigured(): boolean;
  /** 是否支持原生 function calling（bindTools）；不支持时结构化输出退化为 JSON 内容 + Zod 校验 */
  supportsToolCalling(): boolean;
};

/** ===== TTS Provider 接口（2.1，DI 注入） ===== */

export interface AgentTtsRequest {
  text: string;
  voice?: string;
  speed?: number;
  /** M3：指定桌面端音色库 id 时走零样本克隆链；不可用由适配层降级回常规音色 */
  voiceId?: string;
}

export interface AgentTtsResult {
  /** 音频二进制（离线 Provider 生成静音 WAV；真实 Provider 返回引擎输出） */
  data: Buffer;
  /** 文件扩展名，例如 "wav" / "mp3" */
  ext: string;
  /** 估算时长（毫秒），由 Provider 直接给出，避免二次探测 */
  durationMs: number;
}

export interface AgentTtsProvider {
  readonly id: string;
  isConfigured(): boolean;
  synthesize(req: AgentTtsRequest): Promise<AgentTtsResult>;
}

/** ===== 媒体探测（2.1，DI 注入；复用 desktop probe 的语义） ===== */

export interface MediaProbe {
  durationMs: number;
  width: number | null;
  height: number | null;
  fps: number | null;
  hasAudio: boolean;
}

/** ===== 各流水线节点产出 ===== */

/** 创意简报：由 creative-brief 节点产出 */
export interface Brief {
  title: string;
  theme: string;
  tone: string;
  /** 目标总时长（毫秒） */
  targetDurationMs: number;
  canvas: { width: number; height: number; fps: number };
  /** 风格关键词，例如 ["明亮", "旅行", "轻快"] */
  style: string[];
  /** 旁白大纲（按段落） */
  outline: string[];
}

export type SceneAssetType = 'video' | 'image' | 'audio' | 'any';

/** 分镜单场：由 storyboard 节点产出 */
export interface StoryboardScene {
  /** 场次序号，从 0 开始 */
  order: number;
  title: string;
  description: string;
  /** 该场旁白文本（空字符串表示无旁白） */
  narration: string;
  /** 期望素材类型，match-assets 据此从 assets 中挑选 */
  assetType: SceneAssetType;
  /** 该场时长（毫秒） */
  durationMs: number;
  /** 指定配音音色（M3 音色库 id）；缺省用常规 TTS 音色 */
  voiceId?: string;
}

export interface Storyboard {
  scenes: StoryboardScene[];
}

/** 素材匹配结果：由 match-assets 节点产出，scene order → 选中素材 id（null 表示用占位/纯字幕） */
export interface MatchResult {
  sceneAssets: Record<number, string | null>;
}

/** 语音合成结果：由 speech-synthesis 节点产出 */
export interface SpeechSegment {
  sceneOrder: number;
  text: string;
  /** TTS 产出的音频素材 id（在 assemble 阶段写入工程 assets） */
  audioAssetId: string;
  audioPath: string;
  durationMs: number;
}

/** ===== 引擎中间状态（贯穿全链路，可序列化用于断点续传） ===== */

export interface AgentState {
  requirement: string;
  sourceDirs: string[];
  scannedAssets: Asset[];
  brief: Brief | null;
  storyboard: Storyboard | null;
  matchResult: MatchResult | null;
  speechSegments: SpeechSegment[];
  project: Project | null;
  completedNodes: PipelineNode[];
}

/** ===== 依赖注入容器（2.1） ===== */

export interface AgentDeps {
  llm: AgentChatModel;
  tts: AgentTtsProvider;
  /**
   * 视频生成 Provider（阶段五补充，2026-09-15）。
   * 可选：未配置（离线）时流水线节点会跳过 AI 生成，整条链路仍可端到端跑通。
   * 真实实现为 MiniMaxH3VideoProvider，由 desktop 在「AI 设置」里配置密钥后注入。
   */
  videoGen?: VideoGenProvider;
  /** 探测素材元数据；生产环境注入 desktop 的 probeMedia，离线环境注入启发式实现 */
  probe: (filePath: string) => Promise<MediaProbe>;
  /** TTS 音频落盘目录 */
  workDir: string;
  /** 进度/调试日志 */
  logger?: (msg: string) => void;
  /**
   * M2：LLM token 级流式回调（creative-brief / storyboard 节点的结构化生成逐块推送），
   * 桌面端据此广播 agent:event type='token' 实现打字机效果。
   */
  onToken?: (node: PipelineNode, delta: string) => void;
  /**
   * 运行时取消信号：由 runPipeline 把 AgentRunOptions.signal 合并进来，
   * 节点内的 invoke/stream 收到 abort 立即中断（不留半流状态）。
   */
  signal?: AbortSignal;
}

/** ===== 运行入口与选项 ===== */

export interface AgentRunOptions {
  /** 用户的一句话需求，例如「做一个 30 秒的夏日旅行 vlog」 */
  requirement: string;
  /** 参与剪辑的素材目录 */
  sourceDirs: string[];
  /** 已有工程（二次编辑场景） */
  project?: Project;
  /** 注入真实 LLM / TTS / 媒体探测；缺省回退到离线 Provider */
  deps?: Partial<AgentDeps>;
  /** 是否跳过人机中断自动续跑（非交互式/测试场景用 true） */
  autoResume?: boolean;
  /** 中断时的回调（桌面端可弹窗让用户修改分镜） */
  onInterrupt?: (state: AgentState) => Promise<void> | void;
  /** 每完成一个节点的进度回调 */
  onProgress?: (node: PipelineNode, state: AgentState) => void;
  /** 断点续传目录；传入则用 JsonFileCheckpointSaver（LangGraph Checkpoint 落盘） */
  checkpointDir?: string;
  /** LangGraph 线程 id；缺省时自动生成（同一 threadId 共享 checkpoint 历史） */
  threadId?: string;
  signal?: AbortSignal;
}

export type AgentRunResult =
  | { status: 'completed'; project: Project; state: AgentState }
  | {
      status: 'interrupted';
      node: PipelineNode;
      state: AgentState;
      /**
       * 人工确认后调用，继续跑剩余节点直至完成。
       * 传入 edited（人工修改后的分镜）时经 LangGraph `Command({ resume })`
       * 注入回 storyboard-review 节点，替代早期「共享可变 state 对象」的隐式传参。
       */
      resume: (edited?: Storyboard | StoryboardScene[]) => Promise<AgentRunResult>;
    };
