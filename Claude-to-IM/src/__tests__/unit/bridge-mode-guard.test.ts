/**
 * @file bridge-mode-guard.test.ts
 * @description Verifies that `/mode ask` is refused when force-auto is active,
 *   so a user who opted into auto-approve cannot strand themselves behind
 *   per-tool prompts, while `/mode plan` and invalid input behave normally.
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { initBridgeContext } from '../../lib/bridge/context';
import type { BridgeContext } from '../../lib/bridge/context';
import { commandSessionMgmt } from '../../lib/bridge/bridge-manager';
import type { InboundMessage } from '../../lib/bridge/types';

function initContext(forceAuto: boolean): void {
  const ctx = {
    store: {
      getSetting: (k: string) => (k === 'bridge_force_auto' ? (forceAuto ? 'true' : 'false') : null),
    },
    llm: {},
    permissions: { resolvePendingPermission: () => false },
    lifecycle: {},
  } as unknown as BridgeContext;
  initBridgeContext(ctx);
}

const msg = { address: { channelType: 'telegram', chatId: '1', userId: '1' } } as unknown as InboundMessage;

describe('bridge /mode guard under force-auto', () => {
  beforeEach(() => initContext(true));

  it('refuses /mode ask when force-auto is active', () => {
    const res = commandSessionMgmt('/mode', msg, 'ask');
    assert.ok(res, 'returns a response');
    assert.match(res!, /ask/i);
    assert.match(res!, /disabled|staying in/i);
    assert.doesNotMatch(res!, /^Mode set to/);
  });

  it('rejects invalid mode values regardless', () => {
    const res = commandSessionMgmt('/mode', msg, 'bogus');
    assert.match(res!, /Usage: \/mode/);
  });

  it('returns null for commands it does not handle', () => {
    assert.equal(commandSessionMgmt('/status', msg, ''), null);
  });
});
