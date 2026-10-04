import { contextBridge, ipcRenderer } from 'electron';
import type { AssetKind, LibraryEntry, LibrarySearchHit, ScanSummary } from './main/services/library';
import type { Attachment } from './main/services/attach';
import type { AnalyzedAttachment } from './main/services/doc-parse';
import type { ChatThread } from './main/services/chat-store';
import type { VoiceProfile } from './main/services/voice';
import type { ProjectDiff, ProjectVersion, RemoteConfig } from './main/services/versioning';
import type { CreateProjectInput, ProjectSummary } from './main/services/project-store';
import type { ProbeResult } from './main/services/probe';
import type { PlayableResult } from './main/services/preview';
import type { RenderProgress, RenderResult } from './main/services/render';
import type { TtsConfig } from './main/services/tts/config';
import type { TtsProbeReport, TtsRequest, TtsResult, TtsRouteStep } from './main/services/tts';
import type { Project } from '@miaoma/video-project';
import type { PipelineNode, StoryboardScene } from '@miaoma/agent';
import type { AssistantTimelineSnapshot, RouteAttachment, RouteDecision } from '@miaoma/agent';
import type { AgentSnapshot } from './main/services/agent';
import type { AssistantPlanResult, GenerateItem, GenerateOutcome } from './main/services/assistant';
import type { LlmConfig } from './main/services/llm/config';
import type { VideoGenConfig } from './main/services/video-gen/config';
import type { ImageGenConfig } from './main/services/image-gen/config';
import type { ExportQuality } from './lib/export-request';

/** 主进程广播的 AI 任务事件（seq 为自增序号，渲染进程据此检测断档并用 status 快照补偿） */
export interface AgentEvent {
  seq?: number;
  type: 'progress' | 'log' | 'interrupted' | 'completed' | 'error' | 'token';
  node?: PipelineNode;
  message?: string;
  /** M2：token 流式增量（type='token' 时存在） */
  delta?: string;
  snapshot?: AgentSnapshot;
}

export interface AppInfo {
  name: string;
  version: string;
  electron: string;
  node: string;
  chrome: string;
  platform: NodeJS.Platform;
}

export interface LibraryProgress {
  current: number;
  total: number;
  file: string;
}

/** 把本地绝对路径转成渲染进程可访问的 miaoma:// 地址 */
function toMediaUrl(localPath: string): string {
  return `miaoma:///${encodeURIComponent(localPath)}`;
}

/**
 * 预加载脚本：唯一的 bridge 边界。
 * 渲染进程只能通过 window.electronAPI 访问主进程能力，禁止直接 require('electron')。
 */
const api = {
  getAppInfo: (): Promise<AppInfo> => ipcRenderer.invoke('app:info') as Promise<AppInfo>,
  ffmpegStatus: (): Promise<{ path: string | null; available: boolean }> =>
    ipcRenderer.invoke('ffmpeg:status'),
  toMediaUrl,

  library: {
    list: (): Promise<LibraryEntry[]> => ipcRenderer.invoke('library:list'),
    dirs: (): Promise<string[]> => ipcRenderer.invoke('library:dirs'),
    /** 语义检索（P2）：本地特征向量 + 关键词加成的排序命中 */
    search: (query: string, topK?: number): Promise<LibrarySearchHit[]> =>
      ipcRenderer.invoke('library:search', query, topK),
    scan: (dirs: string[]): Promise<ScanSummary> => ipcRenderer.invoke('library:scan', dirs),
    pickDir: (): Promise<string[]> => ipcRenderer.invoke('library:pick-dir'),
    pickFiles: (): Promise<string[]> => ipcRenderer.invoke('library:pick-files'),
    add: (files: string[]): Promise<LibraryEntry[]> => ipcRenderer.invoke('library:add', files),
    remove: (filePath: string): Promise<void> => ipcRenderer.invoke('library:remove', filePath),
    clear: (): Promise<void> => ipcRenderer.invoke('library:clear'),
    /** 订阅扫描进度，返回取消订阅函数 */
    onProgress: (callback: (progress: LibraryProgress) => void): (() => void) => {
      const listener = (_event: unknown, progress: LibraryProgress) => callback(progress);
      ipcRenderer.on('library:progress', listener);
      return () => ipcRenderer.removeListener('library:progress', listener);
    },
  },

  /** 聊天附件接收（P1）：粘贴/拖拽的 base64 内容落主进程临时目录，返回可展示的本地附件 */
  attach: {
    save: (input: { name: string; mime?: string; dataBase64: string }): Promise<Attachment> =>
      ipcRenderer.invoke('attach:save', input),
  },

  /** AI 助手会话持久化（多会话/记忆） */
  chat: {
    list: (): Promise<ChatThread[]> => ipcRenderer.invoke('chat:list'),
    save: (thread: ChatThread): Promise<ChatThread> => ipcRenderer.invoke('chat:save', thread),
    remove: (id: string): Promise<boolean> => ipcRenderer.invoke('chat:delete', id),
  },

  /** 附件内容分析（P2：L1–L2）：文档→纯文本；图片/音视频回占位说明 */
  input: {
    analyze: (attachments: Attachment[]): Promise<AnalyzedAttachment[]> =>
      ipcRenderer.invoke('input:analyze', attachments),
  },

  media: {
    probe: (filePath: string): Promise<ProbeResult> => ipcRenderer.invoke('media:probe', filePath),
    /** 解释某个本地路径为何无法被预览加载（不存在 / 未授权） */
    diagnose: (filePath: string): Promise<{ ok: boolean; reason: string }> =>
      ipcRenderer.invoke('media:diagnose', filePath),
    /** 确保素材可被 <video> 播放：编码不支持时转码 H.264 代理；force=true 跳过编码白名单强制出 faststart 代理 */
    playable: (filePath: string, force?: boolean): Promise<PlayableResult> =>
      ipcRenderer.invoke('media:playable', filePath, force),
    /** 按需生成首帧缩略图（项目封面），返回本地 jpg 绝对路径（再经 toMediaUrl 展示）；失败返回 null */
    thumbnail: (filePath: string, atMs?: number): Promise<string | null> =>
      ipcRenderer.invoke('media:thumbnail', filePath, atMs),
  },

  project: {
    list: (): Promise<ProjectSummary[]> => ipcRenderer.invoke('project:list'),
    create: (input: CreateProjectInput = {}): Promise<Project> =>
      ipcRenderer.invoke('project:create', input),
    get: (id: string): Promise<Project | null> => ipcRenderer.invoke('project:get', id),
    save: (project: Project): Promise<Project> => ipcRenderer.invoke('project:save', project),
    remove: (id: string): Promise<boolean> => ipcRenderer.invoke('project:remove', id),
    /** M5 版本管理：历史/读版/diff/回滚（回滚作为新版本落盘） */
    history: (id: string): Promise<ProjectVersion[]> => ipcRenderer.invoke('project:history', id),
    readVersion: (id: string, oid: string): Promise<Project | null> =>
      ipcRenderer.invoke('project:read-version', id, oid),
    diffVersions: (id: string, fromOid: string, toOid: string): Promise<ProjectDiff | null> =>
      ipcRenderer.invoke('project:diff-versions', id, fromOid, toOid),
    restoreVersion: (id: string, oid: string): Promise<Project> =>
      ipcRenderer.invoke('project:restore-version', id, oid),
  },

  /** M5 云端协同：远端配置与手动 push/pull（本地历史离线完整可用） */
  version: {
    remoteGet: (): Promise<RemoteConfig | null> => ipcRenderer.invoke('version:remote-get'),
    remoteSet: (config: RemoteConfig | null): Promise<RemoteConfig | null> =>
      ipcRenderer.invoke('version:remote-set', config),
    push: (): Promise<string> => ipcRenderer.invoke('version:push'),
    pull: (): Promise<string> => ipcRenderer.invoke('version:pull'),
  },

  tts: {
    synthesize: (request: TtsRequest): Promise<TtsResult> =>
      ipcRenderer.invoke('tts:synthesize', request),
    status: () => ipcRenderer.invoke('tts:status'),
    /** 连通性检测：force=true 跳过 60s 探活缓存重跑一次 */
    probe: (force?: boolean): Promise<TtsProbeReport> => ipcRenderer.invoke('tts:probe', force),
    /** 最近一次合成的降级链（本地零样本 → 云端复刻 → 在线） */
    routeTrace: (): Promise<TtsRouteStep[]> => ipcRenderer.invoke('tts:route-trace'),
    getConfig: (): Promise<TtsConfig> => ipcRenderer.invoke('tts:get-config'),
    setConfig: (config: TtsConfig): Promise<TtsConfig> => ipcRenderer.invoke('tts:set-config', config),
  },

  render: {
    capabilities: (): Promise<
      | { available: false; path: null }
      | ({ available: true; path: string } & import('./main/services/render').RenderCapabilities)
    > => ipcRenderer.invoke('render:capabilities'),
    start: (req: {
      project: Project;
      outputPath: string;
      encoder?: string;
      quality?: ExportQuality;
    }): Promise<RenderResult> => ipcRenderer.invoke('render:start', req),
    cancel: (): Promise<boolean> => ipcRenderer.invoke('render:cancel'),
    /** 订阅渲染进度；返回取消订阅函数 */
    onProgress: (callback: (progress: RenderProgress) => void): (() => void) => {
      const listener = (_event: unknown, progress: RenderProgress) => callback(progress);
      ipcRenderer.on('render:progress', listener);
      return () => ipcRenderer.removeListener('render:progress', listener);
    },
  },

  export: {
    pickDir: (): Promise<string | null> => ipcRenderer.invoke('export:pick-dir'),
    defaultDir: (): Promise<string | null> => ipcRenderer.invoke('export:default-dir'),
    /** 系统「另存为」写文本（分镜脚本导出）；取消/失败返回带标志的对象 */
    saveText: (
      opts: { defaultName: string; content: string },
    ): Promise<{ saved: boolean; filePath?: string; error?: string }> =>
      ipcRenderer.invoke('file:save-text', opts),
    /** 视频另存为：弹系统保存框选目标路径（mp4）；取消返回 null */
    pickSavePath: (defaultName: string): Promise<string | null> =>
      ipcRenderer.invoke('export:pick-save-path', defaultName),
  },

  shell: {
    openPath: (target: string): Promise<string> => ipcRenderer.invoke('shell:open-path', target),
  },

  llm: {
    getConfig: (): Promise<LlmConfig> => ipcRenderer.invoke('llm:get-config'),
    setConfig: (config: LlmConfig): Promise<LlmConfig> => ipcRenderer.invoke('llm:set-config', config),
    status: (): Promise<{ active: LlmConfig['active']; configured: boolean }> =>
      ipcRenderer.invoke('llm:status'),
  },

  agent: {
    /** 启动一次 AI 剪辑，跑到分镜规划后中断；referenceImages 为角色设计图/主体参考图路径（可选） */
    start: (input: { requirement: string; sourceDirs: string[]; referenceImages?: string[] }): Promise<AgentSnapshot> =>
      ipcRenderer.invoke('agent:start', input),
    /** 分镜确认/修改后续跑；传 scenes 则替换引擎内部分镜 */
    resume: (scenes?: StoryboardScene[]): Promise<AgentSnapshot> =>
      ipcRenderer.invoke('agent:resume', scenes),
    /** 断点重试：从磁盘 LangGraph Checkpoint 恢复失败/崩溃的流水线 */
    retry: (): Promise<AgentSnapshot> => ipcRenderer.invoke('agent:retry'),
    status: (): Promise<AgentSnapshot> => ipcRenderer.invoke('agent:status'),
    cancel: (): Promise<boolean> => ipcRenderer.invoke('agent:cancel'),
    /** 订阅进度/中断/完成事件，返回取消订阅函数 */
    onEvent: (callback: (event: AgentEvent) => void): (() => void) => {
      const listener = (_event: unknown, payload: AgentEvent) => callback(payload);
      ipcRenderer.on('agent:event', listener);
      return () => ipcRenderer.removeListener('agent:event', listener);
    },
  },

  /**
   * AI 助手：自然语言 → 时间线改动计划。
   * 主进程只出计划，ref 解析、用户确认与执行都在渲染进程的时间线 store 里做。
   */
  assistant: {
    /** 自然语言 → 改动计划（含花钱动作的费用预估）；history 为最近若干轮上下文 */
    plan: (input: {
      message: string;
      snapshot: AssistantTimelineSnapshot;
      history?: { role: 'user' | 'assistant'; text: string }[];
      /** 会话内已解析的文档附件内容（跨轮记忆） */
      docs?: { name: string; text: string }[];
    }): Promise<AssistantPlanResult> => ipcRenderer.invoke('assistant:plan', input),
    /** 多模态输入意图路由（P3）：带附件时判断走哪条能力链 */
    route: (input: { message: string; attachments: RouteAttachment[] }): Promise<RouteDecision> =>
      ipcRenderer.invoke('assistant:route', input),
    /** 逐段执行 AI 生视频（仅用户确认后调用） */
    generateClips: (items: GenerateItem[]): Promise<GenerateOutcome[]> =>
      ipcRenderer.invoke('assistant:generate-clips', items),
  },

  videoGen: {
    getConfig: (): Promise<VideoGenConfig> => ipcRenderer.invoke('videoGen:get-config'),
    setConfig: (config: VideoGenConfig): Promise<VideoGenConfig> =>
      ipcRenderer.invoke('videoGen:set-config', config),
    status: (): Promise<{ active: VideoGenConfig['active']; configured: boolean }> =>
      ipcRenderer.invoke('videoGen:status'),
    /** 拉取接入点可用的视频模型 id；不传则用已保存配置 */
    listModels: (
      opts?: { apiKey?: string; baseUrl?: string },
    ): Promise<{ ok: boolean; models: string[]; error?: string }> =>
      ipcRenderer.invoke('videoGen:list-models', opts),
  },

  /** 图像生成模型（P4a）：分镜关键帧（千问图像） */
  imageGen: {
    getConfig: (): Promise<ImageGenConfig> => ipcRenderer.invoke('imageGen:get-config'),
    setConfig: (config: ImageGenConfig): Promise<ImageGenConfig> => ipcRenderer.invoke('imageGen:set-config', config),
    status: (): Promise<{ active: ImageGenConfig['active']; configured: boolean }> =>
      ipcRenderer.invoke('imageGen:status'),
  },

  /** M3 自定义音色库（零样本克隆）：导入带校验，删除连带样本清理 */
  voice: {
    list: (): Promise<VoiceProfile[]> => ipcRenderer.invoke('voice:list'),
    /** 导入参考音频；校验失败抛中文错误（时长 3–20s/非静音/格式）。可选同时绑定云端复刻 Speaker ID */
    add: (filePath: string, name?: string, cloudSpeaker?: string): Promise<VoiceProfile> =>
      ipcRenderer.invoke('voice:add', filePath, name, cloudSpeaker),
    /** 绑定/解绑云端复刻 Speaker ID（S_xxxxx）；无 GPU 环境的真实零样本克隆路径 */
    setSpeaker: (id: string, cloudSpeaker?: string): Promise<VoiceProfile> =>
      ipcRenderer.invoke('voice:set-speaker', id, cloudSpeaker),
    remove: (id: string): Promise<boolean> => ipcRenderer.invoke('voice:remove', id),
  },

  /** M4 视觉增强（CLIP/方舟 caption）就绪状态，供 UI 可观察 */
  vision: {
    status: (): Promise<{ installed: boolean; modelPresent: boolean; ready: boolean; reason: string }> =>
      ipcRenderer.invoke('vision:status'),
  },

  platform: process.platform,
};

contextBridge.exposeInMainWorld('electronAPI', api);

export type DesktopApi = typeof api;
export type {
  AssetKind,
  Attachment,
  AnalyzedAttachment,
  ChatThread,
  CreateProjectInput,
  LibraryEntry,
  LibrarySearchHit,
  ProbeResult,
  PlayableResult,
  ProjectSummary,
  ScanSummary,
  TtsConfig,
  TtsProbeReport,
  TtsRequest,
  TtsResult,
  TtsRouteStep,
  VoiceProfile,
  ProjectDiff,
  ProjectVersion,
  RemoteConfig,
  RenderProgress,
  RenderResult,
  AgentSnapshot,
  RouteAttachment,
  RouteDecision,
  StoryboardScene,
  PipelineNode,
  LlmConfig,
  VideoGenConfig,
  ImageGenConfig,
};
