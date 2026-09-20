import { Annotation } from '@langchain/langgraph';
import type { Asset, Project } from '@miaoma/video-project';
import type { PipelineNode } from './constants';
import type { Brief, MatchResult, SpeechSegment, Storyboard } from './types';
import type { AgentState } from './types';

/**
 * LangGraph StateGraph 的状态通道定义（模块 2.2）。
 *
 * 通道与 AgentState 字段一一对应：
 * - 业务产物通道为「最后写入覆盖」（reducer 直接取 next）；
 * - completedNodes 为「追加合并」——每个节点完成后写入 [node]，天然得到执行轨迹，
 *   也是 checkpoint 断点续跑（nextNodeIndex）的判断依据。
 */

const overwrite = <T>(init: () => T) => ({
  reducer: (_x: T, y: T | undefined): T => (y === undefined ? _x : y),
  default: init,
});

export const AgentStateAnnotation = Annotation.Root({
  requirement: Annotation<string>(overwrite<string>(() => '')),
  sourceDirs: Annotation<string[]>(overwrite<string[]>(() => [])),
  scannedAssets: Annotation<Asset[]>(overwrite<Asset[]>(() => [])),
  brief: Annotation<Brief | null>(overwrite<Brief | null>(() => null)),
  storyboard: Annotation<Storyboard | null>(overwrite<Storyboard | null>(() => null)),
  matchResult: Annotation<MatchResult | null>(overwrite<MatchResult | null>(() => null)),
  speechSegments: Annotation<SpeechSegment[]>(overwrite<SpeechSegment[]>(() => [])),
  project: Annotation<Project | null>(overwrite<Project | null>(() => null)),
  completedNodes: Annotation<PipelineNode[]>({
    reducer: (x, y) => (y && y.length > 0 ? [...x, ...y] : x),
    default: () => [],
  }),
});

export type GraphStateType = typeof AgentStateAnnotation.State;

/** 图状态 → 引擎对外的 AgentState 快照（结构同源，做一次浅拷贝防共享可变引用） */
export function toAgentState(values: GraphStateType): AgentState {
  return {
    requirement: values.requirement,
    sourceDirs: values.sourceDirs,
    scannedAssets: values.scannedAssets,
    brief: values.brief,
    storyboard: values.storyboard,
    matchResult: values.matchResult,
    speechSegments: values.speechSegments,
    project: values.project,
    completedNodes: values.completedNodes,
  };
}
