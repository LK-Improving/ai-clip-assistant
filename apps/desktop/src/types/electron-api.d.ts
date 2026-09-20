import type { DesktopApi } from '../preload';

declare global {
  interface Window {
    electronAPI: DesktopApi;
  }
}

export {};
