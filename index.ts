/**
 * Server plugin entry. OpenCode resolves `<directory>/index` when a plugin is
 * configured by path, and `<package>` when it is installed by name.
 */

export { default } from './src/opencode/plugin.js';
