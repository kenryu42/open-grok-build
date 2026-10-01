// Grok Build release sent when the latest stable release cannot be looked up.
// Keep it at a current official release so it stays above the endpoint minimum.
export const GROK_BUILD_VERSION = '1.0.46';
export const GROK_BUILD_CLIENT_IDENTIFIER = 'grok-shell';
export const GROK_BUILD_TOKEN_AUTH = 'xai-grok-cli';

const STABLE_VERSION_TIMEOUT_MS = 5_000;

let stableVersion: Promise<string> | undefined;
let refreshing: Promise<string> | undefined;

/**
 * The inference endpoint rejects requests with HTTP 426 when
 * `x-grok-client-version` is missing or older than its minimum supported
 * release; it ignores User-Agent. Reading the latest stable release from the
 * pointer the official installer uses keeps requests above a raised minimum
 * without a plugin release. The lookup runs once per process until a request
 * is rejected by the gate.
 */
export function resolveGrokBuildVersion() {
  stableVersion ??= fetch(process.env.GROK_BUILD_VERSION_URL || 'https://x.ai/cli/stable', {
    signal: AbortSignal.timeout(STABLE_VERSION_TIMEOUT_MS),
  })
    .then(async (response) => {
      const version = response.ok ? (await response.text()).trim() : '';
      return /^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version) ? version : GROK_BUILD_VERSION;
    })
    .catch(() => GROK_BUILD_VERSION);
  return stableVersion;
}

// Discards the cached release after the gate rejects it and looks it up again.
// Concurrent rejections share one lookup so a failed one cannot replace a newer release.
export function refreshGrokBuildVersion() {
  if (!refreshing) {
    stableVersion = undefined;
    refreshing = resolveGrokBuildVersion().finally(() => {
      refreshing = undefined;
    });
  }
  return refreshing;
}

function platformName(platform: NodeJS.Platform) {
  if (platform === 'darwin') return 'macos';
  if (platform === 'win32') return 'windows';
  return platform;
}

function architectureName(architecture: string) {
  if (architecture === 'arm64') return 'aarch64';
  if (architecture === 'x64') return 'x86_64';
  return architecture;
}

// Same format as the official Grok CLI client's User-Agent.
export function grokBuildUserAgent(
  version = GROK_BUILD_VERSION,
  platform = process.platform,
  architecture = process.arch,
): string {
  return `${GROK_BUILD_CLIENT_IDENTIFIER}/${version} (${platformName(platform)}; ${architectureName(architecture)})`;
}

export function grokBuildIdentityHeaders(version = GROK_BUILD_VERSION): Record<string, string> {
  return {
    'User-Agent': grokBuildUserAgent(version),
    'x-grok-client-identifier': GROK_BUILD_CLIENT_IDENTIFIER,
    'x-grok-client-version': version,
    'x-xai-token-auth': GROK_BUILD_TOKEN_AUTH,
  };
}
