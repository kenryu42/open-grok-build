import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type RequestListener } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, vi } from 'vitest';
import { refreshGrokBuildVersion } from '../src/opencode/identity.js';

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

export async function startTestServer(handler: RequestListener) {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test server address');
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

/**
 * Serves `latest` as the stable Grok Build release so request hooks never reach
 * x.ai, and resets the cached release to 1.0.99 before each test.
 */
export function useStableVersionServer() {
  const state = { latest: '1.0.99' };
  let server: Awaited<ReturnType<typeof startTestServer>>;
  beforeAll(async () => {
    server = await startTestServer((_request, response) => response.end(`${state.latest}\n`));
  });
  afterAll(() => server.close());
  beforeEach(async () => {
    state.latest = '1.0.99';
    vi.stubEnv('GROK_BUILD_VERSION_URL', `${server.origin}/cli/stable`);
    await refreshGrokBuildVersion();
  });
  return state;
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
