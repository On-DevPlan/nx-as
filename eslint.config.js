import { defineConfig } from 'eslint/config';

const BASE = {
  'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
  'no-undef': 'off', // 浏览器/Node 全局混用，靠运行时暴露
  eqeqeq: ['error', 'smart'],
  'prefer-const': 'error',
  'no-var': 'error',
};

export default defineConfig([
  { ignores: ['src/web/public/**', 'node_modules/**', 'assets/**', '.claude/**', '.tool/**'] },
  {
    files: ['**/*.{js,mjs,jsx}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      // 少了这一行，所有 .jsx 都会 Parsing error: Unexpected token '<'
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      ...BASE,
      // JSX 组件用法 <Card /> 不被 core 规则识别为「使用」，jsx 文件单独关闭
      // （真实未用 import 由构建期 Vite/Rollup tree-shake 暴露，不靠这条）
      'no-unused-vars': 'off',
    },
  },
  {
    files: ['**/*.{js,mjs}'],
    rules: { 'no-unused-vars': BASE['no-unused-vars'] },
  },

  // core 是最底层
  {
    files: ['src/core/**/*.js'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [
        { group: ['../modules/**', '../runtime/**', '../web/**'],
          message: 'core 是最底层，不得依赖 modules / runtime / web。' },
      ] } ],
    },
  },

  // 模块之间不得互相依赖：枚举所有兄弟模块（枚举式，漏补是静默的！
  // 新增模块时必须来这里加 '../<新模块>/*'——见脚手架 A07 闭环表第 7 项）
  // 唯一例外：settings 故意不在禁列（基础模块，允许单向只读依赖）
  {
    files: ['src/modules/**/*.js'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [
        { group: ['../auth/*', '../tasks/*', '../prompts/*', '../models/*', '../system/*'],
          message: '模块之间不得互相依赖；共享逻辑下沉 core/。唯一例外：../settings/service.js。' },
      ] } ],
    },
  },

  // 聚合模块是刻意的例外（它要读各模块状态）
  { files: ['src/modules/system/**/*.js'], rules: { 'no-restricted-imports': 'off' } },

  // 前后端边界——价值最高的一条。files 必须同时覆盖 view.jsx
  {
    files: ['src/web/frontend/**/*.{js,jsx}', 'src/modules/**/view.jsx'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [
        { group: ['node:*'], message: '前端不能引用 Node 内置模块。' },
        { group: ['**/modules/*/index.js', '**/modules/*/service.js', '**/modules/*/runner.js', '**/runtime/**', '**/core/**'],
          message: '前端只能 import 模块的 view.jsx，以及 web/frontend 下的组件与 api 客户端。' },
      ] } ],
    },
  },

  // core / runtime / service.js 不得 import 任何 .jsx
  {
    files: ['src/core/**/*.js', 'src/runtime/**/*.js', 'src/modules/**/service.js', 'src/modules/**/index.js', 'src/modules/**/runner.js'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [
        { group: ['**/*.jsx'], message: 'Node 侧不得 import 视图文件。' },
      ] } ],
    },
  },
]);
