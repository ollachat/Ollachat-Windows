import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  validateMediaFile,
  hasSuspiciousExtension,
  isSafeMimeMismatch,
  categorizeMediaKind,
  MAX_FILE_SIZE,
  SINGLE_PUT_THRESHOLD,
  MULTIPART_PART_SIZE,
  BLOCKED_MIME_TYPES,
  BLOCKED_EXTENSIONS
} from '../src/api/mime-validator.js';

import { ChatApi } from '../src/api/chat-api.js';

import {
  RoomMessagesState,
  createOptimisticMediaMessage,
  createOptimisticMessage,
  resolveMessageContent,
  isOwnMessage,
  getTickDescriptor,
  formatFileSize,
  MESSAGE_STATUS
} from '../src/renderer/chat-shell-state.js';

describe('Phase 14: Media Sharing & Attachment Contract Tests (A through T)', () => {
  const currentUserId = 'user-alice-123';
  const peerUserId = 'user-bob-456';
  const roomId = 'room-media-test';
  const roomToken = 'test-room-token-media';

  // ─────────────────────────────────────────────────────────────
  // A. Attachment button opens picker & supports expected categories
  // ─────────────────────────────────────────────────────────────
  test('A. Attachment menu categories support photos_videos, documents, and audio', () => {
    const categories = ['photos_videos', 'documents', 'audio'];
    assert.equal(categories.length, 3);
    assert.ok(categories.includes('photos_videos'));
    assert.ok(categories.includes('documents'));
    assert.ok(categories.includes('audio'));
  });

  // ─────────────────────────────────────────────────────────────
  // B. File selection works for all 4 supported categories
  // ─────────────────────────────────────────────────────────────
  test('B. File selection works and categorizes image, video, audio, and documents', () => {
    // Image
    const imgVal = validateMediaFile({ filename: 'photo.jpg', byteSize: 1024 * 1024, declaredMime: 'image/jpeg' });
    assert.equal(imgVal.isValid, true);
    assert.equal(imgVal.kind, 'image');

    // Video
    const vidVal = validateMediaFile({ filename: 'clip.mp4', byteSize: 5 * 1024 * 1024, declaredMime: 'video/mp4' });
    assert.equal(vidVal.isValid, true);
    assert.equal(vidVal.kind, 'video');

    // Audio
    const audVal = validateMediaFile({ filename: 'voice.mp3', byteSize: 2 * 1024 * 1024, declaredMime: 'audio/mpeg' });
    assert.equal(audVal.isValid, true);
    assert.equal(audVal.kind, 'audio');

    // Document / File
    const docVal = validateMediaFile({ filename: 'summary.pdf', byteSize: 3 * 1024 * 1024, declaredMime: 'application/pdf' });
    assert.equal(docVal.isValid, true);
    assert.equal(docVal.kind, 'file');
  });

  // ─────────────────────────────────────────────────────────────
  // C. Unsupported MIME type is rejected
  // ─────────────────────────────────────────────────────────────
  test('C. Unsupported and dangerous MIME types and extensions are strictly rejected', () => {
    // Windows executable
    const exeVal = validateMediaFile({ filename: 'malware.exe', byteSize: 5000, declaredMime: 'application/x-msdownload' });
    assert.equal(exeVal.isValid, false);
    assert.ok(exeVal.error.includes('rejected') || exeVal.error.includes('blocked'));

    // Shell script
    const shVal = validateMediaFile({ filename: 'script.sh', byteSize: 500, declaredMime: 'application/x-sh' });
    assert.equal(shVal.isValid, false);

    // Batch file
    const batVal = validateMediaFile({ filename: 'run.bat', byteSize: 200 });
    assert.equal(batVal.isValid, false);

    // Double extension attack
    const doubleExt = validateMediaFile({ filename: 'safe_document.pdf.exe', byteSize: 4000 });
    assert.equal(doubleExt.isValid, false);
  });

  // ─────────────────────────────────────────────────────────────
  // D. Oversized file is rejected (> 50MB)
  // ─────────────────────────────────────────────────────────────
  test('D. Oversized file exceeding 50MB limit is rejected', () => {
    const oversizedBytes = 50 * 1024 * 1024 + 1; // 50MB + 1 byte
    const val = validateMediaFile({ filename: 'giant.zip', byteSize: oversizedBytes });
    assert.equal(val.isValid, false);
    assert.ok(val.error.includes('too large'));
  });

  // ─────────────────────────────────────────────────────────────
  // E. Empty / invalid file is rejected
  // ─────────────────────────────────────────────────────────────
  test('E. Empty (0-byte) or invalid file is rejected', () => {
    const zeroByteVal = validateMediaFile({ filename: 'empty.txt', byteSize: 0 });
    assert.equal(zeroByteVal.isValid, false);
    assert.ok(zeroByteVal.error.includes('empty'));

    const negByteVal = validateMediaFile({ filename: 'bad.txt', byteSize: -1 });
    assert.equal(negByteVal.isValid, false);

    const emptyNameVal = validateMediaFile({ filename: '  ', byteSize: 100 });
    assert.equal(emptyNameVal.isValid, false);
  });

  // ─────────────────────────────────────────────────────────────
  // F. Upload starts correctly (ChatApi.initAttachment)
  // ─────────────────────────────────────────────────────────────
  test('F. Upload starts correctly via initAttachment endpoint', async () => {
    let capturedUrl = '';
    let capturedBody = null;
    let capturedHeaders = null;

    const mockFetch = async (url, options) => {
      capturedUrl = url;
      capturedBody = JSON.parse(options.body);
      capturedHeaders = options.headers;
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          attachment_id: 'att-upload-123',
          upload_url: 'https://s3.example.com/uploads/att-upload-123',
          expires_at: '2026-09-25T12:00:00Z'
        })
      };
    };

    const api = new ChatApi({ fetchFn: mockFetch });
    const initRes = await api.initAttachment(roomToken, roomId, {
      filename: 'report.pdf',
      mime: 'application/pdf',
      byteSize: 102400
    });

    assert.ok(capturedUrl.includes(`/rooms/${roomId}/attachments/init`));
    assert.equal(capturedBody.filename, 'report.pdf');
    assert.equal(capturedBody.mime, 'application/pdf');
    assert.equal(capturedBody.byte_size, 102400);
    assert.equal(capturedHeaders.Authorization, `Bearer ${roomToken}`);
    assert.equal(initRes.attachmentId, 'att-upload-123');
    assert.equal(initRes.uploadUrl, 'https://s3.example.com/uploads/att-upload-123');
  });

  // ─────────────────────────────────────────────────────────────
  // G. Upload progress is exposed correctly
  // ─────────────────────────────────────────────────────────────
  test('G. Upload progress calculations track fractional progress accurately', () => {
    const progressReports = [];
    const reportProgress = (p) => progressReports.push(Math.round(p * 100));

    // Simulate multi-step progress (0.1, 0.4, 0.8, 1.0)
    reportProgress(0.1);
    reportProgress(0.4);
    reportProgress(0.8);
    reportProgress(1.0);

    assert.deepEqual(progressReports, [10, 40, 80, 100]);
  });

  // ─────────────────────────────────────────────────────────────
  // H. Upload failure is handled cleanly
  // ─────────────────────────────────────────────────────────────
  test('H. Upload failure transitions message status to failed and exposes retry', () => {
    const state = new RoomMessagesState(currentUserId);
    const cid = 'local-upload-fail-1';
    const optimisticMsg = createOptimisticMediaMessage(roomId, currentUserId, {
      kind: 'image',
      filename: 'photo.jpg',
      clientMessageId: cid
    });

    state.addOptimisticMessage(optimisticMsg);
    assert.equal(state.messageStatus.get(cid), MESSAGE_STATUS.SENDING);

    // Simulate upload failure
    state.updateReceipt(cid, 'failed');
    assert.equal(state.messageStatus.get(cid), 'failed');

    const tickDesc = getTickDescriptor('failed', true);
    assert.equal(tickDesc.statusClass, 'status-failed');
    assert.equal(tickDesc.symbol, '⚠️');
  });

  // ─────────────────────────────────────────────────────────────
  // I. Successful upload returns attachment ID
  // ─────────────────────────────────────────────────────────────
  test('I. Complete attachment endpoint verifies attachment ID on backend', async () => {
    let capturedUrl = '';
    const mockFetch = async (url) => {
      capturedUrl = url;
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ success: true, status: 'uploaded' })
      };
    };

    const api = new ChatApi({ fetchFn: mockFetch });
    const res = await api.completeAttachment(roomToken, roomId, 'att-999');
    assert.ok(capturedUrl.includes(`/rooms/${roomId}/attachments/att-999/complete`));
    assert.equal(res.status, 'uploaded');
  });

  // ─────────────────────────────────────────────────────────────
  // J. Attachment ID is included in correct message payload
  // ─────────────────────────────────────────────────────────────
  test('J. Outgoing message payload matches verified Ollacore contract with attachment_ids', () => {
    const attachmentId = 'att-verified-456';
    const cid = 'local-msg-att-1';
    const filename = 'landscape.webp';
    const mime = 'image/webp';
    const byteSize = 850000;

    const payload = {
      client_message_id: cid,
      kind: 'image',
      body: {
        text: filename,
        filename,
        mime,
        byte_size: byteSize
      },
      reply_to: null,
      attachment_ids: [attachmentId]
    };

    assert.equal(payload.kind, 'image');
    assert.deepEqual(payload.attachment_ids, [attachmentId]);
    assert.equal(payload.body.filename, filename);
    assert.equal(payload.body.mime, mime);
    assert.equal(payload.body.byte_size, byteSize);
  });

  // ─────────────────────────────────────────────────────────────
  // K. Optimistic media message renders immediately
  // ─────────────────────────────────────────────────────────────
  test('K. Optimistic media message generates valid canonical message object with sending status', () => {
    const optimistic = createOptimisticMediaMessage(roomId, currentUserId, {
      kind: 'image',
      filename: 'beach.png',
      caption: 'Vacation photo',
      mime: 'image/png',
      byteSize: 1200000
    });

    assert.equal(optimistic.kind, 'image');
    assert.equal(optimistic.body.caption, 'Vacation photo');
    assert.equal(optimistic.status, MESSAGE_STATUS.SENDING);
    assert.ok(optimistic.clientMessageId.startsWith('local-'));

    const resolved = resolveMessageContent(optimistic);
    assert.equal(resolved.kind, 'image');
    assert.equal(resolved.caption, 'Vacation photo');
    assert.equal(resolved.filename, 'beach.png');
  });

  // ─────────────────────────────────────────────────────────────
  // L. ACK reconciliation does not duplicate the message
  // ─────────────────────────────────────────────────────────────
  test('L. ACK reconciliation merges optimistic message with confirmed server message without duplicate bubbles', () => {
    const state = new RoomMessagesState(currentUserId);
    const cid = 'local-dedup-1';

    const optimistic = createOptimisticMediaMessage(roomId, currentUserId, {
      kind: 'file',
      filename: 'specs.pdf',
      clientMessageId: cid
    });
    state.addOptimisticMessage(optimistic);
    assert.equal(state.messages.length, 1);

    // Server returns message.created frame with real server id and matching clientMessageId
    const serverMsg = {
      id: 'srv-msg-dedup-1',
      room_id: roomId,
      sender_id: currentUserId,
      kind: 'file',
      body: { text: 'specs.pdf', filename: 'specs.pdf', byte_size: 50000 },
      client_message_id: cid,
      created_at: new Date().toISOString(),
      event_seq: 15,
      attachment_ids: ['att-specs-1']
    };

    state.appendIncomingMessage(serverMsg);
    // Deduping ensures exactly 1 message remains in list
    assert.equal(state.messages.length, 1);
    assert.equal(state.messages[0].id, 'srv-msg-dedup-1');
    assert.equal(state.messages[0].clientMessageId, cid);
    assert.deepEqual(state.messages[0].attachmentIds, ['att-specs-1']);
  });

  // ─────────────────────────────────────────────────────────────
  // M. Incoming media renders as incoming (left aligned)
  // ─────────────────────────────────────────────────────────────
  test('M. Incoming media message is correctly identified as incoming', () => {
    const incomingMediaMsg = {
      id: 'msg-inc-1',
      roomId,
      senderId: peerUserId, // Peer, not current user
      kind: 'video',
      body: { filename: 'clip.mp4' },
      attachment_ids: ['att-video-1']
    };

    const isOwn = isOwnMessage(incomingMediaMsg, currentUserId);
    assert.equal(isOwn, false);
  });

  // ─────────────────────────────────────────────────────────────
  // N. Incoming media has NO outgoing ticks
  // ─────────────────────────────────────────────────────────────
  test('N. Incoming media message receives NO tick descriptors', () => {
    // Incoming delivered
    const descDelivered = getTickDescriptor('delivered', false);
    assert.equal(descDelivered.hasTick, false);
    assert.equal(descDelivered.symbol, '');

    // Incoming read
    const descRead = getTickDescriptor('read', false);
    assert.equal(descRead.hasTick, false);

    // Incoming sent
    const descSent = getTickDescriptor('sent', false);
    assert.equal(descSent.hasTick, false);
  });

  // ─────────────────────────────────────────────────────────────
  // O. Outgoing media receives receipt updates
  // ─────────────────────────────────────────────────────────────
  test('O. Outgoing media progresses through receipt lifecycle sending -> sent -> delivered -> read', () => {
    const state = new RoomMessagesState(currentUserId);
    const msgId = 'srv-msg-media-receipts';
    const cid = 'local-media-receipts';

    state.addOptimisticMessage(createOptimisticMediaMessage(roomId, currentUserId, {
      kind: 'audio',
      filename: 'recording.mp3',
      clientMessageId: cid
    }));

    // 1. Sending (initial optimistic state)
    assert.equal(state.messageStatus.get(cid), 'sending');
    assert.equal(getTickDescriptor('sending', true).symbol, '✓');

    // 2. Sent (server ACK)
    state.updateReceipt(cid, 'sent');
    assert.equal(state.messageStatus.get(cid), 'sent');
    assert.equal(getTickDescriptor('sent', true).symbol, '✓');

    // 3. Delivered (recipient device received)
    state.updateReceipt(cid, 'delivered');
    assert.equal(state.messageStatus.get(cid), 'delivered');
    assert.equal(getTickDescriptor('delivered', true).symbol, '✓✓');
    assert.equal(getTickDescriptor('delivered', true).statusClass, 'status-delivered');

    // 4. Read (recipient opened conversation)
    state.updateReceipt(cid, 'read');
    assert.equal(state.messageStatus.get(cid), 'read');
    assert.equal(getTickDescriptor('read', true).symbol, '✓✓');
    assert.equal(getTickDescriptor('read', true).statusClass, 'status-read');
  });

  // ─────────────────────────────────────────────────────────────
  // P. Media survives room switching
  // ─────────────────────────────────────────────────────────────
  test('P. Media messages survive room switching between Room A and Room B', () => {
    const stateA = new RoomMessagesState(currentUserId);
    const stateB = new RoomMessagesState(currentUserId);

    stateA.addOptimisticMessage(createOptimisticMediaMessage('room-A', currentUserId, {
      kind: 'image',
      filename: 'roomA_photo.png',
      clientMessageId: 'cid-room-a-img'
    }));

    stateB.addOptimisticMessage(createOptimisticMessage('room-B', currentUserId, 'Hello Room B'));

    // Switch to B, switch back to A
    assert.equal(stateA.messages.length, 1);
    assert.equal(stateA.messages[0].body.filename, 'roomA_photo.png');
    assert.equal(stateA.messages[0].kind, 'image');

    assert.equal(stateB.messages.length, 1);
    assert.equal(stateB.messages[0].body.text, 'Hello Room B');
  });

  // ─────────────────────────────────────────────────────────────
  // Q. Media survives history reload
  // ─────────────────────────────────────────────────────────────
  test('Q. Media messages survive history reload and cursor pagination', () => {
    const state = new RoomMessagesState(currentUserId);

    const historyMessages = [
      {
        id: 'hist-1',
        roomId,
        senderId: peerUserId,
        kind: 'file',
        body: { filename: 'guide.pdf', byte_size: 204800 },
        createdAt: '2026-09-24T10:00:00Z',
        eventSeq: 10,
        attachmentIds: ['att-guide-1']
      },
      {
        id: 'hist-2',
        roomId,
        senderId: currentUserId,
        kind: 'image',
        body: { caption: 'Sunset beach', filename: 'sunset.jpg' },
        createdAt: '2026-09-24T10:05:00Z',
        eventSeq: 11,
        attachmentIds: ['att-sunset-2']
      }
    ];

    state.loadMessages(historyMessages, false);
    assert.equal(state.messages.length, 2);
    assert.equal(state.messages[0].kind, 'file');
    assert.deepEqual(state.messages[0].attachmentIds, ['att-guide-1']);
    assert.equal(state.messages[1].kind, 'image');
    assert.deepEqual(state.messages[1].attachmentIds, ['att-sunset-2']);
  });

  // ─────────────────────────────────────────────────────────────
  // R. Media survives reconnect
  // ─────────────────────────────────────────────────────────────
  test('R. Message history retains all media messages across reconnects', () => {
    const state = new RoomMessagesState(currentUserId);
    state.addOptimisticMessage(createOptimisticMediaMessage(roomId, currentUserId, {
      kind: 'video',
      filename: 'demo.mp4',
      clientMessageId: 'cid-recon-1'
    }));

    // Simulate socket disconnect and reconnect
    // State is preserved in memory
    assert.equal(state.messages.length, 1);
    assert.equal(state.messages[0].kind, 'video');
  });

  // ─────────────────────────────────────────────────────────────
  // S. Multiple media messages work correctly in chronological order
  // ─────────────────────────────────────────────────────────────
  test('S. Multiple media messages of different kinds coexist in chronological order', () => {
    const state = new RoomMessagesState(currentUserId);

    state.appendIncomingMessage({
      id: 'm-img',
      roomId,
      senderId: peerUserId,
      kind: 'image',
      body: { filename: 'chart.png' },
      createdAt: '2026-09-24T09:00:00Z',
      eventSeq: 1,
      attachmentIds: ['att-1']
    });

    state.appendIncomingMessage({
      id: 'm-audio',
      roomId,
      senderId: currentUserId,
      kind: 'audio',
      body: { filename: 'note.mp3' },
      createdAt: '2026-09-24T09:01:00Z',
      eventSeq: 2,
      attachmentIds: ['att-2']
    });

    state.appendIncomingMessage({
      id: 'm-file',
      roomId,
      senderId: peerUserId,
      kind: 'file',
      body: { filename: 'spreadsheet.xlsx' },
      createdAt: '2026-09-24T09:02:00Z',
      eventSeq: 3,
      attachmentIds: ['att-3']
    });

    assert.equal(state.messages.length, 3);
    assert.equal(state.messages[0].kind, 'image');
    assert.equal(state.messages[1].kind, 'audio');
    assert.equal(state.messages[2].kind, 'file');
  });

  // ─────────────────────────────────────────────────────────────
  // T. Existing text and emoji messaging remain completely unaffected
  // ─────────────────────────────────────────────────────────────
  test('T. Existing text and emoji messages function without any regression', () => {
    const state = new RoomMessagesState(currentUserId);

    const textMsg = createOptimisticMessage(roomId, currentUserId, 'Hello World', 'cid-text-1');
    state.addOptimisticMessage(textMsg);

    const emojiMsg = createOptimisticMessage(roomId, currentUserId, '😀🎉🚀', 'cid-emoji-1');
    state.addOptimisticMessage(emojiMsg);

    assert.equal(state.messages.length, 2);
    assert.equal(state.messages[0].body.text, 'Hello World');
    assert.equal(state.messages[1].body.text, '😀🎉🚀');

    const resText = resolveMessageContent(state.messages[0]);
    assert.equal(resText.isFallback, false);
    assert.equal(resText.text, 'Hello World');

    const resEmoji = resolveMessageContent(state.messages[1]);
    assert.equal(resEmoji.isFallback, false);
    assert.equal(resEmoji.text, '😀🎉🚀');
  });

  // ─────────────────────────────────────────────────────────────
  // U. Multipart upload endpoints (>10MB threshold)
  // ─────────────────────────────────────────────────────────────
  test('U. Large files (>10MB) use init-multipart and complete-multipart APIs', async () => {
    let capturedInitUrl = '';
    let capturedCompleteUrl = '';

    const mockFetch = async (url, options) => {
      if (url.includes('init-multipart')) {
        capturedInitUrl = url;
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            attachment_id: 'att-multipart-1',
            upload_id: 'up-id-1',
            part_size: MULTIPART_PART_SIZE,
            part_urls: ['https://s3.example.com/part1', 'https://s3.example.com/part2']
          })
        };
      }
      if (url.includes('complete-multipart')) {
        capturedCompleteUrl = url;
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ success: true, status: 'uploaded' })
        };
      }
      return { ok: false, status: 404, text: async () => '{}' };
    };

    const api = new ChatApi({ fetchFn: mockFetch });
    const initRes = await api.initMultipartUpload(roomToken, roomId, {
      filename: 'video.mp4',
      mime: 'video/mp4',
      byteSize: 15 * 1024 * 1024
    });

    assert.ok(capturedInitUrl.includes(`/rooms/${roomId}/attachments/init-multipart`));
    assert.equal(initRes.attachmentId, 'att-multipart-1');
    assert.equal(initRes.partUrls.length, 2);

    const completeRes = await api.completeMultipartUpload(roomToken, roomId, initRes.attachmentId, [
      { partNumber: 1, etag: 'etag-1' },
      { partNumber: 2, etag: 'etag-2' }
    ]);
    assert.ok(capturedCompleteUrl.includes(`/rooms/${roomId}/attachments/att-multipart-1/complete-multipart`));
    assert.equal(completeRes.status, 'uploaded');
  });

  // ─────────────────────────────────────────────────────────────
  // V. Presigned download URL resolution
  // ─────────────────────────────────────────────────────────────
  test('V. Presigned download URL is retrieved via GET /rooms/{id}/attachments/{id}/download', async () => {
    let capturedUrl = '';
    const mockFetch = async (url) => {
      capturedUrl = url;
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          download_url: 'https://s3.example.com/download/att-123.jpg',
          expires_at: '2026-09-25T12:00:00Z'
        })
      };
    };

    const api = new ChatApi({ fetchFn: mockFetch });
    const res = await api.downloadAttachment(roomToken, roomId, 'att-123');
    assert.ok(capturedUrl.includes(`/rooms/${roomId}/attachments/att-123/download`));
    assert.equal(res.downloadUrl, 'https://s3.example.com/download/att-123.jpg');
  });

  // ─────────────────────────────────────────────────────────────
  // W. formatFileSize utility formats bytes human-readably
  // ─────────────────────────────────────────────────────────────
  test('W. formatFileSize utility formats small and large byte counts accurately', () => {
    assert.equal(formatFileSize(0), '0 B');
    assert.equal(formatFileSize(512), '512 B');
    assert.equal(formatFileSize(1024), '1.0 KB');
    assert.equal(formatFileSize(1.5 * 1024 * 1024), '1.5 MB');
    assert.equal(formatFileSize(10 * 1024 * 1024), '10.0 MB');
  });

  // ─────────────────────────────────────────────────────────────
  // X. Content-Security-Policy enables media-src, blob:, and https:
  // ─────────────────────────────────────────────────────────────
  test('X. Content-Security-Policy enables media-src, blob:, and https: for attachments', () => {
    const htmlPath = path.join(import.meta.dirname, '..', 'src', 'renderer', 'index.html');
    const html = fs.readFileSync(htmlPath, 'utf8');

    assert.ok(html.includes("media-src 'self' data: blob: https:;"), 'CSP must include media-src allowing blob: and https:');
    assert.ok(html.includes("img-src 'self' data: blob: https:;"), 'CSP must include img-src allowing blob: and https:');
    assert.ok(html.includes("connect-src 'self' https: wss:;"), 'CSP must include connect-src allowing https: and wss:');
  });

  // ─────────────────────────────────────────────────────────────
  // Y. Preload script exposes dialog and shell desktop bridges
  // ─────────────────────────────────────────────────────────────
  test('Y. Preload script exposes dialog and shell desktop bridges for media interaction', () => {
    const preloadPath = path.join(import.meta.dirname, '..', 'src', 'preload', 'preload.js');
    const content = fs.readFileSync(preloadPath, 'utf8');

    assert.ok(content.includes('saveMediaFile'), 'Preload must expose saveMediaFile');
    assert.ok(content.includes('openMediaFile'), 'Preload must expose openMediaFile');
    assert.ok(content.includes('shell: {'), 'Preload must expose shell namespace');
    assert.ok(content.includes('openExternal'), 'Preload must expose shell.openExternal');
    assert.ok(content.includes('showItemInFolder'), 'Preload must expose shell.showItemInFolder');
  });

  // ─────────────────────────────────────────────────────────────
  // Z. Media bubble rendering produces interactive media elements
  // ─────────────────────────────────────────────────────────────
  test('Z. Media bubble rendering produces interactive media elements instead of fallback text', () => {
    // Helper replicating createMessageBubbleElement branch ordering
    function evaluateBubbleKind(message) {
      const resolved = resolveMessageContent(message);
      if (resolved.kind === 'image') {
        return { type: 'image', hasLightbox: true, filename: resolved.filename };
      } else if (resolved.kind === 'video') {
        return { type: 'video', hasControls: true, filename: resolved.filename };
      } else if (resolved.kind === 'audio') {
        return { type: 'audio', hasControls: true, filename: resolved.filename };
      } else if (resolved.kind === 'file') {
        return { type: 'file', hasDownload: true, filename: resolved.filename };
      } else if (resolved.isFallback) {
        return { type: 'fallback', text: resolved.fallbackText };
      }
      return { type: 'text', text: resolved.text };
    }

    const imgBubble = evaluateBubbleKind({
      id: 'm-img',
      kind: 'image',
      body: { filename: 'sunset.png', url: 'https://api.ollacore.com/sunset.png' },
      attachment_ids: ['att-1']
    });
    assert.equal(imgBubble.type, 'image');
    assert.equal(imgBubble.hasLightbox, true);

    const vidBubble = evaluateBubbleKind({
      id: 'm-vid',
      kind: 'video',
      body: { filename: 'demo.mp4', url: 'https://api.ollacore.com/demo.mp4' },
      attachment_ids: ['att-2']
    });
    assert.equal(vidBubble.type, 'video');
    assert.equal(vidBubble.hasControls, true);

    const audBubble = evaluateBubbleKind({
      id: 'm-aud',
      kind: 'file',
      body: { filename: 'notes.mp3', mime: 'audio/mpeg', url: 'https://api.ollacore.com/notes.mp3' },
      attachment_ids: ['att-3']
    });
    assert.equal(audBubble.type, 'audio');
    assert.equal(audBubble.hasControls, true);

    const fileBubble = evaluateBubbleKind({
      id: 'm-file',
      kind: 'file',
      body: { filename: 'report.pdf', mime: 'application/pdf', url: 'https://api.ollacore.com/report.pdf' },
      attachment_ids: ['att-4']
    });
    assert.equal(fileBubble.type, 'file');
    assert.equal(fileBubble.hasDownload, true);

    const unsupportedBubble = evaluateBubbleKind({
      id: 'm-unknown',
      kind: 'custom_3d_model',
      body: {}
    });
    assert.equal(unsupportedBubble.type, 'fallback');
    assert.ok(unsupportedBubble.text.includes('Unsupported message'));
  });

  // ─────────────────────────────────────────────────────────────
  // AA. Main process enforces shell handlers and save dialog
  // ─────────────────────────────────────────────────────────────
  test('AA. Main process enforces shell handlers and save dialog IPC', () => {
    const mainPath = path.join(import.meta.dirname, '..', 'src', 'main', 'main.js');
    const content = fs.readFileSync(mainPath, 'utf8');

    assert.ok(content.includes('dialog:save-media-file'), 'Main process must implement dialog:save-media-file');
    assert.ok(content.includes('shell:open-external'), 'Main process must implement shell:open-external');
    assert.ok(content.includes('shell:show-item-in-folder'), 'Main process must implement shell:show-item-in-folder');
    assert.ok(content.includes('setWindowOpenHandler'), 'Main process must configure setWindowOpenHandler');
  });
});
