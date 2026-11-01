/**
 * Offline Outbox & Pending Message Queue Manager (Phase 4C).
 *
 * Makes outgoing messages durable locally so temporary network loss,
 * app restart, or WebSocket reconnection does not lose pending messages.
 *
 * Flow:
 * 1. Outgoing message enqueued to SQLite pending_outbox BEFORE network send.
 * 2. Attempt WebSocket delivery using existing OllaCore message.send.
 * 3. On server ACK or message.created, remove from pending_outbox.
 * 4. On disconnect or failure, keep message in SQLite with 'failed' or 'pending' status.
 * 5. On reconnect or startup, load pending items and retry with exponential backoff.
 * 6. Never duplicate messages: use client_message_id as the idempotency key.
 */

export class OutboxManager {
  constructor() {
    this._isFlushing = false;
    this._inFlight = new Set();
    this._lastFlushTime = 0;
  }

  /**
   * Persists an outgoing message to the SQLite pending_outbox table BEFORE network send.
   * @param {object} params
   * @param {string} params.clientMessageId
   * @param {string} params.roomId
   * @param {object} params.wirePayload
   * @param {object} [params.optimisticMsg]
   * @param {object} [params.dbBridge]
   * @returns {Promise<boolean>}
   */
  async enqueue({ clientMessageId, roomId, wirePayload, optimisticMsg = null, dbBridge = null }) {
    const db = dbBridge || (typeof window !== 'undefined' ? window.ollacoreDesktop?.db : null);
    if (!db || !clientMessageId || !roomId || !wirePayload) {
      return false;
    }

    const now = new Date().toISOString();
    const payloadToStore = {
      client_message_id: clientMessageId,
      roomId,
      wirePayload,
      optimisticMsg: optimisticMsg ? {
        id: optimisticMsg.id || clientMessageId,
        clientMessageId: optimisticMsg.clientMessageId || clientMessageId,
        roomId: optimisticMsg.roomId || roomId,
        senderId: optimisticMsg.senderId || '',
        kind: optimisticMsg.kind || 'text',
        body: optimisticMsg.body || {},
        status: optimisticMsg.status || null,
        createdAt: optimisticMsg.createdAt || now
      } : null,
      enqueuedAt: now
    };

    try {
      if (typeof db.savePendingOutbox === 'function') {
        await db.savePendingOutbox({
          clientMessageId,
          roomId,
          payloadJson: JSON.stringify(payloadToStore),
          retryCount: 0,
          createdAt: now,
          lastAttemptAt: null
        });
        return true;
      }
    } catch (err) {
      console.warn('[OutboxManager] Failed to persist outbox record to SQLite:', err);
    }
    return false;
  }

  /**
   * Removes a delivered or acknowledged message from SQLite pending_outbox.
   * @param {string} clientMessageId
   * @param {object} [dbBridge]
   * @returns {Promise<boolean>}
   */
  async clear({ clientMessageId, dbBridge = null }) {
    if (!clientMessageId) return false;
    const db = dbBridge || (typeof window !== 'undefined' ? window.ollacoreDesktop?.db : null);
    if (!db?.clearPendingOutboxItem) return false;

    this._inFlight.delete(clientMessageId);
    try {
      await db.clearPendingOutboxItem({ clientMessageId });
      return true;
    } catch (err) {
      console.warn('[OutboxManager] Failed to clear outbox item:', clientMessageId, err);
      return false;
    }
  }

  /**
   * Flushes eligible pending outbox items over the WebSocket with backoff.
   * @param {object} options
   * @param {object} [options.dbBridge]
   * @param {object} [options.chatBridge]
   * @param {Map} [options.requestToClientMap]
   * @param {Function} [options.onStatusUpdate]
   * @returns {Promise<number>} Number of messages retried
   */
  async flush(options = {}) {
    if (this._isFlushing) return 0;

    const db = options.dbBridge || (typeof window !== 'undefined' ? window.ollacoreDesktop?.db : null);
    const chat = options.chatBridge || (typeof window !== 'undefined' ? window.ollacoreDesktop?.chat : null);
    if (!db?.getPendingOutbox || !chat?.send) return 0;

    // Throttle rapid repeated flushes (min 500ms between flush attempts)
    const nowMs = Date.now();
    if (nowMs - this._lastFlushTime < 500) return 0;
    this._lastFlushTime = nowMs;

    this._isFlushing = true;
    let sentCount = 0;

    try {
      let wsState = await chat.getState?.();
      if (wsState === 'connecting' || wsState === 'reconnecting') {
        const startWait = Date.now();
        while ((wsState === 'connecting' || wsState === 'reconnecting') && (Date.now() - startWait < 3000)) {
          await new Promise((resolve) => setTimeout(resolve, 200));
          wsState = await chat.getState?.();
        }
      }
      if (wsState !== 'connected') {
        this._isFlushing = false;
        return 0;
      }

      const pendingItems = await db.getPendingOutbox({ limit: 50 });
      if (!Array.isArray(pendingItems) || pendingItems.length === 0) {
        this._isFlushing = false;
        return 0;
      }

      for (const item of pendingItems) {
        const clientMsgId = item.client_message_id;
        if (!clientMsgId || this._inFlight.has(clientMsgId)) {
          continue;
        }

        // Enforce exponential backoff to avoid tight retry loops:
        // Base delay 1.5s, 3s, 6s, 12s, capped at 30s
        const retryCount = item.retry_count || 0;
        if (item.last_attempt_at) {
          const lastAttemptMs = new Date(item.last_attempt_at).getTime();
          const backoffDelayMs = Math.min(30000, 1500 * Math.pow(2, Math.min(retryCount, 5)));
          if (nowMs - lastAttemptMs < backoffDelayMs) {
            continue; // Not yet eligible for retry
          }
        }

        let parsed = null;
        try {
          parsed = JSON.parse(item.payload_json);
        } catch (_) {
          continue;
        }

        const wirePayload = parsed?.wirePayload || parsed;
        const roomId = item.room_id || parsed?.roomId;
        if (!wirePayload || !roomId) continue;

        // Lost-ACK reconciliation: if message is already confirmed (sent/delivered/read) in roomState or SQLite,
        // clear it from pending_outbox without re-transmitting to prevent duplicates.
        let isAlreadyConfirmed = false;
        if (typeof options.getRoomState === 'function') {
          const rState = options.getRoomState(roomId);
          const st = rState?.getStatus?.(clientMsgId);
          if (st === 'sent' || st === 'delivered' || st === 'read') {
            isAlreadyConfirmed = true;
          }
        }
        if (!isAlreadyConfirmed && typeof db.getMessageById === 'function') {
          try {
            const dbMsg = await db.getMessageById(clientMsgId);
            const dbStatus = dbMsg?.status || dbMsg?.delivery_status || dbMsg?.deliveryStatus;
            if (dbStatus === 'sent' || dbStatus === 'delivered' || dbStatus === 'read') {
              isAlreadyConfirmed = true;
            }
          } catch (_) {}
        }
        if (isAlreadyConfirmed) {
          await this.clear({ clientMessageId: clientMsgId, dbBridge: db });
          continue;
        }

        this._inFlight.add(clientMsgId);

        // Update retry attempt in SQLite
        const attemptTime = new Date().toISOString();
        if (typeof db.updatePendingOutboxAttempt === 'function') {
          await db.updatePendingOutboxAttempt({
            clientMessageId: clientMsgId,
            retryCount: retryCount + 1,
            lastAttemptAt: attemptTime
          }).catch(() => {});
        }

        // Notify UI to display sending state
        options.onStatusUpdate?.(clientMsgId, 'sending', roomId);

        try {
          const requestId = (typeof crypto?.randomUUID === 'function') ? crypto.randomUUID() : `req-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
          if (options.requestToClientMap) {
            options.requestToClientMap.set(requestId, clientMsgId);
          }
          const res = await chat.send('message.send', wirePayload, roomId, requestId);
          if (res?.ok && res?.requestId) {
            sentCount++;
            if (options.requestToClientMap && res.requestId !== requestId) {
              options.requestToClientMap.set(res.requestId, clientMsgId);
            }
          } else {
            this._inFlight.delete(clientMsgId);
            options.onStatusUpdate?.(clientMsgId, 'failed', roomId);
            if (db.updateMessageStatus) {
              await db.updateMessageStatus({ id: clientMsgId, status: 'failed' }).catch(() => {});
            }
          }
        } catch (sendErr) {
          this._inFlight.delete(clientMsgId);
          console.warn('[OutboxManager] Error sending outbox item:', clientMsgId, sendErr);
          options.onStatusUpdate?.(clientMsgId, 'failed', roomId);
          if (db.updateMessageStatus) {
            await db.updateMessageStatus({ id: clientMsgId, status: 'failed' }).catch(() => {});
          }
        }
      }
    } catch (err) {
      console.warn('[OutboxManager] Flush encountered an error:', err);
    } finally {
      this._isFlushing = false;
    }

    return sentCount;
  }

  /**
   * Rehydrates pending outbox messages into renderer state upon app restart/login.
   * @param {object} params
   * @param {object} params.shellState
   * @param {Function} params.getOrCreateRoomMessagesState
   * @param {object} [params.dbBridge]
   * @param {string} [params.defaultStatus]
   * @returns {Promise<number>} Number of pending messages restored
   */
  async recoverOnStartup({ shellState, getOrCreateRoomMessagesState, dbBridge = null, defaultStatus = null }) {
    const db = dbBridge || (typeof window !== 'undefined' ? window.ollacoreDesktop?.db : null);
    if (!db?.getPendingOutbox) return 0;

    let restoredCount = 0;
    try {
      const items = await db.getPendingOutbox({ limit: 100 });
      if (!Array.isArray(items) || items.length === 0) return 0;

      for (const item of items) {
        let parsed = null;
        try {
          parsed = JSON.parse(item.payload_json);
        } catch (_) {
          continue;
        }

        const roomId = item.room_id || parsed?.roomId;
        const clientMsgId = item.client_message_id;
        if (!roomId || !clientMsgId) continue;

        const roomState = getOrCreateRoomMessagesState(roomId);
        if (!roomState) continue;

        // Check if message is already in memory state
        const exists = roomState.messages?.some(
          (m) => m.clientMessageId === clientMsgId || m.id === clientMsgId
        );

        if (!exists) {
          const resolvedStatus = defaultStatus || parsed?.optimisticMsg?.status || 'failed';
          const optimisticMsg = parsed.optimisticMsg || {
            id: clientMsgId,
            clientMessageId: clientMsgId,
            roomId,
            senderId: roomState.currentUserId || shellState?.currentUser?.userId || '',
            kind: parsed?.wirePayload?.kind || 'text',
            body: parsed?.wirePayload?.body || { text: '' },
            status: resolvedStatus,
            createdAt: item.created_at || new Date().toISOString()
          };

          optimisticMsg.status = resolvedStatus;
          optimisticMsg.deliveryStatus = resolvedStatus;
          roomState.addOptimisticMessage(optimisticMsg);
          roomState.updateReceipt(clientMsgId, resolvedStatus, roomId);
          restoredCount++;
        }
      }
    } catch (err) {
      console.warn('[OutboxManager] Startup recovery encountered an error:', err);
    }

    return restoredCount;
  }
}

// Global singleton instance for the renderer
export const outboxManager = new OutboxManager();
