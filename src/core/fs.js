// node:fs/promises 的 re-export —— 单一出口
import fsp from 'node:fs/promises';
export { dirname } from 'node:path';
export { fsp };
export default fsp;
