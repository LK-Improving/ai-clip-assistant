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
 * 3. 安装包 resources/ffmpeg/（模块 5.1）
 * 4. 工程内 extraResources/ffmpeg/（开发态与 3 同源，未经打包时 resources 里没有）
 * 5. 剪映安装目录（本机兜底）
 * 6. PATH 中的 ffmpeg
 *
 * 第 4 位必须排在剪映之前：剪映自带的是裁剪版 ffmpeg（无 libx264，硬件编码器在无对应显卡时
 * 也开不起来），拿它转预览代理会产出空文件，表现为「代理预览加载失败」。
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

  // 开发态（electron-forge start）：appPath = apps/desktop，工程内 extraResources/ffmpeg 即完整版 ffmpeg
  const devCandidates = (() => {
    const bases = [process.cwd()];
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { app } = require('electron') as typeof import('electron');
      bases.unshift(app.getAppPath());
    } catch {
      // 非 Electron 环境（node 直跑脚本）只靠 cwd
    }
    return bases.map((base) => path.join(base, 'extraResources', 'ffmpeg', EXE));
  })();

  const candidates = [
    process.env.MIAOMA_FFMPEG,
    userDataBin,
    ...resourcesCandidates,
    ...devCandidates,
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

/** ffmpeg 正常启动但编码/封装失败 */
export class FfmpegFailedError extends Error {
  readonly stderr: string;

  constructor(message: string, stderr: string) {
    super(message);
    this.name = 'FfmpegFailedError';
    this.stderr = stderr;
  }
}

/**
 * 与 runFfmpeg 的区别：非 0 退出码视为失败并抛出（带 stderr 尾部）。
 *
 * runFfmpeg 为 `ffmpeg -i` 探测场景把所有非 0 退出都当正常返回，
 * 用在「写文件」的转码/导出上会把失败静吞掉（磁盘上留个空文件被当成果返回）。
 * 需要确定产物真的生成时一律用本函数。
 */
export async function runFfmpegOrThrow(args: string[], timeoutMs = 30_000): Promise<FfmpegRunResult> {
  const bin = resolveFfmpegPath();
  if (!bin) throw new FfmpegNotFoundError();

  try {
    return await execFileAsync(bin, args, {
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    });
  } catch (error) {
    const err = error as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
      killed?: boolean;
      signal?: string;
    };
    if (err.code === 'ENOENT') {
      cachedPath = undefined;
      throw new FfmpegNotFoundError();
    }
    const stderr = err.stderr ?? '';
    if (err.killed || err.code === 'ETIMEDOUT') {
      throw new FfmpegFailedError('FFmpeg 执行超时被中断', stderr);
    }
    // 崩溃/被信号杀死时 exit code 可能是负数或字符串错误码，统一归为失败
    throw new FfmpegFailedError(
      `FFmpeg 执行失败（exit ${typeof err.code === 'number' ? err.code : (err.code ?? err.signal ?? '未知')}）：${stderr.slice(-400).trim() || '无输出'}`,
      stderr,
    );
  }
}
