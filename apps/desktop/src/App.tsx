import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { AppShell } from '@/components/layout/app-shell';
import ChatPage from '@/pages/chat';
import EditorPage from '@/pages/editor';
import ExportProgressPage from '@/pages/export-progress';
import ExportSettingsPage from '@/pages/export-settings';
import LibraryPage from '@/pages/library';
import NewProjectPage from '@/pages/new-project';
import ProjectsPage from '@/pages/projects';
import SettingsPage from '@/pages/settings';
import TasksPage from '@/pages/tasks';
import { bindTimelineToActiveProject } from '@/lib/timeline-store';

/**
 * 创作统一从 #/new 开始，#/chat 承接生成、分镜确认与后续对话。
 * 旧启动页/工作台链接兼容跳转到同一个创作入口。
 */
const routes: Record<string, { element: ReactNode }> = {
  '/projects': { element: <ProjectsPage /> },
  '/new': { element: <NewProjectPage /> },
  '/chat': { element: <ChatPage /> },
  '/library': { element: <LibraryPage /> },
  '/editor': { element: <EditorPage /> },
  '/export': { element: <ExportSettingsPage /> },
  '/exporting': { element: <ExportProgressPage /> },
  '/settings': { element: <SettingsPage /> },
  '/tasks': { element: <TasksPage /> },
};

/** 已废弃的旧路由 → 归一到整页 AI 助手对话页 */
const LEGACY_DOCK_ROUTES = new Set(['/ai', '/storyboard']);
const LEGACY_START_ROUTES = new Set(['/launch', '/home']);

function currentRoute() {
  return window.location.hash.replace(/^#/, '') || '/new';
}

export default function App() {
  const [route, setRoute] = useState(currentRoute);

  useEffect(() => {
    const onHashChange = () => setRoute(currentRoute());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  // 遗留的 #/ai、#/storyboard：归一到整页 AI 助手对话页
  useEffect(() => {
    if (LEGACY_START_ROUTES.has(route)) {
      window.location.hash = '#/new';
      return;
    }
    if (!LEGACY_DOCK_ROUTES.has(route)) return;
    window.location.hash = '#/chat';
  }, [route]);

  /**
   * 时间线 store 绑定激活工程：载入当前工程，并在打开/新建工程时重载。
   * 不绑的话会出现“切了工程但时间线还是上一个”。
   */
  useEffect(() => bindTimelineToActiveProject(), []);

  const page = routes[route] ?? routes['/new']!;

  return <AppShell route={route}>{page.element}</AppShell>;
}
