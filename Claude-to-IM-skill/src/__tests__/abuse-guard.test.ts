/**
 * @file abuse-guard.test.ts
 * @description Unit tests for the abuse controls: concurrency gate acquire/release
 *   limit and the per-key token-bucket rate limiter (including time-based refill).
 * @status New (harden/worktree-isolation).
 * @issues none known.
 * @todo none.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ConcurrencyGate, RateLimiter } from '../abuse-guard.js';

test('ConcurrencyGate blocks past the limit and recovers on release', () => {
  const gate = new ConcurrencyGate(() => 2);
  assert.equal(gate.tryAcquire(), true);
  assert.equal(gate.tryAcquire(), true);
  assert.equal(gate.tryAcquire(), false, 'third acquire blocked at limit 2');
  gate.release();
  assert.equal(gate.tryAcquire(), true, 'slot freed after release');
});

test('RateLimiter allows up to perMin then blocks within the window', () => {
  let now = 1_000_000;
  const rl = new RateLimiter(() => 3, () => now);
  assert.equal(rl.allow('s'), true);
  assert.equal(rl.allow('s'), true);
  assert.equal(rl.allow('s'), true);
  assert.equal(rl.allow('s'), false, 'fourth request in window blocked');
});

test('RateLimiter refills over time', () => {
  let now = 0;
  const rl = new RateLimiter(() => 2, () => now);
  assert.equal(rl.allow('s'), true);
  assert.equal(rl.allow('s'), true);
  assert.equal(rl.allow('s'), false);
  now += 60_000; // a full minute → bucket refilled to cap
  assert.equal(rl.allow('s'), true, 'refilled after a minute');
});

test('RateLimiter buckets are per-key', () => {
  let now = 0;
  const rl = new RateLimiter(() => 1, () => now);
  assert.equal(rl.allow('a'), true);
  assert.equal(rl.allow('a'), false);
  assert.equal(rl.allow('b'), true, 'separate key has its own bucket');
});
