// 容器首启：确保 store.machineSecret 存在，并把当前值写到 stdout
// 独立成文件的原因：entrypoint 里用 `node -e "<多行 JS>"` 在 ash/bash 下容易被引号与换行传递破坏
// （表现为静默退出、stdout 为空），落地成脚本文件最稳。
import { loadStore, mutateStore } from '../src/core/store.js';
import { randomBytes } from 'node:crypto';

let store = await loadStore();
if (!store.machineSecret) {
  await mutateStore((s) => {
    s.machineSecret = randomBytes(32).toString('hex');
  });
  store = await loadStore();
  console.error('[secret-init] machineSecret 已生成并写入 store');
} else {
  console.error('[secret-init] machineSecret 复用 store 中的值');
}

process.stdout.write(store.machineSecret || '');
