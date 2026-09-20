/**
 * 阶段二（AI 智能体引擎）端到端离线冒烟测试。
 *
 * 用 esbuild 把真实 agent + core 源码打包到 Node 端执行（无 Electron GUI），
 * 注入「离线 Provider」（OfflineLlmProvider / OfflineTtsProvider）+ 真实 ffmpeg 探测，
 * 覆盖：完整链路、人机中断→resume、空素材库、checkpoint 断点续传。
 *
 * 导出 runAgentSmoke() 返回 [{name,pass,detail?,skip?}] 由 agent-run.mjs 汇总。
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  runPipeline,
  resumeFromCheckpoint,
  createDefaultDeps,
  NODE_RUNNERS,
  type AgentRunOptions,
  type AgentState,
  type MediaProbe,
} from '../../../../packages/agent/src/index';
import { ProjectSchema, projectDurationMs, createId, nowIso, type Asset } from '../../../../packages/core/src/index';

const ROOT = 'D:/Study/重点项目/AI剪映';
const FFMPEG = path.join(ROOT, 'apps/desktop/extraResources/ffmpeg/ffmpeg.exe');
const FFMPEG_CMD = fs.existsSync(FFMPEG) ? FFMPEG : 'ffmpeg';

interface RingResult {
  name: string;
  pass: boolean;
  detail?: string;
  skip?: boolean;
}

function ok(name: string, detail?: string): RingResult {
  return { name, pass: true, detail };
}
function bad(name: string, detail?: string): RingResult {
  return { name, pass: false, detail };
}

/** ===== 媒体探测（复用 desktop probeMedia 的解析逻辑，但不依赖 electron 链） ===== */
function probeFile(filePath: string): Promise<MediaProbe> {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG_CMD, ['-hide_banner', '-i', filePath]);
    let stderr = '';
    p.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    p.on('error', reject);
    p.on('close', () => resolve(parseProbe(stderr)));
  });
}

function parseProbe(stderr: string): MediaProbe {
  let durationMs = 0;
  const dm = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (dm) durationMs = Math.round(Number(dm[1]) * 3_600_000 + Number(dm[2]) * 60_000 + Number(dm[3]) * 1000);
  let width: number | null = null;
  let height: number | null = null;
  let fps: number | null = null;
  let hasAudio = false;
  const vm = stderr.match(/Stream #\d+:\d+.*?:\s*Video:\s*([^,\n]+)/);
  if (vm) {
    const line = stderr.slice(stderr.indexOf(vm[0]));
    const res = line.slice(0, 260).match(/(\d{2,5})\s*x\s*(\d{2,5})/);
    if (res) {
      width = Number(res[1]);
      height = Number(res[2]);
    }
    const f = line.slice(0, 260).match(/([\d.]+)\s*(?:fps|tbr)/);
    if (f) fps = Number(f[1]);
  }
  const am = stderr.match(/Stream #\d+:\d+.*?:\s*Audio:\s*([^,\n]+)/);
  if (am) hasAudio = true;
  return { durationMs, width, height, fps, hasAudio };
}

/** ===== 生成独立素材目录（每个素材一个目录，避免白名单互相污染） ===== */
function genFixture(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `miaoma-fx-${Date.now()}-`));
  const out = path.join(dir, name);
  const ext = path.extname(name).toLowerCase();
  let args: string[];
  if (ext === '.jpg' || ext === '.png') {
    args = ['-y', '-f', 'lavfi', '-i', 'color=c=blue:size=1920x1080', '-frames:v', '1', out];
  } else if (ext === '.wav' || ext === '.mp3') {
    args = ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-c:a', 'pcm_s16le', out];
  } else {
    args = [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc=duration=3:size=1920x1080:rate=30',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=3',
      '-c:v',
      'libx264',
      '-c:a',
      'aac',
      '-shortest',
      out,
    ];
  }
  spawnSync(FFMPEG_CMD, args, { stdio: 'ignore' });
  return dir;
}

/** 断言工程可通过 Zod 校验（runPipeline 内部已 parse，这里再确认一次） */
function assertProject(state: AgentState, label: string): string | null {
  if (!state.project) return `${label}：未产出工程`;
  try {
    const p = ProjectSchema.parse(state.project);
    const dur = projectDurationMs(p);
    if (dur <= 0) return `${label}：总时长异常（${dur}ms）`;
    if (p.tracks.length !== 4) return `${label}：轨道数=${p.tracks.length}（期望 4）`;
    return null;
  } catch (e) {
    return `${label}：工程校验失败 ${(e as Error).message}`;
  }
}

export async function runAgentSmoke(): Promise<RingResult[]> {
  const results: RingResult[] = [];
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'miaoma-agent-smoke-'));
  const workDir = path.join(base, 'tts');
  fs.mkdirSync(workDir, { recursive: true });

  const videoDir = genFixture('clip.mp4');
  const imageDir = genFixture('poster.jpg');
  const audioDir = genFixture('bgm.wav');
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'miaoma-empty-'));

  const deps = { probe: probeFile, workDir };

  try {
    // ===== ① 完整链路（视频+图片+音频混合） =====
    {
      const opts: AgentRunOptions = {
        requirement: '做一个 15 秒的周末城市漫步 vlog',
        sourceDirs: [videoDir, imageDir, audioDir],
        deps,
        autoResume: true,
      };
      const res = await runPipeline(opts);
      if (res.status !== 'completed') {
        results.push(bad('① 完整链路', '未走到 completed'));
      } else {
        const err = assertProject(res.state, '①');
        if (err) results.push(bad('① 完整链路', err));
        else {
          const p = res.project!;
          const types = new Set(p.assets.map((a) => a.type));
          const hasVideo = [...types].includes('video');
          const hasImage = [...types].includes('image');
          const hasAudio = [...types].includes('audio');
          const detail = `素材=[${[...types].join(',')}] 轨道=${p.tracks.length} 时长=${(projectDurationMs(p) / 1000).toFixed(1)}s`;
          results.push(
            hasVideo && hasImage && hasAudio
              ? ok('① 完整链路（视频+图片+音频→四轨工程）', detail)
              : bad('① 完整链路', `素材类型不全 ${detail}`),
          );
        }
      }
    }

    // ===== ② 人机中断 → resume =====
    {
      const opts: AgentRunOptions = {
        requirement: '做一个竖屏夏日旅行 vlog',
        sourceDirs: [videoDir],
        deps,
        autoResume: false,
      };
      const res = await runPipeline(opts);
      if (res.status !== 'interrupted') {
        results.push(bad('② 人机中断', `期望 interrupted，实际 ${res.status}`));
      } else if (res.node !== 'storyboard-review') {
        results.push(bad('② 人机中断', `中断点应为 storyboard-review（LangGraph interrupt），实际 ${res.node}`));
      } else {
        // interrupt 发生在 storyboard-review 节点内部：该节点尚未完成，不入 completedNodes
        const expected = ['scan-assets', 'creative-brief', 'storyboard-plan'];
        const same =
          res.state.completedNodes.length === expected.length &&
          expected.every((n, i) => res.state.completedNodes[i] === n);
        const vertical = res.state.brief?.canvas.height === 1920;
        if (!same) {
          results.push(bad('② 人机中断', `completedNodes=${res.state.completedNodes.join(',')}`));
        } else if (!vertical) {
          results.push(bad('② 人机中断', `竖屏需求未识别画布高度（${res.state.brief?.canvas.height}）`));
        } else {
          const resumed = await res.resume();
          if (resumed.status !== 'completed' || !resumed.project) {
            results.push(bad('② 人机中断→resume', 'resume 后未产出工程'));
          } else {
            const err = assertProject(resumed.state, '②');
            results.push(err ? bad('② 人机中断→resume', err) : ok('② 人机中断→resume（竖屏 1080x1920 识别+续跑完成）'));
          }
        }
      }
    }

    // ===== ③ 空素材库（离线兜底分镜） =====
    {
      const opts: AgentRunOptions = {
        requirement: '记录今天的一杯手冲咖啡',
        sourceDirs: [emptyDir],
        deps,
        autoResume: true,
      };
      const res = await runPipeline(opts);
      if (res.status !== 'completed') {
        results.push(bad('③ 空素材库', '未走到 completed'));
      } else {
        const err = assertProject(res.state, '③');
        if (err) results.push(bad('③ 空素材库', err));
        else {
          const hasTts = res.project!.assets.some((a) => a.type === 'audio' && a.tags.includes('tts'));
          const ttsClips = res.project!.tracks
            .filter((t) => t.type === 'audio')
            .reduce((n, t) => n + t.clips.length, 0);
          const detail = `TTS音频素材=${hasTts} 旁白轨片段=${ttsClips} 时长=${(projectDurationMs(res.project!) / 1000).toFixed(1)}s`;
          results.push(hasTts ? ok('③ 空素材库（离线兜底分镜+TTS 旁白）', detail) : bad('③ 空素材库', `无 TTS 音频 ${detail}`));
        }
      }
    }

    // ===== ④ checkpoint 断点续传 =====
    {
      const ckpt = fs.mkdtempSync(path.join(os.tmpdir(), 'miaoma-ckpt-'));
      const opts: AgentRunOptions = {
        requirement: '把这段旅行素材剪成 20 秒精华',
        sourceDirs: [videoDir, imageDir],
        deps,
        autoResume: false,
        checkpointDir: ckpt,
      };
      const res = await runPipeline(opts);
      if (res.status !== 'interrupted') {
        results.push(bad('④ checkpoint 续传', `期望 interrupted，实际 ${res.status}`));
      } else {
        const resumed = await resumeFromCheckpoint(ckpt, {
          requirement: opts.requirement,
          sourceDirs: opts.sourceDirs,
          deps,
        });
        if (resumed.status !== 'completed' || !resumed.project) {
          results.push(bad('④ checkpoint 续传', 'resumeFromCheckpoint 未产出工程'));
        } else {
          const err = assertProject(resumed.state, '④');
          results.push(err ? bad('④ checkpoint 续传', err) : ok('④ checkpoint 断点续传（崩溃重启后可恢复）'));
        }
      }
    }
    // ===== ⑤ 语义匹配：match-assets 按余弦得分贪心分配（P2） =====
    {
      const mkVideo = (name: string): Asset => ({
        id: createId(),
        name,
        path: `/tmp/${name}`,
        addedAt: nowIso(),
        type: 'video',
        duration: 5000,
        width: 1920,
        height: 1080,
        hasAudio: false,
        tags: [],
      });
      const beach = mkVideo('夕阳海滩散步.mp4');
      const city = mkVideo('城市夜景.mp4');
      const state: AgentState = {
        requirement: '旅行',
        sourceDirs: [],
        // city 故意排在素材库首位：旧轮转逻辑必选 city，语义贪心应选 beach
        scannedAssets: [city, beach],
        brief: null,
        storyboard: {
          scenes: [
            { order: 0, title: '海边日落', description: '夕阳下在海滩散步', narration: '', assetType: 'any', durationMs: 5000 },
            { order: 1, title: '夜晚街头', description: '城市夜景灯光', narration: '', assetType: 'any', durationMs: 5000 },
          ],
        },
        matchResult: null,
        speechSegments: [],
        project: null,
        completedNodes: [],
      };
      const runnerDeps = createDefaultDeps();
      runnerDeps.probe = probeFile;
      // LangGraph 版 runner 返回状态增量而非原地修改
      const update = await NODE_RUNNERS['match-assets'](state, runnerDeps);
      const picks = update.matchResult!.sceneAssets;
      if (picks[0] !== beach.id || picks[1] !== city.id) {
        results.push(bad('⑤ 语义匹配', `场景应分别匹配 海滩/城市 素材，实际 ${JSON.stringify(picks)}`));
      } else {
        results.push(ok('⑤ 语义匹配（match-assets 余弦贪心，中文 bigram 命中素材名）'));
      }
    }
    // ===== ⑥ M2 token 级流式：离线分块拼接 == 完整输出；取消信号在节点边界即时中断 =====
    {
      const deltas: Array<{ node: string; delta: string }> = [];
      const opts: AgentRunOptions = {
        requirement: '做一个 12 秒的竖屏美食开篇短片',
        sourceDirs: [videoDir],
        deps: { probe: probeFile, workDir, onToken: (node, delta) => deltas.push({ node, delta }) },
        autoResume: true,
      };
      const res = await runPipeline(opts);
      const briefText = deltas.filter((d) => d.node === 'creative-brief').map((d) => d.delta).join('');
      const sbText = deltas.filter((d) => d.node === 'storyboard-plan').map((d) => d.delta).join('');
      const maxChunk = deltas.reduce((m, d) => Math.max(m, d.delta.length), 0);
      let streamOk = false;
      try {
        const briefObj = JSON.parse(briefText) as { title?: string };
        const sbObj = JSON.parse(sbText) as unknown;
        streamOk =
          res.status === 'completed' &&
          typeof briefObj.title === 'string' &&
          briefObj.title === res.state.brief?.title &&
          Array.isArray(sbObj) === true &&
          maxChunk > 0 &&
          maxChunk <= 16;
      } catch {
        streamOk = false;
      }
      if (!streamOk) {
        results.push(bad('⑥ token 流式', `拼接不一致或分块越界：brief=${briefText.length}ch sb=${sbText.length}ch maxChunk=${maxChunk}`));
      } else {
        // 预先 abort 的 signal：应在任一节点执行前抛（deps.signal 透传链路的可观测边界）
        const ctrl = new AbortController();
        ctrl.abort();
        let threw = false;
        try {
          await runPipeline({ ...opts, signal: ctrl.signal });
        } catch {
          threw = true;
        }
        results.push(
          threw
            ? ok('⑥ token 级流式（拼接==节点产物、分块≤16ch、取消即时中断）', `事件数=${deltas.length}`)
            : bad('⑥ token 流式取消', '已 abort 的 signal 未阻断流水线'),
        );
      }
    }
    // ===== ⑦ M4 AI 自动转场：assemble 按节奏规则给视频轨片段补 fade =====
    {
      const opts: AgentRunOptions = {
        requirement: '做一个 10 秒的短片',
        sourceDirs: [videoDir, imageDir],
        deps,
        autoResume: true,
      };
      const res = await runPipeline(opts);
      if (res.status !== 'completed') {
        results.push(bad('⑦ 自动转场', '未走到 completed'));
      } else {
        const vt = res.project!.tracks.find((t) => t.type === 'video');
        const clips = (vt?.clips ?? []).slice().sort((a, b) => a.start - b.start);
        const fades = (c: (typeof clips)[number]) =>
          c.effects.filter((e) => e.kind === 'transition').map((e) => String(e.name));
        const firstFades = clips[0] ? fades(clips[0]) : [];
        const lastFades = clips.length > 1 ? fades(clips[clips.length - 1]) : [];
        const total = clips.reduce((n, c) => n + fades(c).length, 0);
        // 两段连续快切换场：首段 fade-in+fade-out，末段 fade-in+fade-out，总数 ≥4
        const okTransitions =
          clips.length >= 2 &&
          firstFades.includes('fade-in') &&
          firstFades.includes('fade-out') &&
          lastFades.includes('fade-in') &&
          lastFades.includes('fade-out') &&
          total >= 4;
        results.push(
          okTransitions
            ? ok('⑦ AI 自动转场（首尾淡入淡出 + 快切换场成对 fade）', `片段=${clips.length} 转场数=${total}`)
            : bad('⑦ 自动转场', `期望首尾成对 fade：first=${firstFades} last=${lastFades} total=${total}`),
        );
      }
    }
  } finally {
    for (const d of [base, videoDir, imageDir, audioDir, emptyDir]) {
      try {
        fs.rmSync(d, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  }

  return results;
}
