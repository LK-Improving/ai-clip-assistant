'use strict';

/**
 * 本地 NSIS Maker（兼容 Electron Forge 7.11 的 class 式 maker 接口）
 *
 * 背景：npm 上的 `electron-forge-maker-nsis`（electron-builder 提供的封装）其
 * `main.js` 仅 `exports.default = function (options) { return buildForge(...) }`，
 * 是一个「函数」而非 maker「类」。Forge 7.11 在解析 maker 时会 `new MakerClass(config, platforms)`，
 * 对普通函数执行 `new` 会**立即调用**它，于是 `buildForge` 里 `path.resolve(config.dir)`
 * 因 `dir` 为 undefined 抛 `The "paths[0]" argument must be of type string. Received undefined`。
 *
 * 本文件把它的逻辑重新包成一个真正的 Maker 子类：
 *   - 继承 `@electron-forge/maker-base` 的 `Maker`，构造时挂上 `__isElectronForgeMaker`
 *   - 实现 `make({ dir, makeDir, targetArch })`，把 Forge 给的「已打包 app 目录」作为
 *     `buildForge` 的 `dir`，并让输出目录对齐 Forge 约定的 `makeDir`。
 *
 * 这样 Forge 解析 `name: './makers/nsis-maker.cjs'` 时 `new` 出来的是合法 maker 实例，
 * 调用 `make()` 时再真正触发 electron-builder 的 NSIS 构建。
 */

const makerBase = require('@electron-forge/maker-base');
const { buildForge } = require('app-builder-lib');

// 不同版本导出名可能是 MakerBase / default / Maker，取第一个可用的
const Maker = makerBase.MakerBase || makerBase.default || makerBase.Maker;

class NsisMaker extends Maker {
  constructor(config = {}, platformsToMakeOn) {
    super(config, platformsToMakeOn);
    this.name = 'nsis';
    this.defaultPlatforms = ['win32'];
  }

  isSupportedOnCurrentPlatform() {
    return process.platform === 'win32';
  }

  async make({ dir, makeDir, targetArch }) {
    const userConfig =
      typeof this.config?.getAppBuilderConfig === 'function'
        ? await this.config.getAppBuilderConfig()
        : this.config || {};

    return buildForge(
      // Forge 已经把 app 打包好，dir 就是那个目录；buildForge 内部 path.resolve(dir) 必为字符串
      { dir },
      {
        win: [`nsis:${targetArch}`],
        config: {
          // appId 防止 electron-builder 报 "Please specify 'appId'"
          appId: 'com.miaoma.studio',
          // 必须显式指定输出目录，对齐 Forge 的 makeDir（buildForge 内部默认也是这个路径，
          // 但我们的 options.config 会整体覆盖它，所以这里兜底写一遍）
          directories: { output: makeDir },
          ...userConfig,
        },
      },
    );
  }
}

module.exports = NsisMaker;
