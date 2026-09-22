import { dirname } from 'node:path';
import {
  planEdits,
  type AssistantAction,
  type AssistantTimelineSnapshot,
  type EditPlan,
  type VideoGenRatio,
} from '@miaoma/agent';
import { addAllowedPath } from '../protocol';
import { broadcastAgentLog, getVideoGenProvider, resolveLlm } from './agent';
import { loadVideoGenConfig } from './video-gen/config';

/**
 * AI 助手对话规划（主进程侧）。
 *
 * 只负责「自然语言 → 时间线改动计划」与「花钱动作的费用预估」，不直接改状态：
 * 时间线的唯一事实源在渲染进程 store，落地必须由渲染进程做（顺带完成 ref→clipId 解析与
 * 用户确认），主进程拿不到也不需要拿到当前 tracks。
 */

/** 已核实的 MiniMax H3 按秒单价（元/秒）；没核实的 Provider 一律不给数字，绝不在卡片上编 */
const MINIMAX_H3_UNIT_PER_SEC: Record<string, number> = { '2K': 0.8, '768P': 0.5 };

export interface VideoGenCost {
  /** 计划生成的总秒数 */
  seconds: number;
  /** 预估金额（元）；单价未知时为 null */
  yuan: number | null;
  provider: string;
  resolution?: string;
  unitPerSec: number | null;
  /** 卡片脚注：单价来源或未知说明 */
  note: string;
}

export interface AssistantPlanResult extends EditPlan {
  cost: VideoGenCost | null;
}

function clipSecondsFor(ref: string | undefined, snapshot: AssistantTimelineSnapshot): number | null {
  if (!ref) return null;
  const wanted = ref.replace(/[\s　]/g, '');
  const selected = snapshot.selectedRef?.replace(/[\s　]/g, '');
  for (const track of snapshot.tracks) {
    for (const clip of track.clips) {
      const key = clip.ref.replace(/[\s　]/g, '');
      if (key === wanted || (wanted === '选中' && selected && key === selected)) {
        return Math.max(1, Math.round(clip.durationMs / 1000));
      }
    }
  }
  return null;
}

function durationSecOf(action: AssistantAction, snapshot: AssistantTimelineSnapshot): number {
  if (action.type !== 'generateClip') return 5;
  if (typeof action.durationSec === 'number' && action.durationSec > 0) return Math.round(action.durationSec);
  // 模型没给时长就跟着被替换的镜头走，再兜底 5 秒（MiniMax H3 最短 4s，由 Provider 夹取）
  return clipSecondsFor(action.ref, snapshot) ?? 5;
}

/** 计划里有几个 generateClip、总共多少秒（费用预估的输入） */
export function estimatePlanCost(plan: EditPlan, snapshot: AssistantTimelineSnapshot): VideoGenCost | null {
  const gens = (plan.actions ?? []).filter((action) => action.type === 'generateClip');
  if (gens.length === 0) return null;
  const seconds = gens.reduce((sum, action) => sum + durationSecOf(action, snapshot), 0);
  const config = loadVideoGenConfig();

  if (config.active === 'offline') {
    return { seconds, yuan: null, provider: config.active, unitPerSec: null, note: '未配置视频生成模型，本次生成不会执行' };
  }
  if (config.active === 'minimax') {
    const resolution = config.minimax.resolution ?? '2K';
    const unitPerSec = MINIMAX_H3_UNIT_PER_SEC[resolution] ?? null;
    return {
      seconds,
      yuan: unitPerSec === null ? null : Math.round(seconds * unitPerSec * 100) / 100,
      provider: config.active,
      resolution,
      unitPerSec,
      note:
        unitPerSec === null
          ? `MiniMax ${resolution} 单价未内置，请以 MiniMax 计费页为准`
          : `MiniMax H3 · ${resolution} · ${unitPerSec} 元/秒 × ${gens.length} 段`,
    };
  }
  return {
    seconds,
    yuan: null,
    provider: config.active,
    unitPerSec: null,
    note: '该 Provider 单价未内置，费用请以服务商计费页为准',
  };
}

export async function planAssistantEdit(input: {
  message: string;
  snapshot: AssistantTimelineSnapshot;
}): Promise<AssistantPlanResult> {
  const message = String(input.message ?? '').trim();
  if (!message) return { reply: '想让我做什么？例如「删掉音乐轨第 2 段」。', actions: [], cost: null };

  const model = resolveLlm();
  // 离线 Provider 是按规则拼 JSON 的确定性模型，听不懂自由指令，直接讲清楚而不是硬试
  if (model.providerId === 'offline') {
    return {
      reply: '当前是离线模型，我只能查素材、看工程摘要。要按对话改时间线，请先在设置中心 → AI 配置里填好大模型（DeepSeek / 方舟 / Ollama 均可）。',
      actions: [],
      cost: null,
    };
  }

  const plan = await planEdits({ model, message, snapshot: input.snapshot });
  return { ...plan, cost: estimatePlanCost(plan, input.snapshot) };
}

export interface GenerateItem {
  prompt: string;
  durationSec: number;
  ratio?: VideoGenRatio;
}

export interface GenerateOutcome {
  ok: boolean;
  videoPath?: string;
  durationMs?: number;
  width?: number;
  height?: number;
  ext?: string;
  error?: string;
}

/**
 * 逐段执行 AI 生视频（用户在确认卡片上点过之后才会走到这里）。
 *
 * - 串行生成并广播进度日志：单段 1–3 分钟，不回报进度用户会以为卡死；
 * - 单段失败只记该段，但配置类错误（模型未开通 / Key 无效）直接停掉后续段，
 *   否则会像之前那样「每段白等 10 分钟 + 每段照扣钱」；
 * - 产物父目录登记进 miaoma:// 白名单，否则编辑器预览会 403。
 */
export async function generateAssistantClips(items: GenerateItem[]): Promise<GenerateOutcome[]> {
  const results: GenerateOutcome[] = new Array(items.length);
  if (items.length === 0) return results;

  const provider = getVideoGenProvider();
  if (!provider.isConfigured()) {
    return items.map(() => ({
      ok: false,
      error: '未配置视频生成模型（设置中心 → AI 设置 → 视频生成模型）',
    }));
  }

  for (let i = 0; i < items.length; i += 1) {
    const item = items[i]!;
    broadcastAgentLog(`[assistant] 生成第 ${i + 1}/${items.length} 段：${item.prompt.slice(0, 30)}…`);
    try {
      const res = await provider.generate({
        prompt: item.prompt,
        durationSec: item.durationSec,
        ratio: item.ratio ?? '16:9',
      });
      addAllowedPath(dirname(res.videoPath));
      broadcastAgentLog(`[assistant] 第 ${i + 1} 段完成：${res.videoPath}`);
      results[i] = {
        ok: true,
        videoPath: res.videoPath,
        durationMs: res.durationMs,
        width: res.width,
        height: res.height,
        ext: res.ext,
      };
    } catch (error) {
      const err = error as Error & { configError?: boolean };
      results[i] = { ok: false, error: err.message };
      broadcastAgentLog(`[assistant] 第 ${i + 1} 段失败：${err.message}`);
      if (err.configError) {
        for (let j = i + 1; j < items.length; j += 1) {
          results[j] = { ok: false, error: '前一段报配置错误，已停止后续生成（未继续产生费用）' };
        }
        break;
      }
    }
  }
  return results;
}
