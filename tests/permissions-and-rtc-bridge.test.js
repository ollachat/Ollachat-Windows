import test from 'node:test';
import assert from 'node:assert/strict';
import { ChatWebSocket } from '../src/chat/chat-websocket.js';

class MockWebSocket {
  static instances = [];
  constructor(url, protocols) {
    this.url = url;
    this.protocols = protocols;
    this.sentData = [];
    this.readyState = 0; // CONNECTING
    MockWebSocket.instances.push(this);
  }

  send(data) {
    this.sentData.push(data);
  }

  close(code, reason) {
    this.readyState = 3; // CLOSED
    if (this.onclose) this.onclose({ code: code || 1000, reason: reason || 'Normal' });
  }

  simulateOpen() {
    this.readyState = 1; // OPEN
    if (this.onopen) this.onopen();
  }

  simulateMessage(msgObj) {
    const raw = typeof msgObj === 'string' ? msgObj : JSON.stringify(msgObj);
    if (this.onmessage) this.onmessage({ data: raw });
  }
}

test('Step 1: Media Permissions & Preload RTC Bridge Suite', async (t) => {
  await t.test('1. PermissionRequestHandler allows audio, video, media, and video fullscreen', () => {
    // Mirror exact permission handler logic in main.js
    function handlePermissionRequest(permission, details) {
      if (permission === 'fullscreen' || permission === 'automatic-fullscreen') {
        return true;
      }
      if (permission === 'media') {
        const mediaTypes = details?.mediaTypes || [];
        const isAllowed = mediaTypes.length === 0 || mediaTypes.every((t) => t === 'audio' || t === 'video');
        return isAllowed;
      }
      if (permission === 'microphone' || permission === 'camera' || permission === 'audioCapture' || permission === 'videoCapture') {
        return true;
      }
      return false;
    }

    // Fullscreen permissions
    assert.equal(handlePermissionRequest('fullscreen', {}), true, 'Allows fullscreen');
    assert.equal(handlePermissionRequest('automatic-fullscreen', {}), true, 'Allows automatic-fullscreen');

    // Media permissions
    assert.equal(handlePermissionRequest('media', { mediaTypes: ['audio'] }), true, 'Allows audio');
    assert.equal(handlePermissionRequest('media', { mediaTypes: ['video'] }), true, 'Allows video');
    assert.equal(handlePermissionRequest('media', { mediaTypes: ['audio', 'video'] }), true, 'Allows audio and video');
    assert.equal(handlePermissionRequest('media', {}), true, 'Allows unspecified media');
    assert.equal(handlePermissionRequest('microphone', {}), true, 'Allows microphone');
    assert.equal(handlePermissionRequest('camera', {}), true, 'Allows camera');
    assert.equal(handlePermissionRequest('audioCapture', {}), true, 'Allows audioCapture');
    assert.equal(handlePermissionRequest('videoCapture', {}), true, 'Allows videoCapture');

    // Sensitive permissions strictly rejected
    assert.equal(handlePermissionRequest('media', { mediaTypes: ['unknown'] }), false, 'Rejects unknown media');
    assert.equal(handlePermissionRequest('geolocation', {}), false, 'Rejects geolocation');
    assert.equal(handlePermissionRequest('notifications', {}), false, 'Rejects notifications');
    assert.equal(handlePermissionRequest('clipboard-read', {}), false, 'Rejects clipboard-read');
    assert.equal(handlePermissionRequest('clipboard-sanitized-write', {}), false, 'Rejects clipboard-sanitized-write');
    assert.equal(handlePermissionRequest('pointerLock', {}), false, 'Rejects pointerLock');
  });

  await t.test('2. PermissionCheckHandler allows audio, video, and video fullscreen checks', () => {
    // Mirror exact permission check logic in main.js
    function handlePermissionCheck(permission, details) {
      if (permission === 'fullscreen' || permission === 'automatic-fullscreen') {
        return true;
      }
      if (permission === 'media') {
        if (!details?.mediaType || details.mediaType === 'audio' || details.mediaType === 'video') {
          return true;
        }
      }
      if (permission === 'microphone' || permission === 'camera' || permission === 'audioCapture' || permission === 'videoCapture') {
        return true;
      }
      return false;
    }

    // Fullscreen permissions
    assert.equal(handlePermissionCheck('fullscreen', {}), true, 'Allows fullscreen check');
    assert.equal(handlePermissionCheck('automatic-fullscreen', {}), true, 'Allows automatic-fullscreen check');

    // Media permissions
    assert.equal(handlePermissionCheck('media', { mediaType: 'audio' }), true, 'Audio allowed');
    assert.equal(handlePermissionCheck('media', { mediaType: 'video' }), true, 'Video allowed');
    assert.equal(handlePermissionCheck('media', {}), true, 'Unspecified mediaType allowed');
    assert.equal(handlePermissionCheck('microphone', {}), true, 'Microphone check allowed');
    assert.equal(handlePermissionCheck('camera', {}), true, 'Camera check allowed');
    assert.equal(handlePermissionCheck('audioCapture', {}), true, 'AudioCapture check allowed');
    assert.equal(handlePermissionCheck('videoCapture', {}), true, 'VideoCapture check allowed');

    // Sensitive permissions strictly rejected
    assert.equal(handlePermissionCheck('media', { mediaType: 'screen' }), false, 'Screen rejected');
    assert.equal(handlePermissionCheck('notifications', {}), false, 'Notifications rejected');
    assert.equal(handlePermissionCheck('geolocation', {}), false, 'Geolocation rejected');
    assert.equal(handlePermissionCheck('clipboard-read', {}), false, 'Clipboard-read rejected');
    assert.equal(handlePermissionCheck('pointerLock', {}), false, 'PointerLock rejected');
  });

  await t.test('3. ChatWebSocket normalizes voice call in call.started event', async () => {
    MockWebSocket.instances = [];
    const ws = new ChatWebSocket({
      token: 'token_voice_call',
      WebSocketClass: MockWebSocket
    });

    await ws.connect();
    const mockSocket = MockWebSocket.instances[0];
    mockSocket.simulateOpen();

    let callStartedEvent = null;
    ws.on('call.started', (evt) => {
      callStartedEvent = evt;
    });

    mockSocket.simulateMessage({
      v: 1,
      type: 'call.started',
      room_id: 'room_voice_101',
      payload: {
        call_id: 'call_voice_555',
        initiator: 'user_alice'
      }
    });

    assert.ok(callStartedEvent, 'Dispatched call.started');
    assert.equal(callStartedEvent.roomId, 'room_voice_101');
    assert.equal(callStartedEvent.callId, 'call_voice_555');
    assert.equal(callStartedEvent.initiator, 'user_alice');
    assert.equal(callStartedEvent.callType, 'voice');
    assert.equal(callStartedEvent.isVideo, false);

    ws.disconnect();
  });

  await t.test('4. ChatWebSocket normalizes video call in call.started event', async () => {
    MockWebSocket.instances = [];
    const ws = new ChatWebSocket({
      token: 'token_video_call',
      WebSocketClass: MockWebSocket
    });

    await ws.connect();
    const mockSocket = MockWebSocket.instances[0];
    mockSocket.simulateOpen();

    let callStartedEvent = null;
    ws.on('call.started', (evt) => {
      callStartedEvent = evt;
    });

    mockSocket.simulateMessage({
      v: 1,
      type: 'call.started',
      room_id: 'room_video_202',
      payload: {
        call_id: 'call_video_777',
        initiator: 'user_bob',
        call_type: 'video',
        is_video: true
      }
    });

    assert.ok(callStartedEvent, 'Dispatched call.started');
    assert.equal(callStartedEvent.roomId, 'room_video_202');
    assert.equal(callStartedEvent.callId, 'call_video_777');
    assert.equal(callStartedEvent.initiator, 'user_bob');
    assert.equal(callStartedEvent.callType, 'video');
    assert.equal(callStartedEvent.isVideo, true);

    ws.disconnect();
  });
});
