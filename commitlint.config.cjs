module.exports = {
  extends: ['@commitlint/config-conventional'],
  rules: {
    // 项目约定：type(scope): 中文描述；scope 允许包名/模块名，长度放宽
    'subject-case': [0],
    'header-max-length': [2, 'always', 100],
  },
};
