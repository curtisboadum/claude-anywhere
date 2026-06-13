/**
 * @file secure-fs.test.ts
 * @description Verifies the startup permission migration tightens pre-existing
 *   world/group-readable state files (0644→0600) and dirs (0755→0700), and
 *   leaves already-private files untouched.
 * @status New (harden/worktree-isolation).
 * @issues Skipped on Windows (POSIX mode bits not meaningful).
 * @todo none.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { hardenStateTree } from '../secure-fs.js';

const skip = process.platform === 'win32';

test('migrates a pre-existing 0644 state file to 0600', { skip }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-secure-'));
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.chmodSync(dataDir, 0o755);
  const file = path.join(dataDir, 'sessions.json');
  fs.writeFileSync(file, '{}');
  fs.chmodSync(file, 0o644);

  const changed = hardenStateTree(root);
  assert.ok(changed >= 2);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(dataDir).mode & 0o777, 0o700);
});

test('leaves an already-private 0600 file untouched', { skip }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-secure-'));
  const file = path.join(root, 'config.env');
  fs.writeFileSync(file, 'X=1');
  fs.chmodSync(file, 0o600);
  fs.chmodSync(root, 0o700);

  const changed = hardenStateTree(root);
  assert.equal(changed, 0);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});
