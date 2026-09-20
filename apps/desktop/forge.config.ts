import { existsSync } from 'node:fs';
import type { ForgeConfig } from '@electron-forge/shared-types';
import { VitePlugin } from '@electron-forge/plugin-vite';

/**
 * Electron Forge 配置（模块 5.1：跨平台打包）
 *
 * - 构建链路由 @electron-forge/plugin-vite 托管（主进程 / 预加载 / 渲染进程三份 vite 配置）
 * - extraResource：把工程内 `extraResources/ffmpeg`（完整版 ffmpeg，含 libx264 + drawtext）
 *   随包拷贝到安装后的 `resources/ffmpeg/`，运行时由 resolveFfmpegPath 的
 *   `process.resourcesPath/ffmpeg/ffmpeg.exe` 候选优先选用 → 字幕烧录 / 高质量 H.264 开箱即用
 * - makers：Windows 用 NSIS 向导式安装包（装到 Program Files + 开始菜单/桌面快捷方式），macOS 用 dmg，
 *   Linux 用官方 deb/rpm（模块 5.1 P3：三平台安装包齐备；仅在对应平台打包时生效，Windows 上自动跳过），
 *   zip 跨平台通用（便携版）
 * - 代码签名：仅在对应环境变量存在时才启用，未配证书时不影响本地打包；
 *   macOS 公证（notarize）同样条件启用（APPLE_ID / APPLE_ID_PASSWORD / APPLE_TEAM_ID）
 */

// Windows Authenticode 签名：存在 CSC_LINK（p12 证书路径）时启用
const windowsSign =
  process.env.CSC_LINK || process.env.MIAOMA_WINDOWS_CERT
    ? {
        signWithParams: [
          '/fd', 'sha256',
          '/tr', process.env.MIAOMA_TIMESTAMP_SERVER || 'http://timestamp.digicert.com',
          '/td', 'sha256',
        ],
      }
    : undefined;

// macOS 签名 + 公证：存在证书身份时启用
const osxSign =
  process.env.APPLE_ID && process.env.APPLE_ID_PASSWORD && process.env.APPLE_TEAM_ID
    ? {
        identity: process.env.APPLE_SIGN_IDENTITY || 'Developer ID Application',
        hardening: true,
        gatekeeperAssess: false,
        entitlements: 'entitlements.plist',
        'entitlements-inherit': 'entitlements.plist',
      }
    : undefined;

// macOS 公证（ stapling ）：签名三件套齐备时一并启用，避免用户侧「无法验证开发者」警告
const osxNotarize =
  process.env.APPLE_ID && process.env.APPLE_ID_PASSWORD && process.env.APPLE_TEAM_ID
    ? {
        appleId: process.env.APPLE_ID,
        appleIdPassword: process.env.APPLE_ID_PASSWORD,
        teamId: process.env.APPLE_TEAM_ID,
      }
    : undefined;

const config: ForgeConfig = {
  // 输出目录强制用纯英文（ASCII）路径：electron-winstaller 调用的原生 rcedit.exe
  // 无法正确处理中文路径下的 Setup.exe（报 "Unable to load file"），把 outDir 指到
  // 一个无中文的路径即可避开。中文项目目录本身不用动。
  outDir: 'D:/kk-build',
  packagerConfig: {
    asar: true,
    // ⚠️ Windows 打包坑：本机实时杀毒（Windows Defender）会锁定刚写好的
    //   resources/app.asar，导致 finalize 阶段报 `EBUSY: resource busy or locked,
    //   unlink ...app.asar`。根因是「已存在的 out 目录里有被锁的旧 app.asar」，
    //   Forge 重新打包前清理它时 unlink 失败。
    // 解决：① 给项目目录加 Defender 排除项（PowerShell 管理员执行
    //   Add-MpPreference -ExclusionPath "D:\Study\重点项目\AI剪映"）；
    //   ② 删掉 apps/desktop/out 后重跑 `pnpm make`。
    name: 'KKJianying',
    executableName: 'kk-jianying',
    // 完整版 ffmpeg 随包分发到 resources/ffmpeg/（与 resolveFfmpegPath 的候选路径对应）
    extraResource: 'extraResources/ffmpeg',
    // 应用图标：存在时才引用，缺失时 electron-packager 退回默认图标，避免打包直接报错
    ...(existsSync('assets/icon.png') ? { icon: 'assets/icon' } : {}),
    // 代码签名（可选，见上方条件）
    ...(windowsSign ? { windowsSign } : {}),
    ...(osxSign ? { osxSign } : {}),
    ...(osxNotarize ? { osxNotarize } : {}),
    // 模块 5.1 可继续补充：appCategoryType、extendInfo 等
  },
  rebuildConfig: {},
  makers: [
    {
      name: '@electron-forge/maker-zip',
      platforms: ['win32', 'darwin', 'linux'],
      config: {},
    },
    {
      // 本地 NSIS maker 封装（apps/desktop/makers/nsis-maker.cjs）。
      // 直接用 electron-forge-maker-nsis 这个 npm 包会报
      // `The "paths[0]" argument must be of type string. Received undefined`——
      // 因为它导出的 default 是个「函数」而非 maker「类」，Forge 7.11 用 `new` 实例化时会
      // 立即调用它导致 buildForge 拿到的 dir 为 undefined。本地封装把它包成真正的
      // Maker 子类，在 make() 里把 Forge 给的已打包 app 目录喂给 buildForge。
      // 其内部 makensis 同样对中文路径敏感，故 outDir 已指向 ASCII 路径。
      name: './makers/nsis-maker.cjs',
      platforms: ['win32'],
      config: {
        getAppBuilderConfig: async () => ({
          productName: 'KKJianying',
          artifactName: '${productName}-Setup-${version}.${ext}',
          // 以下 NSIS 专属选项必须放在 nsis 子键下：electron-builder 26 的 schema
          // 已不再允许根级 oneClick / perMachine 等字段（会报 "unknown property"）。
          nsis: {
            oneClick: false, // 向导式（非一键静默）
            perMachine: true, // 装到 Program Files（需管理员一次）
            allowToChangeInstallationDirectory: true, // 用户可选安装目录
            createDesktopShortcut: true,
            createStartMenuShortcut: true,
          },
          // 图标复用 packagerConfig.icon 拷进安装包的图标（位于 ASCII 输出目录，避开中文路径坑）。
          // 如需自定义安装器图标，把 assets/icon.ico copy 到英文路径后在此加
          // win: { icon: 'D:/.../icon.ico' } 或 nsis: { installerIcon: 'D:/.../icon.ico' }
        }),
      },
    },
    {
      name: '@electron-forge/maker-dmg',
      platforms: ['darwin'],
      config: {
        name: 'KKJianying',
        ...(existsSync('assets/icon.icns') ? { icon: 'assets/icon.icns' } : {}),
      },
    },
    {
      // Linux deb（模块 5.1 P3）：仅 linux 目标平台打包时生效；
      // 中文描述/维护者信息进包元数据，bins 依赖由 ffmpeg 子进程自带兼容库兼并。
      name: '@electron-forge/maker-deb',
      platforms: ['linux'],
      config: {
        options: {
          productName: 'KKJianying',
          genericName: 'kk-jianying',
          description: '企业级类剪映 AI 智能剪辑桌面应用（本地素材 + LangGraph 智能体流水线）',
          maintainer: 'KK Jianying <support@example.local>',
          homepage: 'https://example.local/kk-jianying',
          categories: ['AudioVideo', 'Video'],
          icon: existsSync('assets/icon.png') ? 'assets/icon.png' : undefined,
        },
      },
    },
    {
      // Linux rpm（RHEL/openSUSE 系）：与 deb 同为条件启用，Windows 打包时自动跳过
      name: '@electron-forge/maker-rpm',
      platforms: ['linux'],
      config: {
        options: {
          productName: 'KKJianying',
          genericName: 'kk-jianying',
          description: '企业级类剪映 AI 智能剪辑桌面应用（本地素材 + LangGraph 智能体流水线）',
          license: 'MIT',
          categories: ['AudioVideo'],
          icon: existsSync('assets/icon.png') ? 'assets/icon.png' : undefined,
        },
      },
    },
  ],
  plugins: [
    new VitePlugin({
      build: [
        {
          entry: 'src/main.ts',
          config: 'vite.main.config.ts',
          target: 'main',
        },
        {
          entry: 'src/preload.ts',
          config: 'vite.preload.config.ts',
          target: 'preload',
        },
      ],
      renderer: [
        {
          name: 'main_window',
          config: 'vite.renderer.config.ts',
        },
      ],
    }),
  ],
};

export default config;
