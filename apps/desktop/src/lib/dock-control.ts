/**
 * AI 助手浮层开关的全局控制（模块级单一事实来源 + 订阅）。
 *
 * 生成流水线（发起 → 分镜确认 → 视频生成 → 查看视频）整体收进聊天浮层后，
 * 侧栏「分镜 / AI 工具」、新建创作、workflow 意图等都要能从任意位置把浮层拉起，
 * 因此把 open 态从组件内部提到这里，路由不再决定默认形态。
 */

let open = false;
const listeners = new Set<() => void>();

function emit(): void {
  for (const fn of listeners) fn();
}

export function isDockOpen(): boolean {
  return open;
}

export function setDockOpen(next: boolean): void {
  if (open === next) return;
  open = next;
  emit();
}

/** 从任意调用处拉起浮层（如开始生成、分镜待确认、生成完成时） */
export function requestOpenDock(): void {
  setDockOpen(true);
}

export function subscribeDock(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
