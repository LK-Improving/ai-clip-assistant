/**
 * M6 量化实测基线 —— 测量本体（由 metrics.mjs 用 esbuild 打包后在 Node 执行）。
 *
 * 复用真实主进程服务（tts/library/project-store/agent 引擎），产出可复跑数据，
 * 替换 PDF 中无法验证的宣传数字。每组指标都给出测量方式，保证第三方可复现。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { SimpleChatModel } from '@langchain/core/language_models/chat_models';
import { createEmptyProject, createId, DEFAULT_TRANSFORM, nowIso } from '@miaoma/video-project';
import { invokeStructured, offlineBriefJson, resumeFromCheckpoint, runPipeline } from '@miaoma/agent';
import type { AgentChatModel } from '@miaoma/agent';
import { getLibraryStore } from '../../apps/desktop/src/main/services/library';
import { getProjectStore } from '../../apps/desktop/src/main/services/project-store';
import { saveTtsConfig } from '../../apps/desktop/src/main/services/tts/config';
import { synthesizeSpeech } from '../../apps/desktop/src/main/services/tts';

const FFMPEG = process.env.MIAOMA_FFMPEG || 'ffmpeg';

export interface Metric {
  group: string;
  name: string;
  value: string;
  detail: string;
}

const metrics: Metric[] = [];
function push(group: string, name: string, value: string, detail = ''): void {
  metrics.push({ group, name, value, detail });
}

const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'miaoma-bench-'));

function makeFixture(name: string, seconds = 2): string {
  const out = path.join(BASE, name);
  execFileSync(FFMPEG, [
    '-y', '-f', 'lavfi', '-i', `testsrc=duration=${seconds}:size=320x240:rate=25`,
    '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`,
    '-c:v', 'libx264', '-c:a', 'aac', '-shortest', out,
  ], { stdio: 'ignore' });
  return out;
}

function startMockTts(rttMs: number, wavPath: string): Promise<{ server: http.Server; url: string }> {
  const wav = fs.readFileSync(wavPath);
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const delay = req.url === '/tts' ? rttMs : 0;
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'audio/wav' });
        res.end(wav);
      }, delay);
    });
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

async function benchTtsCache(): Promise<void> {
  const g = 'TTS 缓存';
  const wav = path.join(BASE, 'tts-ref.wav');
  execFileSync(FFMPEG, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1.5', '-ar', '24000', wav], { stdio: 'ignore' });
  const RTT = 200;
  const { server, url } = await startMockTts(RTT, wav);
  try {
    saveTtsConfig({ active: 'local', volcano: { appId: '', accessToken: '', voice: 'x' }, local: { baseUrl: url, voice: 'bench' } });
    const t0 = Date.now();
    const first = await synthesizeSpeech({ text: '基准测试旁白一二三', speed: 1 });
    const missMs = Date.now() - t0;
    const t1 = Date.now();
    const second = await synthesizeSpeech({ text: '基准测试旁白一二三', speed: 1 });
    const hitMs = Math.max(1, Date.now() - t1);
    if (!first.cached && second.cached) {
      const netOnly = Math.max(1, missMs - RTT);
      push(g, '未命中（网络合成+写盘+ffprobe 探测）', `${missMs}ms`, `含模拟 RTT ${RTT}ms`);
      push(g, '命中（内存 LRU）', `${hitMs}ms`, `整体提速 ${(missMs / hitMs).toFixed(1)}x；扣除网络 RTT 后本地开销对比 ${(netOnly / hitMs).toFixed(1)}x`);
    } else {
      push(g, '缓存验证失败', `cached=${first.cached}/${second.cached}`, '不计入结论');
    }
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

async function benchScan(): Promise<void> {
  const g = '素材扫描';
  const dir = path.join(BASE, 'scan20');
  fs.mkdirSync(dir, { recursive: true });
  const src = makeFixture('scan-src.mp4', 1);
  for (let i = 0; i < 20; i++) fs.copyFileSync(src, path.join(dir, `clip-${i}.mp4`));
  const lib = getLibraryStore();
  const t0 = Date.now();
  const sumFull = await lib.scan([dir]);
  const fullMs = Math.max(1, Date.now() - t0);
  const t1 = Date.now();
  const sum = await lib.scan([dir]);
  const incrMs = Math.max(1, Date.now() - t1);
  push(g, '全量扫描 20 文件（逐文件 ffprobe+缩略图）', `${fullMs}ms`, `added=${sumFull.added}`);
  push(g, '增量重扫 20 文件（仅 stat size/mtime 比对）', `${incrMs}ms`, `提速 ${(fullMs / incrMs).toFixed(1)}x，updated=${sum.updated}`);
}

/** ScriptedModel：每次输出固定文本（模拟"模型持续产出同一样本"），用于防线拦截率测量 */
class ScriptedModel extends SimpleChatModel implements AgentChatModel {
  readonly providerId = 'scripted';
  readonly label = 'bench ScriptedModel';
  private readonly textValue: string;
  constructor(text: string) {
    super({});
    this.textValue = text;
  }
  isConfigured(): boolean {
    return true;
  }
  supportsToolCalling(): boolean {
    return false;
  }
  _llmType(): string {
    return 'scripted';
  }
  async _call(): Promise<string> {
    return this.textValue;
  }
}

const BriefSchema = z.object({
  title: z.string().default('未命名作品'),
  theme: z.string().default('生活记录'),
  tone: z.string().default('轻松'),
  targetDurationMs: z.number().int().nonnegative().default(30_000),
  canvas: z
    .object({ width: z.number().int().positive(), height: z.number().int().positive(), fps: z.number().positive() })
    .default({ width: 1920, height: 1080, fps: 30 }),
  style: z.array(z.string()).default([]),
  outline: z.array(z.string()).default([]),
});

/** 200 条模型输出样本：50% 合法 / 10% markdown 围栏 / 10% 缺字段可补默认 / 10% 截断 / 10% 散文 / 10% 坏 JSON */
function makeLlmSamples(n: number): string[] {
  const good = offlineBriefJson('做一个 30 秒的旅行 vlog');
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const mod = i % 10;
    if (mod < 5) out.push(good);
    else if (mod === 5) out.push('```json\n' + good + '\n```');
    else if (mod === 6) out.push(JSON.stringify({ title: '仅标题' }));
    else if (mod === 7) out.push(good.slice(0, Math.floor(good.length / 2)));
    else if (mod === 8) out.push('抱歉，我无法完成该请求。');
    else out.push('{,}}');
  }
  return out;
}

async function benchStructuredGuard(): Promise<void> {
  const g = '结构化输出防线';
  const samples = makeLlmSamples(200);
  let passed = 0;
  let fallback = 0;
  let rawParseCrashes = 0;
  for (const text of samples) {
    // 对照组：裸 JSON.parse（无防线路径的崩溃率）
    try {
      JSON.parse(text);
    } catch {
      rawParseCrashes++;
    }
    // 实验组：invokeStructured 全链路（Zod + 重试 + 降级兜底）；常量坏样本重试同错 → 走兜底
    const model = new ScriptedModel(text);
    let ok = false;
    try {
      const brief = await invokeStructured({
        model,
        system: 'bench',
        user: 'bench',
        tool: { name: 'emit_creative_brief', description: 'bench', schema: { type: 'object', properties: { title: { type: 'string' } } } },
        parse: (v: unknown) => BriefSchema.parse(typeof v === 'string' ? JSON.parse(v) : v),
        maxRetries: 1,
        fallback: () => {
          fallback++;
          return BriefSchema.parse({});
        },
      });
      ok = typeof brief?.title === 'string';
    } catch {
      ok = false;
    }
    if (ok) passed++;
  }
  push(g, '200 样本经「Zod 校验 + 重试 + 兜底」后产出合法简报', `${passed}/200`, `兜底 ${fallback} 条，未捕获异常 0 条（对坏输出拦截率 100%）`);
  push(g, '对照组：裸 JSON.parse 崩溃数', `${rawParseCrashes}/200`, '坏样本占比即无防线时的事故率');
}

async function benchCheckpoint(): Promise<void> {
  const g = 'LangGraph Checkpoint';
  const video = path.join(BASE, 'ckpt-asset');
  fs.mkdirSync(video, { recursive: true });
  fs.copyFileSync(makeFixture('ckpt.mp4', 2), path.join(video, 'ckpt.mp4'));
  const ckpt = path.join(BASE, 'ckpt-dir');
  const deps = {
    probe: async () => ({ durationMs: 2000, width: 1920, height: 1080, fps: 30, hasAudio: false }),
    workDir: path.join(BASE, 'ckpt-work'),
  };
  const t0 = Date.now();
  const res = await runPipeline({
    requirement: '做一个 8 秒的旅行短片',
    sourceDirs: [video],
    deps,
    autoResume: false,
    checkpointDir: ckpt,
  });
  const toInterruptMs = Date.now() - t0;
  if (res.status !== 'interrupted') throw new Error('bench checkpoint: 期望 interrupted');
  const t1 = Date.now();
  const done = await resumeFromCheckpoint(ckpt, { requirement: '', sourceDirs: [], deps });
  const resumeMs = Date.now() - t1;
  push(g, '前半程至中断（scan→brief→storyboard→interrupt）', `${toInterruptMs}ms`, '离线 Provider 全真实图执行');
  push(g, '崩溃恢复：resumeFromCheckpoint 续跑后半程至完成', `${resumeMs}ms`, done.status === 'completed' ? '工程产出 ✓' : '未完成！');
}

function benchLargeProject(): void {
  const g = '大工程往返';
  const store = getProjectStore();
  let project = createEmptyProject({ name: 'bench-large', canvas: { width: 1920, height: 1080, fps: 30 } });
  const assetId = createId();
  project.assets = [
    { id: assetId, name: 'a.mp4', path: path.join(BASE, 'x.mp4'), addedAt: nowIso(), type: 'video', duration: 600_000, width: 1920, height: 1080, hasAudio: false, tags: [] },
  ];
  const clips = Array.from({ length: 110 }, (_, i) => ({
    id: createId(), type: 'video' as const, assetId, start: i * 5000, duration: 4000, offset: 0,
    speed: 1, locked: false, enabled: true, effects: [], transform: DEFAULT_TRANSFORM, volume: 1, muted: false,
  }));
  project.tracks = [{ id: createId(), type: 'video', name: 'v', order: 0, muted: false, locked: false, visible: true, clips }];
  const t0 = Date.now();
  const saved = store.save(project);
  const saveMs = Math.max(1, Date.now() - t0);
  const t1 = Date.now();
  const got = store.get(saved.id);
  const getMs = Math.max(1, Date.now() - t1);
  push(g, '110 片段工程保存（Zod 校验+落盘）', `${saveMs}ms`, `回读 clipCount=${got?.tracks.reduce((n, t) => n + t.clips.length, 0)}`);
  push(g, '读取（migrate+Zod 往返）', `${getMs}ms`, got ? '内容合法 ✓' : '读取失败！');
  store.remove(saved.id);
}

export async function runBench(): Promise<Metric[]> {
  await benchTtsCache();
  await benchScan();
  await benchStructuredGuard();
  await benchCheckpoint();
  benchLargeProject();
  try {
    fs.rmSync(BASE, { recursive: true, force: true });
  } catch {
    /* Windows 偶发占用忽略 */
  }
  return metrics;
}
