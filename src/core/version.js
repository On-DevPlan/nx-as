// 版本单一来源：从 package.json 读。
// 之前 VERSION 硬编码在 runtime/cli.js 和 auth/index.js 两处，0.1.1 发版忘改字面量
// 导致 CLI 自报旧版本。现在唯一来源在这里，发版改 package.json 即全链生效。
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
export const VERSION = require('../../package.json').version;
