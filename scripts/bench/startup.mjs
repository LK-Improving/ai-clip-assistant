/**
 * M1.3 安装包体积基线（bench:dist）。
 *
 * 扫描打包产物目录并输出 Markdown 表格行，供 README/面试数据引用；
 * 启动耗时基线由主进程 [bench] 日志产出（pnpm start 后控制台 grep "bench"）。
 *
 * 用法：pnpm bench:dist
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 兼容 Node ≥18：import.meta.dirname 需 20.11+，本机 20.0 不可用
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** 体积候选：forge 配置的 outDir（D:/kk-build，package/make 产物都落这里）+ 仓内兼容路径 */
const TARGETS = [
  { label: 'forge 产物根（D:/kk-build）', dir: 'D:/kk-build' },
  { label: '仓内 out（备用）', dir: path.join(ROOT, 'apps/desktop/out') },
];

function dirSize(dir) {
  let total = 0;
  let files = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const cur = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(cur, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        try {
          total += fs.statSync(full).size;
          files += 1;
        } catch {
          /* 跳过无法 stat 的文件 */
        }
      }
    }
  }
  return { total, files };
}

function formatMb(bytes) {
  return (bytes / 1024 / 1024).toFixed(1);
}

const ffmpeg = path.join(ROOT, 'apps/desktop/extraResources/ffmpeg/ffmpeg.exe');
const ffmpegSize = fs.existsSync(ffmpeg) ? fs.statSync(ffmpeg).size : 0;

console.log('== KK剪映 · 打包体积基线 ==');
console.log('');
console.log('| 产物 | 体积 | 文件数 |');
console.log('|---|---|---|');

let found = false;
for (const target of TARGETS) {
  if (!fs.existsSync(target.dir)) {
    continue;
  }
  const { total, files } = dirSize(target.dir);
  console.log(`| ${target.label}（合计） | ${formatMb(total)} MB | ${files} |`);
  found = true;
  // 展开顶层条目：便携 app 目录 vs Setup.exe 安装包分列
  for (const entry of fs.readdirSync(target.dir, { withFileTypes: true })) {
    const full = path.join(target.dir, entry.name);
    if (entry.isDirectory()) {
      const sub = dirSize(full);
      console.log(`| └─ ${entry.name}（目录） | ${formatMb(sub.total)} MB | ${sub.files} |`);
    } else if (entry.isFile()) {
      const size = fs.statSync(full).size;
      console.log(`| └─ ${entry.name} | ${formatMb(size)} MB | 1 |`);
    }
  }
}
if (!found) {
  console.log('| （无产物，先跑 pnpm package / pnpm make） | - | - |');
}
console.log(`| extraResources ffmpeg.exe | ${ffmpegSize ? `${formatMb(ffmpegSize)} MB` : '（缺失）'} | ${ffmpegSize ? 1 : 0} |`);
console.log('');
if (!found) {
  console.log('提示：先执行 pnpm package（便携产物）或 pnpm make（安装包）再跑本脚本。');
}
console.log('启动耗时基线：pnpm start 后在主进程控制台查找 `[bench] window create→ready-to-show`。');
