import path from 'node:path';
import { BrowserWindow, app, protocol, shell } from 'electron';
import { registerIpc } from './main/ipc';
import { resolveFfmpegPath } from './main/ffmpeg';
import { addAllowedPath, registerProtocols } from './main/protocol';

/** M1.3 启动基线：进程时间原点（performance.timeOrigin = Electron 进程启动瞬间） */
const MAIN_START_MS = Math.round(performance.timeOrigin);

// 模块 4.3：声明 miaoma:// 为特权协议，支持流式 Range / Fetch API（必须在 app ready 前注册）
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'miaoma',
    privileges: {
      secure: true,
      bypassCSP: true,
      supportFetchAPI: true,
      stream: true,
    },
  },
]);

const createWindow = () => {
  const winStart = Date.now();
  const mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    show: false,
    backgroundColor: '#0b0b0f',
    title: 'KK剪映',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // 模块 4.3 收紧安全策略时可改为 true（届时 preload 不再依赖 node）
      sandbox: false,
    },
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    // M1.3 启动耗时基线（bench）：主进程入口→窗口可展示；devtools/日志可直接 grep [bench]
    console.log(`[bench] window create→ready-to-show: ${Date.now() - winStart}ms (sinceMainModule=${Date.now() - MAIN_START_MS}ms)`);
  });

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    void mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    void mainWindow.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
    );
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
};

void app.whenReady().then(() => {
  // 自定义协议需在创建窗口前注册，供 <video>/<img> 加载本地文件
  registerProtocols();
  // 模块 4.3：userData 下的缩略图 / 缓存 / 导出目录默认可访问
  addAllowedPath(app.getPath('userData'));
  registerIpc();
  createWindow();
  // 预览代理/导出都依赖具体是哪个 ffmpeg（剪映裁剪版无 libx264），开屏先报一行便于排查
  console.log(`[ffmpeg] 解析结果：${resolveFfmpegPath() ?? '未找到（预览代理与导出将不可用）'}`);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
