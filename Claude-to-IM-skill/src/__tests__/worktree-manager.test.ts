/**
 * @file worktree-manager.test.ts
 * @description Integration tests for per-session worktree isolation against real
 *   temp git repos: create, reuse-on-resume, non-git fail-closed, GC by count,
 *   cleanup, and reinforcement-prompt rendering.
 * @status New (harden/worktree-isolation).
 * @issues none known.
 * @todo none.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import {
  ensureWorktree,
  cleanupSession,
  resolveRepoRoot,
  renderSessionInstructions,
} from '../worktree-manager.js';

function mkGitRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-wt-repo-'));
  const real = fs.realpathSync(dir);
  const run = (...args: string[]) => execFileSync('git', ['-C', real, ...args], { stdio: 'ignore' });
  run('init', '-q', '-b', 'main');
  run('config', 'user.email', 'test@example.com');
  run('config', 'user.name', 'Test');
  fs.writeFileSync(path.join(real, 'README.md'), '# test\n');
  run('add', '.');
  run('-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init');
  return real;
}

function uid(): string {
  return 'sess-' + Math.floor(performance.now() * 1000).toString(36) + '-' + process.hrtime.bigint().toString(36);
}

test('creates a sibling worktree on a dedicated branch', async () => {
  const repo = mkGitRepo();
  const sid = uid();
  const res = await ensureWorktree(sid, repo);
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.isolated, true);
  // Sibling of the repo, under .cti-worktrees, never nested inside the repo.
  assert.ok(res.cwd.startsWith(path.join(path.dirname(repo), '.cti-worktrees')));
  assert.ok(!res.cwd.startsWith(repo + path.sep));
  assert.ok(fs.existsSync(res.cwd));
  assert.equal(resolveRepoRoot(res.cwd), res.cwd);
  // Branch exists and is checked out in the worktree.
  const branches = execFileSync('git', ['-C', repo, 'branch', '--list', res.branch ?? ''], { encoding: 'utf-8' });
  assert.ok(branches.includes(res.branch ?? '__none__'));
  cleanupSession(sid);
});

test('reuses the same worktree when the session resumes', async () => {
  const repo = mkGitRepo();
  const sid = uid();
  const a = await ensureWorktree(sid, repo);
  const b = await ensureWorktree(sid, repo);
  assert.equal(a.ok && b.ok, true);
  if (a.ok && b.ok) assert.equal(a.cwd, b.cwd);
  cleanupSession(sid);
});

test('fails closed when the working directory is not a git repo', async () => {
  const nonRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-nonrepo-'));
  const res = await ensureWorktree(uid(), nonRepo);
  assert.equal(res.ok, false);
  if (!res.ok) assert.match(res.error, /not a git repository/i);
});

test('enforces the worktree count cap', async () => {
  const repo = mkGitRepo();
  const prev = process.env.CTI_WORKTREE_MAX;
  process.env.CTI_WORKTREE_MAX = '2';
  const made: string[] = [];
  try {
    const s1 = uid(); const r1 = await ensureWorktree(s1, repo); made.push(s1);
    const s2 = uid(); const r2 = await ensureWorktree(s2, repo); made.push(s2);
    const s3 = uid(); const r3 = await ensureWorktree(s3, repo); made.push(s3);
    assert.equal(r1.ok, true);
    assert.equal(r2.ok, true);
    assert.equal(r3.ok, false);
    if (!r3.ok) assert.match(r3.error, /limit reached/i);
  } finally {
    for (const s of made) cleanupSession(s);
    if (prev === undefined) delete process.env.CTI_WORKTREE_MAX; else process.env.CTI_WORKTREE_MAX = prev;
  }
});

test('cleanupSession removes the worktree and branch', async () => {
  const repo = mkGitRepo();
  const sid = uid();
  const res = await ensureWorktree(sid, repo);
  assert.equal(res.ok, true);
  if (!res.ok) return;
  cleanupSession(sid);
  assert.ok(!fs.existsSync(res.cwd));
  const branches = execFileSync('git', ['-C', repo, 'branch', '--list', res.branch ?? ''], { encoding: 'utf-8' });
  assert.ok(!branches.includes(res.branch ?? '__none__'));
});

test('renderSessionInstructions states worktree facts when isolated', () => {
  const txt = renderSessionInstructions({ isolated: true, cwd: '/tmp/wt-x', branch: 'cti/abc123' });
  assert.match(txt, /\/tmp\/wt-x/);
  assert.match(txt, /cti\/abc123/);
  assert.match(txt, /never edit/i);
});

test('renderSessionInstructions instructs self-setup when not isolated', () => {
  const txt = renderSessionInstructions({ isolated: false, cwd: '/x', branch: null });
  assert.match(txt, /git worktree add/i);
});

test('renderSessionInstructions honours a custom template', () => {
  const txt = renderSessionInstructions(
    { isolated: true, cwd: '/tmp/wt-y', branch: 'cti/def' },
    'WT={{path}} BR={{branch}}',
  );
  assert.equal(txt, 'WT=/tmp/wt-y BR=cti/def');
});
