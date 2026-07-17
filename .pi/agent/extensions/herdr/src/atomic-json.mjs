import { rename, writeFile } from "node:fs/promises";

/**
 * Atomically replace a JSON file with owner-only permissions.
 *
 * @param {string} path
 * @param {unknown} value
 * @returns {Promise<void>}
 */
export async function atomicJson(path, value) {
  const temporary = `${path}.tmp-${process.pid}-${crypto.randomUUID()}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
}
