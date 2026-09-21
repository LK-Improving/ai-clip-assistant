import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { AppShell } from '@/components/layout/app-shell';
import AiWorkflowPage from '@/pages/ai-workflow';
import EditorPage from '@/pages/editor';
import ExportProgressPage from '@/pages/export-progress';
import ExportSettingsPage from '@/pages/export-settings';
import HomePage from '@/pages/home';
import LaunchPage from '@/pages/launch';
import LibraryPage from '@/pages/library';
import NewProjectPage from '@/pages/new-project';
import ProjectsPage from '@/pages/projects';
import SettingsPage from '@/pages/settings';
import StoryboardPage from '@/pages/storyboard';
import TasksPage from '@/pages/tasks';
import { bindTimelineToActiveProject } from '@/lib/timeline-store';

/**
 * 极简 hash 路由：#/home、#/editor ...
 * 后续页面变重时可平滑替换为 react-router，路由表结构不变。
 */
const routes: Record<string, { element: ReactNode; bare?: boolean }> = {
  '/launch': { element: <LaunchPage />, bare: true },
  '/home': { element: <HomePage /> },
  '/projects': { element: <ProjectsPage /> },
  '/new': { element: <NewProjectPage /> },
  '/ai': { element: <AiWorkflowPage /> },
  '/storyboard': { element: <StoryboardPage /> },
  '/library': { element: <LibraryPage /> },
  '/editor': { element: <EditorPage /> },
  '/export': { element: <ExportSettingsPage /> },
  '/exporting': { element: <ExportProgressPage /> },
  '/settings': { element: <SettingsPage /> },
  '/tasks': { element: <TasksPage /> },
};

function currentRoute() {
  return window.location.hash.replace(/^#/, '') || '/launch';
}

export default function App() {
  const [route, setRoute] = useState(currentRoute);

  useEffect(() => {
    const onHashChange = () => setRoute(currentRoute());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  /**
   * 时间线 store 绑定激活工程：载入当前工程，并在打开/新建工程时重载。
   * 不绑的话会出现“切了工程但时间线还是上一个”。
   */
  useEffect(() => bindTimelineToActiveProject(), []);

  const page = routes[route] ?? routes['/home']!;

  if (page.bare) return page.element;
  return <AppShell route={route}>{page.element}</AppShell>;
}
