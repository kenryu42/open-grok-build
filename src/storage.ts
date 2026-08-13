import { randomUUID } from 'node:crypto';
import {
  closeSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';

const homePath = () => process.env.HOME || homedir();

export const getOpenCodeDataDirectory = () =>
  process.env.XDG_DATA_HOME
    ? join(process.env.XDG_DATA_HOME, 'opencode')
    : join(homePath(), '.local', 'share', 'opencode');

export const getOpenGrokBuildDirectory = () => join(getOpenCodeDataDirectory(), 'open-grok-build');

export const getConfigPath = () => join(getOpenGrokBuildDirectory(), 'config.json');
export const getQuotaCachePath = () => join(getOpenGrokBuildDirectory(), 'quota-cache.json');

export function writeFileAtomic(path: string, contents: string, mode = 0o600) {
  const tempPath = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  try {
    writeFileSync(tempPath, contents, {
      encoding: 'utf8',
      flag: 'wx',
      mode,
    });
    renameSync(tempPath, path);
  } catch (error) {
    rmSync(tempPath, { force: true });
    throw error;
  }
}

export function withFileLock<T>(path: string, operation: () => T) {
  const lockPath = `${path}.lock`;
  const deadline = Date.now() + 5_000;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  while (true) {
    try {
      closeSync(openSync(lockPath, 'wx', 0o600));
      break;
    } catch (error) {
      if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'EEXIST') {
        throw error;
      }
      let modified: number;
      try {
        modified = statSync(lockPath).mtimeMs;
      } catch (statError) {
        if (
          !statError ||
          typeof statError !== 'object' ||
          !('code' in statError) ||
          statError.code !== 'ENOENT'
        ) {
          throw statError;
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        continue;
      }
      if (Date.now() - modified > 30_000) {
        rmSync(lockPath, { force: true });
        continue;
      }
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for file lock ${lockPath}.`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  try {
    return operation();
  } finally {
    rmSync(lockPath, { force: true });
  }
}
