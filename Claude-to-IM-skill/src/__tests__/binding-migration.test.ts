/**
 * @file binding-migration.test.ts
 * @description Verifies the startup migration only resets `ask` bindings to
 *   `code` under force-auto, and never touches state when force-auto is off.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { migrateStrandedBindings, type BindingMigrationStore } from '../binding-migration.js';

function makeStore(modes: Array<'code' | 'plan' | 'ask'>): {
  store: BindingMigrationStore;
  updates: Array<{ id: string; mode: string }>;
  bindings: Array<{ id: string; mode: 'code' | 'plan' | 'ask' }>;
} {
  const bindings = modes.map((mode, i) => ({ id: `b${i}`, mode }));
  const updates: Array<{ id: string; mode: string }> = [];
  const store: BindingMigrationStore = {
    listChannelBindings: () => bindings,
    updateChannelBinding: (id, u) => {
      updates.push({ id, mode: u.mode });
      const b = bindings.find((x) => x.id === id);
      if (b) b.mode = u.mode;
    },
  };
  return { store, updates, bindings };
}

describe('migrateStrandedBindings', () => {
  it('resets ask bindings to code under force-auto', () => {
    const { store, updates } = makeStore(['ask', 'code', 'ask', 'plan']);
    const n = migrateStrandedBindings(store, { autoApprove: true, autoApproveAck: true });
    assert.equal(n, 2, 'two ask bindings migrated');
    assert.deepEqual(updates, [
      { id: 'b0', mode: 'code' },
      { id: 'b2', mode: 'code' },
    ]);
  });

  it('does nothing when auto-approve is not acknowledged', () => {
    const { store, updates } = makeStore(['ask', 'ask']);
    const n = migrateStrandedBindings(store, { autoApprove: true, autoApproveAck: false });
    assert.equal(n, 0);
    assert.equal(updates.length, 0, 'no bindings touched without ack');
  });

  it('does nothing when auto-approve is off', () => {
    const { store, updates } = makeStore(['ask']);
    const n = migrateStrandedBindings(store, { autoApprove: false, autoApproveAck: true });
    assert.equal(n, 0);
    assert.equal(updates.length, 0);
  });

  it('leaves plan and code bindings untouched', () => {
    const { store, updates } = makeStore(['code', 'plan']);
    const n = migrateStrandedBindings(store, { autoApprove: true, autoApproveAck: true });
    assert.equal(n, 0);
    assert.equal(updates.length, 0);
  });
});
