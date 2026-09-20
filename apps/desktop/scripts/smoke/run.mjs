/**
 * P0 全链路冒烟测试运行器。
 *
 * 做法：用 esbuild 把真实主进程源码 + harness 打包成 CJS，过程中把 'electron' 别名到
 * electron-stub.ts、'@miaoma/video-project' 别名到 core 源码，从而在 Node 端（无 Electron GUI）
 * 直接执行真实服务逻辑并逐环断言。
 *
 * 用法：node apps/desktop/scripts/smoke/run.mjs
 */

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const ROOT = 'D:/Study/重点项目/AI剪映';
const SMOKE_DIR = path.dirname(fileURLToPath(import.meta.url));
const HARNESS = path.join(SMOKE_DIR, 'harness.ts');
const STUB = path.join(SMOKE_DIR, 'electron-stub.ts');
const CORE = path.join(ROOT, 'packages/core/src/index.ts');
const AGENT = path.join(ROOT, 'packages/agent/src/index.ts');

// esbuild 的 .bin 在 Windows Git Bash 下无法被 spawn 直接执行，改用 JS API（绝对路径 require）
const require = createRequire(import.meta.url);
const esbuild = require(path.join(ROOT, 'node_modules/esbuild'));

/**
 * 磁盘满模拟插件：把 `node:fs` 包一层，当 globalThis.__DISK_FULL__ 为真时，
 * writeFileSync 抛 ENOSPC。仅「磁盘满」环会置位该标志，其余环无副作用。
 * 这样无需真正写满磁盘即可确定性验证「持久化失败时优雅报错、不崩主进程」。
 */
const diskFullPlugin = {
  name: 'disk-full',
  setup(b) {
    b.onResolve({ filter: /^node:fs$/ }, (args) => {
      // 递归保护：wrapper 内部对 node:fs 的引用标记为 external，交给 Node 运行时解析
      if (args.namespace === 'nodefs') return { path: args.path, external: true };
      return { path: args.path, namespace: 'nodefs' };
    });
    b.onLoad({ filter: /.*/, namespace: 'nodefs' }, () => ({
      contents: `
        import * as real from 'node:fs';
        const g = globalThis;
        function writeFileSync(path, data, options) {
          if (g.__DISK_FULL__) {
            const e = new Error('ENOSPC: no space left on device');
            e.code = 'ENOSPC';
            throw e;
          }
          return real.writeFileSync(path, data, options);
        }
        export * from 'node:fs';
        export { writeFileSync };
      `,
      loader: 'js',
    }));
  },
};

// 注入测试环境：隔离的 userData 目录 + 完整版 ffmpeg（libx264 可用；drawtext 缺失→降级）
const USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'miaoma-smoke-ud-'));
const FFMPEG = path.join(ROOT, 'apps/desktop/extraResources/ffmpeg/ffmpeg.exe');
process.env.MIAOMA_SMOKE_USERDATA = USERDATA;
process.env.MIAOMA_FFMPEG = fs.existsSync(FFMPEG) ? FFMPEG : 'ffmpeg';
process.env.MIAOMA_SMOKE = '1';

const OUT = path.join(os.tmpdir(), `miaoma-smoke-${process.pid}.cjs`);

console.log('== 全链路冒烟测试（P0 + P1 + 更细异常 + P1扩展 + 阶段二AI接入与配置，共 27 环）==');
console.log(`userData: ${USERDATA}`);
console.log(`ffmpeg : ${process.env.MIAOMA_FFMPEG}`);
console.log('');

let build;
try {
  build = await esbuild.build({
    entryPoints: [HARNESS],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    alias: { electron: STUB, '@miaoma/video-project': CORE, '@miaoma/agent': AGENT },
    plugins: [diskFullPlugin],
    outfile: OUT,
    logLevel: 'warning',
  });
} catch (e) {
  console.error('[esbuild] 打包失败：');
  console.error(e && e.message ? e.message : String(e));
  if (e && e.errors) {
    for (const err of e.errors) console.error(err.text, err.location || '');
  }
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
  results = await mod.runSmoke();
} catch (e) {
  console.error('[运行] 执行失败：', e);
  process.exit(3);
} finally {
  try { fs.rmSync(OUT, { force: true }); } catch {}
}

let passed = 0;
let failed = 0;
let skipped = 0;
for (const r of results) {
  const tag = r.skip ? 'SKIP' : r.pass ? 'PASS' : 'FAIL';
  if (r.skip) skipped += 1;
  else if (r.pass) passed += 1;
  else failed += 1;
  const line = `  [${tag}] ${r.name}` + (r.detail ? ` — ${r.detail}` : '');
  console.log(line);
}

console.log('');
console.log(`结果：PASS=${passed}  FAIL=${failed}  SKIP=${skipped}  共 ${results.length} 环`);
process.exit(failed > 0 ? 1 : 0);
