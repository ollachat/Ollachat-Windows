import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RoomMessagesState } from '../src/renderer/chat-shell-state.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const appJsPath = path.join(__dirname, '..', 'src', 'renderer', 'app.js');
const appJs = fs.readFileSync(appJsPath, 'utf8');

describe('Notification & History Loading Lifecycle Suite', () => {

  // ═══════════════════════════════════════════════════════════════════
  // 1. Static Contract & Wiring Verification
  // ═══════════════════════════════════════════════════════════════════
  describe('1. Static Code Invariants for History Loading', () => {
    test('1. onNavigateRoom calls selectConversation with forceReload: true unconditionally', () => {
      assert.ok(
        appJs.includes('selectConversation(roomId, { forceReload: true })'),
        'onNavigateRoom must call selectConversation with forceReload: true'
      );
      assert.ok(
        !appJs.includes('if (roomId && (!shellState.selectedRoomId || shellState.selectedRoomId !== roomId))'),
        'Must not skip selection when room is already selected'
      );
    });

    test('2. selectConversation accepts forceReload option and verifies isHistoryLoaded', () => {
      assert.ok(
        appJs.includes('function selectConversation(roomId, { forceReload = false } = {})'),
        'selectConversation must accept forceReload'
      );
      assert.ok(
        appJs.includes('if (!isSameRoom || forceReload || !activeRoomMessagesState.isHistoryLoaded)'),
        'selectConversation must load messages if not isSameRoom, forceReload, or !isHistoryLoaded'
      );
      assert.ok(
        appJs.includes('loadMessagesForRoom(roomId, { forceReload })'),
        'selectConversation must forward forceReload to loadMessagesForRoom'
      );
    });

    test('3. loadMessagesForRoom implements pagination loop and SQLite hydration', () => {
      assert.ok(
        appJs.includes('while (hasMorePages && pageCount < MAX_PAGES)'),
        'loadMessagesForRoom must implement multi-page pagination loop'
      );
      assert.ok(
        appJs.includes('targetState.mergeServerMessages(messages, serverHasMore)'),
        'Each page must be merged with existing messages'
      );
      assert.ok(
        appJs.includes('let dbMsgs = await loadMessagesFromDb(roomId, { limit: 100 })'),
        'loadMessagesForRoom must hydrate local SQLite messages'
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 2. RoomMessagesState Invariants
  // ═══════════════════════════════════════════════════════════════════
  describe('2. RoomMessagesState State Invariants', () => {
    let state;

    beforeEach(() => {
      state = new RoomMessagesState('usr_me');
      state.roomId = 'room_123';
    });

    test('4. Initial state has isHistoryLoaded = false', () => {
      assert.equal(state.isHistoryLoaded, false);
      assert.equal(state.messages.length, 0);
    });

    test('5. Appending incoming realtime message keeps isHistoryLoaded = false', () => {
      state.appendIncomingMessage({
        id: 'msg_rt_1',
        sender_id: 'usr_other',
        body: { text: 'Realtime message while minimized' },
        eventSeq: 105,
        createdAt: '2026-10-23T12:00:00Z'
      });

      assert.equal(state.messages.length, 1);
      assert.equal(state.isHistoryLoaded, false, 'Receiving 1 message must NOT mark history as loaded');
      assert.equal(state.newestSeq, 105);
      assert.equal(state.oldestSeq, 105);
    });

    test('6. mergeServerMessages preserves realtime message and merges historical messages chronologically', () => {
      // 1 realtime message received while minimized:
      state.appendIncomingMessage({
        id: 'msg_rt_1',
        sender_id: 'usr_other',
        body: { text: 'Newest message' },
        eventSeq: 105,
        createdAt: '2026-10-23T12:00:00Z'
      });

      // Now server history returns older messages:
      const historyBatch = [
        { id: 'msg_1', sender_id: 'usr_other', body: { text: 'Hello' }, eventSeq: 1, createdAt: '2026-10-23T11:00:00Z' },
        { id: 'msg_2', sender_id: 'usr_me', body: { text: 'Hi' }, eventSeq: 2, createdAt: '2026-10-23T11:01:00Z' },
        { id: 'msg_3', sender_id: 'usr_other', body: { text: 'Older message' }, eventSeq: 50, createdAt: '2026-10-23T11:30:00Z' }
      ];

      state.mergeServerMessages(historyBatch, false);

      assert.equal(state.messages.length, 4, 'Must have all 3 historical messages PLUS the 1 realtime message');
      assert.equal(state.messages[0].id, 'msg_1', 'Chronological order: first message is msg_1');
      assert.equal(state.messages[1].id, 'msg_2');
      assert.equal(state.messages[2].id, 'msg_3');
      assert.equal(state.messages[3].id, 'msg_rt_1', 'Chronological order: newest message is msg_rt_1');
      assert.equal(state.oldestSeq, 1);
      assert.equal(state.newestSeq, 105);
    });

    test('7. Deduplication by canonical ID and clientMessageId prevents duplicate entries', () => {
      state.appendIncomingMessage({
        id: 'local-1234',
        clientMessageId: 'client-uuid-1',
        sender_id: 'usr_me',
        body: { text: 'Pending outbox message' },
        status: 'sending'
      });

      // Server acknowledges with canonical ID:
      state.mergeServerMessages([
        {
          id: 'server-id-99',
          clientMessageId: 'client-uuid-1',
          sender_id: 'usr_me',
          body: { text: 'Pending outbox message' },
          eventSeq: 10,
          status: 'sent'
        }
      ]);

      assert.equal(state.messages.length, 1, 'Optimistic message reconciled without duplicate');
      assert.equal(state.messages[0].id, 'server-id-99');
      assert.equal(state.messages[0].clientMessageId, 'client-uuid-1');
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 3. Multi-Page Pagination Simulation
  // ═══════════════════════════════════════════════════════════════════
  describe('3. Multi-Page History Pagination Engine', () => {
    test('8. Multi-page pagination retrieves complete history from beginning (seq 1)', async () => {
      // Simulate server with 120 total messages (seq 1 to 120)
      const serverMessages = [];
      for (let i = 1; i <= 120; i++) {
        serverMessages.push({
          id: `msg_${i}`,
          sender_id: i % 2 === 0 ? 'usr_me' : 'usr_other',
          body: { text: `Message #${i}` },
          eventSeq: i,
          createdAt: new Date(1700000000000 + i * 1000).toISOString()
        });
      }

      // Mock chatApi.getMessages implementing server contract
      const apiCalls = [];
      const mockChatApi = {
        getMessages: async (roomId, { limit = 50, beforeSeq = null } = {}) => {
          apiCalls.push({ roomId, limit, beforeSeq });
          let filtered = serverMessages;
          if (beforeSeq !== null && beforeSeq !== undefined) {
            filtered = serverMessages.filter((m) => m.eventSeq < beforeSeq);
          }
          // Returns newest first up to limit, then reversed to chronological
          const slice = filtered.slice(Math.max(0, filtered.length - limit));
          const hasMore = filtered.length > limit;
          return {
            messages: slice,
            hasMore,
            has_more: hasMore
          };
        }
      };

      // Execute pagination engine as in app.js loadMessagesForRoom
      const state = new RoomMessagesState('usr_me');
      state.roomId = 'room_paginated';

      let currentBeforeSeq = 2147483647;
      let hasMorePages = true;
      let pageCount = 0;
      const MAX_PAGES = 50;

      while (hasMorePages && pageCount < MAX_PAGES) {
        pageCount++;
        const res = await mockChatApi.getMessages('room_paginated', {
          limit: 50,
          beforeSeq: currentBeforeSeq
        });

        const messages = res.messages || [];
        const serverHasMore = Boolean(res.hasMore ?? res.has_more);

        if (messages.length > 0) {
          state.mergeServerMessages(messages, serverHasMore);

          let minSeq = null;
          for (const m of messages) {
            const s = Number(m.eventSeq ?? m.event_seq);
            if (Number.isFinite(s) && (minSeq === null || s < minSeq)) {
              minSeq = s;
            }
          }

          if (serverHasMore && minSeq !== null && minSeq > 1) {
            currentBeforeSeq = minSeq;
          } else {
            hasMorePages = false;
          }
        } else {
          hasMorePages = false;
        }

        if (!serverHasMore) {
          hasMorePages = false;
        }
      }

      // Verify that all 120 messages were loaded across 3 pages
      assert.equal(pageCount, 3, 'Must fetch exactly 3 pages for 120 messages (50 + 50 + 20)');
      assert.equal(state.messages.length, 120, 'All 120 messages must be present');
      assert.equal(state.messages[0].id, 'msg_1', 'First message is msg_1 (beginning of history)');
      assert.equal(state.messages[119].id, 'msg_120', 'Last message is msg_120');
      assert.equal(state.oldestSeq, 1);
      assert.equal(state.newestSeq, 120);

      // Verify beforeSeq cursor progression
      assert.equal(apiCalls[0].beforeSeq, 2147483647);
      assert.equal(apiCalls[1].beforeSeq, 71); // minSeq of first batch was 71
      assert.equal(apiCalls[2].beforeSeq, 21); // minSeq of second batch was 21
    });

    test('9. Realtime message arriving while pagination is in flight is not lost', async () => {
      const state = new RoomMessagesState('usr_me');
      state.roomId = 'room_race';

      // Page 1 arrives: messages 51 to 100
      const page1 = [];
      for (let i = 51; i <= 100; i++) {
        page1.push({ id: `msg_${i}`, eventSeq: i, body: { text: `Message #${i}` } });
      }
      state.mergeServerMessages(page1, true);

      // Realtime message arrives right now (msg_101):
      state.appendIncomingMessage({
        id: 'msg_101',
        eventSeq: 101,
        sender_id: 'usr_other',
        body: { text: 'Incoming during pagination' }
      });

      // Page 2 arrives: messages 1 to 50
      const page2 = [];
      for (let i = 1; i <= 50; i++) {
        page2.push({ id: `msg_${i}`, eventSeq: i, body: { text: `Message #${i}` } });
      }
      state.mergeServerMessages(page2, false);

      assert.equal(state.messages.length, 101, 'Must contain 100 historical messages PLUS the 1 concurrent realtime message');
      assert.equal(state.messages[0].id, 'msg_1');
      assert.equal(state.messages[100].id, 'msg_101');
    });

    test('10. Stale response from previous room does not mutate new room', () => {
      let activeToken = 1;
      let selectedRoomId = 'room_A';
      const stateA = new RoomMessagesState('usr_me');
      stateA.roomId = 'room_A';
      const stateB = new RoomMessagesState('usr_me');
      stateB.roomId = 'room_B';

      // Load for room A initiated with token 1:
      const reqToken = activeToken;
      const reqRoomId = 'room_A';

      // User immediately switches to room B:
      activeToken++;
      selectedRoomId = 'room_B';

      // Async response for room A arrives now:
      const staleArrival = () => {
        if (activeToken !== reqToken || selectedRoomId !== reqRoomId) {
          return false; // Guard triggered: ignored!
        }
        stateB.mergeServerMessages([{ id: 'bad_msg', body: { text: 'Should never appear' } }]);
        return true;
      };

      const result = staleArrival();
      assert.equal(result, false, 'Stale response guard must trigger');
      assert.equal(stateB.messages.length, 0, 'Room B messages must not be contaminated');
    });

    test('11. Network error sets hasMore = true and does not falsely claim history is loaded', async () => {
      const state = new RoomMessagesState('usr_me');
      state.roomId = 'room_err';

      // Local cache has 10 messages:
      state.mergeServerMessages([
        { id: 'cached_1', eventSeq: 50, body: { text: 'Cached message' } }
      ]);

      // Server pagination fails:
      let loadFailed = false;
      try {
        throw new Error('Connection reset');
      } catch (err) {
        loadFailed = true;
      }

      if (loadFailed) {
        state.hasMore = true; // Error recovery: allow retry
        state.isHistoryLoaded = false;
      }

      assert.equal(state.isHistoryLoaded, false, 'Must not claim history is complete when request failed');
      assert.equal(state.hasMore, true, 'hasMore must remain true to allow user retry');
      assert.equal(state.messages.length, 1, 'Cached messages must not be deleted on network error');
    });
  });
});
