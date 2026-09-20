import * as nodeFs from 'node:fs';
import path from 'node:path';
import * as git from 'isomorphic-git';
import * as gitHttp from 'isomorphic-git/http/node';
import { app } from 'electron';
import { migrateProject, ProjectSchema, type Project } from '@miaoma/video-project';

/**
 * 统一用 namespace 导入：esbuild 对 external CJS 的 default interop 在模块顶层求值时不可靠
 * （曾致 git.init 收到 undefined fs）；namespace 属性直连 require 结果，无 default 歧义。
 */
const fs = nodeFs as unknown as typeof nodeFs & Record<string, unknown>;
const http = gitHttp as unknown as Parameters<typeof git.push>[0]['http'];
const { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } = nodeFs;

/**
 * 工程版本管理 + 云端协同（M5，PDF P19「云端协同版本管理」）。
 *
 * 不建后端：用 git 引擎（isomorphic-git，纯 JS）同时满足两个词——
 * - **版本管理**：工程每次保存自动快照提交到 `userData/project-repo`（一工程一文件的布局天然可 diff），
 *   支持历史列表、任意版本读取、字段级 diff、一键回滚（回滚落盘为新版本，历史线性不重写）；
 * - **云端协同**：可配置远端（GitHub/Gitee https + token）手动 push/pull；
 *   离线时本地历史完整可用，不破坏隐私定位。
 *
 * 自愈：仓库损坏（垃圾 .git）时重建一次并重试操作，绝不因版本系统卡死保存链路
 * （快照失败只记日志，保存本身永远成功——版本是增强，不是依赖）。
 */

const REPO_DIR_NAME = 'project-repo';
const REMOTE_FILE_NAME = 'project-remote.json';
const BRANCH = 'main';
const AUTHOR = { name: 'KK Jianying', email: 'versioning@local.app' };

function repoDir(): string {
  const dir = path.join(app.getPath('userData'), REPO_DIR_NAME);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function remoteFile(): string {
  return path.join(app.getPath('userData'), REMOTE_FILE_NAME);
}

function relPath(projectId: string): string {
  return `projects/${projectId}.mmproj.json`;
}

async function ensureRepo(): Promise<void> {
  if (!existsSync(path.join(repoDir(), '.git'))) {
    await git.init({ fs, dir: repoDir(), defaultBranch: BRANCH });
  }
}

/** 仓库损坏自愈包装：失败 → 重建仓库 → 重试一次 */
async function withRebuild<T>(op: () => Promise<T>): Promise<T> {
  try {
    await ensureRepo();
    return await op();
  } catch (e) {
    const msg = (e as Error).message ?? '';
    // 明确的仓库损坏/不可用特征才重建；业务错误原样上抛
    if (/corrupt|ENOENT|Cannot find|invalid|not a git object|missing|Unknown|bad object|requires a|not a repository|EmptyRepositoryError|AlreadyExistsError|NotFoundError/i.test(msg)) {
      rmSync(repoDir(), { recursive: true, force: true });
      await ensureRepo();
      return await op();
    }
    throw e;
  }
}

export interface ProjectVersion {
  oid: string;
  message: string;
  timestampMs: number;
  committer: string;
}

/**
 * 快照一次工程保存（store.save 成功后由钩子调用；失败不影响保存主链路）。
 * 无内容变化时 git 层会产出等值 commit——先比对工作区文件跳过，避免历史噪音。
 */
export async function snapshotProject(project: Project, note?: string): Promise<boolean> {
  return withRebuild(async () => {
    const dir = repoDir();
    const file = relPath(project.id);
    const abs = path.join(dir, file);
    const content = JSON.stringify(project, null, 2);
    if (existsSync(abs) && readFileSync(abs, 'utf8') === content) return false;
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content, 'utf8');
    await git.add({ fs, dir, filepath: file });
    await git.commit({
      fs,
      dir,
      ref: BRANCH,
      author: { ...AUTHOR, timestamp: Math.floor(Date.now() / 1000) },
      message: note ? `save: ${project.name}（${note}）` : `save: ${project.name}`,
    });
    return true;
  }).catch(() => false);
}

/** 工程版本历史（新→旧）；读失败自愈重建后返回空列表而非抛错 */
export async function history(projectId: string, limit = 50): Promise<ProjectVersion[]> {
  return withRebuild(async () => {
    const log = await git.log({
      fs,
      dir: repoDir(),
      ref: BRANCH,
      filepath: relPath(projectId),
      depth: limit,
    });
    return log.map((entry) => ({
      oid: entry.oid,
      message: entry.commit.message.trim(),
      timestampMs: (entry.commit.author?.timestamp ?? 0) * 1000,
      committer: entry.commit.author?.name ?? '',
    }));
  }).catch(() => []);
}

/** 读取指定版本的工程（Zod 合法才返回；坏数据 null，由调用方提示） */
export async function readVersion(projectId: string, oid: string): Promise<Project | null> {
  return withRebuild(async () => {
    const { blob } = await git.readBlob({ fs, dir: repoDir(), oid, filepath: relPath(projectId) });
    const raw = JSON.parse(Buffer.from(blob).toString('utf8')) as unknown;
    return ProjectSchema.safeParse(migrateProject(raw)).data ?? null;
  }).catch(() => null);
}

/** 字段级 diff 统计（版本面板展示用，不输出全量 payload） */
export interface ProjectDiff {
  changed: boolean;
  nameChanged: boolean;
  tracksAdded: number;
  tracksRemoved: number;
  clipsAdded: number;
  clipsRemoved: number;
  assetsAdded: number;
  assetsRemoved: number;
  durationDeltaMs: number;
}

function clipIds(project: Project): Set<string> {
  return new Set(project.tracks.flatMap((t) => t.clips.map((c) => c.id)));
}

export function diffProjects(before: Project, after: Project): ProjectDiff {
  const trackIds = (p: Project) => new Set(p.tracks.map((t) => t.id));
  const beforeTracks = trackIds(before);
  const afterTracks = trackIds(after);
  const beforeClips = clipIds(before);
  const afterClips = clipIds(after);
  const beforeAssets = new Set(before.assets.map((a) => a.id));
  const afterAssets = new Set(after.assets.map((a) => a.id));
  const sum = (p: Project) =>
    p.tracks.filter((t) => t.type !== 'text').reduce((m, t) => Math.max(m, ...t.clips.map((c) => c.start + c.duration), 0), 0);
  const durationDeltaMs = sum(after) - sum(before);
  const nameChanged = before.name !== after.name;
  const changed =
    nameChanged ||
    beforeTracks.size !== afterTracks.size ||
    beforeClips.size !== afterClips.size ||
    beforeAssets.size !== afterAssets.size ||
    durationDeltaMs !== 0 ||
    [...beforeClips].some((id) => !afterClips.has(id));
  return {
    changed,
    nameChanged,
    tracksAdded: [...afterTracks].filter((id) => !beforeTracks.has(id)).length,
    tracksRemoved: [...beforeTracks].filter((id) => !afterTracks.has(id)).length,
    clipsAdded: [...afterClips].filter((id) => !beforeClips.has(id)).length,
    clipsRemoved: [...beforeClips].filter((id) => !afterClips.has(id)).length,
    assetsAdded: [...afterAssets].filter((id) => !beforeAssets.has(id)).length,
    assetsRemoved: [...beforeAssets].filter((id) => !afterAssets.has(id)).length,
    durationDeltaMs,
  };
}

/** 回滚：把指定版本作为新版本落盘（历史线性，不重写 git 历史） */
export async function restoreVersion(projectId: string, oid: string): Promise<Project> {
  const project = await readVersion(projectId, oid);
  if (!project) throw new Error('该版本内容无法解析（可能已损坏），回滚中止');
  const { getProjectStore } = await import('./project-store');
  // 动态 import 打破 store↔versioning 静态循环；save 钩子的快照是 fire-and-forget，
  // 这里再显式 await 一次带 rollback 标注的快照：钩子先提交则内容去重跳过，
  // 本调用先提交则钩子去重——两条路径都保证历史 +1 且时序确定
  const saved = await getProjectStore().save(project);
  await snapshotProject(saved, `回滚自 ${oid.slice(0, 7)}`);
  return saved;
}

// ===== 云端协同（可选远端 push/pull） =====

export interface RemoteConfig {
  url: string;
  /** GitHub/Gitee 个人访问 token（仅存 userData，不进工程与日志） */
  token?: string;
}

export function loadRemoteConfig(): RemoteConfig | null {
  try {
    const raw = JSON.parse(readFileSync(remoteFile(), 'utf8')) as RemoteConfig;
    return raw.url ? raw : null;
  } catch {
    return null;
  }
}

export function saveRemoteConfig(config: RemoteConfig | null): void {
  if (!config || !config.url) {
    rmSync(remoteFile(), { force: true });
    return;
  }
  writeFileSync(remoteFile(), JSON.stringify(config, null, 2), 'utf8');
}

function authFor(config: RemoteConfig): (() => { username: string; password: string }) | undefined {
  // isomorphic-git v12：auth 参数改名 onAuth（token 走 https basic）
  return config.token ? () => ({ username: 'x-access-token', password: config.token! }) : undefined;
}

export async function pushToRemote(): Promise<string> {
  const config = loadRemoteConfig();
  if (!config) throw new Error('尚未配置远端仓库（设置 → 版本协同）');
  await withRebuild(() =>
    git.push({ fs, http, dir: repoDir(), url: config.url, ref: BRANCH, onAuth: authFor(config) }),
  );
  return '推送完成';
}

export async function pullFromRemote(): Promise<string> {
  const config = loadRemoteConfig();
  if (!config) throw new Error('尚未配置远端仓库（设置 → 版本协同）');
  await withRebuild(() =>
    git.pull({
      fs,
      http,
      dir: repoDir(),
      url: config.url,
      ref: BRANCH,
      singleBranch: true,
      fastForward: true,
      author: { ...AUTHOR, timestamp: Math.floor(Date.now() / 1000) },
      onAuth: authFor(config),
    }),
  );
  return '拉取完成（快进合并，本地历史线性保留）';
}
