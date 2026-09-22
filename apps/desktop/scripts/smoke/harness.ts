/**
 * P0 全链路冒烟测试本体（在 Node 端跑真实主进程逻辑，无 Electron GUI）。
 *
 * 覆盖「阶段五 5.2」关键回归：
 *  - 导入素材 → 白名单登记（preview 不黑屏的根因）
 *  - 时间线 → 工程桥接（assets 回填 + 孤儿清理）
 *  - 工程落盘 / 读取 / 坏文件容错
 *  - 重启恢复：library-cache 只含 directories:[] + 手动导入条目时，白名单仍能从条目反推恢复（黑屏根因）
 *  - 打开工程时素材目录重新登记（工程自包含）
 *  - miaoma:// 协议 200/206/403/404/416 矩阵
 *  - media:diagnose 区分「不存在 / 未授权 / 正常」
 *  - 真实 ffmpeg 渲染导出（含 libx264；drawtext 缺失时降级为 warning）
 *
 * 关键隔离原则：每个素材放在各自独立目录，避免「导入」环登记父目录污染后续环的白名单断言。
 *
 * 由 run.mjs 用 esbuild 打包后执行；所有断言结果通过 runSmoke() 返回。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import { getLibraryStore, LibraryStore } from '../../src/main/services/library';
import { addAllowedPath, explainAccess, registerProtocols } from '../../src/main/protocol';
import { getProjectStore } from '../../src/main/services/project-store';
import { registerIpc } from '../../src/main/ipc';
import { timelineToProject } from '../../src/lib/project-bridge';
import { EMBED_DIMS, applyAutoTransitions, embedAsset } from '@miaoma/agent';
import { embedImage, visionStatus } from '../../src/main/services/vision';
import { createEmptyProject, createId, DEFAULT_TRANSFORM, migrateProject, nowIso, ProjectSchema } from '@miaoma/video-project';
import type { VideoClip } from '@miaoma/video-project';
import { projectToTimeline } from '../../src/lib/project-bridge';
import { generateThumbnail } from '../../src/main/services/thumbnail';
import { ensurePlayable } from '../../src/main/services/preview';
import { saveTtsConfig, loadTtsConfig } from '../../src/main/services/tts/config';
import {
  renderProject,
  buildRenderPlan,
  detectCapabilities,
  classifyFfmpegFailure,
  estimateOutputBytes,
  probeFreeBytes,
  precheckDiskSpace,
} from '../../src/main/services/render';
import { synthesizeSpeech, zeroShotFallbackReason } from '../../src/main/services/tts';
import { addVoice, listVoices, removeVoice } from '../../src/main/services/voice';
import {
  diffProjects,
  history,
  pushToRemote,
  readVersion,
  restoreVersion,
  saveRemoteConfig,
  snapshotProject,
} from '../../src/main/services/versioning';
import { resolveFfmpegPath } from '../../src/main/ffmpeg';
import { probeMedia } from '../../src/main/services/probe';
import { createAgentDeps, resumeAgentRun, retryAgentRun, startAgentRun } from '../../src/main/services/agent';
import { HttpTaskVideoProvider, MiniMaxH3VideoProvider, NODE_RUNNERS, listRemoteModelIds, minimaxAlternateBase, parseEditPlan, toVideoGenError } from '@miaoma/agent';
import { buildTimelineSnapshot, resolveClipRef, translatePlan } from '../../src/lib/assistant-apply';
import { estimatePlanCost } from '../../src/main/services/assistant';
import { applyTimelineActions, canUndo, getTracks, undoTimeline } from '../../src/lib/timeline-store';
import type { TimelineClip, TimelineTrack } from '../../src/lib/timeline-utils';
import type { AgentDeps, AgentState } from '@miaoma/agent';
import { loadVideoGenConfig, saveVideoGenConfig } from '../../src/main/services/video-gen/config';
import { isLlmConfigured, loadLlmConfig, saveLlmConfig } from '../../src/main/services/llm/config';

const FFMPEG = process.env.MIAOMA_FFMPEG || 'ffmpeg';
const USERDATA = process.env.MIAOMA_SMOKE_USERDATA || path.join(os.tmpdir(), 'miaoma-smoke');
const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'miaoma-smoke-base-'));

// 每个素材独立目录，杜绝白名单污染
let FIX1 = ''; // 导入环：BASE/clip1/clip1.mp4
let FIX2 = ''; // 重启环：BASE/clip2/clip2.mp4
let FIX3 = ''; // 打开环：BASE/clip3/clip3.mp4
let FIX4 = ''; // 素材被删环：BASE/clip4/clip4.mp4（环内删除）
let FIX5 = ''; // 多素材环：BASE/img/img.jpg（图片素材）
let FIX6 = ''; // 多素材环：BASE/aud/aud.wav（音频素材）

interface RingResult {
  name: string;
  pass: boolean;
  skip?: boolean;
  detail: string;
}

function ok(name: string, detail = ''): RingResult {
  return { name, pass: true, detail };
}
function fail(name: string, detail: string): RingResult {
  return { name, pass: false, detail };
}
function skip(name: string, detail: string): RingResult {
  return { name, pass: false, skip: true, detail };
}
const uid = () => randomUUID();

/** 用真实 ffmpeg 生成测试素材（各自独立目录、独立文件名避免互相污染）。按扩展名选择生成方式 */
function genFixture(name: string): string {
  const dir = path.join(BASE, name.replace(/\.[^.]+$/, ''));
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, name);
  const ext = path.extname(name).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') {
    // 图片素材：lavfi color 单帧 → jpg
    execFileSync(FFMPEG, ['-y', '-f', 'lavfi', '-i', 'color=c=0x2a6fdb:s=320x240:d=1', '-frames:v', '1', out], {
      windowsHide: true,
      stdio: 'ignore',
    });
  } else if (ext === '.wav') {
    // 音频素材：lavfi sine → pcm wav
    execFileSync(FFMPEG, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:a', 'pcm_s16le', out], {
      windowsHide: true,
      stdio: 'ignore',
    });
  } else {
    // 视频素材：testsrc + sine（libx264 + aac）
    execFileSync(
      FFMPEG,
      [
        '-y',
        '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=30:duration=2',
        '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac',
        '-shortest',
        out,
      ],
      { windowsHide: true, stdio: 'ignore' },
    );
  }
  return out;
}

async function ringImportAndWhitelist(results: RingResult[]): Promise<void> {
  try {
    const lib = getLibraryStore();
    const entries = await lib.addFiles([FIX1]);
    const entry = entries[0];
    if (!entry) throw new Error('addFiles 未返回条目');
    if (entry.kind !== 'video') throw new Error(`kind 应为 video，实际 ${entry.kind}`);
    if (!entry.hasAudio) throw new Error('探针未识别到音轨（hasAudio=false）');
    // 导入后素材目录必须已加入白名单，否则 preview 会 403 黑屏
    const diag = explainAccess(FIX1);
    if (!diag.ok) throw new Error(`导入后白名单未生效：${diag.reason}`);
    results.push(ok('导入→白名单登记', `video kind=${entry.kind} hasAudio=${entry.hasAudio} 预览可访问`));
  } catch (e) {
    results.push(fail('导入→白名单登记', (e as Error).message));
  }
}

async function ringEditBridge(results: RingResult[]): Promise<void> {
  try {
    const project = createEmptyProject({ name: 'smoke' });
    const tracks = [
      {
        id: uid(),
        kind: 'video' as const,
        name: '视频 1',
        clips: [
          {
            id: uid(),
            name: '片段A',
            kind: 'video' as const,
            start: 0,
            duration: 2000,
            offset: 0,
            hue: 0,
            assetPath: FIX1,
          },
        ],
      },
    ];
    const next = timelineToProject(project, tracks);
    if (next.assets.length !== 1) throw new Error(`assets 应回填 1 个，实际 ${next.assets.length}`);
    const asset = next.assets[0]!;
    if (asset.path !== FIX1) throw new Error('asset.path 与素材路径不一致');
    if (asset.type !== 'video') throw new Error(`asset.type 应为 video，实际 ${asset.type}`);
    if (asset.hasAudio !== true) throw new Error('asset.hasAudio 应为 true');
    if (next.tracks[0]!.clips.length !== 1) throw new Error('轨道未写入 clip');

    // 孤儿清理：清空时间线再转换，assets 应被裁剪为空
    const pruned = timelineToProject(next, [
      { id: next.tracks[0]!.id, kind: 'video', name: '视频 1', clips: [] },
    ]);
    if (pruned.assets.length !== 0) {
      throw new Error(`孤儿清理失败：assets 应为 0，实际 ${pruned.assets.length}`);
    }
    results.push(ok('编辑→工程桥接', `assets 回填+孤儿清理通过（hasAudio=${asset.hasAudio}）`));
  } catch (e) {
    results.push(fail('编辑→工程桥接', (e as Error).message));
  }
}

async function ringSaveAndRoundtrip(results: RingResult[]): Promise<void> {
  try {
    const store = getProjectStore();
    const created = store.create({ name: 'roundtrip' });
    const tracks = [
      {
        id: uid(),
        kind: 'video' as const,
        name: '视频 1',
        clips: [
          { id: uid(), name: 'A', kind: 'video' as const, start: 0, duration: 2000, offset: 0, hue: 0, assetPath: FIX1 },
        ],
      },
    ];
    const built = timelineToProject(created, tracks);
    const saved = store.save(built);
    // 落盘文件存在
    const file = path.join(USERDATA, 'projects', `${saved.id}.mmproj.json`);
    if (!fs.existsSync(file)) throw new Error('工程文件未落盘');
    // 读取往返一致
    const got = store.get(saved.id);
    if (!got) throw new Error('工程读取返回 null');
    if (got.assets.length !== 1) throw new Error(`读取后 assets 应为 1，实际 ${got.assets.length}`);
    if (got.assets[0]!.path !== FIX1) throw new Error('读取后 asset.path 不一致');
    // 坏文件容错：写入损坏 json，list 跳过、get 返回 null，不崩
    const badFile = path.join(USERDATA, 'projects', 'broken.mmproj.json');
    fs.writeFileSync(badFile, '{ this is not json', 'utf8');
    const broken = store.get('broken');
    if (broken !== null) throw new Error('坏文件应返回 null');
    results.push(ok('保存→落盘→读取', `往返一致 + 坏文件容错（id=${saved.id.slice(0, 8)}）`));
  } catch (e) {
    results.push(fail('保存→落盘→读取', (e as Error).message));
  }
}

async function ringRestartRecovery(results: RingResult[]): Promise<void> {
  try {
    // 模拟「重启后」的真实坏缓存：directories 为空，但含一条手动导入条目（FIX2 在独立目录 clip2）
    const cachePath = path.join(USERDATA, 'library-cache.json');
    fs.writeFileSync(
      cachePath,
      JSON.stringify({
        version: 1,
        entries: [
          {
            path: FIX2,
            name: path.basename(FIX2),
            kind: 'video',
            size: fs.statSync(FIX2).size,
            mtimeMs: Math.round(fs.statSync(FIX2).mtimeMs),
            durationMs: 2000,
            hasAudio: true,
            imported: true,
          },
        ],
        directories: [],
      }),
      'utf8',
    );
    // 全新实例读取缓存。关键：FIX2 的目录（BASE/clip2）此前从未被任何 addAllowedPath 登记，
    // 因此若 explainAccess(FIX2) 通过，只能是 load() 从条目反推补登记所致 —— 这正是对黑屏根因的验证。
    const fresh = new LibraryStore();
    const list = fresh.list();
    if (list.length !== 1) throw new Error(`重启后条目数应为 1，实际 ${list.length}`);
    const diag = explainAccess(FIX2);
    if (!diag.ok) {
      throw new Error(`重启后手动导入素材仍被 403：${diag.reason}（黑屏根因未修复）`);
    }
    results.push(ok('重启恢复（黑屏根因）', 'directories:[] + 导入条目 → 白名单从条目反推恢复，预览可访问'));
  } catch (e) {
    results.push(fail('重启恢复（黑屏根因）', (e as Error).message));
  }
}

async function ringReopenReRegisters(results: RingResult[]): Promise<void> {
  try {
    // 通过真实 ipc 处理器走「保存 + 打开」：打开时应把素材目录（BASE/clip3）重新登记进白名单
    const handlers: Record<string, (...a: any[]) => any> = (globalThis as any).__MIAOMA_IPC__;
    if (!handlers['project:save'] || !handlers['project:get']) {
      throw new Error('ipc 处理器未注册（registerIpc 未执行？）');
    }
    const created = getProjectStore().create({ name: 'reopen' });
    const tracks = [
      {
        id: uid(),
        kind: 'video' as const,
        name: '视频 1',
        clips: [
          { id: uid(), name: '素材C', kind: 'video' as const, start: 0, duration: 2000, offset: 0, hue: 0, assetPath: FIX3 },
        ],
      },
    ];
    const built = timelineToProject(created, tracks);
    await handlers['project:save'](null, built);
    const reopened = await handlers['project:get'](null, built.id);
    if (!reopened) throw new Error('project:get 返回 null');
    const diag = explainAccess(FIX3);
    if (!diag.ok) throw new Error(`打开工程后 FIX3 未授权：${diag.reason}`);
    results.push(ok('打开→素材重登记（工程自包含）', `project:get 重新登记素材目录，预览可访问`));
  } catch (e) {
    results.push(fail('打开→素材重登记（工程自包含）', (e as Error).message));
  }
}

async function ringProtocolMatrix(results: RingResult[]): Promise<void> {
  try {
    if (!(globalThis as any).__MIAOMA_PROTOCOL__?.miaoma) {
      throw new Error('协议处理器未注册（registerProtocols 未执行？）');
    }
    const handler = (globalThis as any).__MIAOMA_PROTOCOL__.miaoma;

    async function call(filePath: string, range?: string) {
      const url = `miaoma:///${filePath.replace(/\\/g, '/')}`;
      const req = new Request(url, range ? { headers: { range } } : {});
      const res = await handler(req);
      let bodyLen = 0;
      try {
        const buf = Buffer.from(await res.arrayBuffer());
        bodyLen = buf.length;
      } catch {
        /* 403/404/416 文本 body */
      }
      return { status: res.status, bodyLen };
    }

    const clip1Dir = path.dirname(FIX1); // 已授权目录

    // 1) 已授权 + 无 range → 200
    const full = await call(FIX1);
    if (full.status !== 200) throw new Error(`整文件应为 200，实际 ${full.status}`);
    if (full.bodyLen <= 0) throw new Error('200 响应体为空');

    // 2) 已授权 + range bytes=0-99 → 206，body 长度 = 100
    const ranged = await call(FIX1, 'bytes=0-99');
    if (ranged.status !== 206) throw new Error(`区间应为 206，实际 ${ranged.status}`);
    if (ranged.bodyLen !== 100) throw new Error(`区间 body 应为 100 字节，实际 ${ranged.bodyLen}`);

    // 3) 已授权 + 越界 range bytes=999999- → 416
    const over = await call(FIX1, 'bytes=999999-');
    if (over.status !== 416) throw new Error(`越界应为 416，实际 ${over.status}`);

    // 4) 未授权文件（BASE 根目录从未被登记）
    const unauthPath = path.join(BASE, 'unauthorized.mp4');
    fs.writeFileSync(unauthPath, Buffer.from([1, 2, 3, 4]));
    const unauthRes = await call(unauthPath);
    if (unauthRes.status !== 403) throw new Error(`未授权应为 403，实际 ${unauthRes.status}`);

    // 5) 已授权目录但文件不存在 → 404
    addAllowedPath(clip1Dir);
    const missingRes = await call(path.join(clip1Dir, 'does-not-exist.mp4'));
    if (missingRes.status !== 404) throw new Error(`缺失文件应为 404，实际 ${missingRes.status}`);

    // 6) 真实渲染侧 URL 形态（encodeURIComponent 单段）+ 中文文件名往返（用户故障场景）
    const zhFile = path.join(clip1Dir, '中文测试--微信版操作视频.mp4');
    fs.copyFileSync(FIX1, zhFile);
    const zhUrl = `miaoma:///${encodeURIComponent(zhFile)}`;
    const zhFull = await handler(new Request(zhUrl));
    if (zhFull.status !== 200) throw new Error(`中文编码路径应为 200，实际 ${zhFull.status}`);
    const zhRange = await handler(new Request(zhUrl, { headers: { range: 'bytes=0-9' } }));
    if (zhRange.status !== 206) throw new Error(`中文编码路径 Range 应为 206，实际 ${zhRange.status}`);
    fs.rmSync(zhFile, { force: true });

    // 7) forceTranscode：h264 白名单内也强制出 faststart 代理（Chromium 拒播时的自动降级兜底）
    const play = await ensurePlayable(FIX1, true);
    if (!play.proxied || !play.path || !fs.existsSync(play.path)) {
      throw new Error(`强制代理异常：proxied=${play.proxied} note=${play.note ?? ''}`);
    }

    // 8) 奇数比例素材（AI 生成常见 1344x768）：缩放结果必须强制偶数，
    //    否则 yuv420p 下 libx264 报「height not divisible by 2」，7 个候选编码器全挂（预览不可用）
    const oddDir = path.join(BASE, 'odd-ratio');
    fs.mkdirSync(oddDir, { recursive: true });
    const oddFile = path.join(oddDir, 'odd-1344x768.mp4');
    execFileSync(
      FFMPEG,
      [
        '-y',
        '-f', 'lavfi', '-i', 'testsrc=size=1344x768:rate=24:duration=1',
        '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac',
        '-shortest',
        oddFile,
      ],
      { windowsHide: true, stdio: 'ignore' },
    );
    addAllowedPath(oddDir);
    const oddPlay = await ensurePlayable(oddFile, true);
    if (!oddPlay.proxied || !oddPlay.path) {
      throw new Error(`奇数比例素材代理失败（scale 未强制偶数？）：${oddPlay.note ?? ''}`);
    }
    const oddProxy = await probeMedia(oddPlay.path);
    if (!oddProxy.width || !oddProxy.height || oddProxy.width % 2 !== 0 || oddProxy.height % 2 !== 0) {
      throw new Error(`代理尺寸必须为偶数，实际 ${oddProxy.width}x${oddProxy.height}`);
    }

    results.push(
      ok(
        '预览协议矩阵',
        '200/206/403/404/416 + 中文编码 URL 往返 + 强制 faststart 代理 + 奇数比例素材强制偶数全部符合预期',
      ),
    );
  } catch (e) {
    results.push(fail('预览协议矩阵', (e as Error).message));
  }
}

async function ringDiagnose(results: RingResult[]): Promise<void> {
  try {
    const missing = explainAccess(path.join(BASE, 'gone.mp4'));
    if (missing.ok || !/不存在/.test(missing.reason)) throw new Error(`缺失文件应判「不存在」，实际：${missing.reason}`);

    const freshUnauth = path.join(BASE, 'never-registered.mp4');
    fs.writeFileSync(freshUnauth, Buffer.from([9, 9, 9]));
    const noAuth = explainAccess(freshUnauth);
    if (noAuth.ok || !/未授权/.test(noAuth.reason)) throw new Error(`未登记文件应判「未授权」，实际：${noAuth.reason}`);

    const good = explainAccess(FIX1);
    if (!good.ok) throw new Error(`已授权文件应判 ok，实际：${good.reason}`);

    results.push(ok('media:diagnose 诊断', '区分「不存在 / 未授权 / 正常」三种原因'));
  } catch (e) {
    results.push(fail('media:diagnose 诊断', (e as Error).message));
  }
}

async function ringRender(results: RingResult[]): Promise<void> {
  try {
    const project = createEmptyProject({ name: 'render', width: 320, height: 240, fps: 30 });
    const tracks = [
      {
        id: uid(),
        kind: 'video' as const,
        name: '视频 1',
        clips: [
          { id: uid(), name: 'A', kind: 'video' as const, start: 0, duration: 2000, offset: 0, hue: 0, assetPath: FIX1 },
        ],
      },
      {
        // 字幕轨：用于验证字幕烧录 / 降级逻辑
        id: uid(),
        kind: 'text' as const,
        name: '字幕',
        clips: [
          { id: uid(), name: '测试字幕', kind: 'text' as const, start: 0, duration: 2000, offset: 0, hue: 0 },
        ],
      },
    ];
    const built = timelineToProject(project, tracks);
    const outPath = path.join(BASE, 'out.mp4');

    // 1) 真实渲染：产物有效 + 告警与能力自洽
    const started = Date.now();
    const result = await renderProject({
      project: built,
      outputPath: outPath,
      quality: 'standard',
    });
    const elapsed = Date.now() - started;
    if (!fs.existsSync(outPath)) throw new Error('渲染输出文件未生成');
    const size = fs.statSync(outPath).size;
    if (size <= 0) throw new Error('渲染输出文件为空');

    const caps = detectCapabilities(resolveFfmpegPath() || FFMPEG);
    const downgrade = result.warnings.filter((w: string) => /drawtext|未烧录/.test(w));
    // 能力自洽：drawtext 可用 → 不应有降级告警；不可用 → 必须有降级告警
    if (caps.drawtext && downgrade.length > 0) {
      throw new Error('drawtext 可用却产生了降级告警（逻辑矛盾）');
    }
    if (!caps.drawtext && downgrade.length === 0) {
      throw new Error('drawtext 缺失却无降级告警');
    }

    // 2) 确定性验证降级分支：直接调用 buildRenderPlan 强制 drawtextAvailable=false
    const plan = buildRenderPlan(built, path.join(BASE, 'plan.mp4'), {
      drawtextAvailable: false,
      subtitlesAvailable: false,
      videoEncoder: 'libx264',
      audioEncoder: 'aac',
      pixelFormat: 'yuv420p',
      videoBitrate: '8M',
    });
    const forcedDowngrade = plan.warnings.filter((w: string) => /drawtext|未烧录/.test(w));
    if (forcedDowngrade.length === 0) {
      throw new Error('buildRenderPlan 在 drawtext 关闭时未产生降级告警');
    }

    const detail = `encoder=${result.encoderUsed} drawtext=${caps.drawtext} 耗时=${elapsed}ms 大小=${(size / 1024).toFixed(0)}KB`;
    results.push(ok('导出渲染', `${detail}（降级分支已确定性验证）`));
  } catch (e) {
    results.push(fail('导出渲染', (e as Error).message));
  }
}

async function ringAssetDeleted(results: RingResult[]): Promise<void> {
  try {
    // 落盘一个引用 FIX4 的工程，随后删除素材文件，验证「素材被删」兜底
    const store = getProjectStore();
    const created = store.create({ name: 'asset-deleted' });
    const tracks = [
      {
        id: uid(),
        kind: 'video' as const,
        name: '视频 1',
        clips: [
          { id: uid(), name: 'A', kind: 'video' as const, start: 0, duration: 2000, offset: 0, hue: 0, assetPath: FIX4 },
        ],
      },
    ];
    const built = timelineToProject(created, tracks);
    const saved = store.save(built);

    // 删除素材本体
    fs.rmSync(FIX4, { force: true });
    if (fs.existsSync(FIX4)) throw new Error('素材删除失败（测试前置）');

    // 1) 重开工程不应崩溃（工程元数据仍在，仅素材文件缺失）
    const handlers: Record<string, (...a: any[]) => any> = (globalThis as any).__MIAOMA_IPC__;
    const reopened = await handlers['project:get'](null, saved.id);
    if (!reopened) throw new Error('素材被删后工程仍应能打开（不应返回 null）');

    // 2) 预览诊断应给出「文件不存在」而非静默黑屏
    const diag = explainAccess(FIX4);
    if (diag.ok || !/不存在/.test(diag.reason)) {
      throw new Error(`素材被删后诊断应判「文件不存在」，实际：${diag.reason}`);
    }

    // 3) 渲染引用缺失素材应抛可捕获错误（而非卡死/污染主进程）
    let renderThrew = false;
    try {
      const render = await import('../../src/main/services/render');
      await render.renderProject({ project: reopened, outputPath: path.join(BASE, 'deleted-out.mp4'), quality: 'standard' });
    } catch {
      renderThrew = true;
    }
    if (!renderThrew) throw new Error('素材缺失时渲染未报错（应优雅失败）');

    results.push(ok('异常兜底·素材被删', '重开不崩 + 预览诊断「文件不存在」+ 渲染优雅失败'));
  } catch (e) {
    results.push(fail('异常兜底·素材被删', (e as Error).message));
  }
}

async function ringTtsOffline(results: RingResult[]): Promise<void> {
  try {
    // 配置本地 TTS provider 指向不可达地址（连接被拒 ≈ 断网）
    saveTtsConfig({
      active: 'local',
      volcano: { appId: '', accessToken: '', voice: 'zh_female_roumei' },
      local: { baseUrl: 'http://127.0.0.1:1/tts', voice: 'default' },
      custom: { baseUrl: '', model: 'tts-1', voice: 'default', apiKey: '' },
    });

    const handlers: Record<string, (...a: any[]) => any> = (globalThis as any).__MIAOMA_IPC__;
    if (!handlers['tts:synthesize']) throw new Error('tts:synthesize 处理器未注册');

    let threw = false;
    let msg = '';
    try {
      await handlers['tts:synthesize'](null, { text: `离线合成-${Date.now()}`, provider: 'local' });
    } catch (e) {
      threw = true;
      msg = (e as Error).message;
    }
    if (!threw) throw new Error('TTS 断网时未抛错（应优雅失败）');
    if (!/无法连接|连接|ECONNREFUSED|fetch failed/i.test(msg)) {
      throw new Error(`TTS 断网报错信息不友好：${msg}`);
    }
    // 服务进程不崩：状态接口仍可调用
    const status = handlers['tts:status'] ? await handlers['tts:status']() : null;
    if (status && typeof status !== 'object') throw new Error('tts:status 返回异常');

    results.push(ok('异常兜底·TTS 断网', `合成优雅失败（${msg.slice(0, 24)}…）+ 服务不崩`));
  } catch (e) {
    results.push(fail('异常兜底·TTS 断网', (e as Error).message));
  }
}

async function ringDiskFull(results: RingResult[]): Promise<void> {
  try {
    // 通过 esbuild 插桩：__DISK_FULL__ 置位时 writeFileSync 抛 ENOSPC
    const store = getProjectStore();
    const created = store.create({ name: 'diskfull' });
    const tracks = [
      {
        id: uid(),
        kind: 'video' as const,
        name: '视频 1',
        clips: [
          { id: uid(), name: 'A', kind: 'video' as const, start: 0, duration: 2000, offset: 0, hue: 0, assetPath: FIX1 },
        ],
      },
    ];
    const built = timelineToProject(created, tracks);

    let threw = false;
    let code = '';
    (globalThis as any).__DISK_FULL__ = true;
    try {
      store.save(built);
    } catch (e) {
      threw = true;
      code = (e as NodeJS.ErrnoException).code || '';
    } finally {
      (globalThis as any).__DISK_FULL__ = false;
    }
    if (!threw) throw new Error('磁盘满时 save 未报错（应优雅失败）');
    if (code !== 'ENOSPC') throw new Error(`磁盘满应抛 ENOSPC，实际 code=${code}`);

    // 标志复位后，正常落盘应恢复（证明失败被隔离、未破坏状态）
    const again = store.save(built);
    if (!again || again.id !== built.id) throw new Error('磁盘满标志复位后落盘未恢复');

    // 同样验证素材库缓存写入：addFiles 后 save 在满盘下优雅失败
    const lib = getLibraryStore();
    (globalThis as any).__DISK_FULL__ = true;
    let libThrew = false;
    try {
      await lib.addFiles([FIX1]);
    } catch {
      libThrew = true;
    } finally {
      (globalThis as any).__DISK_FULL__ = false;
    }
    if (!libThrew) throw new Error('磁盘满时 library.save 未报错');

    results.push(ok('异常兜底·磁盘满', 'save/library 写盘失败优雅报 ENOSPC + 复位后恢复'));
  } catch (e) {
    results.push(fail('异常兜底·磁盘满', (e as Error).message));
  }
}

// ===================== 阶段五 5.2 · P1 更深场景 =====================

/** P1·① 多素材类型组合：视频 + 图片 + 音频 + 字幕 同工程混合编排并真实渲染 */
async function ringMixedMediaTypes(results: RingResult[]): Promise<void> {
  try {
    const project = createEmptyProject({ name: 'mixed', width: 320, height: 240, fps: 30 });
    const tracks = [
      {
        id: uid(),
        kind: 'video' as const,
        name: '视频 1',
        clips: [
          { id: uid(), name: '视频A', kind: 'video' as const, start: 0, duration: 2000, offset: 0, hue: 0, assetPath: FIX1 },
          // 图片在编辑器里与视频同轨（kind=video），桥接时识别为 image 类型
          { id: uid(), name: '图片B', kind: 'video' as const, start: 2000, duration: 2000, offset: 0, hue: 0, assetPath: FIX5 },
        ],
      },
      {
        id: uid(),
        kind: 'audio' as const,
        name: '音频 1',
        clips: [
          { id: uid(), name: '音频C', kind: 'audio' as const, start: 0, duration: 4000, offset: 0, hue: 0, assetPath: FIX6 },
        ],
      },
      {
        id: uid(),
        kind: 'text' as const,
        name: '字幕',
        clips: [
          { id: uid(), name: '测试字幕', kind: 'text' as const, start: 0, duration: 4000, offset: 0, hue: 0 },
        ],
      },
    ];
    const hints = new Map([
      [FIX1, { durationMs: 2000, width: 320, height: 240, hasAudio: true }],
      [FIX5, { width: 320, height: 240 }],
      [FIX6, { durationMs: 2000, hasAudio: true }],
    ]);
    const built = timelineToProject(project, tracks, hints);
    if (built.assets.length !== 3) throw new Error(`素材类型应 3 种，实际 ${built.assets.length}`);
    const types = built.assets.map((a) => a.type).sort();
    if (!types.includes('video') || !types.includes('image') || !types.includes('audio')) {
      throw new Error(`素材类型缺失：${types.join(',')}`);
    }
    // 混合工程真实渲染
    const outPath = path.join(BASE, 'mixed-out.mp4');
    const res = await renderProject({ project: built, outputPath: outPath, quality: 'standard' });
    if (!fs.existsSync(outPath) || fs.statSync(outPath).size <= 0) throw new Error('混合工程渲染产物无效');
    results.push(ok('多素材类型组合', `video+image+audio+text 混合渲染通过（encoder=${res.encoderUsed}）`));
  } catch (e) {
    results.push(fail('多素材类型组合', (e as Error).message));
  }
}

/** P1·② 缩略图生成：真出图 + 同参数命中缓存 + 不同时间点出不同图 + 图片素材缩略图 */
async function ringThumbnails(results: RingResult[]): Promise<void> {
  try {
    const p1 = await generateThumbnail(FIX1, { atMs: 500, width: 320 });
    if (!fs.existsSync(p1) || fs.statSync(p1).size <= 0) throw new Error('缩略图未生成');
    if (!/thumbs[/\\][^/\\]+\.jpg$/.test(p1.replace(/\\/g, '/'))) {
      throw new Error(`缩略图路径不在 thumbs 目录：${p1}`);
    }
    // 缓存命中：同一参数返回同一路径
    const p2 = await generateThumbnail(FIX1, { atMs: 500, width: 320 });
    if (p2 !== p1) throw new Error('缩略图未命中缓存（路径不一致）');
    // 不同时间点应生成不同缩略图
    const p3 = await generateThumbnail(FIX1, { atMs: 1500, width: 320 });
    if (p3 === p1) throw new Error('不同时间点应生成不同缩略图');
    // 图片素材缩略图
    const pi = await generateThumbnail(FIX5, { atMs: 0, width: 320 });
    if (!fs.existsSync(pi) || fs.statSync(pi).size <= 0) throw new Error('图片缩略图未生成');
    results.push(ok('缩略图生成+缓存', `视频/图片缩略图生成并命中缓存（${path.basename(p1)}）`));
  } catch (e) {
    results.push(fail('缩略图生成+缓存', (e as Error).message));
  }
}

/** P1·③ 工程迁移：缺省字段的老工程经 migrateProject + ProjectSchema.parse 补齐默认值；非法 id 被拒 */
async function ringProjectMigration(results: RingResult[]): Promise<void> {
  try {
    const now = new Date().toISOString();
    // 老工程：仅含必需字段（id + meta），缺少 canvas/assets/tracks/name
    const legacy = {
      schemaVersion: 1,
      id: uid(),
      meta: { createdAt: now, updatedAt: now },
    };
    const migrated = migrateProject(legacy) as Record<string, unknown>;
    // 迁移表为空 → 原样返回（不静默改写版本）
    if ((migrated as { schemaVersion?: number }).schemaVersion !== 1) {
      throw new Error('空迁移表不应改变 schemaVersion');
    }
    const parsed = ProjectSchema.parse(migrated);
    if (parsed.assets.length !== 0) throw new Error('缺省 assets 应补为 []');
    if (parsed.tracks.length !== 0) throw new Error('缺省 tracks 应补为 []');
    if (parsed.canvas.width !== 1920 || parsed.canvas.height !== 1080 || parsed.canvas.fps !== 30) {
      throw new Error(`canvas 默认值错误：${parsed.canvas.width}x${parsed.canvas.height}@${parsed.canvas.fps}`);
    }
    if (!Array.isArray(parsed.meta.tags)) throw new Error('meta.tags 应补为数组');

    // 反向：非法 id 应被校验拒绝（迁移不静默放行坏数据）
    let rejected = false;
    try {
      ProjectSchema.parse(
        migrateProject({ schemaVersion: 1, id: 'not-a-uuid', meta: { createdAt: now, updatedAt: now } }),
      );
    } catch {
      rejected = true;
    }
    if (!rejected) throw new Error('非 UUID id 未被 ProjectSchema 拒绝');

    results.push(ok('工程迁移+默认值', '老工程经 migrateProject+parse 补齐 canvas/assets/tracks/meta 默认'));
  } catch (e) {
    results.push(fail('工程迁移+默认值', (e as Error).message));
  }
}

/** P1·④ 大工程往返：~110 片段（视频/音频各 50 + 字幕 10）保存→读取一致、时长无漂移 */
async function ringLargeProjectRoundtrip(results: RingResult[]): Promise<void> {
  try {
    const store = getProjectStore();
    const created = store.create({ name: 'large' });
    const N = 50;
    const videoClips = [];
    for (let i = 0; i < N; i += 1) {
      videoClips.push({ id: uid(), name: `v${i}`, kind: 'video' as const, start: i * 1000, duration: 1000, offset: 0, hue: 0, assetPath: FIX1 });
    }
    const audioClips = [];
    for (let i = 0; i < N; i += 1) {
      audioClips.push({ id: uid(), name: `a${i}`, kind: 'audio' as const, start: i * 1000, duration: 1000, offset: 0, hue: 0, assetPath: FIX6 });
    }
    const textClips = [];
    for (let i = 0; i < 10; i += 1) {
      textClips.push({ id: uid(), name: `t${i}`, kind: 'text' as const, start: i * 1000, duration: 1000, offset: 0, hue: 0 });
    }
    const tracks = [
      { id: uid(), kind: 'video' as const, name: '视频 1', clips: videoClips },
      { id: uid(), kind: 'audio' as const, name: '音频 1', clips: audioClips },
      { id: uid(), kind: 'text' as const, name: '字幕', clips: textClips },
    ];
    const built = timelineToProject(created, tracks);
    const saved = store.save(built);
    const got = store.get(saved.id);
    if (!got) throw new Error('大工程读取返回 null');
    let totalClips = 0;
    for (const t of got.tracks) totalClips += t.clips.length;
    const expect = N * 2 + 10;
    if (totalClips !== expect) throw new Error(`往返后片段数应为 ${expect}，实际 ${totalClips}`);
    const sumBefore = built.tracks.reduce((s, t) => s + t.clips.reduce((ss, c) => ss + (c.start + c.duration), 0), 0);
    const sumAfter = got.tracks.reduce((s, t) => s + t.clips.reduce((ss, c) => ss + (c.start + c.duration), 0), 0);
    if (sumBefore !== sumAfter) throw new Error(`往返时长不一致：前 ${sumBefore} / 后 ${sumAfter}`);
    results.push(ok('大工程往返', `~${expect} 片段保存→读取一致，时长无漂移`));
  } catch (e) {
    results.push(fail('大工程往返', (e as Error).message));
  }
}

/** P1·⑤ 性能基线：保存 / 读取耗时断言（本地临时盘，阈值宽松以避免抖动误判） */
async function ringPerformanceBaseline(results: RingResult[]): Promise<void> {
  try {
    const store = getProjectStore();
    const created = store.create({ name: 'perf' });
    const clips = [];
    for (let i = 0; i < 20; i += 1) {
      clips.push({ id: uid(), name: `c${i}`, kind: 'video' as const, start: i * 1000, duration: 1000, offset: 0, hue: 0, assetPath: FIX1 });
    }
    const built = timelineToProject(created, [{ id: uid(), kind: 'video' as const, name: '视频 1', clips }]);
    const t0 = Date.now();
    const saved = store.save(built);
    const saveMs = Date.now() - t0;
    const t1 = Date.now();
    const got = store.get(saved.id);
    const readMs = Date.now() - t1;
    if (!got) throw new Error('性能基线：读取返回 null');
    if (saveMs > 3000) throw new Error(`保存耗时异常：${saveMs}ms`);
    if (readMs > 2000) throw new Error(`读取耗时异常：${readMs}ms`);
    results.push(ok('性能基线', `20 片段保存 ${saveMs}ms / 读取 ${readMs}ms（阈值 3000/2000ms）`));
  } catch (e) {
    results.push(fail('性能基线', (e as Error).message));
  }
}

/** P1·⑥ 素材库：扫描目录（imported=false） vs 手动导入（imported=true），重扫导入素材保留 */
async function ringLibraryScanVsImport(results: RingResult[]): Promise<void> {
  try {
    const lib = getLibraryStore();
    const scanDir = path.join(BASE, 'scanlib');
    fs.mkdirSync(scanDir, { recursive: true });
    fs.copyFileSync(FIX1, path.join(scanDir, 'scan-video.mp4'));
    fs.copyFileSync(FIX6, path.join(scanDir, 'scan-audio.wav'));

    // 1) 扫描目录
    const sum = await lib.scan([scanDir]);
    if (sum.total < 2) throw new Error(`扫描应发现 ≥2 个素材，实际 ${sum.total}`);
    const scannedEntries = lib.list().filter((e) => e.path.startsWith(scanDir));
    if (scannedEntries.length < 2) throw new Error('扫描条目未入库');
    if (scannedEntries.some((e) => e.imported)) throw new Error('扫描导入的素材不应带 imported 标记');

    // 2) 单独导入一个文件（不属扫描目录）
    const imported = await lib.addFiles([FIX1]);
    if (!imported[0]?.imported) throw new Error('addFiles 应标记为 imported');

    // 3) 再次扫描同一目录：手动导入素材必须被保留（否则用户重扫即丢素材）
    await lib.scan([scanDir]);
    const after = lib.list();
    const imp = after.find((e) => e.path === FIX1);
    if (!imp || !imp.imported) throw new Error('重扫描后手动导入素材丢失（黑屏风险）');
    const sc = after.find((e) => e.path.startsWith(scanDir));
    if (!sc) throw new Error('重扫描后扫描素材丢失');

    results.push(ok('素材库·扫描 vs 导入', '扫描(imported=false) + 手动导入(imported=true) 重扫均保留'));
  } catch (e) {
    results.push(fail('素材库·扫描 vs 导入', (e as Error).message));
  }
}

// ===================== 阶段五 5.2 · 更细异常（导出/火山鉴权） =====================

/** 更细异常·火山引擎鉴权 code 分支：未配置 / 返回错误码 / 连接失败 三分支均优雅报错 */
async function ringTtsVolcanoAuth(results: RingResult[]): Promise<void> {
  try {
    const handlers: Record<string, (...a: any[]) => any> = (globalThis as any).__MIAOMA_IPC__;
    if (!handlers['tts:synthesize']) throw new Error('tts:synthesize 处理器未注册');

    // 伪造 WebSocket：让火山 provider 走我们可控的「服务端响应」，无需真实联调
    const origWs = (globalThis as any).WebSocket;
    class FakeWsError {
      binaryType = 'arraybuffer';
      onopen: ((e: unknown) => void) | null = null;
      onmessage: ((e: { data: unknown }) => void) | null = null;
      onerror: ((e: unknown) => void) | null = null;
      onclose: ((e: unknown) => void) | null = null;
      constructor(_url: string) {
        // 先 onopen，再下发一条「鉴权失败」的错误事件（code 分支）
        setTimeout(() => {
          this.onopen && this.onopen({});
          setTimeout(() => {
            this.onmessage &&
              this.onmessage({
                data: JSON.stringify({ event: 'error', code: 4001, message: 'invalid access token' }),
              });
          }, 0);
        }, 0);
      }
      send(_d: string | ArrayBufferView | ArrayBuffer): void {}
      close(): void {}
    }
    class FakeWsConnFail {
      binaryType = 'arraybuffer';
      onopen: ((e: unknown) => void) | null = null;
      onmessage: ((e: { data: unknown }) => void) | null = null;
      onerror: ((e: unknown) => void) | null = null;
      onclose: ((e: unknown) => void) | null = null;
      constructor(_url: string) {
        setTimeout(() => {
          this.onerror && this.onerror({});
        }, 0);
      }
      send(_d: string | ArrayBufferView | ArrayBuffer): void {}
      close(): void {}
    }

    // (a) 未配置：appId/accessToken 缺失 → 明确提示而非静默失败
    saveTtsConfig({
      active: 'volcano',
      volcano: { appId: '', accessToken: '', voice: 'zh_female_roumei' },
      local: { baseUrl: 'http://127.0.0.1:1/tts', voice: 'default' },
      custom: { baseUrl: '', model: 'tts-1', voice: 'default', apiKey: '' },
    });
    let unconfiguredMsg = '';
    try {
      await handlers['tts:synthesize'](null, { text: `未配置-${Date.now()}`, provider: 'volcano' });
    } catch (e) {
      unconfiguredMsg = (e as Error).message;
    }
    if (!/尚未配置火山引擎 TTS/.test(unconfiguredMsg)) {
      throw new Error(`未配置分支提示不符预期：${unconfiguredMsg}`);
    }

    // (b) 已配置但服务端返回错误码 → 抛出「火山引擎 TTS 返回错误 <code>: <msg>」
    saveTtsConfig({
      active: 'volcano',
      volcano: { appId: 'fake-app', accessToken: 'fake-token', voice: 'zh_female_roumei' },
      local: { baseUrl: 'http://127.0.0.1:1/tts', voice: 'default' },
      custom: { baseUrl: '', model: 'tts-1', voice: 'default', apiKey: '' },
    });
    (globalThis as any).WebSocket = FakeWsError;
    let codeMsg = '';
    try {
      await handlers['tts:synthesize'](null, { text: `鉴权失败-${Date.now()}`, provider: 'volcano' });
    } catch (e) {
      codeMsg = (e as Error).message;
    } finally {
      (globalThis as any).WebSocket = origWs;
    }
    if (!/火山引擎 TTS 返回错误 4001/.test(codeMsg)) {
      throw new Error(`错误码分支未触发：${codeMsg}`);
    }

    // (c) 已配置但连接失败（onerror）→ 提示检查 appId/accessToken 与网络
    (globalThis as any).WebSocket = FakeWsConnFail;
    let connMsg = '';
    try {
      await handlers['tts:synthesize'](null, { text: `连接失败-${Date.now()}`, provider: 'volcano' });
    } catch (e) {
      connMsg = (e as Error).message;
    } finally {
      (globalThis as any).WebSocket = origWs;
    }
    if (!/火山引擎 TTS 连接失败/.test(connMsg)) {
      throw new Error(`连接失败分支未触发：${connMsg}`);
    }

    results.push(ok('更细异常·火山鉴权', '未配置/错误码4001/连接失败 三分支均优雅报错'));
  } catch (e) {
    results.push(fail('更细异常·火山鉴权', (e as Error).message));
  }
}

/** 更细异常·导出目标不可写：路径非法/无权限时 renderProject 优雅抛错而非卡死 */
async function ringExportUnwritable(results: RingResult[]): Promise<void> {
  try {
    // 用一个「已是文件」的路径作为输出父目录，迫使 ffmpeg 无法打开输出，
    // 跨平台确定性地模拟「导出目录无写权限 / 路径非法」这一失败分支。
    // （Windows 目录只读属性对文件所有者不生效，故用 file-as-dir 触发 ffmpeg 写盘失败，
    //  仍走与真实「无写权限」完全相同的 spawnFfmpeg→非0退出→优雅抛错路径。）
    const denyFile = path.join(BASE, `deny-${Date.now()}`);
    fs.writeFileSync(denyFile, 'x');
    const outPath = path.join(denyFile, 'out.mp4');

    const project = createEmptyProject({ name: 'export-deny', width: 320, height: 240, fps: 30 });
    const tracks = [
      {
        id: uid(),
        kind: 'video' as const,
        name: '视频 1',
        clips: [
          { id: uid(), name: 'A', kind: 'video' as const, start: 0, duration: 2000, offset: 0, hue: 0, assetPath: FIX1 },
        ],
      },
    ];
    const built = timelineToProject(project, tracks);

    let threw = false;
    let msg = '';
    try {
      await renderProject({ project: built, outputPath: outPath, quality: 'standard' });
    } catch (e) {
      threw = true;
      msg = (e as Error).message;
    }
    if (!threw) throw new Error('导出目标不可写时未报错（应优雅失败）');
    if (!/FFmpeg 渲染失败/.test(msg)) throw new Error(`导出失败信息不友好：${msg}`);

    results.push(ok('更细异常·导出目标不可写', 'renderProject 捕获 ffmpeg 写盘失败并优雅抛错'));
  } catch (e) {
    results.push(fail('更细异常·导出目标不可写', (e as Error).message));
  }
}

// ===================== 阶段五 5.2 · P1 深度扩展（更多边界场景） =====================

/** P1 扩展·① 空工程渲染兜底：无轨道无素材应渲染出合法空画布视频，而非崩溃 */
async function ringRenderEmpty(results: RingResult[]): Promise<void> {
  try {
    const project = createEmptyProject({ name: 'empty' });
    const outPath = path.join(BASE, 'empty-out.mp4');
    const res = await renderProject({ project, outputPath: outPath, quality: 'standard' });
    if (!fs.existsSync(outPath) || fs.statSync(outPath).size <= 0) throw new Error('空工程渲染产物无效');
    results.push(ok('空工程渲染兜底', `无轨道工程渲染出 ${res.durationMs}ms 空画布视频`));
  } catch (e) {
    results.push(fail('空工程渲染兜底', (e as Error).message));
  }
}

/** P1 扩展·② 竖屏/非 16:9 画布渲染：1080x1920 画布下 scale/overlay 不崩，输出尺寸正确 */
async function ringRenderVertical(results: RingResult[]): Promise<void> {
  try {
    const project = createEmptyProject({ name: 'vertical', canvas: { width: 1080, height: 1920, fps: 30 } });
    const tracks = [
      {
        id: uid(),
        kind: 'video' as const,
        name: '视频 1',
        clips: [
          { id: uid(), name: 'A', kind: 'video' as const, start: 0, duration: 2000, offset: 0, hue: 0, assetPath: FIX1 },
        ],
      },
    ];
    const built = timelineToProject(project, tracks);
    const outPath = path.join(BASE, 'vertical-out.mp4');
    await renderProject({ project: built, outputPath: outPath, quality: 'standard' });
    if (!fs.existsSync(outPath)) throw new Error('竖屏渲染产物未生成');
    const probe = await probeMedia(outPath);
    if (probe.width !== 1080 || probe.height !== 1920) {
      throw new Error(`竖屏尺寸不符：期望 1080x1920，实际 ${probe.width}x${probe.height}`);
    }
    results.push(ok('竖屏画布渲染', `1080x1920 非 16:9 画布渲染通过，输出 ${probe.width}x${probe.height}`));
  } catch (e) {
    results.push(fail('竖屏画布渲染', (e as Error).message));
  }
}

/** P1 扩展·③ 纯音频工程渲染：无视频轨 → 纯色底 + 音轨，应含音轨 */
async function ringRenderAudioOnly(results: RingResult[]): Promise<void> {
  try {
    const project = createEmptyProject({ name: 'audioonly', canvas: { width: 320, height: 240, fps: 30 } });
    const tracks = [
      {
        id: uid(),
        kind: 'audio' as const,
        name: '音频 1',
        clips: [
          { id: uid(), name: 'A', kind: 'audio' as const, start: 0, duration: 2000, offset: 0, hue: 0, assetPath: FIX6 },
        ],
      },
    ];
    const built = timelineToProject(project, tracks);
    const outPath = path.join(BASE, 'audio-only-out.mp4');
    await renderProject({ project: built, outputPath: outPath, quality: 'standard' });
    if (!fs.existsSync(outPath) || fs.statSync(outPath).size <= 0) throw new Error('纯音频工程渲染产物无效');
    const probe = await probeMedia(outPath);
    if (!probe.hasAudio) throw new Error('纯音频工程渲染产物应含音轨');
    results.push(ok('纯音频工程渲染', `无视频轨→纯色底+音轨渲染通过（hasAudio=${probe.hasAudio}）`));
  } catch (e) {
    results.push(fail('纯音频工程渲染', (e as Error).message));
  }
}

/** P1 扩展·④ 素材库批量扫描：大量文件扫描数量正确且有性能基线 */
async function ringLibraryScale(results: RingResult[]): Promise<void> {
  try {
    const lib = getLibraryStore();
    const scanDir = path.join(BASE, 'scalelib');
    fs.mkdirSync(scanDir, { recursive: true });
    const src = genFixture('scale-src.mp4');
    const N = 20;
    for (let i = 0; i < N; i += 1) fs.copyFileSync(src, path.join(scanDir, `clip-${i}.mp4`));
    const t0 = Date.now();
    const sum = await lib.scan([scanDir]);
    const ms = Date.now() - t0;
    if (sum.total !== N) throw new Error(`扫描数量应为 ${N}，实际 ${sum.total}`);
    if (ms > 30000) throw new Error(`扫描 ${N} 文件耗时异常：${ms}ms`);
    results.push(ok('素材库批量扫描', `${N} 文件扫描正确且 ${ms}ms（阈值 30s）`));
  } catch (e) {
    results.push(fail('素材库批量扫描', (e as Error).message));
  }
}

/** P1 扩展·⑤ 工程列表容错：坏文件被跳过、有效工程保留，list 不崩 */
async function ringProjectListRobust(results: RingResult[]): Promise<void> {
  try {
    const store = getProjectStore();
    for (const id of ['brokenA', 'brokenB']) {
      fs.writeFileSync(path.join(USERDATA, 'projects', `${id}.mmproj.json`), '{ this is not json', 'utf8');
    }
    const valid = store.create({ name: 'robust-valid' });
    const list = store.list();
    const ids = list.map((s) => s.id);
    if (ids.includes('brokenA') || ids.includes('brokenB')) throw new Error('坏文件未被跳过');
    if (!ids.includes(valid.id)) throw new Error('有效工程未被列出');
    results.push(ok('工程列表容错', `坏文件跳过、有效工程保留（list 共 ${list.length} 项）`));
  } catch (e) {
    results.push(fail('工程列表容错', (e as Error).message));
  }
}

/** P1 扩展·⑥ TTS 空文本边界：空/纯空白文本被拒并给出明确提示 */
async function ringTtsEmptyText(results: RingResult[]): Promise<void> {
  try {
    const handlers: Record<string, (...a: any[]) => any> = (globalThis as any).__MIAOMA_IPC__;
    if (!handlers['tts:synthesize']) throw new Error('tts:synthesize 处理器未注册');
    let threw = false;
    let msg = '';
    try {
      await handlers['tts:synthesize'](null, { text: '   ', provider: 'local' });
    } catch (e) {
      threw = true;
      msg = (e as Error).message;
    }
    if (!threw) throw new Error('空文本未报错');
    if (!/合成文本不能为空/.test(msg)) throw new Error(`空文本报错信息不符：${msg}`);
    results.push(ok('TTS 空文本边界', '空/纯空白文本被拒并给出明确提示'));
  } catch (e) {
    results.push(fail('TTS 空文本边界', (e as Error).message));
  }
}

/**
 * 阶段二·AI 引擎接入（桌面端）：
 * 用真实主进程服务跑一次「启动 → 分镜中断 → 人工改分镜 → resume → 工程落盘」全链路。
 * 本机 TTS 默认不可达，因此同时验证了 TTS 降级为静音占位后链路仍能跑完。
 */
async function ringAgentPipeline(results: RingResult[]): Promise<void> {
  try {
    // 视频 + 图片 + 音频：让离线分镜生成 ≥2 场，从而覆盖「删除分镜后重排序号」路径
    const dirs = [path.dirname(FIX1), path.dirname(FIX5), path.dirname(FIX6)];
    const snap = await startAgentRun({
      requirement: '做一个 20 秒的旅行回忆短片',
      sourceDirs: dirs,
    });
    if (snap.status !== 'interrupted') throw new Error(`期望 interrupted，实际 ${snap.status}`);
    if (snap.node !== 'storyboard-review') throw new Error(`中断点应为 storyboard-review（LangGraph interrupt），实际 ${snap.node}`);
    if (snap.scenes.length === 0) throw new Error('未产出分镜');

    // 模拟用户在分镜页改旁白 / 改时长 / 删掉最后一场
    const edited = snap.scenes.map((s, i) => ({
      ...s,
      narration: `${s.narration}（已修改 ${i + 1}）`,
      durationMs: 3000 + i * 1000,
    }));
    const final = edited.length > 1 ? edited.slice(0, edited.length - 1) : edited;

    const done = await resumeAgentRun(final);
    if (done.status !== 'completed' || !done.projectId) {
      throw new Error(`resume 后未产出工程（status=${done.status}）`);
    }

    const project = await getProjectStore().get(done.projectId);
    if (!project) throw new Error('落盘工程无法读回');
    if (!ProjectSchema.safeParse(project).success) throw new Error('落盘工程未通过 Zod 校验');
    if (project.tracks.length !== 4) throw new Error(`轨道数=${project.tracks.length}（期望 4）`);

    results.push(
      ok(
        '阶段二·AI 引擎接入（桌面端）',
        `分镜 ${snap.scenes.length}→${final.length} 场，resume 后落盘 ${done.projectId.slice(0, 8)}，轨道 ${project.tracks.length}`,
      ),
    );
  } catch (e) {
    results.push(fail('阶段二·AI 引擎接入（桌面端）', (e as Error).message));
  }
}

/**
 * 阶段二·LLM 配置落盘与未配置回退：
 * 选 ark 但不填 apiKey → createAgentDeps 必须回退离线 Provider（而不是让整条链路崩掉）；
 * 填上 apiKey → 使用 ark；选 ollama → 本地模型 Provider（M1 三模型引擎）。最后还原配置。
 */
async function ringLlmConfig(results: RingResult[]): Promise<void> {
  const original = loadLlmConfig();
  try {
    saveLlmConfig({ active: 'ark', ark: { apiKey: '', model: 'm', baseUrl: 'http://x' }, ollama: { ...original.ollama }, custom: { ...original.custom } });
    const afterSave = loadLlmConfig();
    if (afterSave.active !== 'ark') throw new Error('配置未落盘');
    if (isLlmConfigured(afterSave)) throw new Error('空 apiKey 竟被判为已配置');
    const deps1 = createAgentDeps();
    if (deps1.llm.providerId !== 'offline') throw new Error(`未配置时应回退离线，实际 ${deps1.llm.providerId}`);

    saveLlmConfig({ active: 'ark', ark: { apiKey: 'sk-test', model: 'm', baseUrl: 'http://x' }, ollama: { ...original.ollama }, custom: { ...original.custom } });
    const deps2 = createAgentDeps();
    if (deps2.llm.providerId !== 'ark') throw new Error(`已配置时应使用 ark，实际 ${deps2.llm.providerId}`);

    // M1：本地 Ollama 分支（选了且填了地址即生效，不依赖服务真实在线）
    saveLlmConfig({ active: 'ollama', ark: { ...original.ark }, ollama: { baseUrl: 'http://127.0.0.1:11434', model: 'qwen2.5:7b' }, custom: { ...original.custom } });
    const deps3 = createAgentDeps();
    if (deps3.llm.providerId !== 'ollama') throw new Error(`选 ollama 应使用本地模型 Provider，实际 ${deps3.llm.providerId}`);
    if (typeof (deps3.llm as { bindTools?: unknown }).bindTools !== 'function') {
      throw new Error('ollama Provider 应为 LangChain ChatModel（具备 bindTools）');
    }
    // 旧配置文件无 ollama 字段的向后兼容：补齐默认值
    const legacy = { active: 'ark', ark: { apiKey: 'k', model: 'm', baseUrl: 'http://x' } };
    fs.writeFileSync(path.join(USERDATA, 'llm-config.json'), JSON.stringify(legacy), 'utf8');
    const migrated = loadLlmConfig();
    if (!migrated.ollama?.baseUrl) throw new Error('旧配置缺 ollama 字段时应补默认值');

    results.push(
      ok('阶段二·LLM 配置落盘与回退', 'ark 未填 key→回退离线；填 key→ark；选 ollama→本地 Provider；旧配置自动补齐'),
    );
  } catch (e) {
    results.push(fail('阶段二·LLM 配置落盘与回退', (e as Error).message));
  } finally {
    saveLlmConfig(original);
  }
}

/**
 * 自定义模型提供者：LLM custom（DeepSeek 型 OpenAI 兼容）路由到 providerId='custom'；
 * TTS custom 经 mock /audio/speech 真实合成落盘；
 * VideoGen 任务协议 mock 验证 openai-video 与 seedance 两种形态（建任→轮询→下载）。
 */
async function ringCustomProviders(results: RingResult[]): Promise<void> {
  const name = '自定义模型提供者（LLM/TTS/视频）';
  const originalLlm = loadLlmConfig();
  const originalTts = loadTtsConfig();
  const originalVg = loadVideoGenConfig();
  let server: import('node:http').Server | null = null;
  /** 最后一次 seedance 建任载荷：用于断言 duration 已夹到模型接受的档位 */
  let lastTaskBody = '';
  /** 最后一次 MiniMax H3 建任载荷：用于断言分辨率档位透传 */
  let lastMmBody = '';
  try {
    const { createServer } = await import('node:http');
    const wavBytes = Buffer.from('RIFF....WAVEfake-audio-payload-for-bench', 'binary');
    const mp4Bytes = Buffer.from('ftypmp42fake-video-payload-for-bench', 'binary');
    server = createServer((req, res) => {
      const url = req.url ?? '';
      const json = (obj: unknown) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      if (req.method === 'POST' && url === '/audio/speech') {
        res.writeHead(200, { 'content-type': 'audio/mpeg' });
        res.end(wavBytes);
      } else if (req.method === 'GET' && url === '/models') {
        // 方舟风格的模型列表：只应按“看起来是视频模型”筛出 seedance
        json({
          data: [
            { id: 'doubao-seedance-2-5-260628' },
            { id: 'doubao-seed-1-6-250615' },
            { id: 'deepseek-v3' },
          ],
        });
      } else if (req.method === 'POST' && url === '/videos') {
        json({ id: 'vid-1' });
      } else if (req.method === 'GET' && url === '/videos/vid-1') {
        json({ id: 'vid-1', status: 'completed', video_url: 'http://127.0.0.1:' + (server!.address() as { port: number }).port + '/file.mp4' });
      } else if (req.method === 'POST' && url === '/contents/generations/tasks') {
        let raw = '';
        req.on('data', (chunk) => (raw += chunk));
        req.on('end', () => {
          lastTaskBody = raw;
          if (raw.includes('m-notopen')) {
            res.writeHead(404, { 'content-type': 'application/json' });
            res.end(
              JSON.stringify({
                error: {
                  code: 'ModelNotOpen',
                  message: 'Your account 1 has not activated the model m-notopen. Please activate the model service in the Ark Console.',
                },
              }),
            );
            return;
          }
          json({ id: 'sd-1' });
        });
      } else if (req.method === 'GET' && url === '/contents/generations/tasks/sd-1') {
        json({ id: 'sd-1', status: 'succeeded', content: { video_url: 'http://127.0.0.1:' + (server!.address() as { port: number }).port + '/file.mp4' } });
      } else if (req.method === 'POST' && url === '/v2/video_generation') {
        // MiniMax H3 建任响应（顶层 task_id）
        let raw = '';
        req.on('data', (chunk) => (raw += chunk));
        req.on('end', () => {
          lastMmBody = raw;
          json({ task_id: 'mm-1' });
        });
      } else if (req.method === 'GET' && url === '/v2/query/video_generation/mm-1') {
        // 真实结构：状态与产物包在 task 对象里，成功产物在 task.content.url
        json({
          task: {
            id: 'mm-1',
            model: 'MiniMax-H3',
            status: 'succeeded',
            created_at: 1789977256,
            updated_at: 1789977400,
            content: { url: 'http://127.0.0.1:' + (server!.address() as { port: number }).port + '/file.mp4' },
            resolution: '2K',
            duration: 4,
            usage: {},
            ratio: '16:9',
            task_type: 'generation',
          },
        });
      } else if (req.method === 'GET' && url === '/file.mp4') {
        res.writeHead(200, { 'content-type': 'video/mp4' });
        res.end(mp4Bytes);
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    const base = 'http://127.0.0.1:' + (server.address() as { port: number }).port;

    // 1) LLM custom 路由
    saveLlmConfig({
      active: 'custom',
      ark: { ...originalLlm.ark },
      ollama: { ...originalLlm.ollama },
      custom: { baseUrl: `${base}/v1`, apiKey: 'sk-bench', model: 'deepseek-chat' },
    });
    const llm = createAgentDeps().llm;
    if (llm.providerId !== 'custom') throw new Error(`LLM 应路由 custom，实际 ${llm.providerId}`);
    if (typeof llm.bindTools !== 'function') throw new Error('custom LLM 应为 OpenAI 兼容 ChatModel（支持 bindTools）');

    // 2) TTS custom 真实 HTTP 链路
    saveTtsConfig({
      active: 'custom',
      volcano: { ...originalTts.volcano },
      local: { ...originalTts.local },
      custom: { baseUrl: base, model: 'tts-1', voice: 'bench', apiKey: '' },
    });
    const ttsRes = await synthesizeSpeech({ text: '自定义提供商合成文本', provider: 'custom' });
    if (ttsRes.provider !== 'custom' || !fs.existsSync(ttsRes.audioPath)) {
      throw new Error(`TTS custom 合成异常：provider=${ttsRes.provider}`);
    }

    // 3) VideoGen 两种任务协议形态
    const workDir = path.join(BASE, 'custom-video');
    for (const variant of ['openai-video', 'seedance'] as const) {
      const provider = new HttpTaskVideoProvider({
        apiKey: 'k-bench',
        baseUrl: base,
        model: 'm-bench',
        variant,
        workDir,
        pollIntervalMs: 30,
        pollTimeoutMs: 5_000,
      });
      if (!provider.isConfigured()) throw new Error(`${variant} isConfigured 应为 true`);
      const gen = await provider.generate({ prompt: '一只猫在沙滩奔跑', durationSec: 4 });
      if (!fs.existsSync(gen.videoPath) || gen.ext !== 'mp4') {
        throw new Error(`${variant} 生成产物异常：${gen.videoPath}`);
      }
    }
    // 未填模型 id 时 isConfigured=false（不猜测默认值，避免静默错请求）
    if (new HttpTaskVideoProvider({ apiKey: 'k', baseUrl: base, model: '', variant: 'seedance', workDir }).isConfigured()) {
      throw new Error('seedance 未填模型时不应判为可用');
    }
    // 4) seedance 短镜头时长必须夹到模型接受档位（2s → 3），否则方舟直接拒接
    await new HttpTaskVideoProvider({
      apiKey: 'k',
      baseUrl: base,
      model: 'm-bench',
      variant: 'seedance',
      workDir,
      pollIntervalMs: 30,
      pollTimeoutMs: 5_000,
    }).generate({ prompt: '一只猫', durationSec: 2 });
    if (!/"duration":3/.test(lastTaskBody)) {
      throw new Error(`seedance duration 应夹到 3s 档位，实际载荷：${lastTaskBody.slice(0, 200)}`);
    }

    // 5) 模型未开通：给出中文可行动提示 + configError 标记（供节点中断流水线）
    const notOpen = new HttpTaskVideoProvider({
      apiKey: 'k',
      baseUrl: base,
      model: 'm-notopen',
      variant: 'seedance',
      workDir,
      pollIntervalMs: 30,
      pollTimeoutMs: 500,
    });
    let genErr: (Error & { configError?: boolean }) | null = null;
    try {
      await notOpen.generate({ prompt: '一只猫', durationSec: 5 });
    } catch (e) {
      genErr = e as Error & { configError?: boolean };
    }
    if (!genErr) throw new Error('模型未开通时应报错而不是静默成功');
    if (!/未开通/.test(genErr.message)) throw new Error(`未开通应给中文提示，实际：${genErr.message}`);
    if (!genErr.configError) throw new Error('配置类错误应带 configError 标记');

    // 6) gen-clips 全失败必须抛错：不能“流水线全绿 + 0 素材”静默降级
    const clipState = {
      requirement: '一只猫',
      completedNodes: [],
      scannedAssets: [],
      storyboard: {
        title: 't',
        scenes: [{ order: 0, title: '开场', description: '猫在吃猫粮', durationMs: 2200, expectedKind: 'video' }],
      },
      matchResult: { sceneAssets: {} },
    } as unknown as AgentState;
    const clipDeps = { videoGen: notOpen, logger: () => {} } as unknown as AgentDeps;
    let nodeErr = '';
    try {
      await NODE_RUNNERS['generate-clips'](clipState, clipDeps);
    } catch (e) {
      nodeErr = (e as Error).message;
    }
    if (!/全部失败/.test(nodeErr)) {
      throw new Error(`gen-clips 全失败应中断并报“全部失败”，实际：${nodeErr || '未报错（静默产出 0 素材）'}`);
    }

    // 7) 拉取可用模型：只留视频类 id（方舟 id 手填几乎必错，设置页靠它选）
    const remoteModels = await listRemoteModelIds({ baseUrl: base, apiKey: 'k' });
    if (remoteModels.join(',') !== 'doubao-seedance-2-5-260628') {
      throw new Error(`模型列表应只含视频模型，实际：${remoteModels.join('|')}`);
    }

    // 8) MiniMax 国内/海外 Key 不通用：鉴权失败要能映射到另一个区域重试（真实 401 成因）
    if (minimaxAlternateBase('https://api.minimax.io') !== 'https://api.minimaxi.com') {
      throw new Error('海外接入点应映射到国内接入点');
    }
    if (minimaxAlternateBase('https://api.minimaxi.com/') !== 'https://api.minimax.io') {
      throw new Error('国内接入点应映射到海外接入点');
    }
    if (minimaxAlternateBase('https://example.com') !== null) {
      throw new Error('未知域名不应做区域切换');
    }
    const authErr = toVideoGenError(401, 'authorized_error', 'invalid api key (2049)');
    if (!authErr.configError || !/minimaxi\.com/.test(authErr.message)) {
      throw new Error(`401 应标为配置错并提示区域不通用，实际：${authErr.message}`);
    }

    // 9) MiniMax H3 v2：建任→轮询→下载全链路（回归：状态包在 task 里，按顶层 json.status 读会永远 undefined 空转到超时）
    const mm = new MiniMaxH3VideoProvider({
      apiKey: 'k',
      baseUrl: base,
      model: 'minimax-h3',
      workDir,
      pollIntervalMs: 30,
      pollTimeoutMs: 5_000,
    });
    const mmGen = await mm.generate({ prompt: '一只猫在吃猫粮', durationSec: 4, ratio: '16:9' });
    if (!fs.existsSync(mmGen.videoPath) || mmGen.width <= mmGen.height) {
      throw new Error(`MiniMax H3 产物异常：${mmGen.videoPath} ${mmGen.width}x${mmGen.height}`);
    }
    // 缺省保持 2K（不擅自降级）
    if (!/"resolution":"2K"/.test(lastMmBody)) {
      throw new Error(`MiniMax 缺省应发 2K，实际载荷：${lastMmBody.slice(0, 200)}`);
    }
    // 设置中心选 768P 时必须透传（单价 0.50 vs 0.80 元/秒，选错就是白花线）
    await new MiniMaxH3VideoProvider({
      apiKey: 'k',
      baseUrl: base,
      model: 'minimax-h3',
      resolution: '768P',
      workDir,
      pollIntervalMs: 30,
      pollTimeoutMs: 5_000,
    }).generate({ prompt: '一只猫在吃猫粮', durationSec: 4 });
    if (!/"resolution":"768P"/.test(lastMmBody)) {
      throw new Error(`768P 未透传，实际载荷：${lastMmBody.slice(0, 200)}`);
    }
    // 10) 参考图必须按 reference_image 角色写进 content（跨段锁主体的传输层）
    await new MiniMaxH3VideoProvider({
      apiKey: 'k',
      baseUrl: base,
      model: 'minimax-h3',
      workDir,
      pollIntervalMs: 30,
      pollTimeoutMs: 5_000,
    }).generate({ prompt: '一只猫', durationSec: 4, referenceImage: 'data:image/jpeg;base64,QUJD' });
    if (!/reference_image/.test(lastMmBody) || !/data:image\/jpeg;base64,QUJD/.test(lastMmBody)) {
      throw new Error(`参考图未以 reference_image 角色下发，载荷：${lastMmBody.slice(0, 260)}`);
    }

    // 11) 跳段主体一致性：每段 prompt 同一锚点前缀 + 第二段起携带 base64 参考图
    //（回归用户实测的“三只不一样的猫”：逐段独立抽卡没有主体约束）
    const gen: Array<{ prompt: string; referenceImage?: string }> = [];
    const fakeVideo = path.join(workDir, 'fake-clip.mp4');
    fs.writeFileSync(fakeVideo, mp4Bytes);
    const framePath = path.join(workDir, 'frame.jpg');
    fs.writeFileSync(framePath, Buffer.from('fake-jpeg-bytes-for-data-uri', 'binary'));
    const recording = {
      id: 'rec',
      label: 'rec',
      isConfigured: () => true,
      generate: async (req: { prompt: string; referenceImage?: string }) => {
        gen.push({ prompt: req.prompt, referenceImage: req.referenceImage });
        return { videoPath: fakeVideo, durationMs: 4000, width: 1920, height: 1080, ext: 'mp4' };
      },
    };
    const anchorState = {
      requirement: '布偶猫吃猫粮',
      completedNodes: [],
      scannedAssets: [],
      brief: { theme: '一只蓝眼睛布偶猫在安静室内吃猫粮', tone: '温柔治愈', style: ['写实', '暖光'] },
      storyboard: {
        title: 't',
        scenes: [
          { order: 0, title: '开场', description: '侧前方中近景，猫低头吃粮', durationMs: 4000 },
          { order: 1, title: '特写', description: '镜头推近面部', durationMs: 4000 },
        ],
      },
      matchResult: { sceneAssets: {} },
    } as unknown as AgentState;
    await NODE_RUNNERS['generate-clips'](
      anchorState,
      {
        videoGen: recording,
        probe: async () => ({ durationMs: 4460, width: 2560, height: 1440, fps: 24, hasAudio: true }),
        extractFrame: async () => framePath,
        workDir,
        logger: () => {},
      } as unknown as AgentDeps,
    );
    if (gen.length !== 2) throw new Error(`应生成两段，实际 ${gen.length}`);
    if (!/同一个主体/.test(gen[0]!.prompt) || !/侧前方中近景/.test(gen[0]!.prompt)) {
      throw new Error(`prompt 应含主体锚点+场景描述，实际：${gen[0]!.prompt.slice(0, 160)}`);
    }
    if (gen[0]!.referenceImage) throw new Error('第一段不应带参考图（无产物可抽帧）');
    if (!gen[1]!.referenceImage?.startsWith('data:image/jpeg;base64,')) {
      throw new Error(`第二段应携带 base64 参考图锁主体，实际：${String(gen[1]!.referenceImage).slice(0, 40)}`);
    }
    if (gen[1]!.prompt.slice(0, 80) !== gen[0]!.prompt.slice(0, 80)) {
      throw new Error('两段 prompt 的锚点前缀必须逐字一致');
    }

    results.push(
      ok(
        name,
        'LLM→custom；TTS /audio/speech 合成落盘；openai-video 与 seedance 任务链路跑通；MiniMax H3 task 嵌套轮询 + 768P/2K 透传 + reference_image 下发；主体锚点与跨段参考图锁主体；duration 档位/未开通中文报错/gen-clips 不静默/模型列表拉取/MiniMax 区域映射',
      ),
    );
  } catch (e) {
    results.push(fail(name, (e as Error).message));
  } finally {
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    saveLlmConfig(originalLlm);
    saveTtsConfig(originalTts);
    saveVideoGenConfig(originalVg);
  }
}

/**
 * AI 助手对话式剪辑（R2）：ref 解析、计划翻译、非法输入兜底。
 *
 * 不依赖真实大模型：这几个都是纯函数，而「模型幻觉出快照里不存在的 ref」
 * 正是最需要防的那条路径——必须跳过并给人话回执，而不是默默改错片段。
 */
function ringAssistantPlan(results: RingResult[]): void {
  const name = 'R2·对话式剪辑计划与 ref 解析';
  const originalVg = loadVideoGenConfig();
  try {
    const clip = (id: string, label: string, start: number, duration: number): TimelineClip => ({
      id,
      name: label,
      kind: 'audio',
      start,
      duration,
      offset: 0,
      hue: 10,
      assetPath: `C:/media/${label}`,
    });
    const tracks: TimelineTrack[] = [
      { id: 't-audio', kind: 'audio', name: '音乐轨', clips: [clip('c1', 'tts-a.wav', 0, 2000), clip('c2', 'tts-b.wav', 2000, 3000)] },
      { id: 't-text', kind: 'text', name: '字幕轨', clips: [] },
    ];
    const selection = { trackId: 't-audio', clipId: 'c2' };

    // 快照编号按时间序：模型看到的 #N 就是用户在时间线上看到的顺序
    const snapshot = buildTimelineSnapshot(tracks, selection);
    if (snapshot.tracks[0]?.clips[0]?.ref !== '音乐轨#1') {
      throw new Error(`ref 编号异常：${snapshot.tracks[0]?.clips[0]?.ref}`);
    }
    if (snapshot.selectedRef !== '音乐轨#2') throw new Error(`selectedRef 异常：${snapshot.selectedRef}`);

    // 四种写法 + 越界引用
    if (resolveClipRef('音乐轨 第 1 段', tracks, selection)?.clipId !== 'c1') throw new Error('中文序号 ref 解析失败');
    if (resolveClipRef('选中', tracks, selection)?.clipId !== 'c2') throw new Error('「选中」解析失败');
    if (resolveClipRef('#2', tracks, selection)?.clipId !== 'c2') throw new Error('全局序号解析失败');
    if (resolveClipRef('tts-a.wav', tracks, selection)?.clipId !== 'c1') throw new Error('按片段名解析失败');
    if (resolveClipRef('音乐轨#9', tracks, selection) !== null) throw new Error('越界序号应返回 null');

    const plan = parseEditPlan({
      reply: '将删除音乐轨第 1 段并把第 2 段静音',
      actions: [
        { type: 'removeClip', ref: '音乐轨#1' },
        { type: 'updateClip', ref: '选中', patch: { muted: true, volume: 0.6 } },
        { type: 'addCaption', text: '好吃', startMs: 1000, durationMs: 2000 },
        { type: 'seekTo', startMs: 1500 },
        { type: 'removeClip', ref: '不存在的轨#7' },
      ],
    });
    const translated = translatePlan(plan, tracks, selection);
    if (translated.actions.length !== 3) throw new Error(`应产出 3 个动作，实际 ${translated.actions.length}`);
    if (translated.seekMs !== 1500) throw new Error(`seekTo 未单独提取：${translated.seekMs}`);
    if (!translated.notes.some((n) => /没找到片段/.test(n))) throw new Error('无法解析的 ref 应给人话提示');
    if (translated.lines.length !== 4) throw new Error(`确认卡片应列 4 行，实际 ${translated.lines.length}`);
    const update = translated.actions.find((a) => a.type === 'updateClip');
    if (!update || update.type !== 'updateClip' || update.patch.muted !== true || update.patch.volume !== 0.6) {
      throw new Error('updateClip 字段映射异常');
    }

    // 非法输入必须抛错（错误文本回灌给模型重试），不能悄悄产出半个动作
    let threw = '';
    try {
      parseEditPlan({ reply: '', actions: [] });
    } catch (e) {
      threw = (e as Error).message;
    }
    if (!/reply 不能为空/.test(threw)) throw new Error(`空 reply 应被拒，实际：${threw || '未抛错'}`);

    threw = '';
    try {
      parseEditPlan({ reply: 'x', actions: [{ type: 'removeClip' }] });
    } catch (e) {
      threw = (e as Error).message;
    }
    if (!/缺少 ref/.test(threw)) throw new Error(`缺 ref 应被拒，实际：${threw || '未抛错'}`);

    // splitClip：切点合法时展开成「改前段时长 + 新增后段」，素材内入点同步往后推
    const splitPlan = parseEditPlan({ reply: '切开', actions: [{ type: 'splitClip', ref: '音乐轨#1', atMs: 1000 }] });
    const splitT = translatePlan(splitPlan, tracks, selection);
    if (splitT.actions.length !== 2) throw new Error(`切分应产出 2 个动作，实际 ${splitT.actions.length}`);
    const second = splitT.actions.find((a) => a.type === 'addClip');
    if (!second || second.type !== 'addClip' || second.clip.start !== 1000 || second.clip.offset !== 1000 || second.clip.duration !== 1000) {
      throw new Error(`后段入点/起点映射异常：${JSON.stringify(second)}`);
    }
    const badSplit = translatePlan(parseEditPlan({ reply: 'x', actions: [{ type: 'splitClip', ref: '音乐轨#1', atMs: 9000 }] }), tracks, selection);
    if (badSplit.actions.length !== 0 || !badSplit.notes.length) throw new Error('越界切点应跳过并给原因');

    // insertAsset：无目标轨道给人话提示；有则进待检索队列（同步阶段不产动作）
    const noTrack = translatePlan(parseEditPlan({ reply: 'x', actions: [{ type: 'insertAsset', query: '海边的日落' }] }), tracks, selection);
    if (noTrack.inserts.length !== 0 || !noTrack.notes.some((n) => /没有视频轨/.test(n))) {
      throw new Error('无视频轨时 insertAsset 应给可行动提示');
    }
    const withInsert = translatePlan(
      parseEditPlan({ reply: 'x', actions: [{ type: 'insertAsset', query: '海边的日落', kind: 'audio' }] }),
      tracks,
      selection,
    );
    if (withInsert.inserts.length !== 1 || withInsert.inserts[0]?.kind !== 'audio' || withInsert.actions.length !== 0) {
      throw new Error('insertAsset 未进入待检索队列');
    }
    const undoPlan = translatePlan(parseEditPlan({ reply: '撤销', actions: [{ type: 'undo' }] }), tracks, selection);
    if (!undoPlan.undo || undoPlan.lines.length !== 1) throw new Error('undo 动作未翻译');

    // 撤销栈：整批改动一次回退（对话式剪辑的安全网）；全部被跳过的批次不入栈
    const before = getTracks();
    applyTimelineActions([{ type: 'replaceTracks', tracks: [{ id: 't-probe', kind: 'video', name: '视频轨', clips: [] }] }]);
    applyTimelineActions([
      { type: 'addClip', trackId: 't-probe', clip: { name: 'probe', kind: 'video', start: 0, duration: 1000, offset: 0, hue: 1 } },
    ]);
    if (!canUndo()) throw new Error('改动后应可撤销');
    const undone = undoTimeline();
    if (!undone || undone.clips !== 0) throw new Error(`撤销后应回到 0 片段，实际 ${undone?.clips}`);
    if (undoTimeline() === null) throw new Error('应还能再退一步回到初始快照');
    if (getTracks().length !== before.length) throw new Error('撤销到底应回到初始轨道数');
    applyTimelineActions([{ type: 'removeClip', trackId: 'no-such-track', clipId: 'no-such-clip' }]);
    if (canUndo()) throw new Error('全部跳过的批次不应压撤销栈');

    // 上下文注入：播放头、选中标记、字幕文本都要进快照，否则「在这里切开」无从翻译
    const rich = buildTimelineSnapshot(tracks, selection, 4200);
    if (rich.playheadMs !== 4200) throw new Error(`playheadMs 未注入：${rich.playheadMs}`);
    if (rich.tracks[0]?.clips[1]?.selected !== true) throw new Error('选中片段未标记 selected');
    if (rich.tracks[0]?.clips[0]?.selected === true) throw new Error('未选中片段不应被标记');

    // generateClip：结果只能落视频轨（无视频轨全拦下）；带 ref 时顶替目标镜头并沿用其位置
    const genPlan = parseEditPlan({
      reply: '生成两段',
      actions: [
        { type: 'generateClip', prompt: '猫抬头说好吃', durationSec: 5, ref: '音乐轨#2' },
        { type: 'generateClip', prompt: '猫走开' },
      ],
    });
    const genT = translatePlan(genPlan, tracks, selection);
    if (genT.generations.length !== 0) throw new Error(`没有视频轨时生成都应被拦下，实际放行 ${genT.generations.length}`);
    if (!genT.notes.some((n) => /没有视频轨/.test(n))) throw new Error('缺视频轨时 generateClip 应给可行动提示');
    const withVideoTrack: TimelineTrack[] = [
      ...tracks,
      { id: 't-video', kind: 'video', name: '视频轨', clips: [{ id: 'v1', name: 'clip-a.mp4', kind: 'video', start: 1000, duration: 4000, offset: 0, hue: 3, assetPath: 'C:/m/clip-a.mp4' }] },
    ];
    const genT2 = translatePlan(
      parseEditPlan({ reply: '顶替', actions: [{ type: 'generateClip', prompt: '猫抬头说好吃', durationSec: 5, ref: '视频轨#1' }] }),
      withVideoTrack,
      selection,
    );
    const gen = genT2.generations[0];
    if (
      !gen ||
      gen.replaceClipId !== 'v1' ||
      gen.replaceTrackId !== 't-video' ||
      gen.startMs !== 1000 ||
      gen.trackId !== 't-video' ||
      gen.durationSec !== 5
    ) {
      throw new Error(`generateClip 顶替目标解析异常：${JSON.stringify(gen)}`);
    }
    // 顶替音频轨上的镜头：结果仍入视频轨，删除动作落在旧片段所在轨
    const crossTrack = translatePlan(
      parseEditPlan({ reply: '顶替', actions: [{ type: 'generateClip', prompt: '猫抬头', durationSec: 4, ref: '音乐轨#1' }] }),
      withVideoTrack,
      selection,
    );
    const cross = crossTrack.generations[0];
    if (!cross || cross.trackId !== 't-video' || cross.replaceTrackId !== 't-audio' || cross.replaceClipId !== 'c1') {
      throw new Error(`跨轨顶替解析异常：${JSON.stringify(cross)}`);
    }

    // 费用护栏：MiniMax 按已核实单价算出金额（本批两段各 5s = 10s × 0.8 = 8 元）；
    // 未知单价/未知 Provider 给 null + 提示，绝不在卡片上编数字
    saveVideoGenConfig({ ...originalVg, active: 'minimax', minimax: { ...originalVg.minimax, apiKey: 'k', resolution: '2K' } });
    const cost = estimatePlanCost(genPlan, buildTimelineSnapshot(withVideoTrack, selection, 0));
    if (!cost || cost.yuan !== 8 || cost.seconds !== 10) {
      throw new Error(`2K 单价 0.8 元/秒 × 两段各 5s 应为 8 元，实际 ${JSON.stringify(cost)}`);
    }
    saveVideoGenConfig({ ...originalVg, active: 'seedance' });
    const unknown = estimatePlanCost(genPlan, buildTimelineSnapshot(withVideoTrack, selection, 0));
    if (!unknown || unknown.yuan !== null || !/计费页/.test(unknown.note)) {
      throw new Error(`未内置单价的 Provider 应返回 null + 提示，实际 ${JSON.stringify(unknown)}`);
    }
    if (estimatePlanCost({ reply: 'x', actions: [{ type: 'seekTo', startMs: 0 }] }, buildTimelineSnapshot(withVideoTrack, null, 0)) !== null) {
      throw new Error('没有生成动作时不应给费用预估');
    }

    results.push(ok(name, '快照含播放头/选中/字幕上下文 / 四种 ref 写法解析 / 切分、插件、生成展开 / 费用预估不编数字 / 幻觉 ref 逐条跳过 / 批量改动整批撤销'));
  } catch (e) {
    results.push(fail(name, (e as Error).message));
  } finally {
    saveVideoGenConfig(originalVg);
  }
}

/**
 * 编辑器属性真实接线：面板字段（scale/rotation/opacity/volume/muted）经 bridge 回写工程，
 * 渲染链消费（scale/rotate/colorchannelmixer/volume），往返不漂移；静音片段不接入混音。
 */
function ringClipPropertiesWire(results: RingResult[]): void {
  const name = '编辑器属性回写→渲染消费';
  try {
    const proj = createEmptyProject({ name: 'props', canvas: { width: 320, height: 240, fps: 25 } });
    const assetId = createId();
    proj.assets = [
      { id: assetId, name: 'p.mp4', path: FIX1, addedAt: nowIso(), type: 'video', duration: 3000, width: 1920, height: 1080, hasAudio: true, tags: [] },
    ];
    const mkTracks = (muted: boolean) => [
      {
        id: createId(), kind: 'video' as const, name: '视频 1',
        clips: [
          {
            id: createId(), name: 'A', kind: 'video' as const, start: 0, duration: 1500, offset: 0, hue: 0, assetPath: FIX1,
            scale: 1.5, rotation: 90, opacity: 0.5, volume: 0.8, muted,
          },
        ],
      },
    ];
    const built = timelineToProject(proj, mkTracks(false));
    const cv = built.tracks[0]!.clips[0] as VideoClip;
    if (cv.transform.scale !== 1.5 || cv.transform.rotation !== 90 || cv.transform.opacity !== 0.5) {
      throw new Error(`transform 回写异常：${JSON.stringify(cv.transform)}`);
    }
    if (cv.volume !== 0.8 || cv.muted !== false) throw new Error(`音量回写异常：volume=${cv.volume} muted=${cv.muted}`);
    // 往返：工程 → 时间线读回一致（面板受控数据源正确）
    const back = projectToTimeline(built)[0]!.clips[0]!;
    if (back.scale !== 1.5 || back.rotation !== 90 || back.opacity !== 0.5 || back.volume !== 0.8) {
      throw new Error(`往返读取异常：${JSON.stringify({ s: back.scale, r: back.rotation, o: back.opacity, v: back.volume })}`);
    }
    // 渲染链消费断言
    const opts = { drawtextAvailable: false, subtitlesAvailable: false, videoEncoder: 'libx264', audioEncoder: 'aac', pixelFormat: 'yuv420p' };
    const plan = buildRenderPlan(built, path.join(BASE, 'props-out.mp4'), opts);
    for (const frag of ['scale=w=iw*1.5', 'rotate=angle=', 'colorchannelmixer=aa=0.5', 'volume=0.8']) {
      if (!plan.filterComplex.includes(frag)) throw new Error(`filter_complex 缺少「${frag}」`);
    }
    // 静音：带音轨素材的 muted 片段不应接入任何 [i:a] 混音输入
    const mutedBuilt = timelineToProject(proj, mkTracks(true));
    const mutedPlan = buildRenderPlan(mutedBuilt, path.join(BASE, 'props-muted.mp4'), opts);
    if (/\[\d+:a\]/.test(mutedPlan.filterComplex)) throw new Error('静音片段仍接入了音频流');
    results.push(ok(name, 'scale/rotate/opacity/volume 进 filter_complex；往返一致；静音断开混音'));
  } catch (e) {
    results.push(fail(name, (e as Error).message));
  }
}

/**
 * M5：工程版本管理与云端协同（git 引擎，本地优先）。
 * 断言：保存自动快照→历史可回溯、任意版本可读且 Zod 合法、字段级 diff、
 * 回滚作为新版本落盘（历史线性不丢）、垃圾 .git 自愈重建不抛错、未配远端时 push 给明确错误。
 */
async function ringVersioningM5(results: RingResult[]): Promise<void> {
  const name = 'M5·工程版本管理与回滚';
  try {
    const store = getProjectStore();
    const created = store.create({ name: 'm5-初始' });
    // save 钩子是 fire-and-forget，快照链路用 versioning 直调保证确定性
    const vA = { ...created, name: 'm5-A' };
    const vB = { ...vA, name: 'm5-B' };
    const vC = { ...vB, name: 'm5-C' };
    await snapshotProject(vA);
    await snapshotProject(vB);
    await snapshotProject(vC);

    // 1) 历史可回溯（按内容去重后 ≥3 条，新→旧）
    let hist = await history(created.id);
    if (hist.length < 3) throw new Error(`历史应≥3，实际 ${hist.length}`);
    if (!hist[0]!.message.includes('m5-C')) throw new Error(`最新项应为 m5-C，实际 ${hist[0]!.message}`);

    // 2) 任意版本可读且 Zod 合法
    const oldest = hist[hist.length - 1]!;
    const oldProject = await readVersion(created.id, oldest.oid);
    if (!oldProject) throw new Error('旧版本读取/校验失败');

    // 3) 字段级 diff：旧→新仅名称变化
    const latest = await readVersion(created.id, hist[0]!.oid);
    const diff = diffProjects(oldProject, latest!);
    if (!diff.changed || !diff.nameChanged || diff.clipsAdded !== 0) {
      throw new Error(`diff 异常：${JSON.stringify(diff)}`);
    }

    // 4) 回滚作为新版本落盘（历史线性 +1，当前工程=旧内容）
    const restored = await restoreVersion(created.id, oldest.oid);
    if (restored.name !== oldProject.name) throw new Error('回滚后当前工程名不一致');
    const probe = await snapshotProject({ ...restored, name: `m5-probe-${Date.now()}` });
    hist = await history(created.id);
    if (hist.length < 4) {
      throw new Error(`回滚应新增版本，实际历史 ${hist.length}，probe=${probe}，最新=${hist[0]?.message ?? '-'}`);
    }

    // 5) 坏仓自愈：写垃圾 .git/HEAD 后历史不抛错、快照仍能重建恢复
    const repoGitHead = path.join(USERDATA, 'project-repo', '.git', 'HEAD');
    fs.mkdirSync(path.dirname(repoGitHead), { recursive: true });
    fs.writeFileSync(repoGitHead, 'garbage-not-a-ref-!!!!!');
    const afterBroken = await history(created.id);
    if (!Array.isArray(afterBroken)) throw new Error('坏仓 history 应自愈返回数组');
    const resaved = await snapshotProject({ ...restored, name: 'm5-自愈后' });
    if (!resaved) throw new Error('自愈后快照应成功');

    // 6) 未配远端：push 给明确中文错误；清理远端配置
    saveRemoteConfig(null);
    let pushMsg = '';
    try {
      await pushToRemote();
    } catch (e) {
      pushMsg = (e as Error).message;
    }
    if (!pushMsg.includes('尚未配置远端')) throw new Error(`未配远端应明确报错，实际：${pushMsg || '未报错'}`);

    store.remove(created.id);
    results.push(ok(name, '快照→历史≥4/diff/回滚线性/坏仓自愈/远端错误语义'));
  } catch (e) {
    results.push(fail(name, (e as Error).message));
  }
}

/**
 * M4：多模态解析降级与 AI 自动转场。
 * 断言：向量空间维度保护（512 维视觉向量不被误复用于 96 维词法查询）、
 * 模型缺失时视觉链路静降级不抛错（扫描/检索绝不触发下载）、
 * applyAutoTransitions 规则确定性 + 幂等、自动转场经 buildRenderPlan 落入 filter_complex、
 * search 异步化后词法行为不变。
 */
async function ringVisionMultimodalM4(results: RingResult[]): Promise<void> {
  const name = 'M4·视觉增强降级与 AI 自动转场';
  try {
    // 1) 维度保护：非 96 维外部向量必须重算词法向量
    const foreign = embedAsset({ name: 'x.mp4', type: 'video', embedding: new Array(512).fill(0.04) });
    if (foreign.length !== EMBED_DIMS) throw new Error(`维度保护失效：返回 ${foreign.length} 维`);

    // 2) 视觉未就绪降级：embedImage 对不存在路径/未下载模型都返回 null，绝不抛错、绝不触发下载
    const st = visionStatus();
    if (st.ready) throw new Error('本机不应已下载 CLIP，此环假设未就绪');
    if ((await embedImage(path.join(BASE, 'no-such-frame.jpg'))) !== null) throw new Error('缺图时应返回 null');

    // 3) 自动转场规则：两段连续（3s+6.25s 前短后长），首段应有 fade-in 800 + 快切 fade-out 400；
    //    末段快切 fade-in 400 + 收尾 fade-out 1200；重复调用幂等；不覆盖用户已设同名转场
    const clipA = {
      id: createId(), type: 'video' as const, assetId: createId(), start: 0, duration: 3000,
      offset: 0, speed: 1, locked: false, enabled: true, transform: DEFAULT_TRANSFORM, volume: 1, muted: false,
      effects: [{ id: createId(), kind: 'transition' as const, name: 'fade-out', params: { durationMs: 900 }, enabled: true }],
    };
    const clipB = {
      id: createId(), type: 'video' as const, assetId: createId(), start: 3000, duration: 6250,
      offset: 0, speed: 1, locked: false, enabled: true, transform: DEFAULT_TRANSFORM, volume: 1, muted: false,
      effects: [] as typeof clipA.effects,
    };
    applyAutoTransitions([clipA, clipB]);
    const namesOf = (c: typeof clipA) => c.effects.filter((e) => e.kind === 'transition').map((e) => e.name);
    const aNames = namesOf(clipA);
    const bNames = namesOf(clipB);
    if (!aNames.includes('fade-in') || !aNames.includes('fade-out') || !bNames.includes('fade-in') || !bNames.includes('fade-out')) {
      throw new Error(`转场分布异常：A=${aNames} B=${bNames}`);
    }
    const fadeOutA = clipA.effects.find((e) => e.name === 'fade-out');
    if (fadeOutA?.params?.durationMs !== 900) throw new Error('用户已设 fade-out 被覆盖（应保留 900ms）');
    const countBefore = clipA.effects.length + clipB.effects.length;
    applyAutoTransitions([clipA, clipB]);
    if (clipA.effects.length + clipB.effects.length !== countBefore) throw new Error('重复调用不幂等');

    // 4) 自动转场经渲染链路消费：把带 effects 的片段组装进工程，filter_complex 含 fade
    const proj = createEmptyProject({ name: 'm4', canvas: { width: 320, height: 240, fps: 25 } });
    const assetId = createId();
    proj.assets = [
      { id: assetId, name: 'a.mp4', path: FIX1, addedAt: nowIso(), type: 'video', duration: 3000, width: 320, height: 240, hasAudio: false, tags: [] },
    ];
    clipA.assetId = assetId;
    clipB.assetId = assetId;
    proj.tracks = [
      { id: createId(), type: 'video', name: 'v', order: 0, muted: false, locked: false, visible: true, clips: [clipA, clipB] },
    ];
    const plan = buildRenderPlan(proj, path.join(BASE, 'm4-out.mp4'), {
      drawtextAvailable: false, subtitlesAvailable: false, videoEncoder: 'libx264', audioEncoder: 'aac', pixelFormat: 'yuv420p',
    });
    if (!plan.filterComplex.includes('fade=t=in:st=0:d=0.8:alpha=1')) throw new Error('自动 fade-in 未进入 filter_complex');
    if (!plan.filterComplex.includes('fade=t=out:')) throw new Error('自动 fade-out 未进入 filter_complex');

    // 5) search 异步化：视觉未就绪时纯词法行为不变（复用 P2 环目录 semanticlib 的存量条目）
    const hits = await getLibraryStore().search('城市夜景', 5);
    if (hits.length === 0 || hits[0]!.entry.name !== '城市夜景.mp4') {
      throw new Error(`异步化后词法检索行为变化：${hits.map((h) => h.entry.name).join(',') || '无结果'}`);
    }

    results.push(ok(name, '维度保护/未就绪静降级/转场规则幂等不覆盖/链路消纳/异步检索不变'));
  } catch (e) {
    results.push(fail(name, (e as Error).message));
  }
}

/**
 * M3：声音克隆与自定义音色库。
 * 覆盖：参考音频导入校验（合法正弦通过/纯静音拒绝/时长过短拒绝）、索引原子写、
 * 零样本路由（mock Index-TTS 2 服务命中 provider='zero-shot' + 磁盘缓存二命中）、
 * 服务宕机降级链与音色删除后的回退可观察性。
 */
async function ringVoiceCloneM3(results: RingResult[]): Promise<void> {
  const name = 'M3·声音克隆音色库与零样本路由';
  let server: import('node:http').Server | null = null;
  const originalTts = loadTtsConfig();
  try {
    const { createServer } = await import('node:http');

    // 参考音频样本：3.5s 正弦（有声）、3s 纯静音、1s 正弦（过短）
    const refWav = path.join(BASE, 'voice-ref.wav');
    execFileSync(FFMPEG, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3.5', '-ar', '24000', refWav], { stdio: 'ignore' });
    const silentWav = path.join(BASE, 'voice-silent.wav');
    execFileSync(FFMPEG, ['-y', '-f', 'lavfi', '-i', 'anullsrc=r=24000:cl=mono', '-t', '3', silentWav], { stdio: 'ignore' });
    const shortWav = path.join(BASE, 'voice-short.wav');
    execFileSync(FFMPEG, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-ar', '24000', shortWav], { stdio: 'ignore' });

    // 拒绝：纯静音
    let rejectedSilent = '';
    try {
      await addVoice(silentWav, '静音测试');
    } catch (e) {
      rejectedSilent = (e as Error).message;
    }
    if (!rejectedSilent.includes('静音')) throw new Error(`纯静音参考应被拒绝，实际：${rejectedSilent || '竟然通过'}`);
    // 拒绝：时长过短
    let rejectedShort = '';
    try {
      await addVoice(shortWav, '短测试');
    } catch (e) {
      rejectedShort = (e as Error).message;
    }
    if (!rejectedShort.includes('时长')) throw new Error(`1s 参考应被拒绝，实际：${rejectedShort || '竟然通过'}`);
    // 通过：合法样本
    const profile = await addVoice(refWav, '我的声音');
    if (listVoices().length !== 1) throw new Error('音色索引应含 1 条');
    if (!fs.existsSync(profile.samplePath)) throw new Error('样本未拷贝进私有目录');
    if (fs.existsSync(path.join(USERDATA, 'voices.json.tmp'))) throw new Error('原子写不应残留 tmp 文件');

    // 零样本路由：mock Index-TTS 2 服务（/tts/zero-shot 返回 wav 字节）
    const refBytes = fs.readFileSync(refWav);
    server = createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/tts/zero-shot') {
        req.on('data', () => {});
        req.on('end', () => {
          res.writeHead(200, { 'content-type': 'audio/wav' });
          res.end(refBytes);
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as import('node:net').AddressInfo).port;
    saveTtsConfig({
      active: 'volcano',
      volcano: { ...originalTts.volcano, appId: '', accessToken: '' },
      local: { baseUrl: `http://127.0.0.1:${port}`, voice: 'default' },
      custom: { ...originalTts.custom },
    });

    const first = await synthesizeSpeech({ text: '零样本第一条旁白', voiceId: profile.id });
    if (first.provider !== 'zero-shot') throw new Error(`指定音色应走零样本链，实际 provider=${first.provider}`);
    if (!fs.existsSync(first.audioPath)) throw new Error('零样本产物未落盘');
    const second = await synthesizeSpeech({ text: '零样本第一条旁白', voiceId: profile.id });
    if (!second.cached || second.provider !== 'zero-shot') throw new Error('同文本同音色应命中磁盘缓存');

    // 降级链：服务宕机 → 零样本失败 → 常规链（volcano 未配置）抛友好错误 + 可观察原因
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
    let fellBackMsg = '';
    try {
      await synthesizeSpeech({ text: '宕机后的新文本零样本', voiceId: profile.id });
    } catch (e) {
      fellBackMsg = (e as Error).message;
    }
    if (!fellBackMsg.includes('火山引擎 TTS')) throw new Error(`宕机后应降级常规链并报错，实际：${fellBackMsg || '未报错'}`);
    if (!(zeroShotFallbackReason(profile.id) ?? '').includes('零样本合成失败')) {
      throw new Error(`降级原因应可观察（zeroShotFallbackReason），实际：${zeroShotFallbackReason(profile.id)}`);
    }

    // 删除音色：索引与样本一并清理；已删音色走「不存在」降级
    if (!removeVoice(profile.id)) throw new Error('删除返回 false');
    if (fs.existsSync(profile.samplePath)) throw new Error('删除后样本未清理');
    const ghostMsg = await synthesizeSpeech({ text: '引用已删音色', voiceId: 'ghost-id' })
      .then(() => '')
      .catch((e) => (e as Error).message);
    if (!ghostMsg.includes('火山')) throw new Error(`已删音色应降级常规链报错，实际：${ghostMsg || '未报错'}`);
    if (!(zeroShotFallbackReason('ghost-id') ?? '').includes('音色不存在')) throw new Error('已删音色降级原因应为「音色不存在」');

    results.push(ok(name, '校验拒绝静音/短样本；零样本命中+缓存二命中；宕机降级可观察；删除连带清理'));
  } catch (e) {
    results.push(fail(name, (e as Error).message));
  } finally {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    saveTtsConfig(originalTts);
    for (const v of listVoices()) removeVoice(v.id);
  }
}

/**
 * P3：导出异常分类与磁盘空间体检。纯函数断言四类失败归一；
 * statfs 不支持时体检必须安全降级为跳过（本机 Node 20.0 即此分支）；
 * 集成：素材缺失渲染失败时错误文案为中文分类提示而非裸 stderr。
 */
async function ringDiagnosticsP3(results: RingResult[]): Promise<void> {
  const name = 'P3·导出失败分类与磁盘空间体检';
  try {
    // 分类纯函数
    if (classifyFfmpegFailure('write error: No space left on device').kind !== 'disk-full') throw new Error('ENOSPC 未归类为 disk-full');
    if (classifyFfmpegFailure('Permission denied').kind !== 'permission') throw new Error('权限错误未归类');
    if (classifyFfmpegFailure('xxx.mp4: No such file or directory').kind !== 'missing-input') throw new Error('素材缺失未归类');
    if (classifyFfmpegFailure('Error opening output file /x/dir-as-file/out.mp4: No such file or directory').kind !== 'permission') throw new Error('输出路径非法应归为导出不可写');
    if (classifyFfmpegFailure('Unknown encoder: h264_nvenc').kind !== 'encoder') throw new Error('编码器错误未归类');
    if (classifyFfmpegFailure('kaboom unrelated').kind !== 'unknown') throw new Error('未知错误分类异常');

    // 体积估算：16M 码率 60s → (16.192Mbps/8)×60×1.2 ≈ 145.7MB，校验量级与公式
    const est = estimateOutputBytes(60_000, '16M');
    if (!(est > 1.4e8 && est < 1.5e8)) throw new Error(`16M@60s 估算异常：${est}`);

    // statfs 体检：支持则给真实可用字节且短素材预检通过；不支持则全链路 null 安全降级
    const probeTarget = path.join(BASE, 'diag-probe.mp4');
    const free = await probeFreeBytes(probeTarget);
    const rejectSmall = await precheckDiskSpace(probeTarget, 1_000, '16M');
    if (free === null) {
      if (rejectSmall !== null) throw new Error('statfs 不可用时预检应跳过');
    } else {
      if (free <= 0) throw new Error(`probeFreeBytes 返回异常：${free}`);
      if (rejectSmall !== null) throw new Error(`1 秒素材预检不应拒绝：${rejectSmall}`);
    }
    // 超大时长（1000 小时）：支持 statfs 时应拒绝，不支持时安全跳过
    const rejectHuge = await precheckDiskSpace(probeTarget, 3_600_000_000, '16M');
    if (rejectHuge !== null && !rejectHuge.includes('不足')) throw new Error(`超大导出应拒绝：${rejectHuge}`);

    // 集成：素材缺失失败时抛中文分类文案（而非裸 stderr）
    const proj = createEmptyProject({ name: 'diag', canvas: { width: 320, height: 240, fps: 25 } });
    const assetId = createId();
    proj.assets = [
      {
        id: assetId, name: 'missing.mp4', path: path.join(BASE, 'no-such-asset-file.mp4'), addedAt: nowIso(),
        type: 'video', duration: 2000, width: 320, height: 240, hasAudio: false, tags: [],
      },
    ];
    proj.tracks = [
      {
        id: createId(), type: 'video', name: 'v', order: 0, muted: false, locked: false, visible: true,
        clips: [
          {
            id: createId(), type: 'video', assetId, start: 0, duration: 1000, offset: 0,
            speed: 1, locked: false, enabled: true, transform: DEFAULT_TRANSFORM, volume: 1, muted: true,
            effects: [],
          },
        ],
      },
    ];
    let msg = '';
    try {
      await renderProject({ project: proj, outputPath: path.join(BASE, 'diag-out.mp4'), encoder: 'libx264' });
    } catch (e) {
      msg = (e as Error).message;
    }
    if (!msg.includes('素材文件缺失')) throw new Error(`失败文案应为中文分类提示，实际：${msg.slice(0, 80)}`);

    results.push(ok(name, `五类失败归一 + 体积估算 + statfs 降级安全；素材缺失导出抛中文分类错误`));
  } catch (e) {
    results.push(fail(name, (e as Error).message));
  }
}

/**
 * P2：素材语义预处理与检索。扫描即产出 96 维特征向量 + 启发式描述；
 * 真实 library:search IPC 链路验证中文语义命中与英文名命中，空查询给空结果。
 */
async function ringSemanticLibrary(results: RingResult[]): Promise<void> {
  const name = 'P2·素材语义预处理与检索';
  try {
    const lib = getLibraryStore();
    const dir = path.join(BASE, 'semanticlib');
    fs.mkdirSync(dir, { recursive: true });
    const names = ['夕阳海滩散步.mp4', '城市夜景.mp4', 'cat_running.mp4'];
    for (const n of names) fs.copyFileSync(FIX1, path.join(dir, n));
    const sum = await lib.scan([dir]);
    if (sum.total !== names.length) throw new Error(`扫描数量应为 ${names.length}，实际 ${sum.total}`);

    // 语义预处理断言：每个条目都有 96 维 embedding 与中文描述
    const entries = lib.list().filter((e) => e.path.startsWith(dir));
    for (const e of entries) {
      if (!e.embedding || e.embedding.length !== 96) throw new Error(`${e.name} 缺 96 维 embedding`);
      if (!e.description || !e.description.includes('视频')) throw new Error(`${e.name} 缺语义描述`);
    }

    // 真实 IPC handler：中文语义命中（描述/名称 bigram）与英文名命中
    const handlers = (globalThis as unknown as { __MIAOMA_IPC__: Record<string, (e: unknown, ...a: unknown[]) => unknown> }).__MIAOMA_IPC__;
    const hits = (await handlers['library:search'](null, '海滩散步', 10)) as { entry: { name: string }; score: number }[];
    if (hits.length === 0 || hits[0]!.entry.name !== '夕阳海滩散步.mp4') {
      throw new Error(`「海滩散步」应命中夕阳海滩散步.mp4，实际 ${hits.map((h) => `${h.entry.name}:${h.score}`).join(', ') || '无结果'}`);
    }
    const hits2 = (await handlers['library:search'](null, 'cat running', 10)) as { entry: { name: string } }[];
    if (hits2.length === 0 || hits2[0]!.entry.name !== 'cat_running.mp4') {
      throw new Error(`「cat running」应命中 cat_running.mp4，实际 ${hits2[0]?.entry.name ?? '无结果'}`);
    }
    const empty = (await handlers['library:search'](null, '   ')) as unknown[];
    if (empty.length !== 0) throw new Error('空查询应返回空列表');

    results.push(ok(name, `3 素材均带 96 维 embedding；中文/英文语义检索命中首位；空查询安全`));
  } catch (e) {
    results.push(fail(name, (e as Error).message));
  }
}

/**
 * P1：转场/滤镜效果消费（effects → filter_complex）、渲染失败产物回滚、Agent 断点重试。
 * 覆盖：① 未知转场降级告警 ② 带 fade/eq/blackwhite 的工程真实导出 ③ 失败时删除半成品
 * ④ start→interrupted→retry 续跑至完成并清理 checkpoint 目录。
 */
async function ringEffectsAndRollback(results: RingResult[]): Promise<void> {
  const name = 'P1·转场效果消费 + 失败产物回滚 + Agent 断点重试';
  try {
    // —— ① effects → filter_complex 断言（含未知转场降级告警） ——
    const assetId = createId();
    const proj = createEmptyProject({ name: 'fx', canvas: { width: 320, height: 240, fps: 25 } });
    proj.assets = [
      {
        id: assetId, name: 'clip1.mp4', path: FIX1, addedAt: nowIso(),
        type: 'video', duration: 3000, width: 1920, height: 1080, hasAudio: false, tags: [],
      },
    ];
    proj.tracks = [
      {
        id: createId(), type: 'video', name: '视频轨', order: 0, muted: false, locked: false, visible: true,
        clips: [
          {
            id: createId(), type: 'video', assetId, start: 0, duration: 2000, offset: 0,
            speed: 1, locked: false, enabled: true, transform: DEFAULT_TRANSFORM, volume: 1, muted: true,
            effects: [
              { id: createId(), kind: 'transition', name: 'fade-in', params: { durationMs: 800 }, enabled: true },
              { id: createId(), kind: 'transition', name: 'fade-out', params: { durationMs: 600 }, enabled: true },
              { id: createId(), kind: 'filter', name: 'blackwhite', params: {}, enabled: true },
              { id: createId(), kind: 'filter', name: 'eq', params: { brightness: 0.1, contrast: 1.2, saturation: 0.9 }, enabled: true },
              { id: createId(), kind: 'transition', name: 'dissolve', params: { durationMs: 500 }, enabled: true },
            ],
          },
        ],
      },
    ];
    const plan = buildRenderPlan(proj, path.join(BASE, 'fx-out.mp4'), {
      drawtextAvailable: true, subtitlesAvailable: true,
      videoEncoder: 'libx264', audioEncoder: 'aac', pixelFormat: 'yuv420p',
    });
    if (!plan.filterComplex.includes('fade=t=in:st=0:d=0.8:alpha=1')) throw new Error('filter_complex 缺少淡入 fade');
    if (!plan.filterComplex.includes('fade=t=out:')) throw new Error('filter_complex 缺少淡出 fade');
    if (!plan.filterComplex.includes('hue=s=0')) throw new Error('blackwhite 滤镜未消费');
    if (!plan.filterComplex.includes('eq=brightness=0.1')) throw new Error('eq 滤镜未消费');
    if (!plan.warnings.some((w) => w.includes('dissolve'))) throw new Error('未知转场未降级告警');

    // 真实渲染一份带转场的成片，验证 fade 语法被 ffmpeg 接受
    const rendered = await renderProject({ project: proj, outputPath: path.join(BASE, 'fx-render.mp4'), encoder: 'mpeg4' });
    if (!fs.existsSync(rendered.outputPath)) throw new Error('带转场导出失败');

    // —— ② 渲染失败时删除半成品产物（回滚） ——
    const broken = structuredClone(proj);
    (broken.assets[0] as { path: string }).path = path.join(BASE, 'definitely-missing-file.mp4');
    const partialPath = path.join(BASE, 'fx-partial.mp4');
    fs.writeFileSync(partialPath, '半成品 mp4，失败后应被删除');
    let threw = false;
    try {
      await renderProject({ project: broken, outputPath: partialPath, encoder: 'libx264' });
    } catch {
      threw = true;
    }
    if (!threw) throw new Error('输入文件不存在时渲染应失败');
    if (fs.existsSync(partialPath)) throw new Error('失败后半成品未回滚删除');

    // —— ③ Agent 断点重试：start→interrupted→retry→completed，成功后清理 checkpoint ——
    const snap = await startAgentRun({ requirement: '做一个 10 秒的手冲咖啡日常', sourceDirs: [path.dirname(FIX1)] });
    if (snap.status !== 'interrupted') throw new Error(`期望 interrupted，实际 ${snap.status}`);
    const retried = await retryAgentRun();
    if (retried.status !== 'completed' || !retried.projectId) throw new Error(`断点重试未走到 completed：${retried.status}`);
    if (fs.existsSync(path.join(USERDATA, 'agent-runs'))) throw new Error('成功后 checkpoint 目录未清理');

    results.push(ok(name, 'effects→filter_complex + 转场导出成功 + 失败回滚 + 断点重试后续跑')); 
  } catch (e) {
    results.push(fail(name, (e as Error).message));
  }
}

export async function runSmoke(): Promise<RingResult[]> {
  const results: RingResult[] = [];

  // 准备测试素材（真实 ffmpeg 生成，各自独立目录）
  try {
    FIX1 = genFixture('clip1.mp4');
    FIX2 = genFixture('clip2.mp4');
    FIX3 = genFixture('clip3.mp4');
    FIX4 = genFixture('clip4.mp4');
    FIX5 = genFixture('img.jpg'); // 图片素材
    FIX6 = genFixture('aud.wav'); // 音频素材
  } catch (e) {
    results.push(skip('测试素材生成', `无法用 ffmpeg 生成测试素材：${(e as Error).message}`));
  }

  // 注册协议 + ipc 处理器（真实代码路径）
  try {
    registerProtocols();
    registerIpc();
  } catch (e) {
    results.push(fail('初始化（协议+IPC）', (e as Error).message));
    return results;
  }

  await ringImportAndWhitelist(results);
  await ringEditBridge(results);
  await ringSaveAndRoundtrip(results);
  await ringRestartRecovery(results);
  await ringReopenReRegisters(results);
  await ringProtocolMatrix(results);
  await ringDiagnose(results);
  await ringRender(results);
  // 阶段五 5.2 第二阶段：异常兜底
  await ringAssetDeleted(results);
  await ringTtsOffline(results);
  await ringDiskFull(results);

  // 阶段五 5.2 第三阶段：P1 更深场景
  await ringMixedMediaTypes(results);
  await ringThumbnails(results);
  await ringProjectMigration(results);
  await ringLargeProjectRoundtrip(results);
  await ringPerformanceBaseline(results);
  await ringLibraryScanVsImport(results);

  // 阶段五 5.2 第四阶段：更细异常（导出目标不可写 / 火山鉴权 code 分支）
  await ringExportUnwritable(results);
  await ringTtsVolcanoAuth(results);

  // 阶段五 5.2 第五阶段：P1 深度扩展（空工程/竖屏/纯音频/批量扫描/列表容错/空文本）
  await ringRenderEmpty(results);
  await ringRenderVertical(results);
  await ringRenderAudioOnly(results);
  await ringLibraryScale(results);
  await ringProjectListRobust(results);
  await ringTtsEmptyText(results);

  // 阶段二：AI 引擎接入桌面端（真实服务 + 中断→改分镜→resume→落盘）
  await ringAgentPipeline(results);
  // 阶段二续：LLM 配置落盘 + 未配置回退
  await ringLlmConfig(results);

  // P1：转场效果消费 + 失败产物回滚 + Agent 断点重试
  await ringEffectsAndRollback(results);

  // P2：素材语义预处理与检索
  await ringSemanticLibrary(results);

  // P3：导出失败分类与磁盘空间体检
  await ringDiagnosticsP3(results);

  // M3：声音克隆音色库与零样本路由
  await ringVoiceCloneM3(results);

  // M4：多模态解析降级与 AI 自动转场
  await ringVisionMultimodalM4(results);

  // M5：工程版本管理与回滚
  await ringVersioningM5(results);

  // 编辑器属性回写→渲染消费
  ringClipPropertiesWire(results);

  // 自定义模型提供者（LLM/TTS/视频）
  await ringCustomProviders(results);

  // R2 对话式剪辑：计划解析与 ref 落地
  ringAssistantPlan(results);

  return results;
}
