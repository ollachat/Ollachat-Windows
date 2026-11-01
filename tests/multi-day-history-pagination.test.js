import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { ChatApi } from '../src/api/chat-api.js';
import {
  RoomMessagesState,
  groupMessagesByDay,
  formatDayDivider
} from '../src/renderer/chat-shell-state.js';
import { DatabaseManager } from '../src/storage/db/database-manager.js';
import { DatabaseService } from '../src/storage/db/database-service.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('Multi-Day Historical Messages Pagination & Persistence Regression Tests', () => {

  // ─────────────────────────────────────────────────────────────────────────
  // 1. API Contract: hasMore inference when backend omits has_more property
  // ─────────────────────────────────────────────────────────────────────────
  describe('1. ChatApi listMessages hasMore inference contract', () => {
    test('infers hasMore = true when backend returns 50 messages without has_more and minSeq > 1', async () => {
      const mockMsgs = [];
      for (let i = 50; i >= 1; i--) {
        mockMsgs.push({
          id: `msg-${100 + i}`,
          event_seq: 100 + i,
          created_at: new Date(1700000000000 + i * 1000).toISOString()
        });
      }

      // Backend returns only messages and latest_seq, NO has_more or hasMore
      const mockFetch = async () => ({
        ok: true,
        status: 200,
        headers: new Headers(),
        text: async () => JSON.stringify({
          messages: mockMsgs,
          latest_seq: 150
        })
      });

      const api = new ChatApi({ baseUrl: 'https://api.test.com', fetchFn: mockFetch });
      const res = await api.listMessages('room-token', 'room-1', { limit: 50, beforeSeq: 200 });

      assert.equal(res.messages.length, 50);
      assert.equal(res.hasMore, true, 'Must infer hasMore = true for full page with minSeq > 1');
      assert.equal(res.has_more, true);
    });

    test('infers hasMore = false when backend returns fewer than limit (<50) messages without has_more', async () => {
      const mockMsgs = [];
      for (let i = 28; i >= 1; i--) {
        mockMsgs.push({
          id: `msg-${i}`,
          event_seq: i,
          created_at: new Date(1700000000000 + i * 1000).toISOString()
        });
      }

      const mockFetch = async () => ({
        ok: true,
        status: 200,
        headers: new Headers(),
        text: async () => JSON.stringify({
          messages: mockMsgs,
          latest_seq: 28
        })
      });

      const api = new ChatApi({ baseUrl: 'https://api.test.com', fetchFn: mockFetch });
      const res = await api.listMessages('room-token', 'room-1', { limit: 50, beforeSeq: 29 });

      assert.equal(res.messages.length, 28);
      assert.equal(res.hasMore, false, 'Must infer hasMore = false when page has < 50 items');
      assert.equal(res.has_more, false);
    });

    test('infers hasMore = false when oldest message sequence reaches 1', async () => {
      const mockMsgs = [];
      for (let i = 50; i >= 1; i--) {
        mockMsgs.push({
          id: `msg-${i}`,
          event_seq: i, // minSeq is 1
          created_at: new Date(1700000000000 + i * 1000).toISOString()
        });
      }

      const mockFetch = async () => ({
        ok: true,
        status: 200,
        headers: new Headers(),
        text: async () => JSON.stringify({
          messages: mockMsgs,
          latest_seq: 50
        })
      });

      const api = new ChatApi({ baseUrl: 'https://api.test.com', fetchFn: mockFetch });
      const res = await api.listMessages('room-token', 'room-1', { limit: 50, beforeSeq: 51 });

      assert.equal(res.messages.length, 50);
      assert.equal(res.hasMore, false, 'Must infer hasMore = false when minSeq is 1 (oldest possible sequence)');
      assert.equal(res.has_more, false);
    });

    test('respects explicit boolean has_more flag when backend provides it', async () => {
      const mockFetch = async () => ({
        ok: true,
        status: 200,
        headers: new Headers(),
        text: async () => JSON.stringify({
          messages: [{ id: 'm1', event_seq: 100 }],
          has_more: false
        })
      });

      const api = new ChatApi({ baseUrl: 'https://api.test.com', fetchFn: mockFetch });
      const res = await api.listMessages('room-token', 'room-1', { limit: 50 });

      assert.equal(res.hasMore, false);
      assert.equal(res.has_more, false);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 2. Multi-Day Cursor Progression and Sequential Pagination Loop
  // ─────────────────────────────────────────────────────────────────────────
  describe('2. Multi-Day Pagination Loop (>100 messages spanning 5 days)', () => {
    // Generate 175 messages across 5 calendar days:
    // Day 1: 30 msgs (seq 1 to 30) - 2026-10-18
    // Day 2: 35 msgs (seq 31 to 65) - 2026-10-19
    // Day 3: 40 msgs (seq 66 to 105) - 2026-10-20
    // Day 4: 35 msgs (seq 106 to 140) - 2026-10-21
    // Day 5: 35 msgs (seq 141 to 175) - 2026-10-22
    const totalCount = 175;
    const allServerMessages = [];
    const baseDate = new Date('2026-10-18T10:00:00.000Z');

    for (let seq = 1; seq <= totalCount; seq++) {
      let dayOffset = 0;
      if (seq <= 30) dayOffset = 0;
      else if (seq <= 65) dayOffset = 1;
      else if (seq <= 105) dayOffset = 2;
      else if (seq <= 140) dayOffset = 3;
      else dayOffset = 4;

      const d = new Date(baseDate.getTime() + dayOffset * 86400000 + (seq % 30) * 60000);
      allServerMessages.push({
        id: `srv-msg-${seq}`,
        room_id: 'multi-day-room',
        sender_id: seq % 2 === 0 ? 'user-me' : 'user-alice',
        event_seq: seq,
        body: { text: `Message sequence #${seq}` },
        created_at: d.toISOString()
      });
    }

    test('paginates all 175 messages across 4 pages until end of history without cursor loops', async () => {
      // Mock server endpoint simulating GET /rooms/{roomId}/messages
      const mockFetch = async (url) => {
        const parsed = new URL(url);
        const limit = parseInt(parsed.searchParams.get('limit') || '50', 10);
        const beforeSeq = parsed.searchParams.get('before_seq')
          ? parseInt(parsed.searchParams.get('before_seq'), 10)
          : null;

        // Filter messages strictly before beforeSeq
        let matching = allServerMessages;
        if (beforeSeq !== null) {
          matching = matching.filter((m) => m.event_seq < beforeSeq);
        }

        // Backend returns newest matching messages up to limit
        const page = matching.slice(-limit);
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          text: async () => JSON.stringify({
            messages: page,
            latest_seq: 175
            // Notice: NO has_more property in response, matching live backend!
          })
        };
      };

      const api = new ChatApi({ baseUrl: 'https://api.test.com', fetchFn: mockFetch });

      // Simulate the exact client pagination loop from loadMessagesForRoom
      let currentBeforeSeq = 2147483647;
      let hasMorePages = true;
      let pageCount = 0;
      const MAX_PAGES = 50;
      const retrieved = [];
      const cursorProgression = [];

      while (hasMorePages && pageCount < MAX_PAGES) {
        pageCount++;
        cursorProgression.push(currentBeforeSeq);

        const res = await api.listMessages('mock-token', 'multi-day-room', {
          limit: 50,
          beforeSeq: currentBeforeSeq
        });

        const messages = res.messages || [];
        const serverHasMore = (typeof res.hasMore === 'boolean') ? res.hasMore : (messages.length >= 50);

        if (messages.length > 0) {
          retrieved.unshift(...messages);

          let minSeq = null;
          for (const m of messages) {
            const s = m.eventSeq ?? m.event_seq;
            if (typeof s === 'number' && (minSeq === null || s < minSeq)) {
              minSeq = s;
            }
          }

          if (serverHasMore && minSeq !== null && minSeq > 1) {
            if (minSeq < currentBeforeSeq) {
              currentBeforeSeq = minSeq;
            } else {
              hasMorePages = false;
            }
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

      // Assertions
      assert.equal(pageCount, 4, '175 messages must be paginated in exactly 4 pages (50, 50, 50, 25)');
      assert.deepEqual(cursorProgression, [2147483647, 126, 76, 26]);
      assert.equal(retrieved.length, 175, 'Must retrieve all 175 messages');
      assert.equal(retrieved[0].eventSeq, 1, 'First message must be sequence 1');
      assert.equal(retrieved[174].eventSeq, 175, 'Last message must be sequence 175');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 3. SQLite Persistence & Cache Hydration across restarts
  // ─────────────────────────────────────────────────────────────────────────
  describe('3. SQLite Persistence and Re-hydration (>100 messages)', () => {
    let tempDir;
    let dbManager;
    let dbService;

    test('persists multi-day messages in SQLite and re-hydrates completely without loss', async () => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ollachat-multi-day-test-'));
      dbManager = new DatabaseManager(tempDir);
      await dbManager.openUserDatabase('test-user-multi-day');
      dbService = new DatabaseService({
        databaseManager: dbManager,
        sessionStore: { getSession: () => ({ userId: 'test-user-multi-day' }) }
      });

      const messagesToSave = [];
      const baseDate = new Date('2026-10-18T10:00:00.000Z');
      for (let i = 1; i <= 150; i++) {
        const d = new Date(baseDate.getTime() + i * 3600000);
        messagesToSave.push({
          id: `db-msg-${i}`,
          roomId: 'room-sqlite-test',
          senderId: 'test-user-multi-day',
          body: { text: `SQLite message #${i}` },
          eventSeq: i,
          status: 'sent',
          createdAt: d.toISOString()
        });
      }

      // Persist all 150 messages
      for (const m of messagesToSave) {
        await dbService.saveMessage(m);
      }

      // Re-hydrate using the exact SQLite pagination logic in loadMessagesForRoom
      let dbMsgs = await dbService.getMessages({ roomId: 'room-sqlite-test', limit: 100 });
      let allDbMsgs = Array.isArray(dbMsgs) ? [...dbMsgs] : [];
      let dbBeforeSeq = null;
      if (allDbMsgs.length > 0) {
        for (const m of allDbMsgs) {
          const s = Number(m.eventSeq ?? m.event_seq);
          if (Number.isFinite(s) && (dbBeforeSeq === null || s < dbBeforeSeq)) {
            dbBeforeSeq = s;
          }
        }
      }

      let dbPaging = 0;
      while (dbMsgs && dbMsgs.length >= 100 && dbBeforeSeq !== null && dbBeforeSeq > 1 && dbPaging < 50) {
        dbPaging++;
        dbMsgs = await dbService.getMessages({ roomId: 'room-sqlite-test', limit: 100, beforeSeq: dbBeforeSeq });
        if (Array.isArray(dbMsgs) && dbMsgs.length > 0) {
          allDbMsgs.unshift(...dbMsgs);
          let nextMin = null;
          for (const m of dbMsgs) {
            const s = Number(m.eventSeq ?? m.event_seq);
            if (Number.isFinite(s) && (nextMin === null || s < nextMin)) {
              nextMin = s;
            }
          }
          if (nextMin !== null && nextMin < dbBeforeSeq) {
            dbBeforeSeq = nextMin;
          } else {
            break;
          }
        } else {
          break;
        }
      }

      assert.equal(allDbMsgs.length, 150, 'All 150 messages must be re-hydrated from SQLite');
      assert.equal(allDbMsgs[0].event_seq, 1, 'First message must be sequence 1');
      assert.equal(allDbMsgs[149].event_seq, 150, 'Last message must be sequence 150');

      // Test simulated app restart: close database and re-open cleanly
      await dbManager.close();

      const newDbManager = new DatabaseManager(tempDir);
      await newDbManager.openUserDatabase('test-user-multi-day');
      const newDbService = new DatabaseService({
        databaseManager: newDbManager,
        sessionStore: { getSession: () => ({ userId: 'test-user-multi-day' }) }
      });

      const reloadedBatch = await newDbService.getMessages({ roomId: 'room-sqlite-test', limit: 100 });
      assert.equal(reloadedBatch.length, 100, 'First page of restart re-hydration returns 100 messages');
      assert.equal(reloadedBatch[99].event_seq, 150, 'Newest message is seq 150');

      await newDbManager.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 4. Chronological Sorting & Day Dividers across Multiple Days
  // ─────────────────────────────────────────────────────────────────────────
  describe('4. Chronological Sorting and Day Dividers', () => {
    test('groups messages across multiple calendar days with correct headers', () => {
      const fixedNow = new Date('2026-10-23T12:00:00.000Z');

      const messages = [
        // 5 days ago: 2026-10-18
        { id: 'm1', eventSeq: 1, createdAt: '2026-10-18T10:00:00.000Z', body: { text: 'Hello' } },
        { id: 'm2', eventSeq: 2, createdAt: '2026-10-18T11:00:00.000Z', body: { text: 'Day 1 msg 2' } },
        // 2 days ago: 2026-10-21
        { id: 'm3', eventSeq: 3, createdAt: '2026-10-21T09:00:00.000Z', body: { text: 'Day 2 msg 1' } },
        // Yesterday: 2026-10-22
        { id: 'm4', eventSeq: 4, createdAt: '2026-10-22T15:00:00.000Z', body: { text: 'Yesterday msg' } },
        // Today: 2026-10-23
        { id: 'm5', eventSeq: 5, createdAt: '2026-10-23T08:00:00.000Z', body: { text: 'Today msg 1' } },
        { id: 'm6', eventSeq: 6, createdAt: '2026-10-23T11:00:00.000Z', body: { text: 'Today msg 2' } }
      ];

      const groups = groupMessagesByDay(messages, fixedNow);

      assert.equal(groups.length, 4, 'Must create 4 separate day groups');
      assert.equal(groups[0].messages.length, 2);
      assert.equal(groups[1].messages.length, 1);
      assert.equal(groups[2].messages.length, 1);
      assert.equal(groups[3].messages.length, 2);

      // Verify labels
      assert.match(groups[0].label, /Oct 18/);
      assert.match(groups[1].label, /Oct 21/);
      assert.equal(groups[2].label, 'Yesterday');
      assert.equal(groups[3].label, 'Today');
    });

    test('RoomMessagesState merges out-of-order batches into strictly sorted chronological order', () => {
      const state = new RoomMessagesState('test-room', 'user-1');

      // Batch 1 (latest messages from today)
      state.mergeServerMessages([
        { id: 'm4', eventSeq: 40, createdAt: '2026-10-23T10:00:00Z', body: { text: 'Today 1' } },
        { id: 'm5', eventSeq: 50, createdAt: '2026-10-23T11:00:00Z', body: { text: 'Today 2' } }
      ], true);

      assert.equal(state.messages.length, 2);
      assert.equal(state.oldestSeq, 40);
      assert.equal(state.newestSeq, 50);

      // Batch 2 (older messages from yesterday and previous days)
      state.mergeServerMessages([
        { id: 'm1', eventSeq: 10, createdAt: '2026-10-20T10:00:00Z', body: { text: 'Old 1' } },
        { id: 'm2', eventSeq: 20, createdAt: '2026-10-21T10:00:00Z', body: { text: 'Old 2' } },
        { id: 'm3', eventSeq: 30, createdAt: '2026-10-22T10:00:00Z', body: { text: 'Yesterday' } }
      ], false);

      assert.equal(state.messages.length, 5);
      // Strictly chronological
      assert.equal(state.messages[0].id, 'm1');
      assert.equal(state.messages[1].id, 'm2');
      assert.equal(state.messages[2].id, 'm3');
      assert.equal(state.messages[3].id, 'm4');
      assert.equal(state.messages[4].id, 'm5');
      assert.equal(state.oldestSeq, 10);
      assert.equal(state.newestSeq, 50);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 5. Switching chats does not lose older messages
  // ─────────────────────────────────────────────────────────────────────────
  describe('5. Chat Switching State Isolation', () => {
    test('switching between conversations preserves full historical message sets in memory', () => {
      const roomA = new RoomMessagesState('room-A', 'user-1');
      const roomB = new RoomMessagesState('room-B', 'user-1');

      // Room A has 100 historical messages
      const msgsA = [];
      for (let i = 1; i <= 100; i++) {
        msgsA.push({ id: `a-${i}`, eventSeq: i, createdAt: `2026-10-${String(10 + Math.floor(i / 10)).padStart(2, '0')}T10:00:00Z` });
      }
      roomA.mergeServerMessages(msgsA, false);
      roomA.isHistoryLoaded = true;

      // Room B has 50 historical messages
      const msgsB = [];
      for (let i = 1; i <= 50; i++) {
        msgsB.push({ id: `b-${i}`, eventSeq: i, createdAt: `2026-10-${String(15 + Math.floor(i / 10)).padStart(2, '0')}T10:00:00Z` });
      }
      roomB.mergeServerMessages(msgsB, false);
      roomB.isHistoryLoaded = true;

      // Assert Room A still has 100 messages and Room B has 50
      assert.equal(roomA.messages.length, 100);
      assert.equal(roomA.oldestSeq, 1);
      assert.equal(roomA.newestSeq, 100);

      assert.equal(roomB.messages.length, 50);
      assert.equal(roomB.oldestSeq, 1);
      assert.equal(roomB.newestSeq, 50);
    });
  });
});
