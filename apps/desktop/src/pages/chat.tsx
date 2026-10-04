import { AssistantPanel } from '@/components/assistant/assistant-dock';

/** 05 AI 助手对话页（整页）：承载完整「一句话成片」流水线——发起 → 分镜确认 → 生成进度 → 查看视频/导出 */
export default function ChatPage() {
  return <AssistantPanel variant="page" />;
}
