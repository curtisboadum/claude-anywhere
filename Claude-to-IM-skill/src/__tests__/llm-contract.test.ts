/**
 * @file llm-contract.test.ts
 * @description SDK contract checks for the Claude provider: the appended system
 *   prompt has the preset+append shape the Claude Agent SDK expects, and it
 *   carries the worktree reinforcement text. Guards against silent SDK drift.
 * @status New (harden/worktree-isolation).
 * @issues none known.
 * @todo none.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildAppendedSystemPrompt } from '../llm-provider.js';
import { renderSessionInstructions } from '../worktree-manager.js';

test('buildAppendedSystemPrompt returns the SDK preset+append shape', () => {
  const sp = buildAppendedSystemPrompt('STAY IN THE WORKTREE');
  // Must be the object form (not a bare string) so Claude Code's own prompt is preserved.
  assert.equal(typeof sp, 'object');
  assert.equal((sp as { type: string }).type, 'preset');
  assert.equal((sp as { preset: string }).preset, 'claude_code');
  assert.equal((sp as { append: string }).append, 'STAY IN THE WORKTREE');
});

test('appended prompt carries the worktree facts for an isolated session', () => {
  const append = renderSessionInstructions({ isolated: true, cwd: '/wt/repo-abc', branch: 'cti/abc' });
  const sp = buildAppendedSystemPrompt(append) as { append: string };
  assert.match(sp.append, /\/wt\/repo-abc/);
  assert.match(sp.append, /cti\/abc/);
});
