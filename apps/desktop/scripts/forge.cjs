/**
 * Forge 命令启动器（start / package / make / publish 统一入口）。
 *
 * 为什么需要它：forge.config.ts 由 Forge 内置的 jiti 加载，其依赖链里的
 * vite 7 是纯 ESM（内部使用 import.meta）。在 Node < 22.12 上，jiti 走
 * CJS 转译路径会原样残留 import.meta，报：
 *   SyntaxError: Cannot use 'import.meta' outside a module
 * 因此整个 Forge / vite 链路必须在 Node >= 22.12 上运行。
 *
 * 行为：
 * 1. 当前 Node 满足版本 → 直接以当前 node 运行 Forge CLI；
 * 2. 过低 → 按顺序探测可用 Node（MIAOMA_NODE 环境变量 > WorkBuddy 托管
 *    Node 目录 > Program Files），取满足要求的最高版本重启命令。
 */
const { existsSync, readdirSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const MIN_MAJOR = 22;
const MIN_MINOR = 12;
const MIN_TEXT = `${MIN_MAJOR}.${MIN_MINOR}`;

function versionOk(version) {
  const [major = 0, minor = 0] = version.split('.').map(Number);
  return major > MIN_MAJOR || (major === MIN_MAJOR && minor >= MIN_MINOR);
}

function forgeBinPath() {
  const pkgPath = require.resolve('@electron-forge/cli/package.json');
  const pkg = require(pkgPath);
  const binRel = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin['electron-forge'];
  return path.join(path.dirname(pkgPath), binRel);
}

function runForge(nodeExe) {
  const result = spawnSync(nodeExe, [forgeBinPath(), ...process.argv.slice(2)], {
    stdio: 'inherit',
  });
  process.exit(result.status ?? 1);
}

// 1) 当前 Node 已满足要求
if (versionOk(process.versions.node)) {
  runForge(process.execPath);
}

// 2) 当前 Node 过低，探测可用版本
const candidates = [];
if (process.env.MIAOMA_NODE) candidates.push(process.env.MIAOMA_NODE);
try {
  const managedRoot = 'C:/Users/LK/.workbuddy/binaries/node/versions';
  for (const dir of readdirSync(managedRoot)) {
    const exe = path.join(managedRoot, dir, 'node.exe');
    if (existsSync(exe)) candidates.push(exe);
  }
} catch {
  // 托管目录不存在（非本机环境）则跳过
}
candidates.push('C:/Program Files/nodejs/node.exe');

const probed = [];
for (const exe of candidates) {
  const probe = spawnSync(exe, ['-p', 'process.versions.node'], { encoding: 'utf8' });
  const version = (probe.stdout || '').trim();
  if (probe.status === 0 && version) probed.push({ exe, version });
}
probed.sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }));
const best = probed.find((item) => versionOk(item.version));

if (!best) {
  console.error(`[forge] 当前 Node ${process.versions.node} 过低，且未找到 Node >= ${MIN_TEXT}。`);
  console.error('  请安装 Node 22+，或设置环境变量 MIAOMA_NODE 指向其 node.exe 后重试。');
  process.exit(1);
}

console.log(
  `[forge] 当前 Node ${process.versions.node} 不满足要求（需 >= ${MIN_TEXT}），改用 ${best.exe} (${best.version})`,
);
runForge(best.exe);
