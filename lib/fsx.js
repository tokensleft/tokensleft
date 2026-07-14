import { randomUUID } from 'node:crypto';
import { lstat, open, readFile, realpath, rename, stat, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const LOCK_WAIT_MS = 1_000;
const LOCK_RETRY_MS = 25;
const LOCK_STALE_MS = 30_000;

// All tokensleft-owned state (user-level .env, provider token caches) lives
// under this one directory; nothing else may spell the path.
export function configPath(...parts) {
  return join(homedir(), '.tokensleft', ...parts);
}

// Credential files are read concurrently by the CLIs that own them — write a
// temp file and rename so a reader never sees a half-written JSON document.
export class AtomicWriteConflictError extends Error {
  constructor(path) {
    super(`refusing to overwrite ${path}: the file changed while credentials were being refreshed`);
    this.name = 'AtomicWriteConflictError';
    this.code = 'EATOMICCONFLICT';
    this.path = path;
  }
}

export class AtomicWriteLockError extends Error {
  constructor(path) {
    super(`cannot safely update ${path}: another TokensLeft process is writing it`);
    this.name = 'AtomicWriteLockError';
    this.code = 'EATOMICLOCK';
    this.path = path;
  }
}

async function resolveWriteTarget(path) {
  let info;

  try {
    info = await lstat(path);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return path;
    }

    throw error;
  }

  if (!info.isSymbolicLink()) {
    return path;
  }

  try {
    return await realpath(path);
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw Object.assign(new Error(`cannot safely update ${path}: credential symlink target does not exist`), {
        code: 'EATOMICSYMLINK',
        path,
      });
    }

    throw error;
  }
}

async function acquireWriteLock(path) {
  const lockPath = `${path}.tokensleft.lock`;
  const deadline = Date.now() + LOCK_WAIT_MS;

  while (true) {
    try {
      return { handle: await open(lockPath, 'wx', 0o600), path: lockPath };
    } catch (error) {
      if (error.code !== 'EEXIST') {
        throw error;
      }
    }

    try {
      const lockInfo = await lstat(lockPath);

      if (Date.now() - lockInfo.mtimeMs > LOCK_STALE_MS) {
        await unlink(lockPath);
        continue;
      }
    } catch (error) {
      if (error.code === 'ENOENT') {
        continue;
      }

      throw error;
    }

    if (Date.now() >= deadline) {
      throw new AtomicWriteLockError(path);
    }

    await delay(LOCK_RETRY_MS);
  }
}

function recordCleanupError(errors, error) {
  if (error?.code !== 'ENOENT') {
    errors.push(error);
  }
}

export async function writeFileAtomic(path, text, {
  expectedContent,
  mode = 0o600,
  preserveMode = true,
} = {}) {
  const targetPath = await resolveWriteTarget(path);
  let targetMode = mode & 0o777;
  let lock = null;
  let handle = null;
  let tmpPath = null;
  let primaryError = null;

  try {
    // Serializing our own writers closes the read/compare/rename race between
    // concurrent TokensLeft processes. An external CLI can still replace its
    // file after the comparison; portable filesystems offer no strict CAS.
    lock = await acquireWriteLock(targetPath);

    if (preserveMode) {
      try {
        targetMode = (await stat(targetPath)).mode & 0o777;
      } catch (error) {
        if (error.code !== 'ENOENT') {
          throw error;
        }
      }
    }

    tmpPath = `${targetPath}.tmp-${process.pid}-${randomUUID()}`;
    // Keep the temporary credential private while its contents are built.
    handle = await open(tmpPath, 'wx', 0o600);
    await handle.writeFile(String(text), 'utf8');

    if (process.platform !== 'win32') {
      await handle.chmod(targetMode);
    }

    await handle.sync();
    await handle.close();
    handle = null;

    // Compare again while holding the TokensLeft writer lock.
    if (expectedContent !== undefined) {
      let current = null;

      try {
        current = await readFile(targetPath, 'utf8');
      } catch (error) {
        if (error.code !== 'ENOENT') {
          throw error;
        }
      }

      if (current !== expectedContent) {
        throw new AtomicWriteConflictError(targetPath);
      }
    }

    await rename(tmpPath, targetPath);
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    const cleanupErrors = [];

    if (handle) {
      try {
        await handle.close();
      } catch (error) {
        recordCleanupError(cleanupErrors, error);
      }
    }

    if (tmpPath) {
      try {
        await unlink(tmpPath);
      } catch (error) {
        recordCleanupError(cleanupErrors, error);
      }
    }

    if (lock) {
      try {
        await lock.handle.close();
      } catch (error) {
        recordCleanupError(cleanupErrors, error);
      }

      try {
        await unlink(lock.path);
      } catch (error) {
        recordCleanupError(cleanupErrors, error);
      }
    }

    if (cleanupErrors.length > 0) {
      if (primaryError !== null) {
        if (typeof primaryError === 'object') {
          primaryError.cleanupErrors = cleanupErrors;
        }
      } else {
        throw cleanupErrors.length === 1
          ? cleanupErrors[0]
          : new AggregateError(cleanupErrors, `failed to clean up atomic write for ${targetPath}`);
      }
    }
  }
}
