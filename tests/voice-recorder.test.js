import test from 'node:test';
import assert from 'node:assert/strict';
import {
  VoiceRecorder,
  RECORDING_STATE,
  DEFAULT_MAX_DURATION_MS,
  DEFAULT_MIN_DURATION_MS,
  getSupportedAudioMimeType
} from '../src/renderer/voice-recorder.js';
import {
  createOptimisticVoiceMessage,
  createOptimisticMediaMessage,
  resolveMessageContent
} from '../src/renderer/chat-shell-state.js';

class MockAudioTrack {
  constructor() {
    this.kind = 'audio';
    this.enabled = true;
    this.stopped = false;
    this.readyState = 'live';
  }

  stop() {
    this.stopped = true;
    this.readyState = 'ended';
  }
}

class MockMediaStream {
  constructor(tracks = [new MockAudioTrack()]) {
    this.tracks = tracks;
  }

  getTracks() {
    return this.tracks;
  }

  getAudioTracks() {
    return this.tracks.filter(t => t.kind === 'audio');
  }

  getVideoTracks() {
    return this.tracks.filter(t => t.kind === 'video');
  }
}

class MockMediaDevices {
  constructor({ shouldDeny = false, errorType = 'NotAllowedError' } = {}) {
    this.shouldDeny = shouldDeny;
    this.errorType = errorType;
    this.getUserMediaCalls = [];
  }

  async getUserMedia(constraints) {
    this.getUserMediaCalls.push(constraints);
    if (this.shouldDeny) {
      const err = new Error('Permission denied');
      err.name = this.errorType;
      throw err;
    }
    return new MockMediaStream();
  }
}

class MockMediaRecorder {
  static isTypeSupported(mime) {
    return mime.startsWith('audio/webm');
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

  start(timeslice = 100) {
    this.state = 'recording';
    // Simulate initial chunk
    setTimeout(() => {
      if (this.state === 'recording' && this.ondataavailable) {
        this.ondataavailable({ data: new Blob(['mock-audio-bytes'], { type: this.mimeType }) });
      }
    }, 20);
  }

  stop() {
    this.state = 'inactive';
    setTimeout(() => {
      if (this.ondataavailable) {
        this.ondataavailable({ data: new Blob(['final-mock-audio-bytes'], { type: this.mimeType }) });
      }
      if (this.onstop) {
        this.onstop();
      }
    }, 10);
  }
}

class MockAudioContext {
  constructor() {
    this.isClosed = false;
  }
  createMediaStreamSource() {
    return { connect: () => {} };
  }
  createAnalyser() {
    return {
      fftSize: 64,
      frequencyBinCount: 32,
      getByteFrequencyData: (arr) => arr.fill(50)
    };
  }
  close() {
    this.isClosed = true;
  }
}

test('Step 2: Voice Recorder Controller & Metadata Suite', async (t) => {
  await t.test('1. Preferred MIME type selection detects audio/webm;codecs=opus', () => {
    const mime = getSupportedAudioMimeType(MockMediaRecorder);
    assert.equal(mime, 'audio/webm;codecs=opus');
  });

  await t.test('2. Initialization starts in clean IDLE state', () => {
    const recorder = new VoiceRecorder();
    assert.equal(recorder.getState(), RECORDING_STATE.IDLE);
    assert.equal(recorder.isRecording(), false);
    assert.equal(recorder.getDuration(), 0);
  });

  await t.test('3. Microphone permission request specifies audio: true, video: false (No camera)', async () => {
    const mediaDevices = new MockMediaDevices();
    const recorder = new VoiceRecorder({
      mediaDevices,
      MediaRecorderClass: MockMediaRecorder
    });

    await recorder.start();
    assert.equal(mediaDevices.getUserMediaCalls.length, 1);
    assert.deepEqual(mediaDevices.getUserMediaCalls[0], { audio: true, video: false });
    assert.equal(recorder.getState(), RECORDING_STATE.RECORDING);
    assert.equal(recorder.isRecording(), true);

    await recorder.stop();
  });

  await t.test('4. Permission failure handles error and transitions state to ERROR', async () => {
    const mediaDevices = new MockMediaDevices({ shouldDeny: true, errorType: 'NotAllowedError' });
    const recorder = new VoiceRecorder({
      mediaDevices,
      MediaRecorderClass: MockMediaRecorder
    });

    await assert.rejects(
      async () => {
        await recorder.start();
      },
      /microphone permission denied/i
    );

    assert.equal(recorder.getState(), RECORDING_STATE.ERROR);
    assert.equal(recorder.isRecording(), false);
  });

  await t.test('5. Cancel stops recording, discards data, and releases microphone tracks', async () => {
    const mediaDevices = new MockMediaDevices();
    const recorder = new VoiceRecorder({
      mediaDevices,
      MediaRecorderClass: MockMediaRecorder,
      AudioContextClass: MockAudioContext
    });

    await recorder.start();
    const track = recorder._mediaStream.getTracks()[0];
    assert.equal(track.stopped, false);

    let cancelledEmitted = false;
    recorder.on('cancelled', () => {
      cancelledEmitted = true;
    });

    recorder.cancel();

    assert.equal(cancelledEmitted, true);
    assert.equal(track.stopped, true, 'Microphone track must be stopped immediately on cancel');
    assert.equal(recorder.getState(), RECORDING_STATE.IDLE);
    assert.equal(recorder.isRecording(), false);
  });

  await t.test('6. Minimum duration: recording shorter than 0.5s is discarded and returns null', async () => {
    const mediaDevices = new MockMediaDevices();
    const recorder = new VoiceRecorder({
      mediaDevices,
      MediaRecorderClass: MockMediaRecorder,
      minDurationMs: 500
    });

    await recorder.start();
    const track = recorder._mediaStream.getTracks()[0];

    let tooShortEmitted = false;
    recorder.on('tooShort', () => {
      tooShortEmitted = true;
    });

    // Immediately stop (< 500ms)
    const result = await recorder.stop();

    assert.equal(result, null, 'Recordings < 0.5s must return null');
    assert.equal(tooShortEmitted, true);
    assert.equal(track.stopped, true, 'Microphone track must be stopped even if discarded');
    assert.equal(recorder.getState(), RECORDING_STATE.IDLE);
  });

  await t.test('7. Successful recording produces valid Blob with duration and audio MIME', async () => {
    const mediaDevices = new MockMediaDevices();
    const recorder = new VoiceRecorder({
      mediaDevices,
      MediaRecorderClass: MockMediaRecorder,
      minDurationMs: 10 // Lower min duration for testing
    });

    await recorder.start();
    const track = recorder._mediaStream.getTracks()[0];

    // Wait a brief tick so duration > 10ms
    await new Promise((r) => setTimeout(r, 25));

    const result = await recorder.stop();

    assert.ok(result, 'Should return recording result');
    assert.ok(result.blob, 'Should contain Blob');
    assert.ok(result.duration > 0, 'Duration should be positive');
    assert.equal(result.mimeType, 'audio/webm;codecs=opus');
    assert.equal(track.stopped, true, 'Microphone track must be stopped after completion');
    assert.equal(recorder.getState(), RECORDING_STATE.IDLE);
  });

  await t.test('8. Maximum duration: auto-stops when duration reaches maxDurationMs', async () => {
    const mediaDevices = new MockMediaDevices();
    const recorder = new VoiceRecorder({
      mediaDevices,
      MediaRecorderClass: MockMediaRecorder,
      maxDurationMs: 50, // Short max for testing
      minDurationMs: 10
    });

    let maxReached = false;
    recorder.on('maxDurationReached', () => {
      maxReached = true;
    });

    await recorder.start();
    await new Promise((r) => setTimeout(r, 200));

    assert.equal(maxReached, true, 'maxDurationReached should be emitted');
    assert.equal(recorder.isRecording(), false);
  });

  await t.test('9. MediaRecorder error transitions state to ERROR and cleans up tracks', async () => {
    const mediaDevices = new MockMediaDevices();
    const recorder = new VoiceRecorder({
      mediaDevices,
      MediaRecorderClass: MockMediaRecorder
    });

    await recorder.start();
    const track = recorder._mediaStream.getTracks()[0];

    let errorEvent = null;
    recorder.on('error', (err) => {
      errorEvent = err;
    });

    // Simulate recorder error
    recorder._mediaRecorder.onerror({ error: new Error('Audio hardware disconnected') });

    assert.equal(recorder.getState(), RECORDING_STATE.ERROR);
    assert.ok(errorEvent);
    assert.equal(track.stopped, true, 'Microphone track must be stopped on recorder error');
  });

  await t.test('10. TimeUpdate and Level events are emitted during recording', async () => {
    const mediaDevices = new MockMediaDevices();
    const recorder = new VoiceRecorder({
      mediaDevices,
      MediaRecorderClass: MockMediaRecorder,
      AudioContextClass: MockAudioContext
    });

    let timeUpdated = false;
    let levelEmitted = false;

    recorder.on('timeUpdate', () => { timeUpdated = true; });
    recorder.on('level', () => { levelEmitted = true; });

    await recorder.start();
    await new Promise((r) => setTimeout(r, 150));

    recorder.cancel();

    assert.equal(timeUpdated, true);
    assert.equal(levelEmitted, true);
  });

  await t.test('11. FormatDuration correctly converts seconds into MM:SS format', () => {
    assert.equal(VoiceRecorder.formatDuration(0), '0:00');
    assert.equal(VoiceRecorder.formatDuration(5), '0:05');
    assert.equal(VoiceRecorder.formatDuration(65), '1:05');
    assert.equal(VoiceRecorder.formatDuration(600), '10:00');
  });

  await t.test('12. Optimistic voice message matches backend verified wire contract', () => {
    const msg = createOptimisticVoiceMessage('room_101', 'user_alice', {
      filename: 'voice_message_123.webm',
      mime: 'audio/webm;codecs=opus',
      byteSize: 15420,
      duration: 6,
      clientMessageId: 'local-test-uuid'
    });

    assert.equal(msg.roomId, 'room_101');
    assert.equal(msg.senderId, 'user_alice');
    assert.equal(msg.clientMessageId, 'local-test-uuid');
    assert.equal(msg.isVoiceNote, true);
    assert.equal(msg.duration, 6);
    assert.equal(msg.body.is_voice_note, true);
    assert.equal(msg.body.duration, 6);
    assert.equal(msg.body.filename, 'voice_message_123.webm');
    assert.equal(msg.body.mime, 'audio/webm;codecs=opus');
    assert.equal(msg.body.byte_size, 15420);
  });

  await t.test('13. resolveMessageContent correctly identifies voice notes and formats fallback preview', () => {
    const voiceMsg = {
      kind: 'file',
      sender_id: 'user_bob',
      body: {
        text: 'Voice message',
        filename: 'voice_message_456.webm',
        mime: 'audio/webm;codecs=opus',
        byte_size: 20480,
        duration: 12,
        is_voice_note: true
      },
      attachments: [{
        attachment_id: 'att_voice_99',
        filename: 'voice_message_456.webm',
        mime: 'audio/webm;codecs=opus',
        byte_size: 20480
      }]
    };

    const resolved = resolveMessageContent(voiceMsg);
    assert.equal(resolved.kind, 'audio');
    assert.equal(resolved.isVoiceNote, true);
    assert.equal(resolved.duration, 12);
    assert.equal(resolved.attachmentId, 'att_voice_99');
    assert.equal(resolved.fallbackText, '🎤 Voice message');
  });
});
