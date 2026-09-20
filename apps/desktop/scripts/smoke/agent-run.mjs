/**
 * 阶段二 AI 智能体引擎 —— 端到端离线冒烟测试运行器。
 *
 * 用 esbuild 把真实 agent + core 源码打包成 CJS，在 Node 端（无 Electron GUI）执行，
 * 注入离线 Provider + 真实 ffmpeg 探测，验证 runPipeline 全链路 / 人机中断→resume / checkpoint 续传。
 *
 * 用法：node apps/desktop/scripts/smoke/agent-run.mjs
 */

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const ROOT = 'D:/Study/重点项目/AI剪映';
const SMOKE_DIR = path.dirname(fileURLToPath(import.meta.url));
const HARNESS = path.join(SMOKE_DIR, 'agent-harness.ts');
const CORE = path.join(ROOT, 'packages/core/src/index.ts');

const require = createRequire(import.meta.url);
const esbuild = require(path.join(ROOT, 'node_modules/esbuild'));

const FFMPEG = path.join(ROOT, 'apps/desktop/extraResources/ffmpeg/ffmpeg.exe');
process.env.MIAOMA_FFMPEG = fs.existsSync(FFMPEG) ? FFMPEG : 'ffmpeg';

const OUT = path.join(os.tmpdir(), `miaoma-agent-smoke-${process.pid}.cjs`);

console.log('== 阶段二 AI 智能体引擎 冒烟测试（离线 Provider + 真实 ffmpeg 探测）==');
console.log(`ffmpeg : ${process.env.MIAOMA_FFMPEG}`);
console.log('');

let build;
try {
  build = await esbuild.build({
    entryPoints: [HARNESS],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    alias: { '@miaoma/video-project': CORE },
    outfile: OUT,
    logLevel: 'warning',
  });
} catch (e) {
  console.error('[esbuild] 打包失败：');
  console.error(e && e.message ? e.message : String(e));
  if (e && e.errors) for (const err of e.errors) console.error(err.text, err.location || '');
  process.exit(2);
}

if (build.errors && build.errors.length) {
  console.error('[esbuild] 打包错误：', build.errors);
  process.exit(2);
}

let results;
try {
  const require = createRequire(import.meta.url);
  const mod = require(OUT);
  results = await mod.runAgentSmoke();
} catch (e) {
  console.error('[运行] 执行失败：', e);
  process.exit(3);
} finally {
  try {
    fs.rmSync(OUT, { force: true });
  } catch {}
}

let passed = 0;
let failed = 0;
for (const r of results) {
  const tag = r.pass ? 'PASS' : 'FAIL';
  if (r.pass) passed += 1;
  else failed += 1;
  const line = `  [${tag}] ${r.name}` + (r.detail ? ` — ${r.detail}` : '');
  console.log(line);
}

console.log('');
console.log(`结果：PASS=${passed}  FAIL=${failed}  共 ${results.length} 环`);
process.exit(failed > 0 ? 1 : 0);
