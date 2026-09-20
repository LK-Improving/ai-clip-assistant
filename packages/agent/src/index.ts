/**
 * @miaoma/agent —— AI 智能体引擎（阶段二，LangGraph 版）
 *
 * 设计要点：
 * - 基于 @langchain/langgraph StateGraph 编排 10 节点流水线，storyboard-review 用原生
 *   interrupt() 实现人机中断，恢复经 Command({ resume })；LangGraph Checkpoint 由
 *   JsonFileCheckpointSaver 落盘 JSON，支持崩溃后断点续跑；
 * - LLM 经 @langchain/core 模型抽象（离线确定性 / 火山方舟 ChatOpenAI / 本地 ChatOllama），
 *   结构化输出统一走 invokeStructured（Function Calling + Zod + 自动重试 + 降级兜底）；
 * - 通过依赖注入（AgentDeps）接入真实 TTS / 媒体探测 / 视频生成，无密钥时全链路仍可端到端跑通。
 */

export { AGENT_ENGINE_VERSION, PIPELINE_NODES, INTERRUPT_NODE, INTERRUPT_AFTER } from './constants';
export type { PipelineNode } from './constants';

export * from './types';
export * from './llm';
export * from './structured';
export * from './semantic';
export * from './video-gen';
export * from './deps';
export { AgentStateAnnotation, toAgentState } from './graph-state';
export type { GraphStateType } from './graph-state';
export { JsonFileCheckpointSaver } from './checkpointer';
export { NODE_RUNNERS, applyAutoTransitions, splitCaption } from './nodes';
export type { NodeUpdate } from './nodes';
export { runPipeline, resumeFromCheckpoint, saveCheckpoint, loadCheckpoint, PipelineError } from './pipeline';
