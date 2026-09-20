/**
 * Electron 运行桩（仅用于 Node 端冒烟测试，不进生产包）。
 *
 * 设计要点：
 * - 真实主进程服务（library / project-store / protocol / ipc）只用到 electron 的
 *   app.getPath / ipcMain.handle / BrowserWindow.getAllWindows / protocol.handle 等少量 API，
 *   这里用最小实现顶替 GUI 环境；
 * - 把 ipcMain.handle 与 protocol.handle 注册到的处理器挂到 globalThis，
 *   测试本体（harness）据此直接调用真实处理器，从而端到端验证生产代码路径。
 */

import os from 'node:os';
import path from 'node:path';

const userData =
  process.env.MIAOMA_SMOKE_USERDATA ||
  path.join(os.tmpdir(), 'miaoma-smoke');

/** IPC 处理器表：channel -> handler */
const ipcHandlers: Record<string, (...args: any[]) => any> = {};
/** 协议处理器表：scheme -> handler */
const protocolHandlers: Record<string, (request: any) => any> = {};

// 暴露给 harness 读取
(globalThis as any).__MIAOMA_IPC__ = ipcHandlers;
(globalThis as any).__MIAOMA_PROTOCOL__ = protocolHandlers;

export const app = {
  getPath: (_name?: string): string => userData,
  setPath: () => {},
  whenReady: async () => {},
  on: () => {},
};

export const ipcMain = {
  handle: (channel: string, handler: (...args: any[]) => any) => {
    ipcHandlers[channel] = handler;
  },
  on: () => {},
};

export const BrowserWindow = {
  getAllWindows: () => [] as any[],
};

export const dialog = {
  showOpenDialog: async () => ({ canceled: true, filePaths: [] as string[] }),
  showSaveDialog: async () => ({ canceled: true, filePath: '' }),
};

export const shell = {
  openPath: async () => '',
  openExternal: async () => {},
};

export const protocol = {
  handle: (scheme: string, handler: (request: any) => any) => {
    protocolHandlers[scheme] = handler;
  },
  registerSchemesAsPrivileged: () => {},
};

export const nativeImage = {
  createFromPath: () => ({ toPNG: () => Buffer.alloc(0) }),
};

export default {
  app,
  ipcMain,
  BrowserWindow,
  dialog,
  shell,
  protocol,
  nativeImage,
};
