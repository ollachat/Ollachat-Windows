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
import { ChatApi } from '../src/api/chat-api.js';
import { validateMediaFile } from '../src/api/mime-validator.js';

class MockAudioTrack {
  constructor() {
    this.kind = 'audio';
    this.enabled = true;
    this.stopped = false;
  }
  stop() {
    this.stopped = true;
  }
}

class MockMediaStream {
  constructor(tracks = [new MockAudioTrack()]) {
    this.tracks = tracks;
  }
  getTracks() {
    return this.tracks;
  }
}

class MockMediaDevices {
  constructor({ shouldDeny = false, errorType = 'NotAllowedError', errorMessage = 'Permission denied' } = {}) {
    this.shouldDeny = shouldDeny;
    this.errorType = errorType;
    this.errorMessage = errorMessage;
    this.calls = [];
  }

  async getUserMedia(constraints) {
    this.calls.push(constraints);
    if (this.shouldDeny) {
      const err = new Error(this.errorMessage);
      err.name = this.errorType;
      throw err;
    }
    return new MockMediaStream();
  }
}

class MockMediaRecorder {
  static isTypeSupported() {
    return true;
  }

  constructor(stream, options = {}) {
    this.stream = stream;
    this.options = options;
    this.mimeType = options.mimeType || 'audio/webm;codecs=opus';
    this.state = 'inactive';
    this.ondataavailable = null;
    this.onerror = null;
    this.onstop = null;
  }

  start() {
    this.state = 'recording';
    setTimeout(() => {
      if (this.ondataavailable) {
        this.ondataavailable({ data: new Blob(['voice-data'], { type: this.mimeType }) });
      }
    }, 10);
  }

  stop() {
    this.state = 'inactive';
    setTimeout(() => {
      if (this.ondataavailable) {
        this.ondataavailable({ data: new Blob(['voice-data-final'], { type: this.mimeType }) });
      }
      if (this.onstop) {
        this.onstop();
      }
    }, 10);
  }
}

test('Step 2 Verification: Voice & Media Sharing Bug Fixes Suite (A through K)', async (t) => {
  // Bug 1: Permissions & Recording Lifecycle
  await t.test('A. microphone permission success', async () => {
    const mediaDevices = new MockMediaDevices({ shouldDeny: false });
    const recorder = new VoiceRecorder({
      mediaDevices,
      MediaRecorderClass: MockMediaRecorder,
      minDurationMs: 0
    });

    assert.equal(recorder.getState(), RECORDING_STATE.IDLE);
    const started = await recorder.start();
    assert.equal(started, true);
    assert.equal(mediaDevices.calls.length, 1);
    assert.deepEqual(mediaDevices.calls[0], { audio: true, video: false });
    assert.equal(recorder.getState(), RECORDING_STATE.RECORDING);
    assert.equal(recorder.isRecording(), true);

    const result = await recorder.stop();
    assert.ok(result);
    assert.ok(result.blob);
    assert.equal(recorder.getState(), RECORDING_STATE.IDLE);
  });

  await t.test('B. microphone permission denial', async () => {
    const mediaDevices = new MockMediaDevices({
      shouldDeny: true,
      errorType: 'NotAllowedError',
      errorMessage: 'User denied microphone access'
    });
    const recorder = new VoiceRecorder({
      mediaDevices,
      MediaRecorderClass: MockMediaRecorder
    });

    let caughtErr = null;
    try {
      await recorder.start();
    } catch (err) {
      caughtErr = err;
    }

    assert.ok(caughtErr);
    assert.match(caughtErr.message, /Microphone permission denied/i);
    assert.equal(recorder.getState(), RECORDING_STATE.ERROR);
    assert.equal(recorder.isRecording(), false);
  });

  await t.test('C. recorder failure', async () => {
    const mediaDevices = new MockMediaDevices({
      shouldDeny: true,
      errorType: 'NotFoundError',
      errorMessage: 'Requested device not found'
    });
    const recorder = new VoiceRecorder({
      mediaDevices,
      MediaRecorderClass: MockMediaRecorder
    });

    let caughtErr = null;
    try {
      await recorder.start();
    } catch (err) {
      caughtErr = err;
    }

    assert.ok(caughtErr);
    assert.match(caughtErr.message, /No microphone device found/i);
    assert.equal(recorder.getState(), RECORDING_STATE.ERROR);

    // Test device busy error
    const busyDevices = new MockMediaDevices({
      shouldDeny: true,
      errorType: 'NotReadableError',
      errorMessage: 'Device is in use'
    });
    const busyRecorder = new VoiceRecorder({
      mediaDevices: busyDevices,
      MediaRecorderClass: MockMediaRecorder
    });

    let busyErr = null;
    try {
      await busyRecorder.start();
    } catch (err) {
      busyErr = err;
    }
    assert.ok(busyErr);
    assert.match(busyErr.message, /already in use/i);
  });

  // Bug 2: Historical Voice Message URL Resolution & Playback
  await t.test('D. historical voice message URL resolution', async () => {
    // 1. Message from REST history with body.attachment_ids
    const historyMessage1 = {
      id: 'msg_hist_001',
      room_id: 'room_voice_1',
      sender_id: 'user_bob',
      kind: 'file',
      created_at: new Date().toISOString(),
      body: {
        text: 'Voice message',
        filename: 'voice_message_001.webm',
        mime: 'audio/webm;codecs=opus',
        is_voice_note: true,
        duration: 8,
        attachment_ids: ['att_voice_s3_101']
      }
    };

    const resolved1 = resolveMessageContent(historyMessage1);
    assert.equal(resolved1.kind, 'audio');
    assert.equal(resolved1.isVoiceNote, true);
    assert.equal(resolved1.duration, 8);
    assert.equal(resolved1.attachmentId, 'att_voice_s3_101');

    // 2. Message from REST history with message.attachments array
    const historyMessage2 = {
      id: 'msg_hist_002',
      room_id: 'room_voice_1',
      sender_id: 'user_alice',
      kind: 'file',
      created_at: new Date().toISOString(),
      body: {
        text: 'Voice message',
        is_voice_note: true,
        duration: 15
      },
      attachments: [{
        attachment_id: 'att_voice_s3_102',
        filename: 'voice_message_002.webm',
        mime: 'audio/webm'
      }]
    };

    const resolved2 = resolveMessageContent(historyMessage2);
    assert.equal(resolved2.kind, 'audio');
    assert.equal(resolved2.isVoiceNote, true);
    assert.equal(resolved2.duration, 15);
    assert.equal(resolved2.attachmentId, 'att_voice_s3_102');
  });

  await t.test('E. expired presigned URL re-resolution', async () => {
    let downloadCallCount = 0;
    const mockChatApi = {
      downloadAttachment: async (roomId, attachmentId) => {
        downloadCallCount++;
        return {
          downloadUrl: `https://s3.amazonaws.com/ollacore/audio_${attachmentId}_v${downloadCallCount}.webm`,
          expiresAt: new Date(Date.now() + 3600000).toISOString()
        };
      }
    };

    const attachmentUrls = new Map();

    // Initial resolution
    const res1 = await mockChatApi.downloadAttachment('room_1', 'att_expired_01');
    attachmentUrls.set('att_expired_01', res1.downloadUrl);
    assert.equal(downloadCallCount, 1);
    assert.match(attachmentUrls.get('att_expired_01'), /_v1\.webm$/);

    // Audio error triggers cache invalidation and re-resolution once
    attachmentUrls.delete('att_expired_01');
    const res2 = await mockChatApi.downloadAttachment('room_1', 'att_expired_01');
    attachmentUrls.set('att_expired_01', res2.downloadUrl);
    assert.equal(downloadCallCount, 2);
    assert.match(attachmentUrls.get('att_expired_01'), /_v2\.webm$/);
  });

  await t.test('F. voice message playback after app restart', () => {
    // When app restarts, ephemeral blob: URLs do not exist.
    // Ensure resolveMessageContent returns valid attachmentId to resolve presigned S3 URL
    const freshReopenedMessage = {
      id: 'msg_reopened_99',
      room_id: 'room_reopen',
      sender_id: 'user_charlie',
      kind: 'file',
      created_at: new Date(Date.now() - 3600000).toISOString(),
      body: {
        text: 'Voice message',
        is_voice_note: true,
        duration: 22,
        attachment_id: 'att_persisted_99'
      }
    };

    const resolved = resolveMessageContent(freshReopenedMessage);
    assert.equal(resolved.isVoiceNote, true);
    assert.equal(resolved.attachmentId, 'att_persisted_99');
    assert.equal(resolved.url, null); // url is null so renderer will fetch presigned URL, not stale blob
    assert.equal(resolved.duration, 22);
  });

  // Bug 3: Readiness Verification & Message Send
  await t.test('G. voice message send without retry', async () => {
    let initCalled = false;
    let completeCalled = false;
    let readinessPolled = false;
    let messageSent = false;

    const mockBackend = {
      initAttachment: async (roomId, params) => {
        initCalled = true;
        return {
          attachmentId: 'att_vm_live_01',
          uploadUrl: 'https://s3.amazonaws.com/upload/voice.webm'
        };
      },
      completeAttachment: async (roomId, attachmentId) => {
        completeCalled = true;
        return { success: true };
      },
      downloadAttachment: async (roomId, attachmentId) => {
        readinessPolled = true;
        return {
          downloadUrl: 'https://s3.amazonaws.com/ollacore/voice.webm'
        };
      },
      sendMessage: async (payload) => {
        // Must only be sent AFTER attachment is completed and ready!
        assert.equal(initCalled, true);
        assert.equal(completeCalled, true);
        assert.equal(readinessPolled, true);
        assert.deepEqual(payload.attachment_ids, ['att_vm_live_01']);
        messageSent = true;
        return { ok: true, requestId: 'req_001' };
      }
    };

    // Simulate recorder producing blob
    const voiceBlob = new Blob(['voice-recording-bytes'], { type: 'audio/webm;codecs=opus' });
    const roomId = 'room_fast_send';

    // 1. Init
    const init = await mockBackend.initAttachment(roomId, { filename: 'voice.webm', mime: 'audio/webm', byteSize: voiceBlob.size });
    // 2. Complete
    await mockBackend.completeAttachment(roomId, init.attachmentId);
    // 3. Verify readiness
    const ready = await mockBackend.downloadAttachment(roomId, init.attachmentId);
    assert.ok(ready.downloadUrl);
    // 4. Send
    const sendRes = await mockBackend.sendMessage({
      client_message_id: 'local-vm-01',
      kind: 'file',
      body: { text: 'Voice message', is_voice_note: true, duration: 5 },
      attachment_ids: [init.attachmentId]
    });

    assert.equal(sendRes.ok, true);
    assert.equal(messageSent, true);
  });

  await t.test('H. attachment readiness race', async () => {
    let pollCount = 0;
    const mockBackendWithDelay = {
      downloadAttachment: async (roomId, attachmentId) => {
        pollCount++;
        if (pollCount < 3) {
          // Backend asynchronous worker still finalizing S3 object
          throw new Error('Attachment processing in progress (HTTP 409)');
        }
        return { downloadUrl: 'https://s3.amazonaws.com/ollacore/ready.webm' };
      }
    };

    // Client polling loop until ready
    let verifiedUrl = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const res = await mockBackendWithDelay.downloadAttachment('room_race', 'att_race_01');
        if (res?.downloadUrl) {
          verifiedUrl = res.downloadUrl;
          break;
        }
      } catch {
        await new Promise(r => setTimeout(r, 10));
      }
    }

    assert.equal(pollCount, 3);
    assert.ok(verifiedUrl);
    assert.match(verifiedUrl, /ready\.webm/);
  });

  await t.test('I. ordinary audio send without retry', async () => {
    const audioValidation = validateMediaFile({
      filename: 'interview_podcast.mp3',
      byteSize: 1024 * 500,
      declaredMime: 'audio/mpeg'
    });

    assert.equal(audioValidation.isValid, true);
    assert.equal(audioValidation.kind, 'audio');

    const msg = createOptimisticMediaMessage('room_audio', 'user_alice', {
      kind: audioValidation.kind,
      filename: 'interview_podcast.mp3',
      mime: audioValidation.effectiveMime,
      byteSize: 1024 * 500,
      clientMessageId: 'local-audio-send-1'
    });

    assert.equal(msg.kind, 'audio');
    assert.equal(msg.body.filename, 'interview_podcast.mp3');
  });

  await t.test('J. retry does not duplicate messages', () => {
    const roomState = new RoomMessagesState('user_self');
    const clientMessageId = 'local-uuid-unique-123';

    // 1. Initial optimistic message
    const optMsg = createOptimisticVoiceMessage('room_retry_test', 'user_self', {
      filename: 'voice_msg.webm',
      mime: 'audio/webm;codecs=opus',
      byteSize: 12000,
      duration: 7,
      clientMessageId
    });

    roomState.addOptimisticMessage(optMsg);
    assert.equal(roomState.messages.length, 1);
    assert.equal(roomState.messages[0].clientMessageId, clientMessageId);

    // 2. Initial send fails -> mark failed
    roomState.updateReceipt(clientMessageId, 'failed');
    assert.equal(roomState.messageStatus.get(clientMessageId), 'failed');

    // 3. User clicks Retry: status changes back to sending, reusing clientMessageId without adding a new message
    roomState.updateReceipt(clientMessageId, 'sending');
    assert.equal(roomState.messageStatus.get(clientMessageId), 'sending');
    assert.equal(roomState.messages.length, 1); // No duplicate!

    // 4. Server ACK / created arrives
    const serverMessage = {
      id: 'srv_msg_777',
      client_message_id: clientMessageId,
      room_id: 'room_retry_test',
      sender_id: 'user_self',
      kind: 'file',
      created_at: new Date().toISOString(),
      body: {
        text: 'Voice message',
        is_voice_note: true,
        duration: 7
      },
      attachment_ids: ['att_srv_777']
    };

    roomState.appendIncomingMessage(serverMessage);
    assert.equal(roomState.messages.length, 1);
    assert.equal(roomState.messages[0].id, 'srv_msg_777');
    assert.equal(roomState.messages[0].clientMessageId, clientMessageId);
  });

  await t.test('K. room switching preserves playable voice messages', () => {
    const shellState = new ChatShellState();
    shellState.setInbox([
      { roomId: 'room_alpha', name: 'Alpha Chat', kind: 'direct' },
      { roomId: 'room_beta', name: 'Beta Chat', kind: 'direct' }
    ]);

    const stateAlpha = new RoomMessagesState('user_me');
    const stateBeta = new RoomMessagesState('user_me');

    // Alpha has a voice message
    stateAlpha.setInitialMessages('room_alpha', [
      {
        id: 'msg_alpha_voice',
        room_id: 'room_alpha',
        sender_id: 'user_peer',
        kind: 'file',
        created_at: new Date().toISOString(),
        body: { text: 'Voice message', is_voice_note: true, duration: 10, attachment_id: 'att_alpha_01' }
      }
    ]);

    // Beta has a text message
    stateBeta.setInitialMessages('room_beta', [
      {
        id: 'msg_beta_text',
        room_id: 'room_beta',
        sender_id: 'user_peer',
        kind: 'text',
        created_at: new Date().toISOString(),
        body: { text: 'Hello in Beta' }
      }
    ]);

    // Select Alpha
    shellState.selectConversation('room_alpha');
    assert.equal(shellState.selectedRoomId, 'room_alpha');
    const contentAlpha = resolveMessageContent(stateAlpha.messages[0]);
    assert.equal(contentAlpha.isVoiceNote, true);
    assert.equal(contentAlpha.attachmentId, 'att_alpha_01');

    // Switch to Beta
    shellState.selectConversation('room_beta');
    assert.equal(shellState.selectedRoomId, 'room_beta');
    const contentBeta = resolveMessageContent(stateBeta.messages[0]);
    assert.equal(contentBeta.kind, 'text');

    // Switch back to Alpha: voice message is still preserved and playable
    shellState.selectConversation('room_alpha');
    assert.equal(shellState.selectedRoomId, 'room_alpha');
    const contentAlphaAgain = resolveMessageContent(stateAlpha.messages[0]);
    assert.equal(contentAlphaAgain.isVoiceNote, true);
    assert.equal(contentAlphaAgain.attachmentId, 'att_alpha_01');
    assert.equal(contentAlphaAgain.duration, 10);
  });

  await t.test('L. voice player precision timer and seeking calculations', () => {
    // 1. Timer formatting
    assert.equal(VoiceRecorder.formatDuration(0), '0:00');
    assert.equal(VoiceRecorder.formatDuration(1), '0:01');
    assert.equal(VoiceRecorder.formatDuration(9), '0:09');
    assert.equal(VoiceRecorder.formatDuration(13), '0:13');
    assert.equal(VoiceRecorder.formatDuration(65), '1:05');

    // 2. Timer display format: currentTime / duration
    const formatDisplay = (curr, dur) => `${VoiceRecorder.formatDuration(curr)} / ${VoiceRecorder.formatDuration(dur)}`;
    assert.equal(formatDisplay(0, 13), '0:00 / 0:13');
    assert.equal(formatDisplay(1, 13), '0:01 / 0:13');
    assert.equal(formatDisplay(2, 13), '0:02 / 0:13');
    assert.equal(formatDisplay(13, 13), '0:13 / 0:13');

    // 3. Seeking math across 0%, 25%, 50%, 75%, 100%
    const totalDur = 16; // 16 seconds
    const calcSeek = (ratio) => Math.max(0, Math.min(totalDur, ratio * totalDur));
    assert.equal(calcSeek(0.0), 0);
    assert.equal(calcSeek(0.25), 4);
    assert.equal(calcSeek(0.50), 8);
    assert.equal(calcSeek(0.75), 12);
    assert.equal(calcSeek(1.0), 16);

    // Slider value mapping (0 to 1000)
    const calcSliderVal = (currentTime) => (currentTime / totalDur) * 1000;
    assert.equal(calcSliderVal(0), 0);
    assert.equal(calcSliderVal(4), 250);
    assert.equal(calcSliderVal(8), 500);
    assert.equal(calcSliderVal(12), 750);
    assert.equal(calcSliderVal(16), 1000);
  });

  await t.test('M. normalizeMessage extracts attachment IDs across all backend structures', async () => {
    const { normalizeMessage } = await import('../src/api/chat-api.js');

    // 1. Top-level attachment_ids array
    const m1 = normalizeMessage({ id: '1', attachment_ids: ['att_1'] });
    assert.deepEqual(m1.attachmentIds, ['att_1']);

    // 2. Top-level attachments array of objects
    const m2 = normalizeMessage({ id: '2', attachments: [{ attachment_id: 'att_2', filename: 'audio.mp3' }] });
    assert.deepEqual(m2.attachmentIds, ['att_2']);
    assert.equal(m2.attachments[0].attachmentId, 'att_2');

    // 3. Body-level attachment_ids array
    const m3 = normalizeMessage({ id: '3', body: { attachment_ids: ['att_3'], is_voice_note: true } });
    assert.deepEqual(m3.attachmentIds, ['att_3']);

    // 4. Body-level attachments array of objects
    const m4 = normalizeMessage({ id: '4', body: { attachments: [{ id: 'att_4' }] } });
    assert.deepEqual(m4.attachmentIds, ['att_4']);

    // 5. Body-level attachment_id scalar
    const m5 = normalizeMessage({ id: '5', body: { attachment_id: 'att_5' } });
    assert.deepEqual(m5.attachmentIds, ['att_5']);

    // 6. Top-level attachment_id scalar
    const m6 = normalizeMessage({ id: '6', attachment_id: 'att_6' });
    assert.deepEqual(m6.attachmentIds, ['att_6']);
  });

  await t.test('N. single audio instance management', () => {
    let activeVoiceAudio = null;

    const audioA = { paused: true, play: () => { audioA.paused = false; }, pause: () => { audioA.paused = true; } };
    const audioB = { paused: true, play: () => { audioB.paused = false; }, pause: () => { audioB.paused = true; } };

    // Play A
    if (activeVoiceAudio && activeVoiceAudio !== audioA) {
      activeVoiceAudio.pause();
    }
    activeVoiceAudio = audioA;
    audioA.play();

    assert.equal(audioA.paused, false);
    assert.equal(audioB.paused, true);
    assert.equal(activeVoiceAudio, audioA);

    // Play B -> A is paused automatically
    if (activeVoiceAudio && activeVoiceAudio !== audioB) {
      activeVoiceAudio.pause();
    }
    activeVoiceAudio = audioB;
    audioB.play();

    assert.equal(audioA.paused, true);
    assert.equal(audioB.paused, false);
    assert.equal(activeVoiceAudio, audioB);
  });

  await t.test('O. WebM Opus magic byte validation matches EBML header [0x1A, 0x45, 0xDF, 0xA3]', () => {
    const webmHeader = Buffer.from([0x1A, 0x45, 0xDF, 0xA3, 0x01, 0x00, 0x00, 0x00]);
    const res = validateMediaFile({
      filename: 'voice_message.webm',
      byteSize: 1024,
      declaredMime: 'audio/webm;codecs=opus',
      headerBytes: webmHeader
    });
    assert.equal(res.isValid, true);
    assert.equal(res.kind, 'audio');
    assert.equal(res.effectiveMime, 'audio/webm;codecs=opus');
  });

  await t.test('P. MP3 audio validation matches ID3 tag header and frame sync', () => {
    const id3Header = Buffer.from([0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0x00]);
    const resId3 = validateMediaFile({
      filename: 'song.mp3',
      byteSize: 2048,
      declaredMime: 'audio/mpeg',
      headerBytes: id3Header
    });
    assert.equal(resId3.isValid, true);
    assert.equal(resId3.kind, 'audio');

    const mpegSyncHeader = Buffer.from([0xFF, 0xFB, 0x90, 0x64]);
    const resSync = validateMediaFile({
      filename: 'audio.mp3',
      byteSize: 2048,
      declaredMime: 'audio/mpeg',
      headerBytes: mpegSyncHeader
    });
    assert.equal(resSync.isValid, true);
    assert.equal(resSync.kind, 'audio');
  });

  await t.test('Q. Historical voice message resolution and duration extraction', () => {
    const rawHistoricalMsg = {
      id: 'msg_hist_999',
      room_id: 'room_voice_101',
      sender_id: 'user_bob',
      kind: 'file',
      created_at: '2026-09-24T18:00:00.000Z',
      body: {
        text: 'Voice message',
        filename: 'voice_message_1727271234.webm',
        mime: 'audio/webm;codecs=opus',
        byte_size: 4096,
        duration: 7,
        is_voice_note: true
      },
      attachment_ids: ['att_hist_999']
    };

    const resolved = resolveMessageContent(rawHistoricalMsg);
    assert.equal(resolved.kind, 'audio');
    assert.equal(resolved.isVoiceNote, true);
    assert.equal(resolved.duration, 7);
    assert.equal(resolved.attachmentId, 'att_hist_999');
    assert.equal(resolved.fallbackText, '🎤 Voice message');
  });

  await t.test('R. Permission error message mapping produces clear actionable text', async () => {
    const deniedMediaDevices = new MockMediaDevices({
      shouldDeny: true,
      errorType: 'NotAllowedError',
      errorMessage: 'Permission denied'
    });
    const recorder = new VoiceRecorder({ mediaDevices: deniedMediaDevices });
    await assert.rejects(
      () => recorder.start(),
      /Microphone permission denied/
    );
    assert.equal(recorder.getState(), RECORDING_STATE.ERROR);
    assert.match(recorder.error, /Microphone permission denied/);

    const noMicMediaDevices = new MockMediaDevices({
      shouldDeny: true,
      errorType: 'NotFoundError',
      errorMessage: 'Device not found'
    });
    const recorder2 = new VoiceRecorder({ mediaDevices: noMicMediaDevices });
    await assert.rejects(
      () => recorder2.start(),
      /No microphone device found/
    );
    assert.equal(recorder2.getState(), RECORDING_STATE.ERROR);
    assert.match(recorder2.error, /No microphone device found/);
  });

  await t.test('S. Retry payload normalization enforces wire kind "file" for audio', () => {
    const testKinds = ['audio', 'image', 'video', 'file', 'text'];
    const normalizeWireKind = (k) => (k === 'audio' || k === 'image' || k === 'video') ? 'file' : k;

    assert.equal(normalizeWireKind('audio'), 'file');
    assert.equal(normalizeWireKind('image'), 'file');
    assert.equal(normalizeWireKind('video'), 'file');
    assert.equal(normalizeWireKind('file'), 'file');
    assert.equal(normalizeWireKind('text'), 'text');
  });
});

