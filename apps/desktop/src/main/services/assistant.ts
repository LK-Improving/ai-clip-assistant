import { planEdits, type AssistantTimelineSnapshot, type EditPlan } from '@miaoma/agent';
import { resolveLlm } from './agent';

/**
 * AI 助手对话规划（主进程侧）。
 *
 * 只负责「自然语言 → 时间线改动计划」，不直接改状态：
 * 时间线的唯一事实源在渲染进程 store，落地必须由渲染进程做（顺带完成 ref→clipId 解析与
 * 用户确认），主进程拿不到也不需要拿到当前 tracks。
 */
export async function planAssistantEdit(input: {
  message: string;
  snapshot: AssistantTimelineSnapshot;
}): Promise<EditPlan> {
  const message = String(input.message ?? '').trim();
  if (!message) return { reply: '想让我做什么？例如「删掉音乐轨第 2 段」。', actions: [] };

  const model = resolveLlm();
  // 离线 Provider 是按规则拼 JSON 的确定性模型，听不懂自由指令，直接讲清楚而不是硬试
  if (model.providerId === 'offline') {
    return {
      reply: '当前是离线模型，我只能查素材、看工程摘要。要按对话改时间线，请先在设置中心 → AI 配置里填好大模型（DeepSeek / 方舟 / Ollama 均可）。',
      actions: [],
    };
  }

  return planEdits({ model, message, snapshot: input.snapshot });
}
