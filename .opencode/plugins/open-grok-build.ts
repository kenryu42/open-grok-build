/**
 * Drop-in file plugin for `.opencode/plugins/` or `~/.config/opencode/plugins/`.
 * Re-exports the package entry as default (OpenCode legacy loader).
 */
export { OpenGrokBuildPlugin as default } from '../../src/opencode/plugin.js';
