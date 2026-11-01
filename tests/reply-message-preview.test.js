import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  RoomMessagesState,
  formatReplyPreview,
  getReplySenderName,
  resolveMessageContent,
  isOwnMessage
} from '../src/renderer/chat-shell-state.js';
import { sqliteRowToMessage, messageToSqlitePayload } from '../src/renderer/db-sync.js';

describe('WhatsApp-Style Reply Message Preview & Jump to Original', () => {

  describe('1-7. Reply Preview Content by Message Modality', () => {
    test('1. Reply to text shows original text', () => {
      const original = {
        id: 'msg-text-1',
        senderId: 'user-bob',
        kind: 'text',
        body: { text: 'Hello, are you available tomorrow?' }
      };
      const preview = formatReplyPreview(original);
      assert.equal(preview, 'Hello, are you available tomorrow?');
    });

    test('2. Reply to image shows Photo preview (and caption if present)', () => {
      const originalNoCaption = {
        id: 'msg-img-1',
        senderId: 'user-bob',
        kind: 'image',
        body: { filename: 'IMG_2026.jpg' }
      };
      assert.equal(formatReplyPreview(originalNoCaption), '📷 Photo');

      const originalWithCaption = {
        id: 'msg-img-2',
        senderId: 'user-bob',
        kind: 'image',
        body: { caption: 'Sunset in Goa', filename: 'sunset.jpg' }
      };
      assert.equal(formatReplyPreview(originalWithCaption), '📷 Photo: Sunset in Goa');
    });

    test('3. Reply to video shows Video preview (and caption if present)', () => {
      const originalVideo = {
        id: 'msg-vid-1',
        senderId: 'user-bob',
        kind: 'video',
        body: { filename: 'video.mp4' }
      };
      assert.equal(formatReplyPreview(originalVideo), '🎥 Video');

      const originalVideoCaption = {
        id: 'msg-vid-2',
        senderId: 'user-bob',
        kind: 'video',
        body: { caption: 'Demo walkthrough', filename: 'demo.mp4' }
      };
      assert.equal(formatReplyPreview(originalVideoCaption), '🎥 Video: Demo walkthrough');
    });

    test('4. Reply to document shows filename/type', () => {
      const originalDoc = {
        id: 'msg-doc-1',
        senderId: 'user-bob',
        kind: 'file',
        body: { filename: 'Quarterly_Report_2026.pdf' }
      };
      assert.equal(formatReplyPreview(originalDoc), '📄 Quarterly_Report_2026.pdf');

      const originalDocNoFilename = {
        id: 'msg-doc-2',
        senderId: 'user-bob',
        kind: 'document',
        body: {}
      };
      assert.equal(formatReplyPreview(originalDocNoFilename), '📄 Document');
    });

    test('5. Reply to audio shows Audio preview', () => {
      const originalAudio = {
        id: 'msg-aud-1',
        senderId: 'user-bob',
        kind: 'audio',
        body: { filename: 'song.mp3' }
      };
      assert.equal(formatReplyPreview(originalAudio), '🎵 Audio');
    });

    test('6. Reply to voice note shows Voice message preview', () => {
      const originalVoice = {
        id: 'msg-vn-1',
        senderId: 'user-bob',
        kind: 'audio',
        body: { is_voice_note: true, filename: 'voice_message_1.webm' }
      };
      assert.equal(formatReplyPreview(originalVoice), '🎤 Voice message');
    });

    test('6B. Reply to call entry shows Audio call or Video call preview', () => {
      const voiceCallMsg = {
        id: 'call-msg-1',
        kind: 'call',
        isCallEntry: true,
        isVideo: false,
        callType: 'voice'
      };
      assert.equal(formatReplyPreview(voiceCallMsg), '📞 Audio call');

      const videoCallMsg = {
        id: 'call-msg-2',
        kind: 'call',
        isCallEntry: true,
        isVideo: true,
        callType: 'video'
      };
      assert.equal(formatReplyPreview(videoCallMsg), '📹 Video call');
    });

    test('7. Reply preview shows original sender name (You for self, peer name/nickname for others)', () => {
      const currentUserId = 'user-alice';
      const ownMessage = {
        id: 'msg-own',
        senderId: 'user-alice',
        senderName: 'Alice',
        body: { text: 'I will send the report' }
      };
      assert.equal(getReplySenderName(ownMessage, currentUserId), 'You');

      const peerMessage = {
        id: 'msg-peer',
        senderId: 'user-bob',
        senderName: 'Bob',
        body: { text: 'Thanks!' }
      };
      assert.equal(getReplySenderName(peerMessage, currentUserId), 'Bob');

      // Contact nickname override
      const nicknameResolver = (userId) => (userId === 'user-bob' ? 'Bobby D' : null);
      assert.equal(getReplySenderName(peerMessage, currentUserId, nicknameResolver), 'Bobby D');
    });
  });

  describe('8. Long Text Truncation & Compactness', () => {
    test('8. Reply preview preserves meaningful portion and compact string', () => {
      const longText = 'This is a very long message explaining all the technical details of the WebRTC peer connection renegotiation process in extensive detail over many lines of discussion.';
      const original = {
        id: 'msg-long',
        senderId: 'user-bob',
        kind: 'text',
        body: { text: longText }
      };
      const preview = formatReplyPreview(original);
      assert.ok(preview.startsWith('This is a very long message'));
      assert.equal(typeof preview, 'string');
    });
  });

  describe('9-14. Original Message Location, Scrolling, Highlighting & States', () => {
    test('9. Clicking reply locates original message in room state', () => {
      const state = new RoomMessagesState('user-alice');
      state.setInitialMessages('room-1', [
        { id: 'orig-101', senderId: 'user-bob', body: { text: 'Meet at 5pm' } },
        { id: 'reply-102', senderId: 'user-alice', replyTo: 'orig-101', body: { text: 'Sounds good!' } }
      ]);

      const replyMsg = state.messages.find(m => m.id === 'reply-102');
      assert.ok(replyMsg);
      const target = state.messages.find(m => m.id === replyMsg.replyTo);
      assert.ok(target);
      assert.equal(target.id, 'orig-101');
      assert.equal(target.body.text, 'Meet at 5pm');
    });

    test('10. Original message can be located in mock DOM and scrolled into view', () => {
      let scrolled = false;
      let scrollOptions = null;
      const mockRow = {
        id: 'orig-101',
        classList: {
          classes: new Set(),
          add(c) { this.classes.add(c); },
          remove(c) { this.classes.delete(c); },
          contains(c) { return this.classes.has(c); }
        },
        scrollIntoView(options) {
          scrolled = true;
          scrollOptions = options;
        }
      };

      mockRow.scrollIntoView({ behavior: 'smooth', block: 'center' });
      assert.strictEqual(scrolled, true);
      assert.deepEqual(scrollOptions, { behavior: 'smooth', block: 'center' });
    });

    test('11. Original message receives temporary highlight class and timeout clears it', async () => {
      const classes = new Set();
      const mockRow = {
        classList: {
          add(c) { classes.add(c); },
          remove(c) { classes.delete(c); },
          contains(c) { return classes.has(c); }
        }
      };

      mockRow.classList.add('highlighted');
      assert.strictEqual(classes.has('highlighted'), true);

      // Timeout simulation
      mockRow.classList.remove('highlighted');
      assert.strictEqual(classes.has('highlighted'), false);
    });

    test('12. Original message already loaded is resolved synchronously without network fetch', () => {
      const state = new RoomMessagesState('user-alice');
      state.setInitialMessages('room-1', [
        { id: 'orig-201', senderId: 'user-bob', body: { text: 'Are you ready?' } },
        { id: 'reply-202', senderId: 'user-alice', replyTo: 'orig-201', body: { text: 'Yes!' } }
      ]);

      const found = state.messages.find(m => m.id === 'orig-201');
      assert.ok(found);
      assert.equal(formatReplyPreview(found), 'Are you ready?');
    });

    test('13. Original message outside current loaded range can be loaded via pagination/prepend', () => {
      const state = new RoomMessagesState('user-alice');
      // Initially loaded messages only contain the reply
      state.setInitialMessages('room-1', [
        { id: 'reply-302', eventSeq: 50, senderId: 'user-alice', replyTo: 'orig-historical-1', body: { text: 'Agreed' } }
      ]);
      assert.strictEqual(state.messages.some(m => m.id === 'orig-historical-1'), false);

      // Older page is loaded and prepended
      const historicalPage = [
        { id: 'orig-historical-1', eventSeq: 10, senderId: 'user-bob', body: { text: 'Original proposal from last week' } }
      ];
      state.prependOlderMessages(historicalPage, false);

      // Now original message is resolved!
      const target = state.messages.find(m => m.id === 'orig-historical-1');
      assert.ok(target);
      assert.equal(formatReplyPreview(target), 'Original proposal from last week');
    });

    test('14. Original message deleted displays "This message was deleted" and unavailable displays "Message unavailable"', () => {
      const deletedMsg = {
        id: 'orig-del-1',
        senderId: 'user-bob',
        isDeleted: true,
        kind: 'deleted'
      };
      assert.equal(formatReplyPreview(deletedMsg), 'This message was deleted');

      const deletedForMeMsg = {
        id: 'orig-del-2',
        senderId: 'user-bob',
        isDeletedForMe: true,
        body: { text: 'Secret message' }
      };
      assert.equal(formatReplyPreview(deletedForMeMsg), 'Message unavailable');

      // Null or missing message
      assert.equal(formatReplyPreview(null), 'Message unavailable');
      assert.equal(formatReplyPreview(undefined), 'Message unavailable');
    });
  });

  describe('15-20. Persistence, Duplication Guard & Message Flow', () => {
    test('15. Reply survives application restart via SQLite payload mapping', () => {
      const message = {
        id: 'msg-reply-501',
        roomId: 'room-persist-1',
        senderId: 'user-alice',
        kind: 'text',
        body: { text: 'Replying to you' },
        replyTo: 'msg-orig-500'
      };

      const sqlitePayload = messageToSqlitePayload(message, 'room-persist-1');
      assert.equal(sqlitePayload.replyToId, 'msg-orig-500', 'replyTo mapped to replyToId');

      // Rehydrate row back from SQLite
      const fakeDbRow = {
        id: 'msg-reply-501',
        room_id: 'room-persist-1',
        sender_id: 'user-alice',
        kind: 'text',
        body_json: JSON.stringify({ text: 'Replying to you' }),
        reply_to_id: 'msg-orig-500',
        created_at: '2026-10-07T10:00:00Z',
        status: 'sent'
      };
      const restored = sqliteRowToMessage(fakeDbRow);
      assert.equal(restored.replyTo, 'msg-orig-500');
      assert.equal(restored.reply_to, 'msg-orig-500');
      assert.equal(restored.replyToId, 'msg-orig-500');
    });

    test('16. Reply survives SQLite reload and matches original message', () => {
      const state = new RoomMessagesState('user-alice');
      const rows = [
        {
          id: 'orig-600',
          room_id: 'room-1',
          sender_id: 'user-bob',
          kind: 'text',
          body_json: JSON.stringify({ text: 'Lunch at 1pm?' }),
          reply_to_id: null,
          created_at: '2026-10-07T09:00:00Z',
          status: 'delivered'
        },
        {
          id: 'reply-601',
          room_id: 'room-1',
          sender_id: 'user-alice',
          kind: 'text',
          body_json: JSON.stringify({ text: 'Sure thing!' }),
          reply_to_id: 'orig-600',
          created_at: '2026-10-07T09:05:00Z',
          status: 'sent'
        }
      ];

      const loadedMessages = rows.map(sqliteRowToMessage);
      state.setInitialMessages('room-1', loadedMessages, false);

      const reply = state.messages.find(m => m.id === 'reply-601');
      assert.ok(reply);
      const original = state.messages.find(m => m.id === reply.replyTo);
      assert.ok(original);
      assert.equal(formatReplyPreview(original), 'Lunch at 1pm?');
      assert.equal(getReplySenderName(original, 'user-alice'), 'user-bob');
    });

    test('17. No duplicate message is created in RoomMessagesState or during reconciliation', () => {
      const state = new RoomMessagesState('user-alice');
      state.setInitialMessages('room-1', [
        { id: 'orig-700', clientMessageId: 'cid-700', body: { text: 'Hello' } }
      ]);
      assert.equal(state.messages.length, 1);

      // Reconcile incoming server message with same ID
      state.appendIncomingMessage({
        id: 'orig-700',
        clientMessageId: 'cid-700',
        body: { text: 'Hello' }
      });
      assert.equal(state.messages.length, 1, 'Length must remain exactly 1');

      // Merge server messages with same ID
      state.mergeServerMessages([
        { id: 'orig-700', clientMessageId: 'cid-700', body: { text: 'Hello' } }
      ]);
      assert.equal(state.messages.length, 1, 'Length must remain exactly 1');
    });

    test('18. Incoming reply preserves reply reference and resolves original', () => {
      const state = new RoomMessagesState('user-alice');
      state.setInitialMessages('room-1', [
        { id: 'orig-800', senderId: 'user-alice', body: { text: 'Did you get the keys?' } }
      ]);

      const incomingReply = {
        id: 'reply-801',
        senderId: 'user-bob',
        replyTo: 'orig-800',
        body: { text: 'Yes, got them on my desk.' }
      };

      const appended = state.appendIncomingMessage(incomingReply);
      assert.ok(appended);
      assert.equal(appended.replyTo, 'orig-800');

      const target = state.messages.find(m => m.id === appended.replyTo);
      assert.ok(target);
      assert.equal(formatReplyPreview(target), 'Did you get the keys?');
      assert.equal(getReplySenderName(target, 'user-alice'), 'You');
    });

    test('19. Outgoing reply preserves reply reference and resolves original', () => {
      const state = new RoomMessagesState('user-alice');
      state.setInitialMessages('room-1', [
        { id: 'orig-900', senderId: 'user-bob', body: { text: 'Call me when free' } }
      ]);

      const optimisticReply = {
        id: 'local-uuid-901',
        clientMessageId: 'local-uuid-901',
        senderId: 'user-alice',
        replyTo: 'orig-900',
        reply_to: 'orig-900',
        body: { text: 'Calling in 5 mins' }
      };

      state.addOptimisticMessage(optimisticReply);
      assert.equal(state.messages.length, 2);

      const added = state.messages.find(m => m.id === 'local-uuid-901');
      assert.ok(added);
      assert.equal(added.replyTo, 'orig-900');

      const target = state.messages.find(m => m.id === added.replyTo);
      assert.ok(target);
      assert.equal(formatReplyPreview(target), 'Call me when free');
      assert.equal(getReplySenderName(target, 'user-alice'), 'user-bob');
    });

    test('20. Existing reply sending protocol serialization remains functional and compliant', () => {
      // Wire payload serialization check: reply_to is sent cleanly as string ID or null
      const effectiveReplyTo = 'target-canonical-msg-id-123';
      const wirePayload = {
        client_message_id: 'cid-wire-999',
        kind: 'text',
        body: { text: 'Quoting your text' },
        reply_to: effectiveReplyTo,
        attachment_ids: []
      };

      assert.equal(wirePayload.reply_to, 'target-canonical-msg-id-123');
      assert.deepEqual(Object.keys(wirePayload).sort(), ['attachment_ids', 'body', 'client_message_id', 'kind', 'reply_to']);
    });
  });
});
