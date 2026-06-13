/**
 * @file bridge-manager.ts
 * @description Singleton orchestrator for the multi-IM bridge system. Manages
 *   adapter lifecycles, routes inbound messages through the conversation engine,
 *   dispatches slash commands, and coordinates permission handling. Uses
 *   globalThis to survive Next.js HMR in development.
 * @status Modified (fix/bridge-auto-slash-callbacks): pass approver userId into
 *   the permission callback; refuse `/mode ask` under force-auto; extracted the
 *   message/command handlers into sub-functions to satisfy the length gate.
 * @issues none known.
 * @todo none.
 */

import type { BridgeStatus, InboundMessage, OutboundMessage, StreamingPreviewState, ToolCallInfo } from './types.js';
import { createAdapter, getRegisteredTypes } from './channel-adapter.js';
import type { BaseChannelAdapter } from './channel-adapter.js';
// Side-effect import: triggers self-registration of all adapter factories
import './adapters/index.js';
import * as router from './channel-router.js';
import * as engine from './conversation-engine.js';
import * as broker from './permission-broker.js';
import { deliver, deliverRendered } from './delivery-layer.js';
import { markdownToTelegramChunks } from './markdown/telegram.js';
import { markdownToDiscordChunks } from './markdown/discord.js';
import { getBridgeContext } from './context.js';
import { escapeHtml } from './adapters/telegram-utils.js';
import {
  validateWorkingDirectory,
  validateSessionId,
  isDangerousInput,
  sanitizeInput,
  validateMode,
} from './security/validators.js';

const GLOBAL_KEY = '__bridge_manager__';

// ── Streaming preview helpers ──────────────────────────────────

/** Generate a non-zero random 31-bit integer for use as draft_id. */
function generateDraftId(): number {
  return (Math.floor(Math.random() * 0x7FFFFFFE) + 1); // 1 .. 2^31-1
}

interface StreamConfig {
  intervalMs: number;
  minDeltaChars: number;
  maxChars: number;
}

/** Default stream config per channel type. */
const STREAM_DEFAULTS: Record<string, StreamConfig> = {
  telegram: { intervalMs: 700, minDeltaChars: 20, maxChars: 3900 },
  discord: { intervalMs: 1500, minDeltaChars: 40, maxChars: 1900 },
};

function getStreamConfig(channelType = 'telegram'): StreamConfig {
  const { store } = getBridgeContext();
  const defaults = STREAM_DEFAULTS[channelType] || STREAM_DEFAULTS.telegram;
  const prefix = `bridge_${channelType}_stream_`;
  const intervalMs = parseInt(store.getSetting(`${prefix}interval_ms`) || '', 10) || defaults.intervalMs;
  const minDeltaChars = parseInt(store.getSetting(`${prefix}min_delta_chars`) || '', 10) || defaults.minDeltaChars;
  const maxChars = parseInt(store.getSetting(`${prefix}max_chars`) || '', 10) || defaults.maxChars;
  return { intervalMs, minDeltaChars, maxChars };
}

/**
 * Check if a message looks like a numeric permission shortcut (1/2/3) for
 * feishu/qq channels WITH at least one pending permission in that chat.
 *
 * This is used by the adapter loop to route these messages to the inline
 * (non-session-locked) path, avoiding deadlock: the session is blocked
 * waiting for the permission to be resolved, so putting "1" behind the
 * session lock would deadlock.
 */
function isNumericPermissionShortcut(channelType: string, rawText: string, chatId: string): boolean {
  if (channelType !== 'feishu' && channelType !== 'qq' && channelType !== 'weixin') return false;
  const normalized = rawText.normalize('NFKC').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
  if (!/^[123]$/.test(normalized)) return false;
  const { store } = getBridgeContext();
  const pending = store.listPendingPermissionLinksByChat(chatId);
  return pending.length > 0; // any pending → route to inline path
}

/** Fire-and-forget: send a preview draft. Only degrades on permanent failure. */
function flushPreview(
  adapter: BaseChannelAdapter,
  state: StreamingPreviewState,
  config: StreamConfig,
): void {
  if (state.degraded || !adapter.sendPreview) return;

  const text = state.pendingText.length > config.maxChars
    ? state.pendingText.slice(0, config.maxChars) + '...'
    : state.pendingText;

  state.lastSentText = text;
  state.lastSentAt = Date.now();

  adapter.sendPreview(state.chatId, text, state.draftId).then(result => {
    if (result === 'degrade') state.degraded = true;
    // 'skip' — transient failure, next flush will retry naturally
  }).catch(() => {
    // Network error — transient, don't degrade
  });
}

// ── Channel-aware rendering dispatch ──────────────────────────

import type { ChannelAddress, SendResult } from './types.js';

/**
 * Render response text and deliver via the appropriate channel format.
 * Telegram: Markdown → HTML chunks via deliverRendered.
 * Other channels: plain text via deliver (no HTML).
 */
async function deliverResponse(
  adapter: BaseChannelAdapter,
  address: ChannelAddress,
  responseText: string,
  sessionId: string,
  replyToMessageId?: string,
): Promise<SendResult> {
  if (adapter.channelType === 'telegram') {
    const chunks = markdownToTelegramChunks(responseText, 4096);
    if (chunks.length > 0) {
      return deliverRendered(adapter, address, chunks, { sessionId, replyToMessageId });
    }
    return { ok: true };
  }
  if (adapter.channelType === 'discord') {
    // Discord: native markdown, chunk at 2000 chars with fence repair
    const chunks = markdownToDiscordChunks(responseText, 2000);
    for (let i = 0; i < chunks.length; i++) {
      const result = await deliver(adapter, {
        address,
        text: chunks[i].text,
        parseMode: 'Markdown',
        replyToMessageId,
      }, { sessionId });
      if (!result.ok) return result;
    }
    return { ok: true };
  }
  if (adapter.channelType === 'feishu') {
    // Feishu: pass markdown through for adapter to format as post/card
    return deliver(adapter, {
      address,
      text: responseText,
      parseMode: 'Markdown',
      replyToMessageId,
    }, { sessionId });
  }
  // Generic fallback: deliver as plain text (deliver() handles chunking internally)
  return deliver(adapter, {
    address,
    text: responseText,
    parseMode: 'plain',
    replyToMessageId,
  }, { sessionId });
}

interface AdapterMeta {
  lastMessageAt: string | null;
  lastError: string | null;
}

interface BridgeManagerState {
  adapters: Map<string, BaseChannelAdapter>;
  adapterMeta: Map<string, AdapterMeta>;
  running: boolean;
  startedAt: string | null;
  loopAborts: Map<string, AbortController>;
  activeTasks: Map<string, AbortController>;
  /** Per-session processing chains for concurrency control */
  sessionLocks: Map<string, Promise<void>>;
  autoStartChecked: boolean;
}

function getState(): BridgeManagerState {
  const g = globalThis as unknown as Record<string, BridgeManagerState>;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = {
      adapters: new Map(),
      adapterMeta: new Map(),
      running: false,
      startedAt: null,
      loopAborts: new Map(),
      activeTasks: new Map(),
      sessionLocks: new Map(),
      autoStartChecked: false,
    };
  }
  // Backfill sessionLocks for states created before this field existed
  if (!g[GLOBAL_KEY].sessionLocks) {
    g[GLOBAL_KEY].sessionLocks = new Map();
  }
  return g[GLOBAL_KEY];
}

/**
 * Process a function with per-session serialization.
 * Different sessions run concurrently; same-session requests are serialized.
 */
function processWithSessionLock(sessionId: string, fn: () => Promise<void>): Promise<void> {
  const state = getState();
  const prev = state.sessionLocks.get(sessionId) || Promise.resolve();
  const current = prev.then(fn, fn);
  state.sessionLocks.set(sessionId, current);
  // Cleanup when the chain completes.
  // Suppress rejection on the cleanup chain — callers handle errors on `current` directly.
  current.finally(() => {
    if (state.sessionLocks.get(sessionId) === current) {
      state.sessionLocks.delete(sessionId);
    }
  }).catch(() => {});
  return current;
}

/**
 * Start the bridge system.
 * Checks feature flags, registers enabled adapters, starts polling loops.
 */
export async function start(): Promise<void> {
  const state = getState();
  if (state.running) return;

  const { store, lifecycle } = getBridgeContext();

  const bridgeEnabled = store.getSetting('remote_bridge_enabled') === 'true';
  if (!bridgeEnabled) {
    console.log('[bridge-manager] Bridge not enabled (remote_bridge_enabled != true)');
    return;
  }

  // Iterate all registered adapter types and create those that are enabled
  for (const channelType of getRegisteredTypes()) {
    const settingKey = `bridge_${channelType}_enabled`;
    if (store.getSetting(settingKey) !== 'true') continue;

    const adapter = createAdapter(channelType);
    if (!adapter) continue;

    const configError = adapter.validateConfig();
    if (!configError) {
      registerAdapter(adapter);
    } else {
      console.warn(`[bridge-manager] ${channelType} adapter not valid:`, configError);
    }
  }

  // Start all registered adapters, track how many succeeded
  let startedCount = 0;
  for (const [type, adapter] of state.adapters) {
    try {
      await adapter.start();
      console.log(`[bridge-manager] Started adapter: ${type}`);
      startedCount++;
    } catch (err) {
      console.error(`[bridge-manager] Failed to start adapter ${type}:`, err);
    }
  }

  // Only mark as running if at least one adapter started successfully
  if (startedCount === 0) {
    console.warn('[bridge-manager] No adapters started successfully, bridge not activated');
    state.adapters.clear();
    state.adapterMeta.clear();
    return;
  }

  // Mark running BEFORE starting consumer loops — runAdapterLoop checks
  // state.running in its while-condition, so it must be true first.
  state.running = true;
  state.startedAt = new Date().toISOString();

  // Notify host that bridge is starting (e.g., suppress competing polling)
  lifecycle.onBridgeStart?.();

  // Now start the consumer loops (state.running is already true)
  for (const [, adapter] of state.adapters) {
    if (adapter.isRunning()) {
      runAdapterLoop(adapter);
    }
  }

  console.log(`[bridge-manager] Bridge started with ${startedCount} adapter(s)`);
}

/**
 * Stop the bridge system gracefully.
 */
export async function stop(): Promise<void> {
  const state = getState();
  if (!state.running) return;

  const { lifecycle } = getBridgeContext();

  state.running = false;

  // Abort all event loops
  for (const [, abort] of state.loopAborts) {
    abort.abort();
  }
  state.loopAborts.clear();

  // Stop all adapters
  for (const [type, adapter] of state.adapters) {
    try {
      await adapter.stop();
      console.log(`[bridge-manager] Stopped adapter: ${type}`);
    } catch (err) {
      console.error(`[bridge-manager] Error stopping adapter ${type}:`, err);
    }
  }

  state.adapters.clear();
  state.adapterMeta.clear();
  state.startedAt = null;

  // Notify host that bridge stopped
  lifecycle.onBridgeStop?.();

  console.log('[bridge-manager] Bridge stopped');
}

/**
 * Lazy auto-start: checks bridge_auto_start setting once and starts if enabled.
 * Called from POST /api/bridge with action 'auto-start' (triggered by Electron on startup).
 */
export function tryAutoStart(): void {
  const state = getState();
  if (state.autoStartChecked) return;
  state.autoStartChecked = true;

  if (state.running) return;

  const { store } = getBridgeContext();
  const autoStart = store.getSetting('bridge_auto_start');
  if (autoStart !== 'true') return;

  start().catch(err => {
    console.error('[bridge-manager] Auto-start failed:', err);
  });
}

/**
 * Get the current bridge status.
 */
export function getStatus(): BridgeStatus {
  const state = getState();
  return {
    running: state.running,
    startedAt: state.startedAt,
    adapters: Array.from(state.adapters.entries()).map(([type, adapter]) => {
      const meta = state.adapterMeta.get(type);
      return {
        channelType: adapter.channelType,
        running: adapter.isRunning(),
        connectedAt: state.startedAt,
        lastMessageAt: meta?.lastMessageAt ?? null,
        error: meta?.lastError ?? null,
      };
    }),
  };
}

/**
 * Register a channel adapter.
 */
export function registerAdapter(adapter: BaseChannelAdapter): void {
  const state = getState();
  state.adapters.set(adapter.channelType, adapter);
}

/**
 * Run the event loop for a single adapter.
 * Messages for different sessions are dispatched concurrently;
 * messages for the same session are serialized via session locks.
 */
function runAdapterLoop(adapter: BaseChannelAdapter): void {
  const state = getState();
  const abort = new AbortController();
  state.loopAborts.set(adapter.channelType, abort);

  (async () => {
    while (state.running && adapter.isRunning()) {
      try {
        const msg = await adapter.consumeOne();
        if (!msg) continue; // Adapter stopped

        // Callback queries, commands, and numeric permission shortcuts are
        // lightweight — process inline (outside session lock).
        // Regular messages use per-session locking for concurrency.
        //
        // IMPORTANT: numeric shortcuts (1/2/3) for feishu/qq MUST run outside
        // the session lock. The current session is blocked waiting for the
        // permission to be resolved; if "1" enters the session lock queue it
        // deadlocks (permission waits for "1", "1" waits for lock release).
        if (
          msg.callbackData ||
          msg.text.trim().startsWith('/') ||
          isNumericPermissionShortcut(adapter.channelType, msg.text.trim(), msg.address.chatId)
        ) {
          await handleMessage(adapter, msg);
        } else {
          const binding = router.resolve(msg.address);
          // Fire-and-forget into session lock — loop continues to accept
          // messages for other sessions immediately.
          processWithSessionLock(binding.codepilotSessionId, () =>
            handleMessage(adapter, msg),
          ).catch(err => {
            console.error(`[bridge-manager] Session ${binding.codepilotSessionId.slice(0, 8)} error:`, err);
          });
        }
      } catch (err) {
        if (abort.signal.aborted) break;
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(`[bridge-manager] Error in ${adapter.channelType} loop:`, err);
        // Track last error per adapter
        const meta = state.adapterMeta.get(adapter.channelType) || { lastMessageAt: null, lastError: null };
        meta.lastError = errMsg;
        state.adapterMeta.set(adapter.channelType, meta);
        // Brief delay to prevent tight error loops
        await new Promise(r => setTimeout(r, 1000));
      }
    }
  })().catch(err => {
    if (!abort.signal.aborted) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[bridge-manager] ${adapter.channelType} loop crashed:`, err);
      const meta = state.adapterMeta.get(adapter.channelType) || { lastMessageAt: null, lastError: null };
      meta.lastError = errMsg;
      state.adapterMeta.set(adapter.channelType, meta);
    }
  });
}

/**
 * Handle a single inbound message.
 */
async function handleMessage(
  adapter: BaseChannelAdapter,
  msg: InboundMessage,
): Promise<void> {
  const { store } = getBridgeContext();

  // Update lastMessageAt for this adapter
  const adapterState = getState();
  const meta = adapterState.adapterMeta.get(adapter.channelType) || { lastMessageAt: null, lastError: null };
  meta.lastMessageAt = new Date().toISOString();
  adapterState.adapterMeta.set(adapter.channelType, meta);

  // Acknowledge the update offset after processing completes (or fails).
  // This ensures the adapter only advances its committed offset once the
  // message has been fully handled, preventing message loss on crash.
  const ack = () => {
    if (msg.updateId != null && adapter.acknowledgeUpdate) {
      adapter.acknowledgeUpdate(msg.updateId);
    }
  };

  // Handle callback queries (permission buttons)
  if (msg.callbackData) {
    await handlePermissionCallbackMessage(adapter, msg);
    ack();
    return;
  }

  const rawText = msg.text.trim();
  const hasAttachments = !!(msg.attachments && msg.attachments.length > 0);

  // Surface attachment-only download failures instead of silently dropping them.
  if (!rawText && !hasAttachments) {
    await handleEmptyMessage(adapter, msg);
    ack();
    return;
  }

  // Numeric permission shortcut (feishu/qq/weixin). Returns true when consumed.
  if (await tryHandleNumericShortcut(adapter, msg, store, rawText)) {
    ack();
    return;
  }

  // Check for IM commands (before sanitization — commands are validated individually)
  if (rawText.startsWith('/')) {
    await handleCommand(adapter, msg, rawText);
    ack();
    return;
  }

  await routeToConversation(adapter, msg, store, rawText, hasAttachments, ack);
}

/**
 * Resolve a permission inline-button callback. Passes the approver's userId so
 * the broker enforces that only the requester may resolve their own request.
 */
async function handlePermissionCallbackMessage(
  adapter: BaseChannelAdapter,
  msg: InboundMessage,
): Promise<void> {
  const handled = broker.handlePermissionCallback(
    msg.callbackData!,
    msg.address.chatId,
    msg.callbackMessageId,
    msg.address.userId,
  );
  if (handled) {
    await deliver(adapter, {
      address: msg.address,
      text: 'Permission response recorded.',
      parseMode: 'plain',
    });
  }
}

/** Surface attachment-only download failures instead of silently dropping them. */
async function handleEmptyMessage(adapter: BaseChannelAdapter, msg: InboundMessage): Promise<void> {
  const rawData = msg.raw as {
    imageDownloadFailed?: boolean;
    attachmentDownloadFailed?: boolean;
    failedCount?: number;
    failedLabel?: string;
    userVisibleError?: string;
  } | undefined;
  if (rawData?.userVisibleError) {
    await deliver(adapter, {
      address: msg.address,
      text: rawData.userVisibleError,
      parseMode: 'plain',
      replyToMessageId: msg.messageId,
    });
  } else if (rawData?.imageDownloadFailed || rawData?.attachmentDownloadFailed) {
    const failureLabel = rawData.failedLabel || (rawData.imageDownloadFailed ? 'image(s)' : 'attachment(s)');
    await deliver(adapter, {
      address: msg.address,
      text: `Failed to download ${rawData.failedCount ?? 1} ${failureLabel}. Please try sending again.`,
      parseMode: 'plain',
      replyToMessageId: msg.messageId,
    });
  }
}

/**
 * Numeric shortcut for permission replies (feishu/qq/weixin only). On mobile,
 * typing `/perm allow <uuid>` is painful. If the user sends "1", "2", or "3"
 * and there is exactly one pending permission for this chat, map it:
 * 1→allow, 2→allow_session, 3→deny. NFKC normalization folds fullwidth digits
 * and zero-width-joined variants to ASCII. Returns true when consumed.
 */
async function tryHandleNumericShortcut(
  adapter: BaseChannelAdapter,
  msg: InboundMessage,
  store: ReturnType<typeof getBridgeContext>['store'],
  rawText: string,
): Promise<boolean> {
  if (
    adapter.channelType !== 'feishu'
    && adapter.channelType !== 'qq'
    && adapter.channelType !== 'weixin'
  ) {
    return false;
  }
  const normalized = rawText.normalize('NFKC').replace(/[​-‍﻿]/g, '').trim();
  if (!/^[123]$/.test(normalized)) {
    if (rawText !== normalized && /^[123]$/.test(rawText) === false) {
      const codePoints = [...rawText].map(c => 'U+' + c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0'));
      console.log(`[bridge-manager] Shortcut candidate raw codepoints: ${codePoints.join(' ')} → normalized: "${normalized}"`);
    }
    return false;
  }

  const pendingLinks = store.listPendingPermissionLinksByChat(msg.address.chatId);
  if (pendingLinks.length === 1) {
    const actionMap: Record<string, string> = { '1': 'allow', '2': 'allow_session', '3': 'deny' };
    const action = actionMap[normalized];
    const permId = pendingLinks[0].permissionRequestId;
    const handled = broker.handlePermissionCallback(`perm:${action}:${permId}`, msg.address.chatId, undefined, msg.address.userId);
    const label = normalized === '1' ? 'Allow' : normalized === '2' ? 'Allow Session' : 'Deny';
    await deliver(adapter, {
      address: msg.address,
      text: handled ? `${label}: recorded.` : `Permission not found or already resolved.`,
      parseMode: 'plain',
      replyToMessageId: msg.messageId,
    });
    return true;
  }
  if (pendingLinks.length > 1) {
    await deliver(adapter, {
      address: msg.address,
      text: `Multiple pending permissions (${pendingLinks.length}). Please use the full command:\n/perm allow|allow_session|deny <id>`,
      parseMode: 'plain',
      replyToMessageId: msg.messageId,
    });
    return true;
  }
  // pendingLinks.length === 0: no pending permissions, fall through as normal message
  return false;
}

/** Build the combined partial-text + tool-event callbacks for streaming previews/cards. */
function buildStreamingCallbacks(adapter: BaseChannelAdapter, msg: InboundMessage): {
  previewState: StreamingPreviewState | null;
  hasStreamingCards: boolean;
  onPartialText?: (fullText: string) => void;
  onToolEvent?: (toolId: string, toolName: string, status: 'running' | 'complete' | 'error') => void;
} {
  let previewState: StreamingPreviewState | null = null;
  const caps = adapter.getPreviewCapabilities?.(msg.address.chatId) ?? null;
  if (caps?.supported) {
    previewState = {
      draftId: generateDraftId(),
      chatId: msg.address.chatId,
      lastSentText: '',
      lastSentAt: 0,
      degraded: false,
      throttleTimer: null,
      pendingText: '',
    };
  }

  const streamCfg = previewState ? getStreamConfig(adapter.channelType) : null;

  const previewOnPartialText = (previewState && streamCfg) ? (fullText: string) => {
    const ps = previewState!;
    const cfg = streamCfg!;
    if (ps.degraded) return;

    ps.pendingText = fullText.length > cfg.maxChars
      ? fullText.slice(0, cfg.maxChars) + '...'
      : fullText;

    const delta = ps.pendingText.length - ps.lastSentText.length;
    const elapsed = Date.now() - ps.lastSentAt;

    if (delta < cfg.minDeltaChars && ps.lastSentAt > 0) {
      if (!ps.throttleTimer) {
        ps.throttleTimer = setTimeout(() => {
          ps.throttleTimer = null;
          if (!ps.degraded) flushPreview(adapter, ps, cfg);
        }, cfg.intervalMs);
      }
      return;
    }

    if (elapsed < cfg.intervalMs && ps.lastSentAt > 0) {
      if (!ps.throttleTimer) {
        ps.throttleTimer = setTimeout(() => {
          ps.throttleTimer = null;
          if (!ps.degraded) flushPreview(adapter, ps, cfg);
        }, cfg.intervalMs - elapsed);
      }
      return;
    }

    if (ps.throttleTimer) {
      clearTimeout(ps.throttleTimer);
      ps.throttleTimer = null;
    }
    flushPreview(adapter, ps, cfg);
  } : undefined;

  // Streaming card setup (Feishu CardKit v2): runs in parallel with the preview system.
  const hasStreamingCards = typeof adapter.onStreamText === 'function';
  const toolCallTracker = new Map<string, ToolCallInfo>();

  const onStreamCardText = hasStreamingCards ? (fullText: string) => {
    try { adapter.onStreamText!(msg.address.chatId, fullText); } catch { /* non-critical */ }
  } : undefined;

  const onToolEvent = hasStreamingCards ? (toolId: string, toolName: string, status: 'running' | 'complete' | 'error') => {
    if (toolName) {
      toolCallTracker.set(toolId, { id: toolId, name: toolName, status });
    } else {
      const existing = toolCallTracker.get(toolId);
      if (existing) existing.status = status;
    }
    try {
      adapter.onToolEvent!(msg.address.chatId, Array.from(toolCallTracker.values()));
    } catch { /* non-critical */ }
  } : undefined;

  const onPartialText = (previewOnPartialText || onStreamCardText) ? (fullText: string) => {
    if (previewOnPartialText) previewOnPartialText(fullText);
    if (onStreamCardText) onStreamCardText(fullText);
  } : undefined;

  return { previewState, hasStreamingCards, onPartialText, onToolEvent };
}

/** Deliver the engine result text (or error) and persist the SDK session id. */
async function deliverEngineResult(
  adapter: BaseChannelAdapter,
  msg: InboundMessage,
  store: ReturnType<typeof getBridgeContext>['store'],
  binding: import('./types.js').ChannelBinding,
  result: Awaited<ReturnType<typeof engine.processMessage>>,
  hasStreamingCards: boolean,
): Promise<void> {
  // Finalize streaming card if supported; returns true when content is already visible.
  let cardFinalized = false;
  if (hasStreamingCards && adapter.onStreamEnd) {
    try {
      const status = result.hasError ? 'error' : 'completed';
      cardFinalized = await adapter.onStreamEnd(msg.address.chatId, status, result.responseText);
    } catch (err) {
      console.warn('[bridge-manager] Card finalize failed:', err instanceof Error ? err.message : err);
    }
  }

  if (result.responseText) {
    if (!cardFinalized) {
      await deliverResponse(adapter, msg.address, result.responseText, binding.codepilotSessionId, msg.messageId);
    }
  } else if (result.hasError) {
    await deliver(adapter, {
      address: msg.address,
      text: `<b>Error:</b> ${escapeHtml(result.errorMessage)}`,
      parseMode: 'HTML',
      replyToMessageId: msg.messageId,
    });
  }

  // Persist the actual SDK session ID for future resume; clear a stale id on error.
  if (binding.id) {
    try {
      const update = computeSdkSessionUpdate(result.sdkSessionId, result.hasError);
      if (update !== null) {
        store.updateChannelBinding(binding.id, { sdkSessionId: update });
      }
    } catch { /* best effort */ }
  }
}

/** Route a regular (non-command) message through the conversation engine. */
async function routeToConversation(
  adapter: BaseChannelAdapter,
  msg: InboundMessage,
  store: ReturnType<typeof getBridgeContext>['store'],
  rawText: string,
  hasAttachments: boolean,
  ack: () => void,
): Promise<void> {
  // Sanitize general message text before routing to conversation engine
  const { text, truncated } = sanitizeInput(rawText);
  if (truncated) {
    console.warn(`[bridge-manager] Input truncated from ${rawText.length} to ${text.length} chars for chat ${msg.address.chatId}`);
    store.insertAuditLog({
      channelType: adapter.channelType,
      chatId: msg.address.chatId,
      direction: 'inbound',
      messageId: msg.messageId,
      summary: `[TRUNCATED] Input truncated from ${rawText.length} chars`,
    });
  }

  if (!text && !hasAttachments) { ack(); return; }

  const binding = router.resolve(msg.address);
  adapter.onMessageStart?.(msg.address.chatId);

  // Create an AbortController so /stop can cancel this task externally
  const taskAbort = new AbortController();
  const state = getState();
  state.activeTasks.set(binding.codepilotSessionId, taskAbort);

  const { previewState, hasStreamingCards, onPartialText, onToolEvent } = buildStreamingCallbacks(adapter, msg);

  try {
    // Use text or empty string for image-only messages (prompt still required by streamClaude)
    const promptText = text || (hasAttachments ? 'Describe this image.' : '');

    const result = await engine.processMessage(binding, promptText, async (perm) => {
      await broker.forwardPermissionRequest(
        adapter,
        msg.address,
        perm.permissionRequestId,
        perm.toolName,
        perm.toolInput,
        binding.codepilotSessionId,
        perm.suggestions,
        msg.messageId,
      );
    }, taskAbort.signal, hasAttachments ? msg.attachments : undefined, onPartialText, onToolEvent);

    await deliverEngineResult(adapter, msg, store, binding, result, hasStreamingCards);
  } finally {
    if (previewState) {
      if (previewState.throttleTimer) {
        clearTimeout(previewState.throttleTimer);
        previewState.throttleTimer = null;
      }
      adapter.endPreview?.(msg.address.chatId, previewState.draftId);
    }

    if (hasStreamingCards && adapter.onStreamEnd && taskAbort.signal.aborted) {
      try {
        await adapter.onStreamEnd(msg.address.chatId, 'interrupted', '');
      } catch { /* best effort */ }
    }

    state.activeTasks.delete(binding.codepilotSessionId);
    adapter.onMessageEnd?.(msg.address.chatId);
    ack();
  }
}

/**
 * Handle IM slash commands. Parses the command, runs dangerous-input detection,
 * dispatches to a grouped handler, and delivers the response.
 */
async function handleCommand(
  adapter: BaseChannelAdapter,
  msg: InboundMessage,
  text: string,
): Promise<void> {
  const { store } = getBridgeContext();

  // Extract command and args (handle /command@botname format)
  const parts = text.split(/\s+/);
  const command = parts[0].split('@')[0].toLowerCase();
  const args = parts.slice(1).join(' ').trim();

  // Run dangerous-input detection on the full command text
  const dangerCheck = isDangerousInput(text);
  if (dangerCheck.dangerous) {
    store.insertAuditLog({
      channelType: adapter.channelType,
      chatId: msg.address.chatId,
      direction: 'inbound',
      messageId: msg.messageId,
      summary: `[BLOCKED] Dangerous input detected: ${dangerCheck.reason}`,
    });
    console.warn(`[bridge-manager] Blocked dangerous command input from chat ${msg.address.chatId}: ${dangerCheck.reason}`);
    await deliver(adapter, {
      address: msg.address,
      text: `Command rejected: invalid input detected.`,
      parseMode: 'plain',
      replyToMessageId: msg.messageId,
    });
    return;
  }

  const response =
    commandSessionMgmt(command, msg, args)
    ?? commandSessionInfo(command, adapter, msg, args)
    ?? commandHelpText(command)
    ?? `Unknown command: ${escapeHtml(command)}\nType /help for available commands.`;

  if (response) {
    await deliver(adapter, {
      address: msg.address,
      text: response,
      parseMode: 'HTML',
      replyToMessageId: msg.messageId,
    });
  }
}

/** Static help/usage text commands. Returns null if not one of these. */
function commandHelpText(command: string): string | null {
  if (command === '/start') {
    return [
      '<b>CodePilot Bridge</b>',
      '',
      'Send any message to interact with Claude.',
      '',
      '<b>Commands:</b>',
      '/new [path] - Start new session',
      '/bind &lt;session_id&gt; - Bind to existing session',
      '/cwd /path - Change working directory',
      '/mode plan|code|ask - Change mode',
      '/status - Show current status',
      '/sessions - List recent sessions',
      '/stop - Stop current session',
      '/perm allow|allow_session|deny &lt;id&gt; - Respond to permission',
      '/help - Show this help',
    ].join('\n');
  }
  if (command === '/help') {
    return [
      '<b>CodePilot Bridge Commands</b>',
      '',
      '/new [path] - Start new session',
      '/bind &lt;session_id&gt; - Bind to existing session',
      '/cwd /path - Change working directory',
      '/mode plan|code|ask - Change mode',
      '/status - Show current status',
      '/sessions - List recent sessions',
      '/stop - Stop current session',
      '/perm allow|allow_session|deny &lt;id&gt; - Respond to permission request',
      '1/2/3 - Quick permission reply (Feishu/QQ/WeChat, single pending)',
      '/help - Show this help',
    ].join('\n');
  }
  return null;
}

/**
 * Session-management commands (/new, /bind, /cwd, /mode). Returns the response
 * text, or null if `command` is not handled here. Under force-auto (auto-approve
 * + ack) the `ask` mode is refused so the user is never stranded behind prompts.
 */
export function commandSessionMgmt(
  command: string,
  msg: InboundMessage,
  args: string,
): string | null {
  switch (command) {
    case '/new': {
      // Abort any running task on the current session before creating a new one
      const oldBinding = router.resolve(msg.address);
      const st = getState();
      const oldTask = st.activeTasks.get(oldBinding.codepilotSessionId);
      if (oldTask) {
        oldTask.abort();
        st.activeTasks.delete(oldBinding.codepilotSessionId);
      }

      let workDir: string | undefined;
      if (args) {
        const validated = validateWorkingDirectory(args);
        if (!validated) {
          return 'Invalid path. Must be an absolute path without traversal sequences.';
        }
        workDir = validated;
      }
      const binding = router.createBinding(msg.address, workDir);
      return `New session created.\nSession: <code>${binding.codepilotSessionId.slice(0, 8)}...</code>\nCWD: <code>${escapeHtml(binding.workingDirectory || '~')}</code>`;
    }

    case '/bind': {
      if (!args) return 'Usage: /bind &lt;session_id&gt;';
      if (!validateSessionId(args)) {
        return 'Invalid session ID format. Expected a 32-64 character hex/UUID string.';
      }
      const binding = router.bindToSession(msg.address, args);
      return binding ? `Bound to session <code>${args.slice(0, 8)}...</code>` : 'Session not found.';
    }

    case '/cwd': {
      if (!args) return 'Usage: /cwd /path/to/directory';
      const validatedPath = validateWorkingDirectory(args);
      if (!validatedPath) {
        return 'Invalid path. Must be an absolute path without traversal sequences or special characters.';
      }
      const binding = router.resolve(msg.address);
      router.updateBinding(binding.id, { workingDirectory: validatedPath });
      return `Working directory set to <code>${escapeHtml(validatedPath)}</code>`;
    }

    case '/mode': {
      if (!validateMode(args)) return 'Usage: /mode plan|code|ask';
      const forceAuto = getBridgeContext().store.getSetting('bridge_force_auto') === 'true';
      if (forceAuto && args === 'ask') {
        return 'Auto-approve is enabled (CTI_AUTO_APPROVE), so <b>ask</b> mode is disabled — staying in <b>code</b>. Unset CTI_AUTO_APPROVE to use ask mode.';
      }
      const binding = router.resolve(msg.address);
      router.updateBinding(binding.id, { mode: args });
      return `Mode set to <b>${args}</b>`;
    }

    default:
      return null;
  }
}

/**
 * Session-info and control commands (/status, /sessions, /stop, /perm).
 * Returns the response text, or null if `command` is not handled here.
 */
function commandSessionInfo(
  command: string,
  adapter: BaseChannelAdapter,
  msg: InboundMessage,
  args: string,
): string | null {
  switch (command) {
    case '/status': {
      const binding = router.resolve(msg.address);
      return [
        '<b>Bridge Status</b>',
        '',
        `Session: <code>${binding.codepilotSessionId.slice(0, 8)}...</code>`,
        `CWD: <code>${escapeHtml(binding.workingDirectory || '~')}</code>`,
        `Mode: <b>${binding.mode}</b>`,
        `Model: <code>${binding.model || 'default'}</code>`,
      ].join('\n');
    }

    case '/sessions': {
      const bindings = router.listBindings(adapter.channelType);
      if (bindings.length === 0) return 'No sessions found.';
      const lines = ['<b>Sessions:</b>', ''];
      for (const b of bindings.slice(0, 10)) {
        const active = b.active ? 'active' : 'inactive';
        lines.push(`<code>${b.codepilotSessionId.slice(0, 8)}...</code> [${active}] ${escapeHtml(b.workingDirectory || '~')}`);
      }
      return lines.join('\n');
    }

    case '/stop': {
      const binding = router.resolve(msg.address);
      const st = getState();
      const taskAbort = st.activeTasks.get(binding.codepilotSessionId);
      if (taskAbort) {
        taskAbort.abort();
        st.activeTasks.delete(binding.codepilotSessionId);
        return 'Stopping current task...';
      }
      return 'No task is currently running.';
    }

    case '/perm': {
      // Text-based permission approval fallback (for channels without inline buttons)
      const permParts = args.split(/\s+/);
      const permAction = permParts[0];
      const permId = permParts.slice(1).join(' ');
      if (!permAction || !permId || !['allow', 'allow_session', 'deny'].includes(permAction)) {
        return 'Usage: /perm allow|allow_session|deny &lt;permission_id&gt;';
      }
      const handled = broker.handlePermissionCallback(`perm:${permAction}:${permId}`, msg.address.chatId, undefined, msg.address.userId);
      return handled ? `Permission ${permAction}: recorded.` : `Permission not found or already resolved.`;
    }

    default:
      return null;
  }
}

// ── SDK Session Update Logic ─────────────────────────────────

/**
 * Compute the sdkSessionId value to persist after a conversation result.
 * Returns the new value to write, or null if no update is needed.
 *
 * Rules:
 * - If result has sdkSessionId AND no error → save the new ID
 * - If result has error (regardless of sdkSessionId) → clear to empty string
 * - Otherwise → no update needed
 */
export function computeSdkSessionUpdate(
  sdkSessionId: string | null | undefined,
  hasError: boolean,
): string | null {
  if (sdkSessionId && !hasError) {
    return sdkSessionId;
  }
  if (hasError) {
    return '';
  }
  return null;
}

// ── Test-only export ─────────────────────────────────────────
// Exposed so integration tests can exercise handleMessage directly
// without wiring up the full adapter loop.
/** @internal */
export const _testOnly = { handleMessage };
