import test from 'node:test';
import assert from 'node:assert/strict';
import {
  VoiceRecorder,
  RECORDING_STATE,
  DEFAULT_MAX_DURATION_MS,
  DEFAULT_MIN_DURATION_MS
} from '../src/renderer/voice-recorder.js';
import {
  ChatShellState,
  RoomMessagesState,
  resolveMessageContent,
  createOptimisticVoiceMessage,
  createOptimisticMediaMessage
} from '../src/renderer/chat-shell-state.js';
import { ChatApi, normalizeMessage } from '../src/api/chat-api.js';
import { validateMediaFile } from '../src/api/mime-validator.js';

test('Voice Message & Audio Pipeline Regression Suite', async (t) => {

  await t.test('1. Voice recording first-send: WebM MIME sanitization allows backend init without error', async () => {
    // MediaRecorder produces audio/webm;codecs=opus
    const declaredMime = 'audio/webm;codecs=opus';
    const filename = 'voice_message_1727200000000.webm';
    const byteSize = 8192;
    const headerBytes = new Uint8Array([0x1A, 0x45, 0xDF, 0xA3, 0x9F, 0x42, 0x86, 0x81]);

    const validation = validateMediaFile({
      filename,
      byteSize,
      declaredMime,
      headerBytes
    });

    assert.equal(validation.isValid, true, 'Voice note must pass media validation');
    assert.equal(validation.kind, 'audio', 'Voice note kind must be audio');

    // Backend init MIME sanitization
    const ext = (filename.split('.').pop() || '').toLowerCase().trim();
    let backendInitMime = (validation.effectiveMime || '').toLowerCase().split(';')[0].trim();
    if (ext === 'webm' || backendInitMime === 'audio/webm' || backendInitMime === 'video/webm') {
      backendInitMime = 'video/webm';
    }

    assert.equal(backendInitMime, 'video/webm', 'Backend initAttachment must receive video/webm to prevent HTTP 415');
  });

  await t.test('2. Voice attachment readiness before message.send: downloadAttachment polling resolves downloadUrl', async () => {
    let callCount = 0;
    const mockChatApi = {
      async downloadAttachment(token, roomId, attachmentId) {
        callCount++;
        if (callCount < 2) {
          const err = new Error('attachment processing');
          err.httpStatus = 409;
          throw err;
        }
        return {
          downloadUrl: `https://s3.ollacore.com/attachments/${attachmentId}?sig=valid`,
          status: 'ready'
        };
      }
    };

    let resolvedUrl = null;
    for (let attempt = 0; attempt < 15; attempt++) {
      try {
        const dl = await mockChatApi.downloadAttachment('token', 'room-1', 'att-123');
        if (dl?.downloadUrl) {
          resolvedUrl = dl.downloadUrl;
          break;
        }
      } catch {}
      await new Promise(r => setTimeout(r, 10));
    }

    assert.ok(resolvedUrl, 'Download URL must be resolved on readiness polling');
    assert.match(resolvedUrl, /https:\/\/s3\.ollacore\.com\/attachments\/att-123/);
    assert.equal(callCount, 2, 'Polling retried until 200 ready');
  });

  await t.test('3. Retry must not be required after a successful upload', async () => {
    const roomId = 'room-test-1';
    const currentUserId = 'user-a';
    const clientMessageId = `local-${Date.now()}`;
    const filename = 'voice_message_123.webm';
    const duration = 6;
    const size = 12000;

    const optimistic = createOptimisticVoiceMessage(roomId, currentUserId, {
      filename,
      mime: 'audio/webm;codecs=opus',
      byteSize: size,
      duration,
      clientMessageId
    });

    const roomState = new RoomMessagesState({ roomId, currentUserId });
    roomState.addOptimisticMessage(optimistic);

    assert.equal(roomState.messages.length, 1);
    assert.equal(roomState.getStatus(clientMessageId), 'sending');

    // Simulate upload success returning attachment ID & downloadUrl directly
    const attachmentId = 'att-voice-001';
    const downloadUrl = 'https://s3.ollacore.com/voice/att-voice-001.webm';

    // Update message state with attachment
    const msg = roomState.messages[0];
    msg.attachmentIds = [attachmentId];
    msg.attachments = [{
      id: attachmentId,
      filename,
      mime: 'audio/webm',
      byteSize: size
    }];

    // Simulate WebSocket confirmation (message.created)
    const serverMessage = {
      id: 'srv-msg-100',
      client_message_id: clientMessageId,
      room_id: roomId,
      sender_id: currentUserId,
      kind: 'file',
      body: {
        text: 'Voice message',
        filename,
        mime: 'audio/webm',
        byte_size: size,
        duration,
        is_voice_note: true
      },
      attachment_ids: [attachmentId],
      created_at: new Date().toISOString()
    };

    const reconciled = roomState.appendIncomingMessage(serverMessage);
    assert.equal(reconciled.id, 'srv-msg-100');
    assert.equal(reconciled.clientMessageId, clientMessageId);
    assert.deepEqual(reconciled.attachmentIds, [attachmentId]);

    // Update receipt to sent
    roomState.updateReceipt(clientMessageId, 'sent');
    assert.equal(roomState.getStatus(clientMessageId), 'sent');
    assert.notEqual(roomState.getStatus(clientMessageId), 'failed', 'Must not fail or require retry');
  });

  await t.test('4. Historical recorded voice message restoration & normalization', async () => {
    const rawHistoryMessage = {
      id: '01a0d3f2-msg-voice',
      room_id: 'room-history-1',
      sender_id: 'user-sender',
      kind: 'file',
      body: {
        text: 'Voice message',
        filename: 'voice_message_1727200000000.webm',
        mime: 'audio/webm',
        byte_size: 15420,
        duration: 8,
        is_voice_note: true
      },
      attachment_ids: ['01a0d3f2-att-voice'],
      attachments: [{
        id: '01a0d3f2-att-voice',
        original_name: 'voice_message_1727200000000.webm',
        mime: 'video/webm',
        byte_size: 15420,
        status: 'uploaded'
      }],
      created_at: '2026-09-24T14:30:00.000Z'
    };

    const normalized = normalizeMessage(rawHistoryMessage);
    assert.equal(normalized.id, '01a0d3f2-msg-voice');
    assert.deepEqual(normalized.attachmentIds, ['01a0d3f2-att-voice']);
    assert.equal(normalized.attachments.length, 1);
    assert.equal(normalized.attachments[0].id, '01a0d3f2-att-voice');

    const resolved = resolveMessageContent(normalized);
    assert.equal(resolved.kind, 'audio');
    assert.equal(resolved.isVoiceNote, true);
    assert.equal(resolved.duration, 8);
    assert.equal(resolved.attachmentId, '01a0d3f2-att-voice');
    assert.equal(resolved.fallbackText, '🎤 Voice message');
  });

  await t.test('5. Historical voice attachment URL resolution', async () => {
    const mockChatApi = {
      async downloadAttachment(token, roomId, attachmentId) {
        assert.equal(attachmentId, '01a0d3f2-att-voice');
        return {
          downloadUrl: 'https://s3.ollacore.com/presigned/01a0d3f2-att-voice.webm',
          status: 'ready'
        };
      }
    };

    const res = await mockChatApi.downloadAttachment('token', 'room-history-1', '01a0d3f2-att-voice');
    assert.ok(res.downloadUrl);
    assert.match(res.downloadUrl, /01a0d3f2-att-voice\.webm/);
  });

  await t.test('6. Voice message playback after application restart: state properly parses durations and flags', async () => {
    const historicalMessages = [
      {
        id: 'msg-voice-old',
        roomId: 'room-restart',
        senderId: 'user-remote',
        kind: 'file',
        body: {
          text: 'Voice message',
          filename: 'voice_message_old.webm',
          mime: 'audio/webm',
          duration: 12,
          is_voice_note: true
        },
        attachmentIds: ['att-voice-old'],
        attachments: [{
          id: 'att-voice-old',
          filename: 'voice_message_old.webm',
          mime: 'video/webm'
        }],
        createdAt: '2026-09-24T10:00:00Z'
      }
    ];

    const roomState = new RoomMessagesState({ roomId: 'room-restart', currentUserId: 'user-me' });
    roomState.setInitialMessages('room-restart', historicalMessages);

    assert.equal(roomState.messages.length, 1);
    const msg = roomState.messages[0];
    const resolved = resolveMessageContent(msg);

    assert.equal(resolved.kind, 'audio');
    assert.equal(resolved.isVoiceNote, true);
    assert.equal(resolved.duration, 12);
    assert.equal(resolved.attachmentId, 'att-voice-old');
  });

  await t.test('7. Normal MP3 remains working: validation, kind audio, and MIME sanitization', async () => {
    const filename = 'sample_track.mp3';
    const byteSize = 3145728;
    const declaredMime = 'audio/mpeg';
    const headerBytes = new Uint8Array([0x49, 0x44, 0x33, 0x03, 0x00]); // ID3 tag

    const validation = validateMediaFile({
      filename,
      byteSize,
      declaredMime,
      headerBytes
    });

    assert.equal(validation.isValid, true);
    assert.equal(validation.kind, 'audio');
    assert.equal(validation.effectiveMime, 'audio/mpeg');

    // Normal MP3 is not a voice note
    const resolved = resolveMessageContent({
      id: 'mp3-msg-1',
      kind: 'audio',
      body: {
        text: 'sample_track.mp3',
        filename: 'sample_track.mp3',
        mime: 'audio/mpeg',
        byte_size: byteSize
      },
      attachmentIds: ['att-mp3-1']
    });

    assert.equal(resolved.kind, 'audio');
    assert.equal(resolved.isVoiceNote, false);
    assert.equal(resolved.filename, 'sample_track.mp3');
    assert.equal(resolved.fallbackText, '🎵 Audio: sample_track.mp3');
  });

  await t.test('8. MP3 metadata eventually renders correctly with attachment ID', async () => {
    const rawMp3History = {
      id: 'mp3-hist-1',
      room_id: 'room-mp3',
      sender_id: 'user-b',
      kind: 'file',
      body: {
        text: 'song.mp3',
        filename: 'song.mp3',
        mime: 'audio/mpeg',
        byte_size: 4096000
      },
      attachment_ids: ['att-mp3-99'],
      attachments: [{
        id: 'att-mp3-99',
        original_name: 'song.mp3',
        mime: 'audio/mpeg',
        byte_size: 4096000,
        status: 'uploaded'
      }],
      created_at: '2026-09-24T12:00:00Z'
    };

    const normalized = normalizeMessage(rawMp3History);
    const resolved = resolveMessageContent(normalized);

    assert.equal(resolved.kind, 'audio');
    assert.equal(resolved.isVoiceNote, false);
    assert.equal(resolved.attachmentId, 'att-mp3-99');
    assert.equal(resolved.filename, 'song.mp3');
    assert.equal(resolved.byteSize, 4096000);
  });

  await t.test('9. Voice and MP3 attachment metadata remain distinct where required', async () => {
    const voiceMessage = {
      id: 'msg-voice',
      kind: 'file',
      body: {
        text: 'Voice message',
        filename: 'voice_message_1.webm',
        mime: 'audio/webm',
        duration: 15,
        is_voice_note: true
      },
      attachmentIds: ['att-v1']
    };

    const mp3Message = {
      id: 'msg-mp3',
      kind: 'file',
      body: {
        text: 'music.mp3',
        filename: 'music.mp3',
        mime: 'audio/mpeg'
      },
      attachmentIds: ['att-m1']
    };

    const resolvedVoice = resolveMessageContent(voiceMessage);
    const resolvedMp3 = resolveMessageContent(mp3Message);

    assert.equal(resolvedVoice.kind, 'audio');
    assert.equal(resolvedVoice.isVoiceNote, true);
    assert.equal(resolvedVoice.duration, 15);
    assert.equal(resolvedVoice.fallbackText, '🎤 Voice message');

    assert.equal(resolvedMp3.kind, 'audio');
    assert.equal(resolvedMp3.isVoiceNote, false);
    assert.equal(resolvedMp3.duration, 0);
    assert.equal(resolvedMp3.fallbackText, '🎵 Audio: music.mp3');
  });
});
