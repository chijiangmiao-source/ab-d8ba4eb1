import { rename, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * 以 “写临时文件 + rename” 的方式原子落盘，
 * 保证状态机要么是旧版本、要么是新版本，不存在写到一半的 JSON。
 */
export async function atomicWriteJson(file, data) {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const { writeFile } = await import('node:fs/promises');
  await writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await rename(tmp, file);
}
