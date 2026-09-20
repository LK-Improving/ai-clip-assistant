import type { Clip } from './clip';
import type { Project } from './project';

/** 片段在时间线上的结束时间（毫秒） */
export function clipEndMs(clip: Clip): number {
  return clip.start + clip.duration;
}

/**
 * 计算工程总时长（毫秒）：所有片段结束时间的最大值。
 * 空工程返回 0，调用方应自行兜底（如最小 1000ms）。
 */
export function projectDurationMs(project: Project): number {
  let max = 0;
  for (const track of project.tracks) {
    for (const clip of track.clips) {
      if (clip.enabled === false) continue;
      if (clipEndMs(clip) > max) max = clipEndMs(clip);
    }
  }
  return max;
}
