import { execFile } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const EXE = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';

/** 剪映（JianyingPro）自带 ffmpeg，本机未安装时可作为兜底 */
const JIANYING_ROOTS = [
  'D:/Tools/JianyingPro',
  'C:/Tools/JianyingPro',
  'C:/Program Files/JianyingPro',
  process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'JianyingPro') : '',
];

export class FfmpegNotFoundError extends Error {
  constructor() {
    super(
      '未找到 FFmpeg。请安装 FFmpeg 并加入 PATH，或设置环境变量 MIAOMA_FFMPEG 指向可执行文件。',
    );
    this.name = 'FfmpegNotFoundError';
  }
}

function detectJianying(): string | null {
  for (const root of JIANYING_ROOTS) {
    if (!root || !existsSync(root)) continue;
    try {
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const candidate = path.join(root, entry.name, EXE);
        if (existsSync(candidate)) return candidate;
      }
    } catch {
      // 目录无权限等情况直接跳过
    }
  }
  return null;
}

let cachedPath: string | null | undefined;

/**
 * FFmpeg 可执行文件路径解析（优先级从高到低）：
 * 1. 环境变量 MIAOMA_FFMPEG
 * 2. 应用数据目录 bin/（模块 5.1 打包时会随包分发）
 * 3. 剪映安装目录（本机兜底）
 * 4. PATH 中的 ffmpeg
 */
export function resolveFfmpegPath(): string | null {
  if (cachedPath !== undefined) return cachedPath;

  const userDataBin = (() => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { app } = require('electron') as typeof import('electron');
      return path.join(app.getPath('userData'), 'bin', EXE);
    } catch {
      return '';
    }
  })();

  const resourcesCandidates = (() => {
    try {
      const base = process.resourcesPath ?? '';
      // 打包后完整版 ffmpeg 随应用分发到 resources/ffmpeg/（见模块 5.1 打包配置）
      // 兼容 electron-packager 把目录直接拷到 resources 根的情况
      return [path.join(base, 'ffmpeg', EXE), path.join(base, EXE)];
    } catch {
      return [];
    }
  })();

  const candidates = [
    process.env.MIAOMA_FFMPEG,
    userDataBin,
    ...resourcesCandidates,
    detectJianying(),
    'ffmpeg',
  ].filter((p): p is string => Boolean(p));

  for (const candidate of candidates) {
    if (candidate === 'ffmpeg') {
      // PATH 查找交由 execFile 处理，先假定可用
      cachedPath = 'ffmpeg';
      return cachedPath;
    }
    if (existsSync(candidate)) {
      cachedPath = candidate;
      return cachedPath;
    }
  }
  cachedPath = null;
  return null;
}

export interface FfmpegRunResult {
  stdout: string;
  stderr: string;
}

/** 执行 ffmpeg，统一处理「找不到二进制」与超时 */
export async function runFfmpeg(args: string[], timeoutMs = 30_000): Promise<FfmpegRunResult> {
  const bin = resolveFfmpegPath();
  if (!bin) throw new FfmpegNotFoundError();

  try {
    const { stdout, stderr } = await execFileAsync(bin, args, {
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    });
    return { stdout, stderr };
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
    if (err.code === 'ENOENT') {
      cachedPath = undefined;
      throw new FfmpegNotFoundError();
    }
    // ffmpeg -i <file> 无输出文件时返回 1，属正常情况，由调用方解析 stderr
    if (err.stderr !== undefined) return { stdout: err.stdout ?? '', stderr: err.stderr };
    throw error;
  }
}
