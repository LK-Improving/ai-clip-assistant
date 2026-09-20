/**
 * 阶段二常量：工作流节点顺序、人机中断点、引擎版本。
 * 原本在骨架 index.ts 中占位，现抽出单独模块供 pipeline / types 复用。
 */
export const AGENT_ENGINE_VERSION = '0.4.0';

/**
 * 工作流节点顺序（基于 @langchain/langgraph 的 StateGraph 编排，共 10 个真实节点）：
 * scan-assets → creative-brief → storyboard-plan → storyboard-review(人机审核/interrupt)
 * → match-assets → generate-clips → speech-synthesis → assemble-timeline
 * → validate(Zod 校验) → save-project(工程落盘)。
 *
 * 节点名 `storyboard-plan`（分镜规划）：LangGraph 要求节点名不得与状态通道同名，
 * 分镜产物通道为 `storyboard`，故节点名用 storyboard-plan 区分。
 * storyboard-review 调用 LangGraph 的 interrupt() 实现人机中断（见 nodes.ts），
 * 恢复经 Command({ resume }) 回注人工修改的分镜（见 pipeline.ts）；
 * validate / save-project 为显式节点，使「10 节点流水线」名副其实。
 */
export const PIPELINE_NODES = [
  'scan-assets',
  'creative-brief',
  'storyboard-plan',
  'storyboard-review',
  'match-assets',
  'generate-clips',
  'speech-synthesis',
  'assemble-timeline',
  'validate',
  'save-project',
] as const;

export type PipelineNode = (typeof PIPELINE_NODES)[number];

/** 人机交互中断点：分镜规划完成后、进入 match-assets 前暂停，等待人工确认/修改 */
export const INTERRUPT_NODE: PipelineNode = 'storyboard-review';

/** 历史别名（早期自研引擎以「某节点之后暂停」表达中断，现由 LangGraph interrupt 直接承担） */
export const INTERRUPT_AFTER = INTERRUPT_NODE;
