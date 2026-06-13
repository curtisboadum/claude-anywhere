/**
 * @file worktree-manager.ts
 * @description Per-session git worktree isolation for the bridge: deterministically
 *   creates/reuses a unique worktree + branch per IM session, sets the agent cwd,
 *   GCs by TTL/count/disk, and renders the reinforcement system prompt.
 * @status New (harden/worktree-isolation). Covered by __tests__/worktree-manager.test.ts.
 * @issues none known.
 * @todo Optionally wire cleanupSession to a bridge session-end hook if core exposes one.
 *
 * Every IM-driven Claude/Codex session runs inside its own git worktree on a
 * dedicated branch, so concurrent sessions can never collide on the working
 * tree of the main checkout. Coordination happens only at PR/merge time.
 *
 * This is enforced by the bridge (the providers set the agent's `cwd` to the
 * returned worktree path) — it does NOT depend on the model obeying a prompt.
 *
 * Layout (sibling, never nested inside the repo):
 *   <repoParent>/.cti-worktrees/<repoName>-<sessionShort>   (override: CTI_WORKTREE_ROOT)
 *   branch: cti/<sessionShort>
 *
 * Tunables (env):
 *   CTI_WORKTREE_ISOLATION   "false" to opt out (NOT recommended)
 *   CTI_WORKTREE_ROOT        override the worktree parent directory
 *   CTI_WORKTREE_TTL_HOURS   GC worktrees idle longer than this (default 72)
 *   CTI_WORKTREE_MAX         hard cap on live worktrees (default 20)
 *   CTI_WORKTREE_MAX_DISK_MB GC oldest until total disk under this (default 5000)
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

import { CTI_HOME } from './config.js';

const DATA_DIR = path.join(CTI_HOME, 'data');
const MAP_PATH = path.join(DATA_DIR, 'worktrees.json');

export interface WorktreeRecord {
  sessionId: string;
  repoRoot: string;
  path: string;
  branch: string;
  createdAt: number;
  lastUsedAt: number;
}

export type EnsureWorktreeOutcome =
  | { ok: true; cwd: string; branch: string | null; repoRoot: string; isolated: boolean }
  | { ok: false; error: string };

// ── env helpers (read at call time so tests can vary them) ──

function isolationEnabled(): boolean {
  return process.env.CTI_WORKTREE_ISOLATION !== 'false';
}
function ttlMs(): number {
  const h = Number(process.env.CTI_WORKTREE_TTL_HOURS);
  return (Number.isFinite(h) && h > 0 ? h : 72) * 3600_000;
}
function maxCount(): number {
  const n = Number(process.env.CTI_WORKTREE_MAX);
  return Number.isFinite(n) && n > 0 ? n : 20;
}
function maxDiskMb(): number {
  const n = Number(process.env.CTI_WORKTREE_MAX_DISK_MB);
  return Number.isFinite(n) && n > 0 ? n : 5000;
}

// ── small git/fs utils ──

function git(repoRoot: string, args: string[]): string {
  return execFileSync('git', ['-C', repoRoot, ...args], {
    encoding: 'utf-8',
    timeout: 15_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function tryGit(repoRoot: string, args: string[]): { ok: true; out: string } | { ok: false; err: string } {
  try {
    return { ok: true, out: git(repoRoot, args) };
  } catch (e) {
    const err = e instanceof Error ? ((e as { stderr?: Buffer }).stderr?.toString() || e.message) : String(e);
    return { ok: false, err: err.trim() };
  }
}

/** Resolve the top-level dir of the git repo containing `dir`, or null if none. */
export function resolveRepoRoot(dir: string): string | null {
  const r = tryGit(dir, ['rev-parse', '--show-toplevel']);
  return r.ok && r.out ? r.out : null;
}

function sessionShort(sessionId: string): string {
  return crypto.createHash('sha1').update(sessionId).digest('hex').slice(0, 12);
}

function ensureDataDir(): void {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
}

function loadMap(): WorktreeRecord[] {
  try {
    return JSON.parse(fs.readFileSync(MAP_PATH, 'utf-8')) as WorktreeRecord[];
  } catch {
    return [];
  }
}

function saveMap(records: WorktreeRecord[]): void {
  ensureDataDir();
  const tmp = MAP_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(records, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, MAP_PATH);
}

function dirSizeMb(dir: string): number {
  try {
    const out = execFileSync('du', ['-sk', dir], { encoding: 'utf-8', timeout: 15_000 });
    const kb = Number(out.split('\t')[0] || out.trim().split(/\s+/)[0]);
    return Number.isFinite(kb) ? kb / 1024 : 0;
  } catch {
    return 0;
  }
}

function worktreeRootFor(repoRoot: string): string {
  return process.env.CTI_WORKTREE_ROOT || path.join(path.dirname(repoRoot), '.cti-worktrees');
}

/** Physically remove a worktree + its branch, ignoring individual failures. */
function destroyWorktree(rec: WorktreeRecord): void {
  tryGit(rec.repoRoot, ['worktree', 'remove', '--force', rec.path]);
  if (fs.existsSync(rec.path)) {
    try { fs.rmSync(rec.path, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  tryGit(rec.repoRoot, ['branch', '-D', rec.branch]);
  tryGit(rec.repoRoot, ['worktree', 'prune']);
}

// ── per-session in-process mutex (serialize concurrent ensure for one session) ──
const inflight = new Map<string, Promise<EnsureWorktreeOutcome>>();

/**
 * Ensure an isolated worktree exists for `sessionId` rooted in the repo that
 * contains `baseDir`. Reuses the existing worktree on resume. Returns an error
 * outcome (surfaced to the IM user) when `baseDir` is not a git repo or quota
 * is exhausted.
 */
export function ensureWorktree(sessionId: string, baseDir?: string): Promise<EnsureWorktreeOutcome> {
  const existing = inflight.get(sessionId);
  if (existing) return existing;
  const p = ensureWorktreeInner(sessionId, baseDir).finally(() => inflight.delete(sessionId));
  inflight.set(sessionId, p);
  return p;
}

async function ensureWorktreeInner(sessionId: string, baseDir?: string): Promise<EnsureWorktreeOutcome> {
  const base = baseDir && baseDir.trim() ? baseDir : process.cwd();

  if (!isolationEnabled()) {
    return { ok: true, cwd: base, branch: null, repoRoot: base, isolated: false };
  }

  const repoRoot = resolveRepoRoot(base);
  if (!repoRoot) {
    return {
      ok: false,
      error:
        `Working directory "${base}" is not a git repository. ` +
        `Worktree isolation requires a git repo — set CTI_DEFAULT_WORKDIR to one, ` +
        `or set CTI_WORKTREE_ISOLATION=false to opt out (not recommended).`,
    };
  }

  const records = loadMap();

  // Reuse on resume.
  const idx = records.findIndex((r) => r.sessionId === sessionId);
  if (idx !== -1) {
    const rec = records[idx];
    if (fs.existsSync(rec.path) && resolveRepoRoot(rec.path) === rec.path) {
      rec.lastUsedAt = Date.now();
      saveMap(records);
      return { ok: true, cwd: rec.path, branch: rec.branch, repoRoot: rec.repoRoot, isolated: true };
    }
    // Stale record (worktree was removed out-of-band) — drop and recreate.
    records.splice(idx, 1);
  }

  // GC before creating, so quota checks see a fresh picture.
  const afterGc = garbageCollectRecords(records, sessionId);

  if (afterGc.length >= maxCount()) {
    return {
      ok: false,
      error:
        `Worktree limit reached (${afterGc.length}/${maxCount()}). ` +
        `Finish or clean up existing sessions before starting a new one.`,
    };
  }

  const short = sessionShort(sessionId);
  const repoName = path.basename(repoRoot);
  const wtRoot = worktreeRootFor(repoRoot);
  const wtPath = path.join(wtRoot, `${repoName}-${short}`);
  const branch = `cti/${short}`;

  fs.mkdirSync(wtRoot, { recursive: true, mode: 0o700 });

  // If the branch already exists (prior session reusing the same short), attach
  // to it; otherwise create it fresh from HEAD.
  const branchExists = tryGit(repoRoot, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).ok;
  const add = branchExists
    ? tryGit(repoRoot, ['worktree', 'add', wtPath, branch])
    : tryGit(repoRoot, ['worktree', 'add', '-b', branch, wtPath, 'HEAD']);

  if (!add.ok) {
    return { ok: false, error: `Failed to create worktree: ${add.err}` };
  }

  const rec: WorktreeRecord = {
    sessionId,
    repoRoot,
    path: wtPath,
    branch,
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
  };
  afterGc.push(rec);
  saveMap(afterGc);

  return { ok: true, cwd: wtPath, branch, repoRoot, isolated: true };
}

/**
 * Drop records that are over TTL / over count / over disk, destroying their
 * worktrees. Never touches `keepSessionId`. Returns the surviving records
 * (also persisted).
 */
function garbageCollectRecords(records: WorktreeRecord[], keepSessionId?: string): WorktreeRecord[] {
  const now = Date.now();
  const ttl = ttlMs();
  const survivors: WorktreeRecord[] = [];
  const doomed: WorktreeRecord[] = [];

  for (const rec of records) {
    if (rec.sessionId !== keepSessionId && now - rec.lastUsedAt > ttl) doomed.push(rec);
    else survivors.push(rec);
  }

  // Count cap: GC oldest survivors (excluding keep) until under the limit.
  survivors.sort((a, b) => a.lastUsedAt - b.lastUsedAt);
  while (survivors.length > maxCount()) {
    const victimIdx = survivors.findIndex((r) => r.sessionId !== keepSessionId);
    if (victimIdx === -1) break;
    doomed.push(survivors.splice(victimIdx, 1)[0]);
  }

  // Disk cap: if the worktree root is too large, GC oldest until under (best effort).
  if (survivors.length > 0) {
    const root = worktreeRootFor(survivors[0].repoRoot);
    if (fs.existsSync(root) && dirSizeMb(root) > maxDiskMb()) {
      while (survivors.length > 1 && dirSizeMb(root) > maxDiskMb()) {
        const victimIdx = survivors.findIndex((r) => r.sessionId !== keepSessionId);
        if (victimIdx === -1) break;
        doomed.push(survivors.splice(victimIdx, 1)[0]);
      }
    }
  }

  for (const rec of doomed) destroyWorktree(rec);
  if (doomed.length > 0) saveMap(survivors);
  return survivors;
}

/** Remove the worktree for a finished session (stream-close / unbind hook). */
export function cleanupSession(sessionId: string): void {
  const records = loadMap();
  const idx = records.findIndex((r) => r.sessionId === sessionId);
  if (idx === -1) return;
  destroyWorktree(records[idx]);
  records.splice(idx, 1);
  saveMap(records);
}

/** Run TTL/quota GC over all known worktrees (daemon startup hook). */
export function startupGc(): void {
  const records = loadMap();
  if (records.length === 0) return;
  garbageCollectRecords(records);
}

// ── reinforcement system-prompt rendering ──

const DEFAULT_ISOLATED_TEMPLATE =
  'You are already running inside an isolated git worktree at {{path}} on branch ' +
  '"{{branch}}". All of your file edits MUST stay inside this worktree — never edit ' +
  'files in the main checkout or any other worktree. When your work is complete, ' +
  'commit on this branch and open a pull request; do not merge to the main branch yourself.';

const DEFAULT_FALLBACK_TEMPLATE =
  'Before editing any files, set up an isolated workspace. Check whether you are ' +
  'already in a worktree (compare `git rev-parse --git-dir` with `--git-common-dir`). ' +
  'If not, create one with `git worktree add .worktrees/<feature-branch> -b ' +
  '<feature-branch>` and do all your work there. Never edit files in the main ' +
  'checkout. Open a PR from your branch when done.';

/**
 * Build the system-prompt reinforcement appended to each session. When the
 * session is isolated, it states the worktree facts; otherwise it instructs the
 * agent to create its own. A custom CTI_SESSION_INSTRUCTIONS overrides the
 * isolated template ({{path}}/{{branch}} are interpolated).
 */
export function renderSessionInstructions(
  outcome: { isolated: boolean; cwd: string; branch: string | null },
  customTemplate?: string,
): string {
  if (!outcome.isolated) return DEFAULT_FALLBACK_TEMPLATE;
  const template = customTemplate && customTemplate.trim() ? customTemplate : DEFAULT_ISOLATED_TEMPLATE;
  return template
    .split('{{path}}').join(outcome.cwd)
    .split('{{branch}}').join(outcome.branch ?? '');
}
