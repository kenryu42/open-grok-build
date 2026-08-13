import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, vi } from 'vitest';

export function useTempOpenCodeHome(prefix: string) {
  const homes: string[] = [];

  afterEach(() => {
    vi.unstubAllEnvs();
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
  });

  return () => {
    const home = mkdtempSync(join(tmpdir(), prefix));
    homes.push(home);
    vi.stubEnv('HOME', home);
    vi.stubEnv('XDG_DATA_HOME', '');
    return home;
  };
}

export function runBun(source: string, environment: NodeJS.ProcessEnv = {}) {
  const child = spawn('bun', ['-e', source], {
    cwd: process.cwd(),
    env: { ...process.env, ...environment },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += String(chunk);
  });
  return new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr || `Bun process exited with ${String(code)}.`));
    });
  });
}
