// bind-audit 的 nginx 端口收集（从 http.d conf 文件实读 listen，避免与 tunnel.js 耦合）
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { nginxPorts } from './bind-audit.mjs';

export async function readConfPorts(dir, streamPort) {
  const names = await readdir(dir).catch(() => []);
  const texts = [];
  for (const n of names.filter((x) => x.endsWith('.conf'))) {
    texts.push(await readFile(join(dir, n), 'utf8').catch(() => ''));
  }
  return nginxPorts(texts, streamPort);
}
