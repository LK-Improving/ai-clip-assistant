import { BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { dirname } from 'node:path';
import { resolveFfmpegPath } from './ffmpeg';
import { addAllowedPath, explainAccess } from './protocol';
import { getLibraryStore } from './services/library';
import { getProjectStore } from './services/project-store';
import type { CreateProjectInput } from './services/project-store';
import { probeMedia } from './services/probe';
import { ensurePlayable } from './services/preview';
import { generateThumbnail } from './services/thumbnail';
import { saveAttachment } from './services/attach';
import type { Attachment } from './services/attach';
import { parseDocument } from './services/doc-parse';
import type { AnalyzedAttachment } from './services/doc-parse';
import { detectCapabilities } from './services/render/capabilities';
import { renderProject, RenderAbortError } from './services/render';
import type { ExportQuality } from '../lib/export-request';
import { loadTtsConfig, saveTtsConfig } from './services/tts/config';
import type { TtsConfig } from './services/tts/config';
import { synthesizeSpeech, ttsProbe, ttsRouteTrace, ttsStatus } from './services/tts';
import { resetLocalProbeCache } from './services/tts/providers/local';
import type { Project } from '@miaoma/video-project';
import type { StoryboardScene } from '@miaoma/agent';
import { listRemoteModelIds } from '@miaoma/agent';
import { cancelAgentRun, getAgentStatus, resumeAgentRun, retryAgentRun, startAgentRun } from './services/agent';
import { generateAssistantClips, planAssistantEdit, routeAssistantIntent } from './services/assistant';
import type { GenerateItem } from './services/assistant';
import { addVoice, listVoices, removeVoice, setVoiceSpeaker } from './services/voice';
import { visionStatus, visionCaptionStatus } from './services/vision';
import { describeImage } from './services/vision';
import {
  diffProjects,
  history as projectHistory,
  loadRemoteConfig,
  pullFromRemote,
  pushToRemote,
  readVersion,
  restoreVersion,
  saveRemoteConfig,
  type ProjectDiff,
  type ProjectVersion,
  type RemoteConfig,
} from './services/versioning';
import { isLlmConfigured, loadLlmConfig, saveLlmConfig } from './services/llm/config';
import type { LlmConfig } from './services/llm/config';
import { isVideoGenConfigured, loadVideoGenConfig, saveVideoGenConfig } from './services/video-gen/config';
import type { VideoGenConfig } from './services/video-gen/config';
import { isImageGenConfigured, loadImageGenConfig, saveImageGenConfig } from './services/image-gen/config';
import type { ImageGenConfig } from './services/image-gen/config';
import { deleteThread, listThreads, saveThread } from './services/chat-store';
import type { ChatThread } from './services/chat-store';

function broadcaster() {
  return BrowserWindow.getAllWindows()[0]?.webContents;
}

/**
 * 把工程引用的素材目录登记进 miaoma:// 白名单。
 * 真实素材位于工程目录之外（如 Downloads），不登记则预览 / 渲染时协议层返回 403。
 * 这是「工程自包含」的关键：打开或保存工程时确保素材可被访问。幂等，可重复调用。
 */
function registerProjectAssets(project: Project | null | undefined): void {
  for (const asset of project?.assets ?? []) {
    if (asset.path && !asset.path.includes('://')) addAllowedPath(dirname(asset.path));
  }
}

/** 主进程全部 IPC 入口（渲染进程通过 preload 暴露的 API 调用） */
export function registerIpc(): void {
  ipcMain.handle('app:info', () => ({
    name: '智剪 AI · VideoFlow',
    version: process.env.npm_package_version ?? '0.1.0',
    electron: process.versions.electron ?? '',
    node: process.versions.node,
    chrome: process.versions.chrome ?? '',
    platform: process.platform,
  }));

  ipcMain.handle('ffmpeg:status', () => {
    const bin = resolveFfmpegPath();
    return { path: bin, available: Boolean(bin) };
  });

  ipcMain.handle('library:list', () => getLibraryStore().list());
  ipcMain.handle('library:dirs', () => getLibraryStore().dirs);

  // 语义检索（P2）：返回按余弦得分+关键词加成排序的命中；空查询返回空列表
  ipcMain.handle('library:search', (_event, query: string, topK?: number) =>
    getLibraryStore().search(String(query ?? ''), topK),
  );

  ipcMain.handle('library:scan', async (_event, dirs: string[]) => {
    return getLibraryStore().scan(dirs, (info) => {
      broadcaster()?.send('library:progress', info);
    });
  });

  ipcMain.handle('library:pick-dir', async () => {
    const result = await dialog.showOpenDialog({
      title: '选择素材目录',
      properties: ['openDirectory', 'multiSelections'],
    });
    return result.canceled ? [] : result.filePaths;
  });

  ipcMain.handle('library:pick-files', async () => {
    const result = await dialog.showOpenDialog({
      title: '导入素材',
      properties: ['openFile', 'multiSelections'],
      filters: [
        {
          name: '媒体文件',
          extensions: [
            'mp4', 'mov', 'mkv', 'avi', 'webm', 'm4v',
            'mp3', 'wav', 'm4a', 'aac', 'flac',
            'jpg', 'jpeg', 'png', 'webp', 'gif',
            'srt', 'ass', 'vtt',
          ],
        },
      ],
    });
    return result.canceled ? [] : result.filePaths;
  });

  ipcMain.handle('library:add', async (_event, files: string[]) => getLibraryStore().addFiles(files));
  ipcMain.handle('library:remove', (_event, filePath: string) => getLibraryStore().remove(filePath));
  ipcMain.handle('library:clear', () => getLibraryStore().clear());

  // ===== M3 自定义音色库（零样本克隆）：导入校验/列表/删除；样本在 userData 白名单内可直接试听 =====
  ipcMain.handle('voice:list', () => listVoices());
  ipcMain.handle('voice:add', async (_event, filePath: string, name?: string, cloudSpeaker?: string) =>
    addVoice(filePath, name, cloudSpeaker),
  );
  // 给已有音色绑定/解绑云端复刻 Speaker ID（无 GPU 环境的真实克隆链路）
  ipcMain.handle('voice:set-speaker', (_event, id: string, cloudSpeaker?: string) =>
    setVoiceSpeaker(id, cloudSpeaker),
  );
  ipcMain.handle('voice:remove', (_event, id: string) => removeVoice(id));

  // M4 视觉增强状态（transformers/模型是否就绪 + 不可用原因，供 UI 与日志可观察）
  ipcMain.handle('vision:status', () => visionStatus());

  ipcMain.handle('media:probe', async (_event, filePath: string) => probeMedia(filePath));

  /** 预览加载失败时用来解释原因（文件缺失 / 路径未授权），避免黑屏无从排查 */
  ipcMain.handle('media:diagnose', (_event, filePath: string) => explainAccess(filePath));

  /** 确保素材可被 <video> 播放：不支持的编码按需转码为 H.264 代理（缓存复用）；force 预览失败自动降级强制代理 */
  ipcMain.handle('media:playable', async (_event, filePath: string, force?: boolean) =>
    ensurePlayable(String(filePath ?? ''), Boolean(force)),
  );

  /** 按需生成视频/图片首帧缩略图（项目封面用）；源不可读、非法路径或无 ffmpeg 时返回 null，由前端回退占位 */
  ipcMain.handle('media:thumbnail', async (_event, filePath: string, atMs?: number) => {
    const p = String(filePath ?? '');
    if (!p || p.includes('://')) return null;
    try {
      return await generateThumbnail(p, { atMs: atMs ?? 0, width: 480 });
    } catch {
      return null;
    }
  });

  // ---- 工程持久化：create / get / save / list / remove ----
  ipcMain.handle('project:list', () => getProjectStore().list());

  ipcMain.handle('project:create', (_event, input: CreateProjectInput = {}) => {
    const project = getProjectStore().create(input);
    // 新建工程立即登记（此时 assets 通常为空，登记是幂等的，为后续加素材铺路）
    registerProjectAssets(project);
    return project;
  });

  ipcMain.handle('project:get', (_event, id: string) => {
    const project = getProjectStore().get(id);
    // 打开工程时把其引用素材所在目录一并放行，保证重开工程后 miaoma:// 仍可播放
    registerProjectAssets(project);
    return project;
  });

  ipcMain.handle('project:save', (_event, project: Project) => {
    // 素材所在目录一并放行（新建工程的素材在编辑期加入、首次保存时才进 assets，必须在此登记）
    registerProjectAssets(project);
    return getProjectStore().save(project);
  });

  ipcMain.handle('project:remove', (_event, id: string) => getProjectStore().remove(id));

  // ===== M5 工程版本管理与云端协同（git 引擎，本地优先）=====
  ipcMain.handle('project:history', async (_event, id: string): Promise<ProjectVersion[]> =>
    projectHistory(id),
  );
  ipcMain.handle('project:read-version', (_event, id: string, oid: string) => readVersion(id, oid));
  ipcMain.handle('project:diff-versions', async (_event, id: string, fromOid: string, toOid: string): Promise<ProjectDiff | null> => {
    const before = await readVersion(id, fromOid);
    const after = await readVersion(id, toOid);
    return before && after ? diffProjects(before, after) : null;
  });
  ipcMain.handle('project:restore-version', (_event, id: string, oid: string) => restoreVersion(id, oid));
  ipcMain.handle('version:remote-get', () => loadRemoteConfig());
  ipcMain.handle('version:remote-set', (_event, config: RemoteConfig | null) => {
    saveRemoteConfig(config);
    return loadRemoteConfig();
  });
  ipcMain.handle('version:push', () => pushToRemote());
  ipcMain.handle('version:pull', () => pullFromRemote());

  ipcMain.handle('tts:synthesize', async (_event, request) => synthesizeSpeech(request));
  ipcMain.handle('tts:status', () => ttsStatus());
  /** 连通性检测：火山只握手探活（不产生字符费用）+ 本地协议识别与试合成 */
  ipcMain.handle('tts:probe', (_event, force?: boolean) => ttsProbe({ force: Boolean(force) }));
  /** 最近一次合成的降级链（哪一环不可用、为什么、耗时多少） */
  ipcMain.handle('tts:route-trace', () => ttsRouteTrace());
  ipcMain.handle('tts:get-config', () => loadTtsConfig());
  ipcMain.handle('tts:set-config', (_event, config: TtsConfig) => {
    saveTtsConfig(config);
    // 服务地址/协议改了，旧探活结论必须作废，否则会出现「改了配置仍报旧诊断」
    resetLocalProbeCache();
    return loadTtsConfig();
  });

  // ---- 模块 4.2：渲染通信 + 进度/取消 ----
  let activeRender: AbortController | null = null;

  ipcMain.handle('render:capabilities', () => {
    const bin = resolveFfmpegPath();
    if (!bin) return { available: false, path: null };
    const caps = detectCapabilities(bin);
    return { available: true, path: bin, ...caps };
  });

  ipcMain.handle(
    'render:start',
    async (_event, req: { project: Project; outputPath: string; encoder?: string; quality?: ExportQuality }) => {
      const controller = new AbortController();
      activeRender = controller;
      try {
        const result = await renderProject({
          project: req.project,
          outputPath: req.outputPath,
          encoder: req.encoder,
          quality: req.quality,
          signal: controller.signal,
          onProgress: (p) => broadcaster()?.send('render:progress', p),
        });
        return result;
      } catch (error) {
        if (error instanceof RenderAbortError) {
          throw new Error('RENDER_CANCELLED');
        }
        throw error;
      } finally {
        activeRender = null;
      }
    },
  );

  ipcMain.handle('render:cancel', () => {
    activeRender?.abort();
    activeRender = null;
    return true;
  });

  // ---- 模块 4.3：导出目录选择 + 打开文件 ----
  ipcMain.handle('export:pick-dir', async () => {
    const result = await dialog.showOpenDialog({
      title: '选择导出目录',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    const dir = result.filePaths[0]!;
    addAllowedPath(dir);
    return dir;
  });

  ipcMain.handle('export:default-dir', async () => {
    try {
      const { app } = require('electron') as typeof import('electron');
      const dir = dirname(app.getPath('userData')) + '/exports';
      const fs = await import('node:fs/promises');
      await fs.mkdir(dir, { recursive: true });
      addAllowedPath(dir);
      return dir;
    } catch {
      return null;
    }
  });

  /** 系统「另存为」写文本文件（分镜脚本导出等）：取消返回 {saved:false}，写失败带 error */
  ipcMain.handle(
    'file:save-text',
    async (_event, opts: { defaultName: string; content: string }) => {
      const win = BrowserWindow.getFocusedWindow();
      const options = {
        title: '导出脚本',
        defaultPath: opts.defaultName,
        filters: [
          { name: 'Markdown', extensions: ['md'] },
          { name: '文本文件', extensions: ['txt'] },
          { name: '所有文件', extensions: ['*'] },
        ],
      };
      const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options);
      if (result.canceled || !result.filePath) return { saved: false as const };
      try {
        const fs = await import('node:fs/promises');
        await fs.writeFile(result.filePath, opts.content, 'utf8');
        return { saved: true as const, filePath: result.filePath };
      } catch (error) {
        return { saved: false as const, error: (error as Error).message };
      }
    },
  );

  /** 视频「另存为」：弹系统保存框选目标路径（不写内容，由渲染层 render:start 落盘）；取消返回 null */
  ipcMain.handle('export:pick-save-path', async (_event, defaultName: string) => {
    const win = BrowserWindow.getFocusedWindow();
    const options = {
      title: '选择导出位置',
      defaultPath: defaultName,
      filters: [{ name: '视频文件', extensions: ['mp4'] }],
    };
    const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return null;
    addAllowedPath(dirname(result.filePath));
    return result.filePath;
  });

  ipcMain.handle('shell:open-path', (_event, target: string) => shell.openPath(target));

  // ===== AI 助手会话持久化（多会话/记忆） =====
  ipcMain.handle('chat:list', () => listThreads());
  ipcMain.handle('chat:save', (_event, thread: ChatThread) => saveThread(thread));
  ipcMain.handle('chat:delete', (_event, id: string) => deleteThread(id));

  // ===== 聊天附件接收（P1）：渲染层粘贴 → base64 → 落 userData/temp + 白名单 + 安全兜底 =====
  ipcMain.handle('attach:save', (_event, input: { name: string; mime?: string; dataBase64: string }) =>
    saveAttachment(input),
  );

  // ===== 附件内容分析（P2：L1–L2）：文档→纯文本；图片/音视频回占位说明 =====
  ipcMain.handle('input:analyze', async (_event, attachments: Attachment[]): Promise<AnalyzedAttachment[]> => {
    const list = Array.isArray(attachments) ? attachments.slice(0, 20) : [];
    return Promise.all(
      list.map(async (a): Promise<AnalyzedAttachment> => {
        try {
          const parsed = await parseDocument({ path: a.path, name: a.name, kind: a.kind });
          // L3：图片附件补视觉描述（激活 Provider 配了 visionModel 时）；不可用则把原因写进 note，让用户知道大模型有没有真读到图
          if (a.kind === 'image') {
            try {
              parsed.caption = (await describeImage(a.path)) ?? undefined;
            } catch {
              /* vision 未就绪：忽略 caption */
            }
            if (parsed.caption) {
              parsed.note = undefined; // 识别成功：抹掉 doc-parse 的占位说明，避免与 caption 矛盾
            } else {
              const status = visionCaptionStatus();
              parsed.note = status.available
                ? `图片「${a.name}」视觉识别失败（超时或接口异常），不影响分镜生成；角色一致性由设计图直接作为参考图锁定`
                : `图片「${a.name}」未做内容识别：${status.reason}；不影响分镜生成，角色一致性由设计图直接作为参考图锁定`;
            }
          }
          return { id: a.id, name: a.name, ...parsed };
        } catch (error) {
          return { id: a.id, name: a.name, kind: a.kind, text: '', chars: 0, note: `解析失败：${(error as Error).message}` };
        }
      }),
    );
  });

  // ===== 阶段二：AI 智能体引擎 =====
  ipcMain.handle(
    'agent:start',
    async (_event, input: { requirement: string; sourceDirs: string[]; referenceImages?: string[] }) => startAgentRun(input),
  );
  ipcMain.handle('agent:resume', async (_event, scenes?: StoryboardScene[]) =>
    resumeAgentRun(scenes),
  );
  /** 断点重试：从磁盘 LangGraph Checkpoint 恢复失败/崩溃的流水线；无断点时抛错由前端提示 */
  ipcMain.handle('agent:retry', () => retryAgentRun());
  ipcMain.handle('agent:status', () => getAgentStatus());
  ipcMain.handle('agent:cancel', () => cancelAgentRun());

  ipcMain.handle('llm:get-config', () => loadLlmConfig());
  ipcMain.handle('llm:set-config', (_event, config: LlmConfig) => {
    saveLlmConfig(config);
    return loadLlmConfig();
  });
  ipcMain.handle('llm:status', () => {
    const config = loadLlmConfig();
    return { active: config.active, configured: isLlmConfigured(config) };
  });

  /**
   * AI 助手：自然语言 → 时间线改动计划。
   * 主进程只出计划不改状态，ref 解析与执行在渲染进程 store（单一事实源）。
   */
  ipcMain.handle('assistant:plan', (_event, input: Parameters<typeof planAssistantEdit>[0]) =>
    planAssistantEdit(input),
  );

  // 多模态输入意图路由（P3）：仅当携带附件时由渲染层调用
  ipcMain.handle('assistant:route', (_event, input: Parameters<typeof routeAssistantIntent>[0]) =>
    routeAssistantIntent(input),
  );

  /**
   * AI 助手：逐段执行 AI 生视频（花钱动作）。
   * 只在渲染进程展示确认卡片、用户点「确认应用」后才会被调用。
   */
  ipcMain.handle('assistant:generate-clips', (_event, items: GenerateItem[]) =>
    generateAssistantClips(Array.isArray(items) ? items : []),
  );

  // ===== 视频生成模型（阶段五补充，2026-09-15） =====
  ipcMain.handle('videoGen:get-config', () => loadVideoGenConfig());
  ipcMain.handle('videoGen:set-config', (_event, config: VideoGenConfig) => {
    saveVideoGenConfig(config);
    return loadVideoGenConfig();
  });
  ipcMain.handle('videoGen:status', () => {
    const config = loadVideoGenConfig();
    return { active: config.active, configured: isVideoGenConfigured(config) };
  });

  // ===== 图像生成模型（P4a）：分镜关键帧 =====
  ipcMain.handle('imageGen:get-config', () => loadImageGenConfig());
  ipcMain.handle('imageGen:set-config', (_event, config: ImageGenConfig) => {
    saveImageGenConfig(config);
    return loadImageGenConfig();
  });
  ipcMain.handle('imageGen:status', () => {
    const config = loadImageGenConfig();
    return { active: config.active, configured: isImageGenConfigured(config) };
  });

  /**
   * 拉取接入点可用的视频模型 id（方舟 id 是小写带日期版本，手填几乎必错）。
   * 不传参数则用已保存的配置；传了则用表单当前值（支持“没保存先试一下”）。
   */
  ipcMain.handle(
    'videoGen:list-models',
    async (_event, opts?: { apiKey?: string; baseUrl?: string }) => {
      const cfg = loadVideoGenConfig();
      const source = cfg.active === 'custom' ? cfg.custom : cfg.seedance;
      const baseUrl = String(opts?.baseUrl ?? source.baseUrl ?? '').trim();
      const apiKey = String(opts?.apiKey ?? source.apiKey ?? '').trim();
      if (!baseUrl) return { ok: false, models: [] as string[], error: '接入点为空，请先填写接入点' };
      try {
        const models = await listRemoteModelIds({ baseUrl, apiKey });
        if (!models.length) {
          return {
            ok: false,
            models,
            error: '接入点未返回可用的视频模型 id（方舟需先在控制台开通模型服务）',
          };
        }
        return { ok: true, models, error: undefined as string | undefined };
      } catch (e) {
        return { ok: false, models: [] as string[], error: (e as Error).message };
      }
    },
  );
}
