import { useCallback, useEffect, useSyncExternalStore } from 'react';
import type { AssetMetaHint } from '@/lib/project-bridge';
import {
  applyTimelineActions,
  canUndo,
  getSaveState,
  getSelection,
  getTracks,
  setAssetHintsProvider,
  setSelection,
  subscribeTimeline,
  undoTimeline,
  type SaveState,
  type TimelineAction,
  type TimelineSelection,
} from '@/lib/timeline-store';
import type { TimelineTrack } from '@/lib/timeline-utils';

/**
 * 时间线 store 的 React 绑定（编辑器与 AI 助手面板共用同一份状态）。
 *
 * 用 useSyncExternalStore 而不是 useState + 手动订阅：两处 UI 同时挂载时
 * 不会各自持有一份副本，也不会漏掉对方发起的改动。
 */
export function useTimelineTracks(): TimelineTrack[] {
  return useSyncExternalStore(subscribeTimeline, getTracks, getTracks);
}

export function useTimelineSelection(): [TimelineSelection | null, (next: TimelineSelection | null) => void] {
  const selection = useSyncExternalStore(subscribeTimeline, getSelection, getSelection);
  const update = useCallback((next: TimelineSelection | null) => setSelection(next), []);
  return [selection, update];
}

export function useTimelineSaveState(): SaveState {
  return useSyncExternalStore(subscribeTimeline, getSaveState, getSaveState);
}

/** 提交一批时间线动作；返回实际生效条数与被跳过的原因（目标不存在等） */
export function useApplyTimeline(): (actions: TimelineAction[]) => ReturnType<typeof applyTimelineActions> {
  return useCallback((actions: TimelineAction[]) => applyTimelineActions(actions), []);
}

/** 当前能不能撤销（控制「撤销」按钮置灰） */
export function useCanUndo(): boolean {
  return useSyncExternalStore(subscribeTimeline, canUndo, canUndo);
}

export { undoTimeline };

/**
 * 注册素材元数据来源（时长 / 分辨率 / 是否含音轨）。
 *
 * 落盘已搬进 store，任何入口（编辑器拖拽、对话插入）改完都会自动保存；
 * 但「新素材首次进工程」需要素材库探测值补全字段，所以由编辑器把这份数据交出来。
 * 传 null 注销（页面卸载时）。
 */
export function useTimelineAssetHints(provider: (() => Map<string, AssetMetaHint>) | null): void {
  useEffect(() => {
    setAssetHintsProvider(provider);
    return () => setAssetHintsProvider(null);
  }, [provider]);
}
