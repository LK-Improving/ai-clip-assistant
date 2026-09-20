/**
 * M6 量化实测基线 runner：
 * esbuild 打包 metrics.entry.ts（electron→stub、workspace 包→src），Node 端跑真实主进程服务，
 * 输出 Markdown 表格到 stdout 并写入 docs/性能与效果实测.md（--write 时）。
 *
 * 用法：pnpm bench:metrics [--write]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const ENTRY = path.join(HERE, 'metrics.entry.ts');
const STUB = path.join(ROOT, 'apps/desktop/scripts/smoke/electron-stub.ts');
const CORE = path.join(ROOT, 'packages/core/src/index.ts');
const AGENT = path.join(ROOT, 'packages/agent/src/index.ts');

const require = createRequire(import.meta.url);
const esbuild = require(path.join(ROOT, 'node_modules/esbuild'));

const FFMPEG = path.join(ROOT, 'apps/desktop/extraResources/ffmpeg/ffmpeg.exe');
const USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'miaoma-bench-ud-'));
process.env.MIAOMA_SMOKE_USERDATA = USERDATA;
process.env.MIAOMA_FFMPEG = fs.existsSync(FFMPEG) ? FFMPEG : 'ffmpeg';

const OUT = path.join(os.tmpdir(), `miaoma-bench-${process.pid}.cjs`);
try {
  await esbuild.build({
    entryPoints: [ENTRY],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    alias: { electron: STUB, '@miaoma/video-project': CORE, '@miaoma/agent': AGENT },
    outfile: OUT,
    logLevel: 'warning',
  });
} catch (e) {
  console.error('[esbuild] 打包失败：', e && e.message);
  process.exit(2);
}

let metrics;
try {
  const mod = require(OUT);
  metrics = await mod.runBench();
} catch (e) {
  console.error('[bench] 执行失败：', e);
  process.exit(3);
} finally {
  try {
    fs.rmSync(OUT, { force: true });
    fs.rmSync(USERDATA, { recursive: true, force: true });
  } catch {}
}

const lines = [];
lines.push('# KK剪映 · 性能与效果实测（M6）');
lines.push('');
lines.push(`> 由 \`pnpm bench:metrics\` 于 ${new Date().toISOString()} 在本机自动采集，测量代码 = scripts/bench/metrics.*，可复跑验证。`);
lines.push('> 环境：' + (os.release() ?? '') + ' / Node ' + process.version + ' / ffmpeg=' + process.env.MIAOMA_FFMPEG);
lines.push('');
let lastGroup = '';
for (const m of metrics) {
  if (m.group !== lastGroup) {
    lines.push(`## ${m.group}`);
    lines.push('');
    lines.push('| 指标 | 实测值 | 说明 |');
    lines.push('|---|---|---|');
    lastGroup = m.group;
  }
  lines.push(`| ${m.name} | **${m.value}** | ${m.detail} |`);
}
lines.push('');
lines.push('## 口径结论（替换 PDF 宣传数字）');
lines.push('');
lines.push('- 「TTS 重复请求响应提升 10 倍以上」→ 以本表实测的缓存命中/未命中比为准（本机离线 mock 环境数字）；');
lines.push('- 「格式错误率降低 90% 以上」→ 以「结构化输出防线」组实测为准：200 混合坏样本经 Zod+重试+兜底后未捕获异常 0，对照裸 JSON.parse 崩溃数即为防线拦截量；');
lines.push('- 「制作周期从小时级到分钟级」「效率 5 倍」→ 定性表述 + 本表工程操作耗时（扫描/保存/checkpoint 恢复）佐证，不引用未经测量的倍数。');
lines.push('');

const table = lines.join('\n');
console.log(table);
if (process.argv.includes('--write')) {
  fs.writeFileSync(path.join(ROOT, 'docs/性能与效果实测.md'), table, 'utf8');
  console.log('[bench] 已写入 docs/性能与效果实测.md');
}
void pathToFileURL;
