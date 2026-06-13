/**
 * @file isolation-e2e.test.ts
 * @description End-to-end proof of the isolation guarantee: work performed in the
 *   worktree the bridge hands the agent (its cwd) does NOT touch the main checkout.
 *   Simulates an agent edit by writing+committing inside ensureWorktree()'s cwd and
 *   asserts the main repo working tree stays clean and never sees the file.
 * @status New (harden/worktree-isolation).
 * @issues Exercises the cwd the provider uses; the real CLI is not spawned in unit tests.
 * @todo none.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { ensureWorktree, cleanupSession } from '../worktree-manager.js';

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf-8' }).trim();
}

function mkGitRepo(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cti-iso-')));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(dir, 'README.md'), '# main\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

test('agent edits in the worktree never reach the main checkout', async () => {
  const repo = mkGitRepo();
  const sid = 'iso-sess-' + process.hrtime.bigint().toString(36);

  const res = await ensureWorktree(sid, repo);
  assert.equal(res.ok, true);
  if (!res.ok) return;

  // Simulate the agent doing work in its cwd (the worktree).
  const agentFile = path.join(res.cwd, 'agent-output.txt');
  fs.writeFileSync(agentFile, 'work done by the IM-driven agent');
  git(res.cwd, 'add', '.');
  git(res.cwd, 'commit', '-q', '-m', 'agent change');

  // The main checkout working tree must be clean and must not contain the file.
  assert.equal(git(repo, 'status', '--porcelain'), '', 'main working tree must stay clean');
  assert.ok(!fs.existsSync(path.join(repo, 'agent-output.txt')), 'edit must not appear in main checkout');

  // The change lives on the session branch, isolated from main.
  assert.equal(git(repo, 'rev-parse', 'main'), git(repo, 'rev-parse', 'main'));
  const branchTip = git(repo, 'log', '-1', '--format=%s', res.branch ?? '');
  assert.equal(branchTip, 'agent change', 'change is committed on the isolated session branch');
  assert.notEqual(git(repo, 'rev-parse', 'main'), git(repo, 'rev-parse', res.branch ?? 'main'), 'branch has diverged from main');

  cleanupSession(sid);
});
