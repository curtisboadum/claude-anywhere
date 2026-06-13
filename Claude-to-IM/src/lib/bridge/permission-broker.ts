/**
 * @file permission-broker.ts
 * @description Forwards Claude permission requests to IM channels and resolves the
 *   user's button/text response. Binds each callback to the requesting chat,
 *   message, AND user, with an expiry window and atomic single-claim — so a
 *   different (even allowlisted) user cannot approve another user's request, and
 *   stale/replayed callbacks are rejected.
 * @status Modified (harden/worktree-isolation): same-user binding + expiry.
 * @issues none known.
 * @todo none.
 *
 * When Claude needs tool approval, the broker formats a prompt with inline
 * buttons, records a permission link, and resolves it when a callback arrives.
 */

import type { PermissionUpdate } from '@anthropic-ai/claude-agent-sdk';
import type { ChannelAddress, OutboundMessage } from './types.js';
import type { BaseChannelAdapter } from './channel-adapter.js';
import { deliver } from './delivery-layer.js';
import { getBridgeContext } from './context.js';
import { escapeHtml } from './adapters/telegram-utils.js';

/**
 * Dedup recent permission forwards to prevent duplicate cards.
 * Key: permissionRequestId, value: timestamp. Entries expire after 30s.
 */
const recentPermissionForwards = new Map<string, number>();

/**
 * Forward a permission request to an IM channel as an interactive message.
 */
export async function forwardPermissionRequest(
  adapter: BaseChannelAdapter,
  address: ChannelAddress,
  permissionRequestId: string,
  toolName: string,
  toolInput: Record<string, unknown>,
  sessionId?: string,
  suggestions?: unknown[],
  replyToMessageId?: string,
): Promise<void> {
  const { store } = getBridgeContext();

  // Dedup: prevent duplicate forwarding of the same permission request
  const now = Date.now();
  if (recentPermissionForwards.has(permissionRequestId)) {
    console.warn(`[permission-broker] Duplicate forward suppressed for ${permissionRequestId}`);
    return;
  }
  recentPermissionForwards.set(permissionRequestId, now);
  // Clean up old entries
  for (const [id, ts] of recentPermissionForwards) {
    if (now - ts > 30_000) recentPermissionForwards.delete(id);
  }

  console.log(`[permission-broker] Forwarding permission request: ${permissionRequestId} tool=${toolName} channel=${adapter.channelType}`);

  // Format the input summary (truncated)
  const inputStr = JSON.stringify(toolInput, null, 2);
  const truncatedInput = inputStr.length > 300
    ? inputStr.slice(0, 300) + '...'
    : inputStr;

  let result: import('./types.js').SendResult;

  if (adapter.channelType === 'qq' || adapter.channelType === 'weixin') {
    const channelLabel = adapter.channelType === 'weixin' ? 'WeChat' : 'QQ';
    // QQ / WeChat: plain text permission prompt with copyable /perm commands (no inline buttons)
    const plainText = [
      `Permission Required`,
      ``,
      `Tool: ${toolName}`,
      truncatedInput,
      ``,
      `Reply:`,
      `1 - Allow once`,
      `2 - Allow session`,
      `3 - Deny`,
      ``,
      `Or use full command:`,
      `/perm allow ${permissionRequestId}`,
      `/perm allow_session ${permissionRequestId}`,
      `/perm deny ${permissionRequestId}`,
    ].join('\n');

    const plainMessage: OutboundMessage = {
      address,
      text: plainText,
      parseMode: 'plain',
      replyToMessageId,
    };

    result = await deliver(adapter, plainMessage, { sessionId });
    console.log(
      `[permission-broker] Sent plain-text permission prompt for ${channelLabel}: ${permissionRequestId}`,
    );
  } else {
    const text = [
      `<b>Permission Required</b>`,
      ``,
      `Tool: <code>${escapeHtml(toolName)}</code>`,
      `<pre>${escapeHtml(truncatedInput)}</pre>`,
      ``,
      `Choose an action:`,
    ].join('\n');

    const message: OutboundMessage = {
      address,
      text,
      parseMode: 'HTML',
      inlineButtons: [
        [
          { text: 'Allow', callbackData: `perm:allow:${permissionRequestId}` },
          { text: 'Allow Session', callbackData: `perm:allow_session:${permissionRequestId}` },
          { text: 'Deny', callbackData: `perm:deny:${permissionRequestId}` },
        ],
      ],
      replyToMessageId,
    };

    result = await deliver(adapter, message, { sessionId });
  }

  // Record the link so we can match callback queries back to this permission
  if (result.ok && result.messageId) {
    try {
      store.insertPermissionLink({
        permissionRequestId,
        channelType: adapter.channelType,
        chatId: address.chatId,
        messageId: result.messageId,
        toolName,
        suggestions: suggestions ? JSON.stringify(suggestions) : '',
        userId: address.userId,
      });
    } catch { /* best effort */ }
  }
}

/**
 * Handle a permission callback from an inline button press.
 * Validates that the callback came from the same chat AND same message that
 * received the permission request, prevents duplicate resolution via atomic
 * DB check-and-set, and implements real allow_session semantics by passing
 * updatedPermissions (suggestions).
 *
 * Returns true if the callback was recognized and handled.
 */
export function handlePermissionCallback(
  callbackData: string,
  callbackChatId: string,
  callbackMessageId?: string,
  callbackUserId?: string,
): boolean {
  const { store, permissions } = getBridgeContext();

  // Parse callback data: perm:action:permId
  const parts = callbackData.split(':');
  if (parts.length < 3 || parts[0] !== 'perm') return false;

  const action = parts[1];
  const permissionRequestId = parts.slice(2).join(':'); // permId might contain colons

  // Look up the permission link to validate origin and check dedup
  const link = store.getPermissionLink(permissionRequestId);
  if (!link) {
    console.warn(`[permission-broker] No permission link found for ${permissionRequestId}`);
    return false;
  }

  // Security: verify the callback came from the same chat that received the request
  if (link.chatId !== callbackChatId) {
    console.warn(`[permission-broker] Chat ID mismatch: expected ${link.chatId}, got ${callbackChatId}`);
    return false;
  }

  // Security: verify the callback came from the original permission message
  if (callbackMessageId && link.messageId !== callbackMessageId) {
    console.warn(`[permission-broker] Message ID mismatch: expected ${link.messageId}, got ${callbackMessageId}`);
    return false;
  }

  // Security: same-user binding — only the user who triggered the request may
  // resolve it (closes the group-chat hole where any allowlisted member could
  // approve another member's tool use).
  if (link.userId && callbackUserId && link.userId !== callbackUserId) {
    console.warn(`[permission-broker] User mismatch: request by ${link.userId}, callback from ${callbackUserId}`);
    return false;
  }

  // Security: expire stale callbacks (replay / late clicks on old cards).
  if (link.createdAt && isExpired(link.createdAt)) {
    console.warn(`[permission-broker] Permission ${permissionRequestId} expired`);
    return false;
  }

  // Dedup: reject if already resolved (fast path before expensive resolution)
  if (link.resolved) {
    console.warn(`[permission-broker] Permission ${permissionRequestId} already resolved`);
    return false;
  }

  // Atomically mark as resolved BEFORE calling resolvePendingPermission
  // to prevent race conditions with concurrent button clicks
  let claimed: boolean;
  try {
    claimed = store.markPermissionLinkResolved(permissionRequestId);
  } catch {
    return false;
  }

  if (!claimed) {
    // Another concurrent handler already resolved this permission
    console.warn(`[permission-broker] Permission ${permissionRequestId} already claimed by concurrent handler`);
    return false;
  }

  return applyPermissionAction(action, permissionRequestId, link, permissions);
}

/** Default callback expiry window (seconds); override with CTI_PERM_TTL_SEC. */
function permTtlMs(): number {
  const n = Number(process.env.CTI_PERM_TTL_SEC);
  return (Number.isFinite(n) && n > 0 ? n : 600) * 1000;
}

/** True if an ISO `createdAt` is older than the permission TTL. */
function isExpired(createdAt: string): boolean {
  const t = Date.parse(createdAt);
  if (Number.isNaN(t)) return false;
  return Date.now() - t > permTtlMs();
}

/** Resolve a claimed permission link according to the chosen action. */
function applyPermissionAction(
  action: string,
  permissionRequestId: string,
  link: import('./host.js').PermissionLinkRecord,
  permissions: ReturnType<typeof getBridgeContext>['permissions'],
): boolean {
  switch (action) {
    case 'allow':
      return permissions.resolvePendingPermission(permissionRequestId, { behavior: 'allow' });

    case 'allow_session': {
      // Parse stored suggestions so subsequent same-tool calls auto-approve
      let updatedPermissions: PermissionUpdate[] | undefined;
      if (link.suggestions) {
        try {
          updatedPermissions = JSON.parse(link.suggestions) as PermissionUpdate[];
        } catch { /* fall through without updatedPermissions */ }
      }
      return permissions.resolvePendingPermission(permissionRequestId, {
        behavior: 'allow',
        ...(updatedPermissions ? { updatedPermissions } : {}),
      });
    }

    case 'deny':
      return permissions.resolvePendingPermission(permissionRequestId, {
        behavior: 'deny',
        message: 'Denied via IM bridge',
      });

    default:
      return false;
  }
}
