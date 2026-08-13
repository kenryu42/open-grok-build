export const GROK_BUILD_VERSION = '0.2.111';
export const GROK_BUILD_CLIENT_IDENTIFIER = 'grok-pager';
export const GROK_BUILD_TOKEN_AUTH = 'xai-grok-cli';

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

export function grokBuildUserAgent(
  platform = process.platform,
  architecture = process.arch,
): string {
  return `${GROK_BUILD_CLIENT_IDENTIFIER}/${GROK_BUILD_VERSION} grok-shell/${GROK_BUILD_VERSION} (${platformName(platform)}; ${architectureName(architecture)})`;
}

export function grokBuildIdentityHeaders(): Record<string, string> {
  return {
    'User-Agent': grokBuildUserAgent(),
    'x-grok-client-identifier': GROK_BUILD_CLIENT_IDENTIFIER,
    'x-grok-client-version': GROK_BUILD_VERSION,
    'x-xai-token-auth': GROK_BUILD_TOKEN_AUTH,
  };
}
