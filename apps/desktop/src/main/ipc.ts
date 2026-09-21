import { BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { dirname } from 'node:path';
import { resolveFfmpegPath } from './ffmpeg';
import { addAllowedPath, explainAccess } from './protocol';
import { getLibraryStore } from './services/library';
import { getProjectStore } from './services/project-store';
import type { CreateProjectInput } from './services/project-store';
import { probeMedia } from './services/probe';
import { ensurePlayable } from './services/preview';
import { detectCapabilities } from './services/render/capabilities';
import { renderProject, RenderAbortError } from './services/render';
import type { ExportQuality } from '../lib/export-request';
import { loadTtsConfig, saveTtsConfig } from './services/tts/config';
import { synthesizeSpeech, ttsStatus } from './services/tts';
import type { TtsConfig } from './services/tts/config';
import type { Project } from '@miaoma/video-project';
import type { StoryboardScene } from '@miaoma/agent';
import { listRemoteModelIds } from '@miaoma/agent';
import { cancelAgentRun, getAgentStatus, resumeAgentRun, retryAgentRun, startAgentRun } from './services/agent';
import { planAssistantEdit } from './services/assistant';
import { addVoice, listVoices, removeVoice } from './services/voice';
import { visionStatus } from './services/vision';
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
    name: 'KK剪映',
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
  ipcMain.handle('voice:add', async (_event, filePath: string, name?: string) => addVoice(filePath, name));
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
  ipcMain.handle('tts:get-config', () => loadTtsConfig());
  ipcMain.handle('tts:set-config', (_event, config: TtsConfig) => {
    saveTtsConfig(config);
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

  ipcMain.handle('shell:open-path', (_event, target: string) => shell.openPath(target));

  // ===== 阶段二：AI 智能体引擎 =====
  ipcMain.handle(
    'agent:start',
    async (_event, input: { requirement: string; sourceDirs: string[] }) => startAgentRun(input),
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
