import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { DatabaseService } from '../src/storage/db/database-service.js';
import { RoomMessagesState, REACTION_EMOJIS } from '../src/renderer/chat-shell-state.js';
import { ChatApi } from '../src/api/chat-api.js';
import { ChatWebSocket } from '../src/chat/chat-websocket.js';
import { sqliteRowToMessage, messageToSqlitePayload } from '../src/renderer/db-sync.js';

describe('Message Reactions Suite (OllaChat Windows Desktop)', () => {
  let tmpDir;
  let dbService;
  let mockSessionStore;
  const currentUserId = 'user-alice';
  const peerUserId = 'user-bob';
  const otherUserId = 'user-charlie';
  const roomId = 'room-101';
  const messageId = 'msg-555';

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), 'ollachat-reactions-test-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8));
    await fs.mkdir(tmpDir, { recursive: true });
    mockSessionStore = {
      currentSession: { userId: currentUserId },
      getSession() {
        return this.currentSession;
      }
    };
    dbService = new DatabaseService({
      storageDir: tmpDir,
      sessionStore: mockSessionStore
    });
  });

  afterEach(async () => {
    if (dbService && dbService.databaseManager?.isOpen) {
      await dbService.databaseManager.close();
    }
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  // ═════════════════════════════════════════════════════════════════
  // 1. In-Memory State Tests
  // ═════════════════════════════════════════════════════════════════
  describe('In-Memory State (RoomMessagesState & Reactions)', () => {
    test('adds a reaction to a message', () => {
      const state = new RoomMessagesState(roomId, currentUserId);
      state.messages = [
        { id: messageId, roomId, senderId: peerUserId, body: { text: 'Hello' } }
      ];

      const success = state.updateReaction(messageId, currentUserId, '❤️', true);
      assert.equal(success, true);

      const msg = state.messages.find(m => m.id === messageId);
      assert.ok(msg.reactions);
      assert.deepEqual(msg.reactions['❤️'], [currentUserId]);
    });

    test('multiple users reacting with the same emoji aggregates into one list with correct count', () => {
      const state = new RoomMessagesState(roomId, currentUserId);
      state.messages = [
        { id: messageId, roomId, senderId: peerUserId, body: { text: 'Hello' } }
      ];

      state.updateReaction(messageId, currentUserId, '👍', true);
      state.updateReaction(messageId, peerUserId, '👍', true);
      state.updateReaction(messageId, otherUserId, '👍', true);

      const msg = state.messages.find(m => m.id === messageId);
      assert.equal(msg.reactions['👍'].length, 3);
      assert.ok(msg.reactions['👍'].includes(currentUserId));
      assert.ok(msg.reactions['👍'].includes(peerUserId));
      assert.ok(msg.reactions['👍'].includes(otherUserId));
    });

    test('removes a user reaction without affecting other users', () => {
      const state = new RoomMessagesState(roomId, currentUserId);
      state.messages = [
        { id: messageId, roomId, senderId: peerUserId, body: { text: 'Hello' } }
      ];

      state.updateReaction(messageId, currentUserId, '😂', true);
      state.updateReaction(messageId, peerUserId, '😂', true);

      // Remove current user's reaction
      const removed = state.updateReaction(messageId, currentUserId, '😂', false);
      assert.equal(removed, true);

      const msg = state.messages.find(m => m.id === messageId);
      assert.deepEqual(msg.reactions['😂'], [peerUserId]);
    });

    test('deletes the emoji key when the last user reaction is removed', () => {
      const state = new RoomMessagesState(roomId, currentUserId);
      state.messages = [
        { id: messageId, roomId, senderId: peerUserId, body: { text: 'Hello' } }
      ];

      state.updateReaction(messageId, currentUserId, '🔥', true);
      state.updateReaction(messageId, currentUserId, '🔥', false);

      const msg = state.messages.find(m => m.id === messageId);
      assert.equal(msg.reactions['🔥'], undefined);
    });

    test('duplicate addReaction calls do not create duplicate entries or inflate counts', () => {
      const state = new RoomMessagesState(roomId, currentUserId);
      state.messages = [
        { id: messageId, roomId, senderId: peerUserId, body: { text: 'Hello' } }
      ];

      state.updateReaction(messageId, currentUserId, '🙏', true);
      state.updateReaction(messageId, currentUserId, '🙏', true);

      const msg = state.messages.find(m => m.id === messageId);
      assert.equal(msg.reactions['🙏'].length, 1);
    });

    test('matches message by clientMessageId or client_message_id', () => {
      const state = new RoomMessagesState(roomId, currentUserId);
      state.messages = [
        { clientMessageId: 'client-999', roomId, senderId: currentUserId, body: { text: 'Optimistic' } }
      ];

      const success = state.updateReaction('client-999', currentUserId, '😮', true);
      assert.equal(success, true);

      const msg = state.messages.find(m => m.clientMessageId === 'client-999');
      assert.deepEqual(msg.reactions['😮'], [currentUserId]);
    });

    test('enforces limit of 20 distinct emojis per message', () => {
      const state = new RoomMessagesState(roomId, currentUserId);
      state.messages = [
        { id: messageId, roomId, senderId: peerUserId, body: { text: 'Hello' } }
      ];

      // Add 20 distinct emojis
      for (let i = 0; i < 20; i++) {
        const emoji = String.fromCodePoint(0x1F600 + i);
        const res = state.updateReaction(messageId, currentUserId, emoji, true);
        assert.equal(res, true);
      }

      // 21st distinct emoji should be rejected
      const rejected = state.updateReaction(messageId, currentUserId, '🎉', true);
      assert.equal(rejected, false);

      // But adding another user to an existing emoji should succeed
      const allowedExisting = state.updateReaction(messageId, peerUserId, String.fromCodePoint(0x1F600), true);
      assert.equal(allowedExisting, true);
    });
  });

  // ═════════════════════════════════════════════════════════════════
  // 2. Database Persistence Tests
  // ═════════════════════════════════════════════════════════════════
  describe('Database Persistence (SQLite & Migrations)', () => {
    test('persists message with reactions JSON blob and reloads it', async () => {
      await dbService.saveConversation({
        roomId,
        peerUserId,
        kind: 'direct',
        displayName: 'Bob'
      });

      const msgData = {
        id: messageId,
        roomId,
        senderId: peerUserId,
        body: { text: 'Testing persistence' },
        reactions: {
          '❤️': [currentUserId, peerUserId],
          '👍': [otherUserId]
        }
      };

      await dbService.saveMessage(msgData);

      // Fetch messages from database
      const rows = await dbService.getMessages({ roomId });
      assert.ok(rows.length > 0);
      const loaded = rows.find(m => m.id === messageId);
      assert.ok(loaded);
      assert.ok(loaded.reactions);
      assert.deepEqual(loaded.reactions['❤️'], [currentUserId, peerUserId]);
      assert.deepEqual(loaded.reactions['👍'], [otherUserId]);
    });

    test('updateMessageReaction adds and removes reactions in SQLite', async () => {
      await dbService.saveConversation({
        roomId,
        peerUserId,
        kind: 'direct',
        displayName: 'Bob'
      });

      await dbService.saveMessage({
        id: messageId,
        roomId,
        senderId: peerUserId,
        body: { text: 'Hello' }
      });

      // Add reaction via updateMessageReaction
      await dbService.updateMessageReaction({
        roomId,
        messageId,
        userId: currentUserId,
        emoji: '🔥',
        isAdd: true
      });

      let rows = await dbService.getMessages({ roomId });
      let loaded = rows.find(m => m.id === messageId);
      assert.deepEqual(loaded.reactions?.['🔥'], [currentUserId]);

      // Add peer reaction
      await dbService.updateMessageReaction({
        roomId,
        messageId,
        userId: peerUserId,
        emoji: '🔥',
        isAdd: true
      });

      rows = await dbService.getMessages({ roomId });
      loaded = rows.find(m => m.id === messageId);
      assert.equal(loaded.reactions?.['🔥']?.length, 2);

      // Remove current user reaction
      await dbService.updateMessageReaction({
        roomId,
        messageId,
        userId: currentUserId,
        emoji: '🔥',
        isAdd: false
      });

      rows = await dbService.getMessages({ roomId });
      loaded = rows.find(m => m.id === messageId);
      assert.deepEqual(loaded.reactions?.['🔥'], [peerUserId]);
    });

    test('survives database force-close and reopening without losing reactions', async () => {
      await dbService.saveConversation({
        roomId,
        peerUserId,
        kind: 'direct',
        displayName: 'Bob'
      });

      await dbService.saveMessage({
        id: messageId,
        roomId,
        senderId: peerUserId,
        body: { text: 'Persistent message' },
        reactions: {
          '🙏': [currentUserId]
        }
      });

      // Close the database connection
      await dbService.databaseManager.close();

      // Create new DatabaseService instance pointing to the same directory
      const reopenedDb = new DatabaseService({
        storageDir: tmpDir,
        sessionStore: mockSessionStore
      });

      const rows = await reopenedDb.getMessages({ roomId });
      const loaded = rows.find(m => m.id === messageId);
      assert.ok(loaded);
      assert.deepEqual(loaded.reactions?.['🙏'], [currentUserId]);

      await reopenedDb.databaseManager.close();
    });

    test('getMessageReactions returns normalized list of reactions', async () => {
      await dbService.saveConversation({
        roomId,
        peerUserId,
        kind: 'direct',
        displayName: 'Bob'
      });

      await dbService.saveMessage({
        id: messageId,
        roomId,
        senderId: peerUserId,
        body: { text: 'Hello' }
      });

      await dbService.updateMessageReaction({
        roomId,
        messageId,
        userId: currentUserId,
        emoji: '👍',
        isAdd: true
      });

      const queryRes = await dbService.getMessageReactions({ roomId, messageId });
      assert.ok(queryRes.reactions);
      assert.deepEqual(queryRes.reactions['👍'], [currentUserId]);
    });

    test('handles message with no reactions gracefully', async () => {
      await dbService.saveConversation({
        roomId,
        peerUserId,
        kind: 'direct',
        displayName: 'Bob'
      });

      await dbService.saveMessage({
        id: 'msg-no-reactions',
        roomId,
        senderId: peerUserId,
        body: { text: 'No reactions here' }
      });

      const rows = await dbService.getMessages({ roomId });
      const loaded = rows.find(m => m.id === 'msg-no-reactions');
      assert.ok(loaded);
      assert.equal(loaded.reactions, null);
    });
  });

  // ═════════════════════════════════════════════════════════════════
  // 3. Serialization & Sync Helpers
  // ═════════════════════════════════════════════════════════════════
  describe('db-sync Serialization & Deserialization', () => {
    test('messageToSqlitePayload preserves reactions field', () => {
      const msg = {
        id: 'm1',
        roomId: 'r1',
        senderId: 'u1',
        body: { text: 'test' },
        reactions: { '❤️': ['u1', 'u2'] }
      };

      const payload = messageToSqlitePayload(msg);
      assert.deepEqual(payload.reactions, { '❤️': ['u1', 'u2'] });
    });

    test('sqliteRowToMessage correctly restores reactions from reactions column or body_json', () => {
      const row = {
        id: 'm1',
        room_id: 'r1',
        sender_id: 'u1',
        body_json: JSON.stringify({ text: 'test' }),
        reactions: JSON.stringify({ '👍': ['u2'] })
      };

      const restored = sqliteRowToMessage(row);
      assert.ok(restored);
      assert.deepEqual(restored.reactions, { '👍': ['u2'] });
    });
  });

  // ═════════════════════════════════════════════════════════════════
  // 4. REST API & WebSocket Protocol Tests
  // ═════════════════════════════════════════════════════════════════
  describe('REST API & WebSocket Protocol Integration', () => {
    test('chatApi.addReaction sends POST with JSON emoji body to correct endpoint', async () => {
      const calls = [];
      const mockFetch = async (url, options) => {
        calls.push({ url, options, body: JSON.parse(options.body) });
        return {
          status: 200,
          ok: true,
          headers: new Headers({ 'content-type': 'application/json' }),
          text: async () => JSON.stringify({ success: true })
        };
      };

      const api = new ChatApi({
        baseUrl: 'https://api.test.local/v1',
        sessionToken: 'test-token',
        fetchFn: mockFetch
      });

      await api.addReaction('room-token-123', roomId, messageId, '❤️');

      assert.equal(calls.length, 1);
      assert.equal(calls[0].options.method, 'POST');
      assert.equal(calls[0].url, `https://api.test.local/v1/rooms/${roomId}/messages/${messageId}/reactions`);
      assert.deepEqual(calls[0].body, { emoji: '❤️' });
    });

    test('chatApi.removeReaction sends DELETE with JSON emoji body to correct endpoint', async () => {
      const calls = [];
      const mockFetch = async (url, options) => {
        calls.push({ url, options, body: JSON.parse(options.body) });
        return {
          status: 200,
          ok: true,
          headers: new Headers({ 'content-type': 'application/json' }),
          text: async () => JSON.stringify({ success: true })
        };
      };

      const api = new ChatApi({
        baseUrl: 'https://api.test.local/v1',
        sessionToken: 'test-token',
        fetchFn: mockFetch
      });

      await api.removeReaction('room-token-123', roomId, messageId, '❤️');

      assert.equal(calls.length, 1);
      assert.equal(calls[0].options.method, 'DELETE');
      assert.equal(calls[0].url, `https://api.test.local/v1/rooms/${roomId}/messages/${messageId}/reactions`);
      assert.deepEqual(calls[0].body, { emoji: '❤️' });
    });

    test('chatWebSocket emits reaction.added and reaction.removed when server events arrive', async () => {
      class MockWS {
        static instances = [];
        constructor() {
          this.readyState = 0;
          this.sentData = [];
          this.onopen = null;
          this.onmessage = null;
          this.onclose = null;
          this.onerror = null;
          MockWS.instances.push(this);
        }
        send(data) {
          this.sentData.push(data);
        }
        close() {
          this.readyState = 3;
          if (this.onclose) this.onclose({ code: 1000, reason: '' });
        }
        simulateOpen() {
          this.readyState = 1;
          if (this.onopen) this.onopen();
        }
        simulateMessage(data) {
          const raw = typeof data === 'string' ? data : JSON.stringify(data);
          if (this.onmessage) this.onmessage({ data: raw });
        }
      }

      const ws = new ChatWebSocket({
        token: 'token_123',
        WebSocketClass: MockWS
      });

      await ws.connect();
      const mockSocket = MockWS.instances[MockWS.instances.length - 1];
      mockSocket.simulateOpen();

      let addedEvent = null;
      let removedEvent = null;

      ws.on('reaction.added', (e) => { addedEvent = e; });
      ws.on('reaction.removed', (e) => { removedEvent = e; });

      mockSocket.simulateMessage({
        type: 'reaction.added',
        room_id: roomId,
        payload: {
          message_id: messageId,
          principal_id: currentUserId,
          emoji: '👍'
        }
      });

      assert.deepEqual(addedEvent, {
        roomId,
        messageId,
        principalId: currentUserId,
        emoji: '👍'
      });

      mockSocket.simulateMessage({
        type: 'reaction.removed',
        room_id: roomId,
        payload: {
          message_id: messageId,
          principal_id: currentUserId,
          emoji: '👍'
        }
      });

      assert.deepEqual(removedEvent, {
        roomId,
        messageId,
        principalId: currentUserId,
        emoji: '👍'
      });

      ws.disconnect();
    });

    test('outgoing reaction.add and reaction.remove frames have valid format', async () => {
      class MockWS {
        static instances = [];
        constructor() {
          this.readyState = 0;
          this.sentData = [];
          this.onopen = null;
          this.onmessage = null;
          this.onclose = null;
          this.onerror = null;
          MockWS.instances.push(this);
        }
        send(data) {
          this.sentData.push(data);
        }
        close() {
          this.readyState = 3;
          if (this.onclose) this.onclose({ code: 1000, reason: '' });
        }
        simulateOpen() {
          this.readyState = 1;
          if (this.onopen) this.onopen();
        }
      }

      const ws = new ChatWebSocket({
        token: 'token_123',
        WebSocketClass: MockWS
      });
      await ws.connect();
      const mockSocket = MockWS.instances[MockWS.instances.length - 1];
      mockSocket.simulateOpen();

      ws.addReaction(roomId, messageId, '❤️');
      ws.removeReaction(roomId, messageId, '❤️');

      const sentFrames = mockSocket.sentData.map(d => JSON.parse(d));
      assert.equal(sentFrames.length, 2);
      assert.equal(sentFrames[0].type, 'reaction.add');
      assert.equal(sentFrames[0].room_id, roomId);
      assert.equal(sentFrames[0].payload.message_id, messageId);
      assert.equal(sentFrames[0].payload.emoji, '❤️');

      assert.equal(sentFrames[1].type, 'reaction.remove');
      assert.equal(sentFrames[1].room_id, roomId);
      assert.equal(sentFrames[1].payload.message_id, messageId);
      assert.equal(sentFrames[1].payload.emoji, '❤️');

      ws.disconnect();
    });
  });

  // ═════════════════════════════════════════════════════════════════
  // 5. UI Reaction Helpers Tests
  // ═════════════════════════════════════════════════════════════════
  describe('UI Reaction Helpers', () => {
    test('REACTION_EMOJIS contains the standard WhatsApp emoji set', () => {
      assert.ok(Array.isArray(REACTION_EMOJIS));
      assert.ok(REACTION_EMOJIS.includes('👍'));
      assert.ok(REACTION_EMOJIS.includes('❤️'));
      assert.ok(REACTION_EMOJIS.includes('😂'));
      assert.ok(REACTION_EMOJIS.includes('😮'));
      assert.ok(REACTION_EMOJIS.includes('😢'));
      assert.ok(REACTION_EMOJIS.includes('🙏'));
    });
  });
});
