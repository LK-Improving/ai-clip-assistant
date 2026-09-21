/**
 * 渲染层冒烟：把 AppShell（含 AI 助手浮层）在 Node 里 renderToString 一遍。
 *
 * 为什么需要它：助手浮层挂在 AppShell 上、被所有页面共享，它一旦在初始化阶段抛错
 * （导入错误、hooks 顺序、访问不存在的浏览器 API），整个应用就是白屏，
 * 而主进程冒烟与 tsc 都抓不到这类问题。
 *
 * 用法：pnpm check:render（或 node apps/desktop/scripts/smoke/render-check.mjs）
 */
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const SMOKE_DIR = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(SMOKE_DIR, '../..');
const ROOT = path.resolve(APP, '../..');
const require = createRequire(import.meta.url);
const esbuild = require(path.join(ROOT, 'node_modules/esbuild'));

const ENTRY = `
import { renderToString } from 'react-dom/server';
import { createElement } from 'react';
import { AppShell } from '@/components/layout/app-shell';
export function render(route: string): string {
  return renderToString(createElement(AppShell, { route, children: createElement('div', null, 'x') }));
}
`;

const OUT = path.join(os.tmpdir(), `miaoma-render-check-${process.pid}.cjs`);

let failures = 0;
function check(label, ok, detail = '') {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

try {
  await esbuild.build({
    stdin: { contents: ENTRY, resolveDir: APP, loader: 'ts' },
    bundle: true,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    alias: {
      '@': path.join(APP, 'src'),
      '@miaoma/video-project': path.join(ROOT, 'packages/core/src/index.ts'),
      '@miaoma/agent': path.join(ROOT, 'packages/agent/src/index.ts'),
    },
    outfile: OUT,
    logLevel: 'warning',
  });

  const mod = require(OUT);
  console.log('== 渲染层冒烟（AppShell + AI 助手浮层 SSR 渲染）==');

  // 剪辑页：浮层默认收起，只应看到把手，不应出现输入框
  const editorHtml = mod.render('/editor');
  check('剪辑页渲染不崩溃', editorHtml.length > 1000, `length=${editorHtml.length}`);
  check('剪辑页含左侧导航', editorHtml.includes('设置中心') && editorHtml.includes('剪辑'));
  check('剪辑页浮层收起（无输入框）', !editorHtml.includes('Enter 发送'));

  // AI 创作页：浮层自动展开，输入框就绪（SSR 不跑 effect，所以只校初始结构）
  const aiHtml = mod.render('/ai');
  check('AI 页渲染不崩溃', aiHtml.length > 1000, `length=${aiHtml.length}`);
  check('AI 页浮层自动展开', aiHtml.includes('AI 助手') && aiHtml.includes('Enter 发送'));
  check('AI 页输入框给出可用指令示例', aiHtml.includes('删掉音乐轨'));
} catch (error) {
  check('渲染层冒烟执行', false, (error && error.message) || String(error));
} finally {
  try {
    fs.rmSync(OUT, { force: true });
  } catch {
    /* 清理失败不影响结论 */
  }
}

console.log('');
console.log(failures === 0 ? '结果：渲染层冒烟全部通过' : `结果：${failures} 项失败`);
process.exit(failures > 0 ? 1 : 0);
