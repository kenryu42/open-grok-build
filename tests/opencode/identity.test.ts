import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GROK_BUILD_VERSION,
  grokBuildIdentityHeaders,
  grokBuildUserAgent,
} from '../../src/opencode/identity.js';
import { startTestServer } from '../stateTestHelpers.js';

// Serves the queued versions in order, one per lookup.
async function withVersionSequence(
  versions: string[],
  run: (identity: typeof import('../../src/opencode/identity.js')) => Promise<void>,
  status = 200,
) {
  const server = await startTestServer((_request, response) => {
    response.writeHead(status, { 'Content-Type': 'text/plain' });
    response.end(versions.shift());
  });
  try {
    vi.stubEnv('GROK_BUILD_VERSION_URL', `${server.origin}/cli/stable`);
    await run(await import('../../src/opencode/identity.js'));
  } finally {
    await server.close();
  }
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('Grok Build client identity', () => {
  it('bundles a current Grok Build release for when the lookup fails', () => {
    expect(GROK_BUILD_VERSION).toBe('1.0.46');
  });

  it('formats the User-Agent like the official client with normalized platform names', () => {
    expect(grokBuildUserAgent('1.0.46', 'darwin', 'arm64')).toBe(
      'grok-shell/1.0.46 (macos; aarch64)',
    );
    expect(grokBuildUserAgent('1.0.46', 'win32', 'x64')).toBe(
      'grok-shell/1.0.46 (windows; x86_64)',
    );
    expect(grokBuildUserAgent('1.0.46', 'linux', 'riscv64')).toBe(
      'grok-shell/1.0.46 (linux; riscv64)',
    );
  });

  it('returns the identity headers for a version, defaulting to the bundled release', () => {
    expect(grokBuildIdentityHeaders('1.0.99')).toEqual({
      'User-Agent': grokBuildUserAgent('1.0.99'),
      'x-grok-client-identifier': 'grok-shell',
      'x-grok-client-version': '1.0.99',
      'x-xai-token-auth': 'xai-grok-cli',
    });
    expect(grokBuildIdentityHeaders()['x-grok-client-version']).toBe('1.0.46');
  });
});

describe('resolveGrokBuildVersion', () => {
  it('reads the latest stable release once per process', async () => {
    const versions = ['1.0.99\n', '1.0.100'];
    await withVersionSequence(versions, async (identity) => {
      await expect(identity.resolveGrokBuildVersion()).resolves.toBe('1.0.99');
      await expect(identity.resolveGrokBuildVersion()).resolves.toBe('1.0.99');
    });
    expect(versions).toEqual(['1.0.100']);
  });

  it('looks up the latest stable release again on refresh', async () => {
    const versions = ['1.0.99', '1.0.100'];
    await withVersionSequence(versions, async (identity) => {
      await expect(identity.resolveGrokBuildVersion()).resolves.toBe('1.0.99');
      await expect(identity.refreshGrokBuildVersion()).resolves.toBe('1.0.100');
      await expect(identity.resolveGrokBuildVersion()).resolves.toBe('1.0.100');
    });
    expect(versions).toEqual([]);
  });

  it('shares one lookup between concurrent refreshes', async () => {
    const versions = ['1.0.99', '1.0.100', 'not a version'];
    await withVersionSequence(versions, async (identity) => {
      await identity.resolveGrokBuildVersion();

      await expect(
        Promise.all([identity.refreshGrokBuildVersion(), identity.refreshGrokBuildVersion()]),
      ).resolves.toEqual(['1.0.100', '1.0.100']);
      await expect(identity.resolveGrokBuildVersion()).resolves.toBe('1.0.100');
    });
    expect(versions).toEqual(['not a version']);
  });

  it.each([
    { status: 500, body: 'unavailable' },
    { status: 200, body: '<html>not a version</html>' },
  ])('uses the bundled release when the stable pointer returns $status $body', async (reply) => {
    await withVersionSequence(
      [reply.body],
      async (identity) => {
        await expect(identity.resolveGrokBuildVersion()).resolves.toBe('1.0.46');
      },
      reply.status,
    );
  });

  it('uses the bundled release when the stable pointer is unreachable', async () => {
    const server = await startTestServer((_request, response) => response.end('1.0.99'));
    await server.close();
    vi.stubEnv('GROK_BUILD_VERSION_URL', `${server.origin}/cli/stable`);
    const identity = await import('../../src/opencode/identity.js');

    await expect(identity.resolveGrokBuildVersion()).resolves.toBe('1.0.46');
  });
});
