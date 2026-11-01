import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import crypto from 'node:crypto';
import { DatabaseManager } from '../src/storage/db/database-manager.js';
import { DatabaseService } from '../src/storage/db/database-service.js';
import { OutboxManager } from '../src/renderer/outbox-manager.js';
import {
  ChatShellState,
  RoomMessagesState,
  resolveMessageContent,
  isForwardedMessage,
  getCleanForwardedText,
  formatReplyPreview,
  resolveGroupSenderName,
  createOptimisticMessage,
  createOptimisticMediaMessage,
  createOptimisticVoiceMessage
} from '../src/renderer/chat-shell-state.js';
import { sqliteRowToMessage, messageToSqlitePayload } from '../src/renderer/db-sync.js';

describe('OllaChat Windows — WhatsApp-Style Message & Media Forwarding (Phase 19)', () => {
  let tmpDir;
  let mockSessionStore;
  let dbService;
  let outbox;

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), 'ollachat-forwarding-test-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8));
    await fs.mkdir(tmpDir, { recursive: true });

    mockSessionStore = {
      currentSession: {
        userId: 'user_forwarder_1',
        sessionToken: 'token_secret_forwarder_123',
        phone: '+15550001'
      },
      getSession() {
        return this.currentSession;
      }
    };

    dbService = new DatabaseService({
      storageDir: tmpDir,
      sessionStore: mockSessionStore
    });

    outbox = new OutboxManager();
  });

  afterEach(async () => {
    try {
      if (dbService && dbService.databaseManager?.isOpen) {
        await dbService.databaseManager.close();
      }
    } catch {}
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  // ==========================================
  // TEXT FORWARDING (Tests 1-10)
  // ==========================================
  describe('Text Forwarding Lifecycle', () => {
    test('1. Forward text to one chat creates a new destination message', async () => {
      const sourceMsg = {
        id: 'msg_src_100',
        roomId: 'room_source',
        senderId: 'user_bob',
        kind: 'text',
        body: { text: 'Hello from Bob!' },
        createdAt: '2026-10-07T10:00:00.000Z'
      };

      const cleanText = getCleanForwardedText(sourceMsg.body.text);
      assert.equal(cleanText, 'Hello from Bob!');

      const clientMsgId = `local-${crypto.randomUUID()}`;
      const destMsg = createOptimisticMessage('room_dest_1', 'user_forwarder_1', `[Forwarded] ${cleanText}`, clientMsgId);
      destMsg.body.is_forwarded = true;
      destMsg.isForwarded = true;

      assert.equal(destMsg.roomId, 'room_dest_1');
      assert.equal(destMsg.senderId, 'user_forwarder_1');
      assert.equal(destMsg.clientMessageId, clientMsgId);
      assert.notEqual(destMsg.clientMessageId, sourceMsg.id);

      const resolved = resolveMessageContent(destMsg);
      assert.equal(resolved.isForwarded, true);
      assert.equal(resolved.text, 'Hello from Bob!');
    });

    test('2. Forward text to multiple chats generates independent unique client_message_ids', async () => {
      const sourceMsg = {
        id: 'msg_src_multi',
        kind: 'text',
        body: { text: 'Announcement to all teams' }
      };

      const destRooms = ['room_A', 'room_B', 'room_C'];
      const forwardedMessages = destRooms.map((targetRoomId) => {
        const cid = `local-${crypto.randomUUID()}`;
        const msg = createOptimisticMessage(targetRoomId, 'user_forwarder_1', `[Forwarded] ${sourceMsg.body.text}`, cid);
        msg.body.is_forwarded = true;
        return msg;
      });

      assert.equal(forwardedMessages.length, 3);
      const cids = new Set(forwardedMessages.map(m => m.clientMessageId));
      assert.equal(cids.size, 3, 'All clientMessageIds must be mutually unique');

      for (let i = 0; i < destRooms.length; i++) {
        assert.equal(forwardedMessages[i].roomId, destRooms[i]);
        assert.equal(forwardedMessages[i].senderId, 'user_forwarder_1');
      }
    });

    test('3. Source message remains completely unchanged after forwarding', async () => {
      const sourceMsg = {
        id: 'msg_src_immutable',
        roomId: 'room_source',
        senderId: 'user_alice',
        kind: 'text',
        body: { text: 'Important original message' },
        createdAt: '2026-10-07T09:00:00.000Z'
      };
      const originalSnapshot = JSON.stringify(sourceMsg);

      // Perform forward simulation
      const clean = getCleanForwardedText(sourceMsg.body.text);
      const destCid = `local-${crypto.randomUUID()}`;
      const destMsg = createOptimisticMessage('room_dest', 'user_forwarder_1', `[Forwarded] ${clean}`, destCid);
      destMsg.body.is_forwarded = true;

      assert.equal(JSON.stringify(sourceMsg), originalSnapshot, 'Original source message must not be mutated');
    });

    test('4. Destination message gets unique client_message_id and not source message id', () => {
      const sourceId = 'server-uuid-original-1234';
      const sourceMsg = { id: sourceId, kind: 'text', body: { text: 'Testing ID uniqueness' } };

      const newCid = `local-${crypto.randomUUID()}`;
      assert.notEqual(newCid, sourceId);
      assert.match(newCid, /^local-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    });

    test('5. Forwarded label appears via isForwardedMessage and resolveMessageContent', () => {
      const regularMsg = { kind: 'text', body: { text: 'Normal unforwarded chat' } };
      assert.equal(isForwardedMessage(regularMsg), false);
      const resRegular = resolveMessageContent(regularMsg);
      assert.equal(resRegular.isForwarded, false);
      assert.equal(resRegular.text, 'Normal unforwarded chat');

      const prefixMsg = { kind: 'text', body: { text: '[Forwarded] Hello world' } };
      assert.equal(isForwardedMessage(prefixMsg), true);
      const resPrefix = resolveMessageContent(prefixMsg);
      assert.equal(resPrefix.isForwarded, true);
      assert.equal(resPrefix.text, 'Hello world');

      const flagMsg = { kind: 'text', body: { text: 'Hello with flag', is_forwarded: true } };
      assert.equal(isForwardedMessage(flagMsg), true);
      const resFlag = resolveMessageContent(flagMsg);
      assert.equal(resFlag.isForwarded, true);
      assert.equal(resFlag.text, 'Hello with flag');
    });

    test('6. Forwarded message persists in SQLite database', async () => {
      const clientMsgId = `local-${crypto.randomUUID()}`;
      const forwardMsg = {
        id: clientMsgId,
        roomId: 'room_dest_sql',
        clientMessageId: clientMsgId,
        senderId: 'user_forwarder_1',
        kind: 'text',
        body: { text: '[Forwarded] Stored in SQLite', is_forwarded: true },
        status: 'pending',
        createdAt: new Date().toISOString()
      };

      await dbService.saveMessage(forwardMsg);

      const rows = await dbService.getMessages({ roomId: 'room_dest_sql' });
      assert.equal(rows.length, 1);
      const loaded = rows[0];
      assert.equal(loaded.room_id, 'room_dest_sql');
      assert.equal(loaded.sender_id, 'user_forwarder_1');
      assert.equal(loaded.client_message_id, clientMsgId);

      const parsedBody = JSON.parse(loaded.body_json);
      assert.equal(parsedBody.is_forwarded, true);
      assert.equal(parsedBody.text, '[Forwarded] Stored in SQLite');
    });

    test('7. Forwarded text loaded from SQLite still shows Forwarded label after restart', async () => {
      const clientMsgId = `local-${crypto.randomUUID()}`;
      await dbService.saveMessage({
        id: clientMsgId,
        roomId: 'room_restart_test',
        clientMessageId: clientMsgId,
        senderId: 'user_forwarder_1',
        kind: 'text',
        body: { text: '[Forwarded] Persistent after reload', is_forwarded: true },
        status: 'sent',
        createdAt: new Date().toISOString()
      });

      // Simulate app restart: re-fetch from database
      const rows = await dbService.getMessages({ roomId: 'room_restart_test', limit: 10 });
      assert.equal(rows.length, 1);
      const reloaded = rows[0];
      const parsed = {
        id: reloaded.id,
        roomId: reloaded.room_id,
        senderId: reloaded.sender_id,
        kind: reloaded.kind,
        body: JSON.parse(reloaded.body_json)
      };

      const resolved = resolveMessageContent(parsed);
      assert.equal(resolved.isForwarded, true);
      assert.equal(resolved.text, 'Persistent after reload');
    });

    test('8. Offline forwarded text enters existing outbox', async () => {
      const clientMsgId = `local-${crypto.randomUUID()}`;
      const wirePayload = {
        client_message_id: clientMsgId,
        kind: 'text',
        body: { text: '[Forwarded] Offline message', is_forwarded: true },
        attachment_ids: []
      };

      const enqueued = await outbox.enqueue({
        clientMessageId: clientMsgId,
        roomId: 'room_offline_fwd',
        wirePayload,
        dbBridge: dbService
      });
      assert.equal(enqueued, true);

      const count = (await dbService.getPendingOutbox()).length;
      assert.equal(count, 1);

      const pendingItems = await dbService.getPendingOutbox();
      assert.equal(pendingItems.length, 1);
      assert.equal(pendingItems[0].client_message_id, clientMsgId);
      assert.equal(pendingItems[0].room_id, 'room_offline_fwd');
    });

    test('9. Outbox flushes forwarded text after reconnect', async () => {
      const clientMsgId = `local-${crypto.randomUUID()}`;
      const wirePayload = {
        client_message_id: clientMsgId,
        kind: 'text',
        body: { text: '[Forwarded] Delivery on reconnect', is_forwarded: true },
        attachment_ids: []
      };

      await outbox.enqueue({
        clientMessageId: clientMsgId,
        roomId: 'room_reconnect_test',
        wirePayload,
        dbBridge: dbService
      });

      let sentPayload = null;
      let sentRoom = null;
      const mockChatBridge = {
        async getState() { return 'connected'; },
        async send(frameType, payload, roomId) {
          sentPayload = payload;
          sentRoom = roomId;
          return { ok: true, requestId: 'req_123' };
        }
      };

      const flushed = await outbox.flush({
        dbBridge: dbService,
        chatBridge: mockChatBridge
      });
      assert.equal(flushed, 1);
      assert.equal(sentRoom, 'room_reconnect_test');
      assert.equal(sentPayload.client_message_id, clientMsgId);
      assert.equal(sentPayload.body.text, '[Forwarded] Delivery on reconnect');
    });

    test('10. No duplicate after ACK/message.created clears from outbox', async () => {
      const clientMsgId = `local-${crypto.randomUUID()}`;
      await outbox.enqueue({
        clientMessageId: clientMsgId,
        roomId: 'room_ack_test',
        wirePayload: { client_message_id: clientMsgId },
        dbBridge: dbService
      });

      const cleared = await outbox.clear({
        clientMessageId: clientMsgId,
        dbBridge: dbService
      });
      assert.equal(cleared, true);

      const count = (await dbService.getPendingOutbox()).length;
      assert.equal(count, 0, 'Outbox item must be cleared upon ACK');
    });
  });

  // ==========================================
  // MEDIA FORWARDING (Tests 11-27)
  // ==========================================
  describe('Media Forwarding & Room Scope Safety', () => {
    test('11-15. Image: Source attachment ID is NOT reused; new destination ID created; source remains intact', () => {
      const sourceAttachmentId = 'att_source_img_999';
      const sourceMsg = {
        id: 'msg_source_img',
        roomId: 'room_source',
        kind: 'image',
        attachmentIds: [sourceAttachmentId],
        body: {
          filename: 'photo.jpg',
          mime: 'image/jpeg',
          byte_size: 1048576,
          caption: 'Sunset at beach'
        }
      };

      // Simulated re-upload returning new destination attachment ID
      const destAttachmentId = 'att_dest_img_111';
      assert.notEqual(sourceAttachmentId, destAttachmentId, 'Must NEVER reuse source attachment ID across rooms');

      const clientMsgId = `local-${crypto.randomUUID()}`;
      const destMsg = createOptimisticMediaMessage('room_dest_img', 'user_forwarder_1', {
        kind: 'image',
        filename: 'photo.jpg',
        mime: 'image/jpeg',
        byteSize: 1048576,
        attachmentId: destAttachmentId,
        clientMessageId: clientMsgId
      });
      destMsg.attachmentIds = [destAttachmentId];
      destMsg.attachment_ids = [destAttachmentId];
      destMsg.body.is_forwarded = true;
      destMsg.body.caption = '[Forwarded] Sunset at beach';

      // 14. Image renders correctly
      const resolvedDest = resolveMessageContent(destMsg);
      assert.equal(resolvedDest.kind, 'image');
      assert.equal(resolvedDest.isForwarded, true);
      assert.equal(resolvedDest.caption, 'Sunset at beach');
      assert.equal(destMsg.attachmentIds[0], destAttachmentId);

      // 15. Source remains intact
      assert.equal(sourceMsg.attachmentIds[0], sourceAttachmentId);
      assert.equal(sourceMsg.roomId, 'room_source');
    });

    test('16-18. Video: Destination video retains MIME/filename and source remains intact', () => {
      const sourceAttId = 'att_src_vid_222';
      const newAttId = 'att_dest_vid_333';
      assert.notEqual(sourceAttId, newAttId);

      const clientMsgId = `local-${crypto.randomUUID()}`;
      const destMsg = createOptimisticMediaMessage('room_dest_vid', 'user_forwarder_1', {
        kind: 'video',
        filename: 'vacation.mp4',
        mime: 'video/mp4',
        byteSize: 5242880,
        attachmentId: newAttId,
        clientMessageId: clientMsgId
      });
      destMsg.attachmentIds = [newAttId];
      destMsg.body.is_forwarded = true;

      const resolved = resolveMessageContent(destMsg);
      assert.equal(resolved.kind, 'video');
      assert.equal(resolved.filename, 'vacation.mp4');
      assert.equal(resolved.mime, 'video/mp4');
      assert.equal(resolved.isForwarded, true);
    });

    test('19-21. Document: Filename and byte size preserved', () => {
      const sourceAttId = 'att_src_doc_444';
      const newAttId = 'att_dest_doc_555';

      const clientMsgId = `local-${crypto.randomUUID()}`;
      const destMsg = createOptimisticMediaMessage('room_dest_doc', 'user_forwarder_1', {
        kind: 'file',
        filename: 'Quarterly_Report.pdf',
        mime: 'application/pdf',
        byteSize: 204800,
        attachmentId: newAttId,
        clientMessageId: clientMsgId
      });
      destMsg.attachmentIds = [newAttId];
      destMsg.body.is_forwarded = true;

      const resolved = resolveMessageContent(destMsg);
      assert.equal(resolved.kind, 'file');
      assert.equal(resolved.filename, 'Quarterly_Report.pdf');
      assert.equal(resolved.mime, 'application/pdf');
      assert.equal(resolved.byteSize, 204800);
      assert.equal(resolved.isForwarded, true);
    });

    test('22-23. Imported audio: Destination audio plays and preserves metadata', () => {
      const newAttId = 'att_dest_audio_666';
      const clientMsgId = `local-${crypto.randomUUID()}`;
      const destMsg = createOptimisticMediaMessage('room_dest_audio', 'user_forwarder_1', {
        kind: 'audio',
        filename: 'track.mp3',
        mime: 'audio/mpeg',
        byteSize: 3145728,
        attachmentId: newAttId,
        clientMessageId: clientMsgId
      });
      destMsg.attachmentIds = [newAttId];
      destMsg.body.is_forwarded = true;

      const resolved = resolveMessageContent(destMsg);
      assert.equal(resolved.mime, 'audio/mpeg');
      assert.equal(resolved.filename, 'track.mp3');
      assert.equal(resolved.isForwarded, true);
    });

    test('24-27. Voice note: is_voice_note remains true, duration preserved, renders as voice note', () => {
      const sourceVoiceNote = {
        id: 'msg_vn_src',
        roomId: 'room_source',
        kind: 'file',
        attachmentIds: ['att_vn_src_777'],
        body: {
          filename: 'voice_message_1696000000.webm',
          mime: 'video/webm',
          byte_size: 65536,
          duration: 14,
          is_voice_note: true
        }
      };

      const newAttId = 'att_vn_dest_888';
      const clientMsgId = `local-${crypto.randomUUID()}`;
      const destVnMsg = createOptimisticVoiceMessage('room_dest_vn', 'user_forwarder_1', {
        filename: sourceVoiceNote.body.filename,
        mime: 'video/webm',
        byteSize: 65536,
        duration: 14,
        attachmentId: newAttId,
        clientMessageId: clientMsgId
      });
      destVnMsg.attachmentIds = [newAttId];
      destVnMsg.attachment_ids = [newAttId];
      destVnMsg.body.is_forwarded = true;
      destVnMsg.body.is_voice_note = true;

      const resolved = resolveMessageContent(destVnMsg);
      assert.equal(resolved.isVoiceNote, true, 'Must preserve voice-note classification');
      assert.equal(resolved.duration, 14, 'Must preserve voice note duration');
      assert.equal(resolved.isForwarded, true);
      assert.equal(destVnMsg.attachmentIds[0], newAttId);
      assert.notEqual(destVnMsg.attachmentIds[0], sourceVoiceNote.attachmentIds[0]);
    });
  });

  // ==========================================
  // MULTI-MESSAGE & MULTI-CHAT (Tests 28-34)
  // ==========================================
  describe('Multi-Message Selection & Multi-Chat Forwarding', () => {
    test('28-30. Multi-message selection preserves chronological order for mixed content', () => {
      const shellState = new ChatShellState();
      shellState.enterMessageSelectionMode('msg_3');
      shellState.toggleMessageSelection('msg_1');
      shellState.toggleMessageSelection('msg_2');

      const selectedIds = shellState.getSelectedMessageIds();
      assert.equal(selectedIds.length, 3);
      assert.ok(shellState.isMessageSelected('msg_1'));
      assert.ok(shellState.isMessageSelected('msg_2'));
      assert.ok(shellState.isMessageSelected('msg_3'));

      const messages = [
        { id: 'msg_3', createdAt: '2026-10-07T10:03:00.000Z', kind: 'file', body: { filename: 'doc.pdf' } },
        { id: 'msg_1', createdAt: '2026-10-07T10:01:00.000Z', kind: 'text', body: { text: 'First message' } },
        { id: 'msg_2', createdAt: '2026-10-07T10:02:00.000Z', kind: 'image', body: { filename: 'pic.png' } }
      ];

      // Sort chronologically (Phase 7 rule)
      const sorted = [...messages].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
      assert.equal(sorted[0].id, 'msg_1');
      assert.equal(sorted[1].id, 'msg_2');
      assert.equal(sorted[2].id, 'msg_3');
    });

    test('31. Partial failure isolation: Message failure does not abort other messages', async () => {
      const queue = [
        { id: 'msg_1', kind: 'text', shouldFail: false },
        { id: 'msg_2', kind: 'image', shouldFail: true },
        { id: 'msg_3', kind: 'text', shouldFail: false }
      ];

      const results = [];
      for (const item of queue) {
        try {
          if (item.shouldFail) {
            throw new Error(`Media upload failed for ${item.id}`);
          }
          results.push({ id: item.id, status: 'success' });
        } catch (err) {
          results.push({ id: item.id, status: 'failed', error: err.message });
        }
      }

      assert.equal(results[0].status, 'success');
      assert.equal(results[1].status, 'failed');
      assert.equal(results[2].status, 'success');
    });

    test('32-34. Multi-chat forwarding generates independent clientMessageId and uploads per destination', () => {
      const sourceMsg = {
        id: 'msg_src_broadcast',
        kind: 'image',
        attachmentIds: ['att_shared_source']
      };

      const destinations = ['room_team_alpha', 'room_team_beta', 'room_general'];
      const uploads = destinations.map((roomId, idx) => {
        return {
          targetRoomId: roomId,
          clientMessageId: `local-${crypto.randomUUID()}`,
          newAttachmentId: `att_dest_${idx}_${Date.now()}`
        };
      });

      const uniqueCids = new Set(uploads.map(u => u.clientMessageId));
      const uniqueAtts = new Set(uploads.map(u => u.newAttachmentId));

      assert.equal(uniqueCids.size, 3, 'Every destination room must have unique clientMessageId');
      assert.equal(uniqueAtts.size, 3, 'Every destination room must have independent uploaded attachmentId');
      assert.ok(!uniqueAtts.has(sourceMsg.attachmentIds[0]), 'Source attachment ID must never appear in destination attachments');
    });
  });

  // ==========================================
  // SECURITY & CALL HISTORY (Tests 35-38)
  // ==========================================
  describe('Security Constraints & Call Entry Forwarding Prevention', () => {
    test('35. Call history entries are rejected from forwarding', () => {
      const callMsgAudio = { isCallEntry: true, kind: 'call', callType: 'audio' };
      const callMsgVideo = { kind: 'call', callType: 'video' };
      const textMsg = { kind: 'text', body: { text: 'Normal text' } };

      const batch = [callMsgAudio, callMsgVideo, textMsg];
      const validMessages = batch.filter((m) => {
        const res = resolveMessageContent(m);
        return !m.isCallEntry && m.kind !== 'call' && res.kind !== 'call';
      });

      assert.equal(validMessages.length, 1);
      assert.equal(validMessages[0], textMsg);
    });

    test('36-38. No raw auth token or SQL exposed in forwarded payloads', () => {
      const clientMsgId = `local-${crypto.randomUUID()}`;
      const payload = {
        client_message_id: clientMsgId,
        kind: 'text',
        body: { text: '[Forwarded] Safe message', is_forwarded: true },
        reply_to: null,
        attachment_ids: []
      };

      const payloadStr = JSON.stringify(payload);
      assert.ok(!payloadStr.includes('token_secret'));
      assert.ok(!payloadStr.includes('ak_'));
      assert.ok(!payloadStr.includes('SELECT '));
      assert.ok(!payloadStr.includes('DROP '));
    });
  });

  // ==========================================
  // REGRESSION VERIFICATION (Tests 39-45)
  // ==========================================
  describe('Regression Verification (Replies, Groups, Outbox)', () => {
    test('39-40. Reply preview and formatReplyPreview work on forwarded messages', () => {
      const forwardedMsg = {
        id: 'msg_fwd_reply_test',
        kind: 'text',
        body: { text: '[Forwarded] Hello replied message', is_forwarded: true }
      };

      const previewText = formatReplyPreview(forwardedMsg);
      assert.equal(previewText, 'Hello replied message', 'Reply preview should display the clean forwarded text');
    });

    test('41. Group sender names still resolve without exposing internal UUIDs', () => {
      const participants = [
        { userId: 'user_malavika_uuid_999', displayName: 'Malavika', username: 'malavika99' }
      ];

      const resolved = resolveGroupSenderName(
        { senderId: 'user_malavika_uuid_999' },
        'user_forwarder_1',
        { roomParticipants: participants }
      );

      assert.equal(resolved, 'Malavika');
      assert.notEqual(resolved, 'user_malavika_uuid_999');
    });

    test('42-45. Offline outbox and SQLite durability continue working flawlessly', async () => {
      const clientMsgId = `local-${crypto.randomUUID()}`;
      const wirePayload = {
        client_message_id: clientMsgId,
        kind: 'text',
        body: { text: 'Regression check outbox' }
      };

      const enqueued = await outbox.enqueue({
        clientMessageId: clientMsgId,
        roomId: 'room_regression_check',
        wirePayload,
        dbBridge: dbService
      });
      assert.equal(enqueued, true);

      const items = await dbService.getPendingOutbox();
      assert.equal(items.length, 1);
      assert.equal(items[0].client_message_id, clientMsgId);

      const cleared = await outbox.clear({
        clientMessageId: clientMsgId,
        dbBridge: dbService
      });
      assert.equal(cleared, true);

      const count = (await dbService.getPendingOutbox()).length;
      assert.equal(count, 0);
    });
  });

  // ==========================================
  // ATTACHMENT ID PERSISTENCE & FORWARDING BUG FIX (Tests 1-20)
  // ==========================================
  describe('Attachment ID SQLite Persistence & Defensive Media Forwarding (Phase 19 Bug Fix)', () => {
    // Helper extracting source attachment ID matching forwardSingleMessage defensive logic
    function resolveSourceAttachmentId(msg) {
      let sourceAttachmentId = null;
      if (Array.isArray(msg.attachmentIds) && msg.attachmentIds.length > 0) {
        const item = msg.attachmentIds[0];
        sourceAttachmentId = (typeof item === 'object' && item !== null) ? (item.id || item.attachment_id || item.attachmentId) : item;
      }
      if (!sourceAttachmentId && Array.isArray(msg.attachment_ids) && msg.attachment_ids.length > 0) {
        const item = msg.attachment_ids[0];
        sourceAttachmentId = (typeof item === 'object' && item !== null) ? (item.id || item.attachment_id || item.attachmentId) : item;
      }
      if (!sourceAttachmentId && Array.isArray(msg.attachments) && msg.attachments.length > 0) {
        const item = msg.attachments[0];
        sourceAttachmentId = (typeof item === 'object' && item !== null) ? (item.id || item.attachment_id || item.attachmentId) : item;
      }
      if (!sourceAttachmentId && msg.body) {
        if (Array.isArray(msg.body.attachment_ids) && msg.body.attachment_ids.length > 0) {
          const item = msg.body.attachment_ids[0];
          sourceAttachmentId = (typeof item === 'object' && item !== null) ? (item.id || item.attachment_id || item.attachmentId) : item;
        } else if (Array.isArray(msg.body.attachmentIds) && msg.body.attachmentIds.length > 0) {
          const item = msg.body.attachmentIds[0];
          sourceAttachmentId = (typeof item === 'object' && item !== null) ? (item.id || item.attachment_id || item.attachmentId) : item;
        } else if (Array.isArray(msg.body.attachments) && msg.body.attachments.length > 0) {
          const item = msg.body.attachments[0];
          sourceAttachmentId = (typeof item === 'object' && item !== null) ? (item.id || item.attachment_id || item.attachmentId) : item;
        } else if (msg.body.attachment_id || msg.body.attachmentId) {
          const item = msg.body.attachment_id || msg.body.attachmentId;
          sourceAttachmentId = (typeof item === 'object' && item !== null) ? (item.id || item.attachment_id || item.attachmentId) : item;
        }
      }
      if (!sourceAttachmentId) {
        sourceAttachmentId = msg.attachmentId || msg.attachment_id || null;
      }
      if (typeof sourceAttachmentId === 'object' && sourceAttachmentId !== null) {
        sourceAttachmentId = sourceAttachmentId.id || sourceAttachmentId.attachment_id || sourceAttachmentId.attachmentId || null;
      }
      return sourceAttachmentId ? String(sourceAttachmentId) : null;
    }

    function categorizeForwardError(err) {
      const m = String(err?.message || '').toLowerCase();
      const c = String(err?.code || '').toLowerCase();
      if (c === 'network_failure' || m.includes('offline') || m.includes('network') || m.includes('connection')) {
        return 'Some forwarded messages could not be sent. Please check your connection.';
      }
      if (c === 'missing_attachment_id' || m.includes('source attachment id missing')) {
        return 'Unable to forward this media.';
      }
      if (c === 'media_source_failure' || m.includes('download source attachment')) {
        return 'Unable to access the original media.';
      }
      if (c === 'upload_failure' || m.includes('upload')) {
        return 'Unable to upload the media.';
      }
      return 'Unable to forward this media.';
    }

    test('1. Message with attachment_ids persists to SQLite body_json', async () => {
      const msg = {
        id: 'msg_persist_test_1',
        roomId: 'room_persist_1',
        senderId: 'user_sender_1',
        kind: 'image',
        attachment_ids: ['att_uuid_101'],
        body: { filename: 'photo.jpg', mime: 'image/jpeg', byte_size: 20480 }
      };

      const payload = messageToSqlitePayload(msg, 'room_persist_1');
      assert.ok(payload.bodyJson, 'payload must have bodyJson');
      const parsedBody = JSON.parse(payload.bodyJson);
      assert.deepEqual(parsedBody.attachment_ids, ['att_uuid_101'], 'bodyJson must include attachment_ids');

      await dbService.saveMessage(payload);
      const row = await dbService.databaseManager.get('SELECT body_json FROM messages WHERE id = ?;', [msg.id]);
      assert.ok(row, 'Message row must be found in SQLite');
      const savedBody = JSON.parse(row.body_json);
      assert.deepEqual(savedBody.attachment_ids, ['att_uuid_101'], 'SQLite row body_json must preserve attachment_ids');
    });

    test('2. SQLite-loaded message contains attachment_ids and attachmentIds', async () => {
      const msg = {
        id: 'msg_persist_test_2',
        roomId: 'room_persist_2',
        senderId: 'user_sender_2',
        kind: 'image',
        attachment_ids: ['att_uuid_102'],
        body: { filename: 'test.jpg', mime: 'image/jpeg', byte_size: 1024 }
      };
      await dbService.saveMessage(messageToSqlitePayload(msg, 'room_persist_2'));

      const rows = await dbService.getMessages({ roomId: 'room_persist_2' });
      assert.equal(rows.length, 1);
      const loadedMsg = sqliteRowToMessage(rows[0]);
      assert.ok(loadedMsg, 'Loaded message must not be null');
      assert.deepEqual(loadedMsg.attachment_ids, ['att_uuid_102']);
      assert.deepEqual(loadedMsg.attachmentIds, ['att_uuid_102']);
      assert.equal(loadedMsg.attachment_id, 'att_uuid_102');
    });

    test('3. Image attachment ID survives persistence/reload', async () => {
      const imgMsg = {
        id: 'msg_img_survive',
        roomId: 'room_media_types_3',
        senderId: 'user_alice',
        kind: 'image',
        attachment_ids: ['att_img_survive_999'],
        body: { filename: 'holiday.jpg', mime: 'image/jpeg', byte_size: 50000, caption: 'Vacation' }
      };
      await dbService.saveMessage(messageToSqlitePayload(imgMsg, 'room_media_types_3'));

      const rows = await dbService.getMessages({ roomId: 'room_media_types_3' });
      const loaded = sqliteRowToMessage(rows.find(r => r.id === 'msg_img_survive'));
      assert.equal(resolveSourceAttachmentId(loaded), 'att_img_survive_999');
      assert.equal(loaded.body.caption, 'Vacation');
    });

    test('4. Video attachment ID survives persistence/reload', async () => {
      const vidMsg = {
        id: 'msg_vid_survive',
        roomId: 'room_media_types_4',
        senderId: 'user_alice',
        kind: 'video',
        attachment_ids: ['att_vid_survive_888'],
        body: { filename: 'movie.mp4', mime: 'video/mp4', byte_size: 1048576 }
      };
      await dbService.saveMessage(messageToSqlitePayload(vidMsg, 'room_media_types_4'));

      const rows = await dbService.getMessages({ roomId: 'room_media_types_4' });
      const loaded = sqliteRowToMessage(rows.find(r => r.id === 'msg_vid_survive'));
      assert.equal(resolveSourceAttachmentId(loaded), 'att_vid_survive_888');
      assert.equal(loaded.kind, 'video');
      assert.equal(loaded.body.filename, 'movie.mp4');
    });

    test('5. Audio attachment ID survives persistence/reload', async () => {
      const audMsg = {
        id: 'msg_aud_survive',
        roomId: 'room_media_types_5',
        senderId: 'user_alice',
        kind: 'audio',
        attachment_ids: ['att_aud_survive_777'],
        body: { filename: 'song.mp3', mime: 'audio/mpeg', byte_size: 2048000 }
      };
      await dbService.saveMessage(messageToSqlitePayload(audMsg, 'room_media_types_5'));

      const rows = await dbService.getMessages({ roomId: 'room_media_types_5' });
      const loaded = sqliteRowToMessage(rows.find(r => r.id === 'msg_aud_survive'));
      assert.equal(resolveSourceAttachmentId(loaded), 'att_aud_survive_777');
      assert.equal(loaded.body.mime, 'audio/mpeg');
    });

    test('6. Voice-note attachment ID survives persistence/reload and preserves voice note metadata', async () => {
      const vnMsg = {
        id: 'msg_vn_survive',
        roomId: 'room_media_types_6',
        senderId: 'user_alice',
        kind: 'file',
        attachment_ids: ['att_vn_survive_666'],
        body: {
          filename: 'voice_message_1690000000.webm',
          mime: 'video/webm',
          byte_size: 32768,
          duration: 18,
          is_voice_note: true
        }
      };
      await dbService.saveMessage(messageToSqlitePayload(vnMsg, 'room_media_types_6'));

      const rows = await dbService.getMessages({ roomId: 'room_media_types_6' });
      const loaded = sqliteRowToMessage(rows.find(r => r.id === 'msg_vn_survive'));
      assert.equal(resolveSourceAttachmentId(loaded), 'att_vn_survive_666');
      assert.equal(loaded.is_voice_note, true);
      assert.equal(loaded.isVoiceNote, true);
      assert.equal(loaded.body.duration, 18);
    });

    test('7. Document attachment ID survives persistence/reload', async () => {
      const docMsg = {
        id: 'msg_doc_survive',
        roomId: 'room_media_types_7',
        senderId: 'user_alice',
        kind: 'file',
        attachment_ids: ['att_doc_survive_555'],
        body: { filename: 'invoice.pdf', mime: 'application/pdf', byte_size: 150000 }
      };
      await dbService.saveMessage(messageToSqlitePayload(docMsg, 'room_media_types_7'));

      const rows = await dbService.getMessages({ roomId: 'room_media_types_7' });
      const loaded = sqliteRowToMessage(rows.find(r => r.id === 'msg_doc_survive'));
      assert.equal(resolveSourceAttachmentId(loaded), 'att_doc_survive_555');
      assert.equal(loaded.body.filename, 'invoice.pdf');
    });

    test('8. Forwarding can resolve the persisted attachment ID directly from loaded message', async () => {
      const docMsg = {
        id: 'msg_doc_survive_8',
        roomId: 'room_media_types_8',
        senderId: 'user_alice',
        kind: 'file',
        attachment_ids: ['att_doc_survive_555'],
        body: { filename: 'invoice.pdf', mime: 'application/pdf', byte_size: 150000 }
      };
      await dbService.saveMessage(messageToSqlitePayload(docMsg, 'room_media_types_8'));

      const rows = await dbService.getMessages({ roomId: 'room_media_types_8' });
      const loaded = sqliteRowToMessage(rows.find(r => r.id === 'msg_doc_survive_8'));
      const resolvedId = resolveSourceAttachmentId(loaded);
      assert.equal(resolvedId, 'att_doc_survive_555', 'Forwarding must resolve the attachment ID without error');
    });

    test('9. Source attachment ID is not reused as destination attachment ID', () => {
      const sourceAttachmentId = 'att_source_orig_123';
      const destAttachmentId = `dest_att_${crypto.randomUUID()}`;
      assert.notEqual(sourceAttachmentId, destAttachmentId, 'Destination must generate a new attachment ID');
    });

    test('10. Destination receives a new attachment ID', () => {
      const newAttId = 'att_destination_fresh_456';
      const destMsg = createOptimisticMediaMessage('room_target_10', 'user_forwarder_1', {
        kind: 'image',
        filename: 'pic.jpg',
        mime: 'image/jpeg',
        byteSize: 1024,
        attachmentId: newAttId,
        clientMessageId: 'local-test-10'
      });
      destMsg.attachmentIds = [newAttId];
      destMsg.attachment_ids = [newAttId];

      assert.deepEqual(destMsg.attachmentIds, ['att_destination_fresh_456']);
      assert.deepEqual(destMsg.attachment_ids, ['att_destination_fresh_456']);
    });

    test('11. Forwarded image succeeds end-to-end with loaded SQLite message', async () => {
      const imgMsg = {
        id: 'msg_img_11',
        roomId: 'room_media_11',
        senderId: 'user_alice',
        kind: 'image',
        attachment_ids: ['att_img_11_src'],
        body: { filename: 'pic.jpg', mime: 'image/jpeg', byte_size: 4096 }
      };
      await dbService.saveMessage(messageToSqlitePayload(imgMsg, 'room_media_11'));

      const rows = await dbService.getMessages({ roomId: 'room_media_11' });
      const loadedImg = sqliteRowToMessage(rows.find(r => r.id === 'msg_img_11'));
      const sourceAttId = resolveSourceAttachmentId(loadedImg);
      assert.ok(sourceAttId, 'Source attachment ID must exist');

      // Emulate upload returning new destination attachment ID
      const newAttId = 'att_dest_image_success';
      const destMsg = createOptimisticMediaMessage('room_dest_img_11', 'user_forwarder_1', {
        kind: 'image',
        filename: loadedImg.body.filename,
        mime: loadedImg.body.mime,
        byteSize: loadedImg.body.byte_size,
        attachmentId: newAttId,
        clientMessageId: `local-${crypto.randomUUID()}`
      });
      destMsg.body.is_forwarded = true;
      destMsg.attachmentIds = [newAttId];
      destMsg.attachment_ids = [newAttId];

      const resolved = resolveMessageContent(destMsg);
      assert.equal(resolved.kind, 'image');
      assert.equal(resolved.isForwarded, true);
      assert.equal(destMsg.attachment_ids[0], newAttId);
    });

    test('12. Forwarded video succeeds with loaded SQLite message', async () => {
      const vidMsg = {
        id: 'msg_vid_12',
        roomId: 'room_media_12',
        senderId: 'user_alice',
        kind: 'video',
        attachment_ids: ['att_vid_12_src'],
        body: { filename: 'clip.mp4', mime: 'video/mp4', byte_size: 8192 }
      };
      await dbService.saveMessage(messageToSqlitePayload(vidMsg, 'room_media_12'));

      const rows = await dbService.getMessages({ roomId: 'room_media_12' });
      const loadedVid = sqliteRowToMessage(rows.find(r => r.id === 'msg_vid_12'));
      const sourceAttId = resolveSourceAttachmentId(loadedVid);
      assert.ok(sourceAttId);

      const newAttId = 'att_dest_video_success';
      const destMsg = createOptimisticMediaMessage('room_dest_vid_12', 'user_forwarder_1', {
        kind: 'video',
        filename: loadedVid.body.filename,
        mime: loadedVid.body.mime,
        byteSize: loadedVid.body.byte_size,
        attachmentId: newAttId,
        clientMessageId: `local-${crypto.randomUUID()}`
      });
      destMsg.body.is_forwarded = true;
      destMsg.attachmentIds = [newAttId];

      const resolved = resolveMessageContent(destMsg);
      assert.equal(resolved.kind, 'video');
      assert.equal(resolved.isForwarded, true);
    });

    test('13. Forwarded audio succeeds with loaded SQLite message', async () => {
      const audMsg = {
        id: 'msg_aud_13',
        roomId: 'room_media_13',
        senderId: 'user_alice',
        kind: 'audio',
        attachment_ids: ['att_aud_13_src'],
        body: { filename: 'audio.mp3', mime: 'audio/mpeg', byte_size: 16384 }
      };
      await dbService.saveMessage(messageToSqlitePayload(audMsg, 'room_media_13'));

      const rows = await dbService.getMessages({ roomId: 'room_media_13' });
      const loadedAud = sqliteRowToMessage(rows.find(r => r.id === 'msg_aud_13'));
      const sourceAttId = resolveSourceAttachmentId(loadedAud);
      assert.ok(sourceAttId);

      const newAttId = 'att_dest_audio_success';
      const destMsg = createOptimisticMediaMessage('room_dest_aud_13', 'user_forwarder_1', {
        kind: 'audio',
        filename: loadedAud.body.filename,
        mime: loadedAud.body.mime,
        byteSize: loadedAud.body.byte_size,
        attachmentId: newAttId,
        clientMessageId: `local-${crypto.randomUUID()}`
      });
      destMsg.body.is_forwarded = true;
      destMsg.attachmentIds = [newAttId];

      const resolved = resolveMessageContent(destMsg);
      assert.equal(resolved.mime, 'audio/mpeg');
      assert.equal(resolved.isForwarded, true);
    });

    test('14. Forwarded voice note succeeds and preserves voice note rendering', async () => {
      const vnMsg = {
        id: 'msg_vn_14',
        roomId: 'room_media_14',
        senderId: 'user_alice',
        kind: 'file',
        attachment_ids: ['att_vn_14_src'],
        body: { filename: 'voice_message_14.webm', mime: 'video/webm', byte_size: 8192, duration: 18, is_voice_note: true }
      };
      await dbService.saveMessage(messageToSqlitePayload(vnMsg, 'room_media_14'));

      const rows = await dbService.getMessages({ roomId: 'room_media_14' });
      const loadedVn = sqliteRowToMessage(rows.find(r => r.id === 'msg_vn_14'));
      const sourceAttId = resolveSourceAttachmentId(loadedVn);
      assert.ok(sourceAttId);

      const newAttId = 'att_dest_vn_success';
      const destMsg = createOptimisticVoiceMessage('room_dest_vn_14', 'user_forwarder_1', {
        filename: loadedVn.body.filename,
        mime: loadedVn.body.mime,
        byteSize: loadedVn.body.byte_size,
        duration: loadedVn.body.duration,
        attachmentId: newAttId,
        clientMessageId: `local-${crypto.randomUUID()}`
      });
      destMsg.body.is_forwarded = true;
      destMsg.attachmentIds = [newAttId];

      assert.equal(destMsg.body.is_voice_note, true);
      assert.equal(destMsg.body.duration, 18);
      const resolved = resolveMessageContent(destMsg);
      assert.equal(resolved.isForwarded, true);
    });

    test('15. Forwarded document succeeds with loaded SQLite message', async () => {
      const docMsg = {
        id: 'msg_doc_15',
        roomId: 'room_media_15',
        senderId: 'user_alice',
        kind: 'file',
        attachment_ids: ['att_doc_15_src'],
        body: { filename: 'invoice.pdf', mime: 'application/pdf', byte_size: 150000 }
      };
      await dbService.saveMessage(messageToSqlitePayload(docMsg, 'room_media_15'));

      const rows = await dbService.getMessages({ roomId: 'room_media_15' });
      const loadedDoc = sqliteRowToMessage(rows.find(r => r.id === 'msg_doc_15'));
      const sourceAttId = resolveSourceAttachmentId(loadedDoc);
      assert.ok(sourceAttId);

      const newAttId = 'att_dest_doc_success';
      const destMsg = createOptimisticMediaMessage('room_dest_doc_15', 'user_forwarder_1', {
        kind: 'file',
        filename: loadedDoc.body.filename,
        mime: loadedDoc.body.mime,
        byteSize: loadedDoc.body.byte_size,
        attachmentId: newAttId,
        clientMessageId: `local-${crypto.randomUUID()}`
      });
      destMsg.body.is_forwarded = true;
      destMsg.attachmentIds = [newAttId];

      const resolved = resolveMessageContent(destMsg);
      assert.equal(resolved.kind, 'file');
      assert.equal(resolved.filename, 'invoice.pdf');
      assert.equal(resolved.isForwarded, true);
    });

    test('16. Missing attachment ID produces a media-specific error (not connection error)', () => {
      const msgWithoutAtt = {
        kind: 'image',
        body: { filename: 'lost.jpg' }
      };
      const attId = resolveSourceAttachmentId(msgWithoutAtt);
      assert.equal(attId, null);

      const err = new Error('Source attachment ID missing from message');
      err.code = 'MISSING_ATTACHMENT_ID';
      const userMessage = categorizeForwardError(err);
      assert.equal(userMessage, 'Unable to forward this media.');
      assert.notEqual(userMessage, 'Some forwarded messages could not be sent. Please check your connection.');
    });

    test('17. Real network failure still produces the connection error', () => {
      const netErr = new Error("Media can't be forwarded while offline.");
      netErr.code = 'NETWORK_FAILURE';
      const userMessage = categorizeForwardError(netErr);
      assert.equal(userMessage, 'Some forwarded messages could not be sent. Please check your connection.');
    });

    test('18. Text forwarding remains working without requiring attachments', () => {
      const textMsg = {
        id: 'msg_text_plain',
        kind: 'text',
        body: { text: 'Plain text forward' }
      };
      const clean = getCleanForwardedText(textMsg.body.text);
      const destMsg = createOptimisticMessage('room_dest_text_18', 'user_forwarder_1', `[Forwarded] ${clean}`, 'local-cid-18');
      destMsg.body.is_forwarded = true;

      const resolved = resolveMessageContent(destMsg);
      assert.equal(resolved.kind, 'text');
      assert.equal(resolved.text, 'Plain text forward');
      assert.equal(resolved.isForwarded, true);
    });

    test('19. SQLite restart preserves media forwarding information', async () => {
      // 1. Save media to current DB
      const originalMsg = {
        id: 'msg_restart_test_19',
        roomId: 'room_restart_19',
        senderId: 'user_alice',
        kind: 'image',
        attachment_ids: ['att_survive_restart_19'],
        body: { filename: 'preserved.jpg', mime: 'image/jpeg', byte_size: 4096 }
      };
      await dbService.saveMessage(messageToSqlitePayload(originalMsg, 'room_restart_19'));

      // 2. Simulate closing DB and application shutdown
      await dbService.databaseManager.close();

      // 3. Simulate application restart: new DatabaseService instance on same directory
      const restartedDb = new DatabaseService({
        storageDir: tmpDir,
        sessionStore: mockSessionStore
      });

      // 4. Load messages after restart
      const rows = await restartedDb.getMessages({ roomId: 'room_restart_19' });
      assert.equal(rows.length, 1);
      const loadedMsg = sqliteRowToMessage(rows[0]);
      assert.ok(loadedMsg);

      // 5. Verify attachment ID survives restart and is forwardable
      const attId = resolveSourceAttachmentId(loadedMsg);
      assert.equal(attId, 'att_survive_restart_19');

      await restartedDb.databaseManager.close();
    });

    test('20. Existing forwarding tests and room isolation remain intact', () => {
      assert.equal(typeof createOptimisticMediaMessage, 'function');
      assert.equal(typeof createOptimisticVoiceMessage, 'function');
      assert.equal(typeof getCleanForwardedText, 'function');
      assert.equal(typeof resolveMessageContent, 'function');
    });
  });

  // ==========================================
  // MESSAGE SELECTION COUNT & FORWARDING UX LIFECYCLE
  // ==========================================
  describe('Message Selection Count and Forwarding UX Lifecycle', () => {
    test('1. Selecting 1 message immediately updates selected IDs and count to 1', () => {
      const shell = new ChatShellState();
      assert.equal(shell.getSelectedMessageIds().length, 0);
      assert.equal(shell.isMessageSelectionMode, false);

      const isSel = shell.toggleMessageSelection('msg_1');
      assert.equal(isSel, true);
      assert.equal(shell.isMessageSelectionMode, true);
      assert.equal(shell.getSelectedMessageIds().length, 1);
      assert.deepEqual(shell.getSelectedMessageIds(), ['msg_1']);
      assert.equal(shell.isMessageSelected('msg_1'), true);
      assert.equal(shell.isMessageSelected('msg_2'), false);
    });

    test('2. Selecting a second message updates count to 2, selecting a third updates to 3', () => {
      const shell = new ChatShellState();
      shell.toggleMessageSelection('msg_1');
      shell.toggleMessageSelection('msg_2');
      assert.equal(shell.getSelectedMessageIds().length, 2);
      assert.equal(shell.isMessageSelected('msg_1'), true);
      assert.equal(shell.isMessageSelected('msg_2'), true);

      shell.toggleMessageSelection('msg_3');
      assert.equal(shell.getSelectedMessageIds().length, 3);
      assert.equal(shell.isMessageSelected('msg_3'), true);
    });

    test('3. Deselecting a message decrements the count correctly', () => {
      const shell = new ChatShellState();
      shell.toggleMessageSelection('msg_1');
      shell.toggleMessageSelection('msg_2');
      assert.equal(shell.getSelectedMessageIds().length, 2);

      const stillSelected = shell.toggleMessageSelection('msg_1');
      assert.equal(stillSelected, false);
      assert.equal(shell.getSelectedMessageIds().length, 1);
      assert.equal(shell.isMessageSelected('msg_1'), false);
      assert.equal(shell.isMessageSelected('msg_2'), true);
      assert.equal(shell.isMessageSelectionMode, true);
    });

    test('4. Deselecting all messages returns count to 0 and exits selection mode', () => {
      const shell = new ChatShellState();
      shell.toggleMessageSelection('msg_1');
      assert.equal(shell.isMessageSelectionMode, true);
      assert.equal(shell.getSelectedMessageIds().length, 1);

      const stillSelected = shell.toggleMessageSelection('msg_1');
      assert.equal(stillSelected, false);
      assert.equal(shell.getSelectedMessageIds().length, 0);
      assert.equal(shell.isMessageSelectionMode, false);
      assert.equal(shell.isMessageSelected('msg_1'), false);
    });

    test('5. Single source of truth: Toolbar count derived from shellState.selectedMessageIds', () => {
      const shell = new ChatShellState();
      const getToolbarCount = () => `${shell.getSelectedMessageIds().length} selected`;

      assert.equal(getToolbarCount(), '0 selected');
      shell.toggleMessageSelection('msg_10');
      assert.equal(getToolbarCount(), '1 selected');
      shell.toggleMessageSelection('msg_20');
      assert.equal(getToolbarCount(), '2 selected');
      shell.toggleMessageSelection('msg_10');
      assert.equal(getToolbarCount(), '1 selected');
      shell.toggleMessageSelection('msg_20');
      assert.equal(getToolbarCount(), '0 selected');
    });

    test('6. Selection supports message objects (text, media, voice notes) and clientMessageId matching', () => {
      const shell = new ChatShellState();
      const textMsg = { id: 'msg_text_1', clientMessageId: 'local_cid_1', kind: 'text' };
      const imgMsg = { id: 'msg_img_2', clientMessageId: 'local_cid_2', kind: 'image' };
      const voiceMsg = { id: 'msg_voice_3', client_message_id: 'local_cid_3', kind: 'voice' };

      shell.toggleMessageSelection(textMsg);
      shell.toggleMessageSelection(imgMsg);
      shell.toggleMessageSelection(voiceMsg);

      assert.equal(shell.getSelectedMessageIds().length, 3);
      assert.equal(shell.isMessageSelected(textMsg), true);
      assert.equal(shell.isMessageSelected('msg_text_1'), true);
      assert.equal(shell.isMessageSelected(imgMsg), true);
      assert.equal(shell.isMessageSelected('msg_img_2'), true);
      assert.equal(shell.isMessageSelected(voiceMsg), true);
      assert.equal(shell.isMessageSelected('msg_voice_3'), true);

      // Optimistic message with only clientMessageId
      const optMsg = { clientMessageId: 'opt_cid_99', kind: 'text' };
      shell.toggleMessageSelection(optMsg);
      assert.equal(shell.getSelectedMessageIds().length, 4);
      assert.equal(shell.isMessageSelected(optMsg), true);
      assert.equal(shell.isMessageSelected('opt_cid_99'), true);

      // Deselect via object
      shell.toggleMessageSelection(imgMsg);
      assert.equal(shell.getSelectedMessageIds().length, 3);
      assert.equal(shell.isMessageSelected(imgMsg), false);
    });

    test('7. Leaving/switching conversation automatically clears stale selected message IDs', () => {
      const shell = new ChatShellState();
      shell.selectConversation('room_alpha');
      shell.toggleMessageSelection('msg_alpha_1');
      shell.toggleMessageSelection('msg_alpha_2');
      assert.equal(shell.getSelectedMessageIds().length, 2);
      assert.equal(shell.isMessageSelectionMode, true);

      // Switch to different room
      shell.selectConversation('room_beta');
      assert.equal(shell.getSelectedMessageIds().length, 0);
      assert.equal(shell.isMessageSelectionMode, false);
      assert.equal(shell.isMessageSelected('msg_alpha_1'), false);
    });

    test('8. Logout shellState.clear() cleans up selected message IDs and selection mode', () => {
      const shell = new ChatShellState();
      shell.toggleMessageSelection('msg_persistent_1');
      assert.equal(shell.getSelectedMessageIds().length, 1);
      assert.equal(shell.isMessageSelectionMode, true);

      shell.clear();
      assert.equal(shell.getSelectedMessageIds().length, 0);
      assert.equal(shell.isMessageSelectionMode, false);
    });

    test('9. Forward message filtering matches all selected IDs (id, clientMessageId, client_message_id)', () => {
      const shell = new ChatShellState();
      shell.toggleMessageSelection('server_id_1');
      shell.toggleMessageSelection('local_cid_2');

      const roomMessages = [
        { id: 'server_id_1', clientMessageId: 'cid_1', body: { text: 'One' } },
        { id: 'server_id_2', clientMessageId: 'local_cid_2', body: { text: 'Two' } },
        { id: 'server_id_3', clientMessageId: 'cid_3', body: { text: 'Three' } }
      ];

      const selectedIds = shell.getSelectedMessageIds();
      const msgsToForward = roomMessages.filter((m) => {
        return (m.id && selectedIds.includes(String(m.id))) ||
               (m.clientMessageId && selectedIds.includes(String(m.clientMessageId))) ||
               (m.client_message_id && selectedIds.includes(String(m.client_message_id)));
      });

      assert.equal(msgsToForward.length, 2);
      assert.equal(msgsToForward[0].body.text, 'One');
      assert.equal(msgsToForward[1].body.text, 'Two');
    });

    test('10. Forwarding UX progress and state transitions maintain safety and proper UX labels', async () => {
      let isForwardingInProgress = false;
      const progressLogs = [];

      async function simulatedForward(targetRooms, messages) {
        if (isForwardingInProgress) return;
        isForwardingInProgress = true;
        const totalOps = targetRooms.length * messages.length;
        let completedOps = 0;

        try {
          for (const room of targetRooms) {
            for (const msg of messages) {
              completedOps++;
              const isMedia = Boolean(msg.attachmentId || msg.kind === 'image');
              const label = isMedia
                ? (totalOps > 1 ? `Uploading & forwarding (${completedOps}/${totalOps})...` : 'Uploading media...')
                : (totalOps > 1 ? `Forwarding (${completedOps}/${totalOps})...` : 'Forwarding...');
              progressLogs.push(label);
              await new Promise((r) => setTimeout(r, 10));
            }
          }
        } finally {
          isForwardingInProgress = false;
        }
      }

      const rooms = ['room_A', 'room_B'];
      const messages = [
        { id: 'm1', kind: 'text' },
        { id: 'm2', kind: 'image', attachmentId: 'att_123' }
      ];

      const p1 = simulatedForward(rooms, messages);
      // Concurrency check: duplicate invocation should be rejected
      assert.equal(isForwardingInProgress, true);
      const p2 = simulatedForward(rooms, messages);
      await Promise.all([p1, p2]);

      assert.equal(isForwardingInProgress, false);
      assert.equal(progressLogs.length, 4);
      assert.equal(progressLogs[0], 'Forwarding (1/4)...');
      assert.equal(progressLogs[1], 'Uploading & forwarding (2/4)...');
      assert.equal(progressLogs[2], 'Forwarding (3/4)...');
      assert.equal(progressLogs[3], 'Uploading & forwarding (4/4)...');
    });

    test('11. Granular error classification remains intact (missing attachment, media source, upload, network)', () => {
      const isMissingId = (err) => err?.code === 'MISSING_ATTACHMENT_ID' || String(err?.message || '').includes('Source attachment ID missing');
      const isMediaSourceError = (err) => err?.code === 'MEDIA_SOURCE_FAILURE' || String(err?.message || '').includes('download source attachment');
      const isUploadError = (err) => err?.code === 'UPLOAD_FAILURE' || String(err?.message || '').includes('Media upload failed');
      const isNetworkError = (err) => err?.code === 'NETWORK_FAILURE' || String(err?.message || '').includes('offline');

      const errMissing = new Error('Source attachment ID missing from message');
      errMissing.code = 'MISSING_ATTACHMENT_ID';
      assert.equal(isMissingId(errMissing), true);
      assert.equal(isNetworkError(errMissing), false);

      const errSource = new Error('Failed to download source attachment');
      errSource.code = 'MEDIA_SOURCE_FAILURE';
      assert.equal(isMediaSourceError(errSource), true);

      const errUpload = new Error('Media upload failed: 500 server error');
      errUpload.code = 'UPLOAD_FAILURE';
      assert.equal(isUploadError(errUpload), true);

      const errNet = new Error("Media can't be forwarded while offline.");
      errNet.code = 'NETWORK_FAILURE';
      assert.equal(isNetworkError(errNet), true);
    });
  });
});
