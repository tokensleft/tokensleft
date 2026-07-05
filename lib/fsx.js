import { rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

// All tokensleft-owned state (user-level .env, provider token caches) lives
// under this one directory; nothing else may spell the path.
export function configPath(...parts) {
  return join(homedir(), '.tokensleft', ...parts);
}

// Credential files are read concurrently by the CLIs that own them — write a
// temp file and rename so a reader never sees a half-written JSON document.
export async function writeFileAtomic(path, text) {
  const tmpPath = `${path}.tmp-${process.pid}`;
  await writeFile(tmpPath, text, 'utf8');
  await rename(tmpPath, path);
}
