/**
 * @file build.js
 * @description esbuild bundler for the daemon. The ESM banner shims require AND
 *   __filename/__dirname so bundled CJS-style code (e.g. version lookups that do
 *   path.resolve(__dirname, ...)) does not crash with "__dirname is not defined".
 * @status Modified (harden/worktree-isolation): add __filename/__dirname shim.
 * @issues none known.
 * @todo none.
 */

import * as esbuild from 'esbuild';

await esbuild.build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: 'dist/daemon.mjs',
  external: [
    // SDK must stay external — it spawns a CLI subprocess and resolves
    // dist/cli.js relative to its own package location. Bundling it
    // breaks that path resolution.
    '@anthropic-ai/claude-agent-sdk',
    '@openai/codex-sdk',
    // discord.js optional native deps
    'bufferutil', 'utf-8-validate', 'zlib-sync', 'erlpack',
    // Node.js built-ins
    'fs', 'path', 'os', 'crypto', 'http', 'https', 'net', 'tls',
    'stream', 'events', 'url', 'util', 'child_process', 'worker_threads',
    'node:*',
  ],
  banner: {
    js: [
      "import { createRequire as __cti_cr } from 'module';",
      "import { fileURLToPath as __cti_ftu } from 'url';",
      "import { dirname as __cti_dn } from 'path';",
      'const require = __cti_cr(import.meta.url);',
      'const __filename = __cti_ftu(import.meta.url);',
      'const __dirname = __cti_dn(__filename);',
    ].join('\n'),
  },
});

console.log('Built dist/daemon.mjs');
