import type { Clip, Project } from '@miaoma/video-project';
import { createEmptyProject } from '@miaoma/video-project';

/** 缩略图占位的色相（后续由真实关键帧图替换） */
export interface MockProject {
  id: string;
  name: string;
  date: string;
  duration: string;
  hue: number;
}

export const recentProjects: MockProject[] = [
  { id: 'p1', name: '城市旅行 Vlog', date: '2026/07/28 14:30', duration: '00:45', hue: 262 },
  { id: 'p2', name: '产品介绍视频', date: '2026/07/28 14:26', duration: '01:20', hue: 200 },
  { id: 'p3', name: '学习资料', date: '2026/07/28 14:18', duration: '03:10', hue: 150 },
  { id: 'p4', name: '生活记录', date: '2026/07/26 09:45', duration: '00:58', hue: 20 },
  { id: 'p5', name: '美食探店', date: '2026/07/26 09:30', duration: '02:05', hue: 330 },
];

export const assetLibrary = [
  { id: 'a1', name: '富士山.jpg', kind: '图片', duration: '', hue: 220 },
  { id: 'a2', name: '城市夜景.mp4', kind: '视频', duration: '00:32', hue: 262 },
  { id: 'a3', name: '樱花.mp4', kind: '视频', duration: '00:18', hue: 330 },
  { id: 'a4', name: '柴犬.mp4', kind: '视频', duration: '00:09', hue: 60 },
  { id: 'a5', name: '海浪.mp4', kind: '视频', duration: '00:21', hue: 200 },
  { id: 'a6', name: '晚餐.mp4', kind: '视频', duration: '00:15', hue: 25 },
  { id: 'a7', name: '森林.mp4', kind: '视频', duration: '00:27', hue: 150 },
  { id: 'a8', name: '红酒.mp4', kind: '视频', duration: '00:12', hue: 0 },
  { id: 'a9', name: '街头.mp4', kind: '视频', duration: '00:44', hue: 280 },
] as const;

export interface MockStoryboard {
  index: string;
  range: string;
  narration: string;
  hue: number;
}

export const storyboards: MockStoryboard[] = [
  { index: '01', range: '00:00 - 00:05', narration: '城市黄昏的延时开场，交代旅行主题', hue: 262 },
  { index: '02', range: '00:05 - 00:12', narration: '清晨的富士山与樱花，切入主题画面', hue: 330 },
  { index: '03', range: '00:12 - 00:20', narration: '街景与美食特写快剪，节奏加快', hue: 25 },
  { index: '04', range: '00:20 - 00:30', narration: '旅途人物互动，情绪升华', hue: 200 },
  { index: '05', range: '00:30 - 00:40', narration: '结尾定格与字幕落版，呼应开场', hue: 150 },
];

export const workflowSteps = [
  { label: '准备阶段', desc: '理解需求与素材', state: 'done' },
  { label: '创意规划', desc: '生成创意简报与脚本', state: 'done' },
  { label: '素材生成', desc: '配音、字幕与画面匹配', state: 'running' },
  { label: '视频合成', desc: '时间线组装与渲染', state: 'todo' },
] as const;

export const aiTodos = [
  { label: '理解创作意图', state: 'done' },
  { label: '分析素材库', state: 'done' },
  { label: '生成分镜脚本', state: 'running' },
  { label: '匹配背景音乐', state: 'todo' },
  { label: '生成视频文案', state: 'todo' },
] as const;

/** 演示工程：真实数据模型实例，编辑器 / 分镜页共用 */
export function createDemoProject(): Project {
  const project = createEmptyProject({ name: '城市旅行 Vlog' });
  const videoTrack = project.tracks.find((t) => t.type === 'video');
  if (videoTrack && videoTrack.type === 'video') {
    const clip: Clip = {
      type: 'video',
      id: 'clip-demo-1',
      name: '富士山.mp4',
      start: 0,
      duration: 12_000,
      assetId: 'asset-demo-1',
      speed: 1,
      locked: false,
      enabled: true,
      effects: [],
      offset: 0,
      transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
      volume: 1,
      muted: false,
    };
    videoTrack.clips.push(clip);
  }
  return project;
}

/** 时间线轨道的静态展示数据（毫秒 → 百分比在组件内换算） */
export const timelineTracks = [
  {
    kind: 'video' as const,
    label: '视频 1',
    clips: [
      { name: '开场.mp4', left: 0, width: 18, hue: 262 },
      { name: '富士山.mp4', left: 18.5, width: 26, hue: 330 },
      { name: '街头.mp4', left: 45, width: 20, hue: 200 },
    ],
  },
  {
    kind: 'audio' as const,
    label: '音频 1',
    clips: [
      { name: '背景音乐.wav', left: 0, width: 62, hue: 150 },
      { name: '旁白.mp3', left: 64, width: 22, hue: 170 },
    ],
  },
  {
    kind: 'text' as const,
    label: '字幕',
    clips: [
      { name: '在旅途中，遇见更大的世界', left: 20, width: 30, hue: 262 },
      { name: '美食与故事都在路上', left: 55, width: 24, hue: 280 },
    ],
  },
];
