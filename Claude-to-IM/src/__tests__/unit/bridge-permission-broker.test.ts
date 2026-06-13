/**
 * @file bridge-permission-broker.test.ts
 * @description Unit tests for the permission broker callback handling: action
 *   parsing, chat/message validation, dedup, same-user binding, and expiry.
 * @status Modified (harden/worktree-isolation): same-user + expiry tests.
 * @issues none known.
 * @todo none.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { initBridgeContext } from '../../lib/bridge/context';
import { handlePermissionCallback } from '../../lib/bridge/permission-broker';
import type { BridgeStore, PermissionGateway, PermissionResolution } from '../../lib/bridge/host';

// ── Mock Store ──────────────────────────────────────────────

function createMockStore() {
  const links = new Map<string, { chatId: string; messageId: string; resolved: boolean; suggestions: string; userId?: string; createdAt?: string }>();

  return {
    links,
    getSetting: () => null,
    getChannelBinding: () => null,
    upsertChannelBinding: () => ({} as any),
    updateChannelBinding: () => {},
    listChannelBindings: () => [],
    getSession: () => null,
    createSession: () => ({ id: '1', working_directory: '', model: '' }),
    updateSessionProviderId: () => {},
    addMessage: () => {},
    getMessages: () => ({ messages: [] }),
    acquireSessionLock: () => true,
    renewSessionLock: () => {},
    releaseSessionLock: () => {},
    setSessionRuntimeStatus: () => {},
    updateSdkSessionId: () => {},
    updateSessionModel: () => {},
    syncSdkTasks: () => {},
    getProvider: () => undefined,
    getDefaultProviderId: () => null,
    insertAuditLog: () => {},
    checkDedup: () => false,
    insertDedup: () => {},
    cleanupExpiredDedup: () => {},
    insertOutboundRef: () => {},
    insertPermissionLink: () => {},
    getPermissionLink: (id: string) => {
      return links.get(id) ?? null;
    },
    markPermissionLinkResolved: (id: string) => {
      const link = links.get(id);
      if (!link || link.resolved) return false;
      link.resolved = true;
      return true;
    },
    listPendingPermissionLinksByChat: (chatId: string) => {
      return [...links.values()].filter(l => l.chatId === chatId && !l.resolved);
    },
    getChannelOffset: () => '0',
    setChannelOffset: () => {},
  };
}

// ── Mock Permission Gateway ─────────────────────────────────

function createMockGateway() {
  const resolved: Array<{ id: string; resolution: PermissionResolution }> = [];
  return {
    resolved,
    resolvePendingPermission(id: string, resolution: PermissionResolution) {
      resolved.push({ id, resolution });
      return true;
    },
  };
}

type MockStore = ReturnType<typeof createMockStore>;
type MockGateway = ReturnType<typeof createMockGateway>;

function setupContext(store: MockStore, gateway: MockGateway) {
  delete (globalThis as Record<string, unknown>)['__bridge_context__'];
  initBridgeContext({
    store: store as unknown as BridgeStore,
    llm: { streamChat: () => new ReadableStream() },
    permissions: gateway,
    lifecycle: {},
  });
}

// ── Tests ───────────────────────────────────────────────────

describe('permission-broker', () => {
  let store: MockStore;
  let gateway: MockGateway;

  beforeEach(() => {
    store = createMockStore();
    gateway = createMockGateway();
    setupContext(store, gateway);
  });

  it('returns false for non-perm callback data', () => {
    assert.equal(handlePermissionCallback('other:data', '123'), false);
  });

  it('returns false when permission link not found', () => {
    assert.equal(handlePermissionCallback('perm:allow:unknown-id', '123'), false);
  });

  it('returns false when chatId does not match', () => {
    store.links.set('perm-1', {
      chatId: '999',
      messageId: 'msg-1',
      resolved: false,
      suggestions: '',
    });

    assert.equal(handlePermissionCallback('perm:allow:perm-1', '123'), false);
  });

  it('returns false when messageId does not match', () => {
    store.links.set('perm-1', {
      chatId: '123',
      messageId: 'msg-1',
      resolved: false,
      suggestions: '',
    });

    assert.equal(handlePermissionCallback('perm:allow:perm-1', '123', 'wrong-msg'), false);
  });

  it('resolves allow action correctly', () => {
    store.links.set('perm-1', {
      chatId: '123',
      messageId: 'msg-1',
      resolved: false,
      suggestions: '',
    });

    const result = handlePermissionCallback('perm:allow:perm-1', '123');
    assert.ok(result);
    assert.equal(gateway.resolved.length, 1);
    assert.equal(gateway.resolved[0].resolution.behavior, 'allow');
  });

  it('resolves deny action correctly', () => {
    store.links.set('perm-2', {
      chatId: '456',
      messageId: 'msg-2',
      resolved: false,
      suggestions: '',
    });

    const result = handlePermissionCallback('perm:deny:perm-2', '456');
    assert.ok(result);
    assert.equal(gateway.resolved[0].resolution.behavior, 'deny');
    assert.equal(gateway.resolved[0].resolution.message, 'Denied via IM bridge');
  });

  it('prevents duplicate resolution', () => {
    store.links.set('perm-3', {
      chatId: '123',
      messageId: 'msg-3',
      resolved: false,
      suggestions: '',
    });

    const first = handlePermissionCallback('perm:allow:perm-3', '123');
    assert.ok(first);

    const second = handlePermissionCallback('perm:allow:perm-3', '123');
    assert.equal(second, false);
    assert.equal(gateway.resolved.length, 1);
  });

  it('handles permId with colons', () => {
    store.links.set('perm:with:colons', {
      chatId: '123',
      messageId: 'msg-4',
      resolved: false,
      suggestions: '',
    });

    const result = handlePermissionCallback('perm:allow:perm:with:colons', '123');
    assert.ok(result);
    assert.equal(gateway.resolved[0].id, 'perm:with:colons');
  });

  it('allow_session passes suggestions as updatedPermissions', () => {
    const suggestions = JSON.stringify([{ type: 'allow', toolName: 'Bash' }]);
    store.links.set('perm-4', {
      chatId: '123',
      messageId: 'msg-5',
      resolved: false,
      suggestions,
    });

    const result = handlePermissionCallback('perm:allow_session:perm-4', '123');
    assert.ok(result);
    assert.equal(gateway.resolved[0].resolution.behavior, 'allow');
    assert.ok((gateway.resolved[0].resolution as any).updatedPermissions);
  });

  // ── Same-user binding (harden/worktree-isolation) ──

  it('rejects a callback from a different user than the requester', () => {
    store.links.set('perm-u', {
      chatId: '123', messageId: 'msg-u', resolved: false, suggestions: '',
      userId: 'alice', createdAt: new Date().toISOString(),
    });
    // bob presses the button on alice's request
    const result = handlePermissionCallback('perm:allow:perm-u', '123', 'msg-u', 'bob');
    assert.equal(result, false);
    assert.equal(gateway.resolved.length, 0, 'must not resolve for a different user');
  });

  it('allows a callback from the requesting user', () => {
    store.links.set('perm-u2', {
      chatId: '123', messageId: 'msg-u2', resolved: false, suggestions: '',
      userId: 'alice', createdAt: new Date().toISOString(),
    });
    const result = handlePermissionCallback('perm:allow:perm-u2', '123', 'msg-u2', 'alice');
    assert.ok(result);
    assert.equal(gateway.resolved[0].resolution.behavior, 'allow');
  });

  // ── Expiry (harden/worktree-isolation) ──

  it('rejects a callback for an expired permission link', () => {
    const old = new Date(Date.now() - 3_600_000).toISOString(); // 1h ago, past default 600s TTL
    store.links.set('perm-x', {
      chatId: '123', messageId: 'msg-x', resolved: false, suggestions: '',
      userId: 'alice', createdAt: old,
    });
    const result = handlePermissionCallback('perm:allow:perm-x', '123', 'msg-x', 'alice');
    assert.equal(result, false);
    assert.equal(gateway.resolved.length, 0, 'expired link must not resolve');
  });
});
