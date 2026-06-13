/**
 * @file secure-fs.ts
 * @description Startup filesystem hardening: set a private umask and tighten any
 *   pre-existing loose permissions under the state directory (dirs→700, files→600).
 *   Protects data written before this hardening shipped.
 * @status New (harden/worktree-isolation). Covered by __tests__/secure-fs.test.ts.
 * @issues none known.
 * @todo none.
 */

import fs from 'node:fs';
import path from 'node:path';

/** Set a private umask so newly created files default to owner-only. */
export function applyPrivateUmask(): void {
  try {
    process.umask(0o077);
  } catch {
    // umask may be unavailable in some workers/platforms — non-fatal.
  }
}

/**
 * Recursively tighten permissions under `root`: directories to 0700, files to
 * 0600, whenever the current mode grants any group/other access. Skips symlinks
 * (never follows them). Returns the number of paths re-chmod'd. Best-effort:
 * individual failures are swallowed so startup never aborts on a stray file.
 */
export function hardenStateTree(root: string): number {
  let changed = 0;
  let entries: fs.Dirent[];
  try {
    if (!fs.existsSync(root)) return 0;
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return 0;
  }

  // Tighten the root directory itself.
  changed += tighten(root, 0o700);

  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      changed += hardenStateTree(full);
    } else if (entry.isFile()) {
      changed += tighten(full, 0o600);
    }
  }
  return changed;
}

/** chmod `target` to `desired` if its current mode grants group/other bits. */
function tighten(target: string, desired: number): number {
  try {
    const mode = fs.statSync(target).mode & 0o777;
    if ((mode & 0o077) !== 0 && mode !== desired) {
      fs.chmodSync(target, desired);
      return 1;
    }
  } catch {
    // best effort
  }
  return 0;
}
