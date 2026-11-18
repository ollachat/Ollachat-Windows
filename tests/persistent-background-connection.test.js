import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { ChatWebSocket, CONNECTION_STATE } from '../src/chat/chat-websocket.js';
import { VoiceCallManager, CALL_STATE } from '../src/call/voice-call-manager.js';

class MockWebSocket {
  static instances = [];

  constructor(url, protocols) {
    this.url = url;
    this.protocols = protocols;
    this.readyState = 0;
    this.sentData = [];
    this.closed = false;
    this.closeCode = null;
    this.closeReason = null;
    this.onopen = null;
    this.onmessage = null;
    this.onerror = null;
    this.onclose = null;
    MockWebSocket.instances.push(this);
  }

  simulateOpen() {
    this.readyState = 1;
    if (this.onopen) this.onopen();
  }

  simulateMessage(data) {
    if (this.onmessage) {
      this.onmessage({ data: typeof data === 'string' ? data : JSON.stringify(data) });
    }
  }

  send(data) {
    this.sentData.push(data);
  }

  close(code = 1000, reason = '') {
    this.readyState = 3;
    this.closed = true;
    this.closeCode = code;
    this.closeReason = reason;
    if (this.onclose) this.onclose({ code, reason });
  }
}

describe('Persistent Application-Level Connection & Background Messaging Architecture', () => {
  beforeEach(() => {
    MockWebSocket.instances = [];
  });

  test('1. Multi-room pool connects room sockets independently and aggregates connection state', async () => {
    const tokens = {
      'room-1': 'rt_token_1',
      'room-2': 'rt_token_2'
    };

    const pool = new ChatWebSocket({
      multiRoom: true,
      WebSocketClass: MockWebSocket,
      getToken: async (roomId) => tokens[roomId]
    });

    assert.equal(pool.state, CONNECTION_STATE.DISCONNECTED);

    // Connect room 1
    const connectPromise1 = pool.connectRoom('room-1');
    await Promise.resolve(); // allow getToken resolution
    assert.equal(MockWebSocket.instances.length, 1);
    const sock1 = MockWebSocket.instances[0];
    sock1.simulateOpen();
    await connectPromise1;

    assert.equal(pool.state, CONNECTION_STATE.CONNECTED);
    assert.equal(pool.getRoomState('room-1'), CONNECTION_STATE.CONNECTED);

    // Connect room 2
    const connectPromise2 = pool.connectRoom('room-2');
    await Promise.resolve();
    assert.equal(MockWebSocket.instances.length, 2);
    const sock2 = MockWebSocket.instances[1];
    sock2.simulateOpen();
    await connectPromise2;

    assert.equal(pool.state, CONNECTION_STATE.CONNECTED);
    assert.equal(pool.getRoomState('room-2'), CONNECTION_STATE.CONNECTED);
    assert.deepEqual(pool.getActiveRooms().sort(), ['room-1', 'room-2']);

    pool.disconnect();
    assert.equal(sock1.closed, true);
    assert.equal(sock2.closed, true);
    assert.equal(pool.state, CONNECTION_STATE.DISCONNECTED);
  });

  test('2. Opening or selecting an already-connected chat does NOT create duplicate WebSockets', async () => {
    const pool = new ChatWebSocket({
      multiRoom: true,
      WebSocketClass: MockWebSocket,
      getToken: async (roomId) => `rt_token_${roomId}`
    });

    const p1 = pool.connectRoom('room-alpha');
    await Promise.resolve();
    MockWebSocket.instances[0].simulateOpen();
    await p1;

    assert.equal(MockWebSocket.instances.length, 1);

    // Attempting to connect again while already connected
    await pool.connectRoom('room-alpha');
    assert.equal(MockWebSocket.instances.length, 1, 'Must reuse existing active room socket');

    pool.disconnect();
  });

  test('3. Switching or deselecting a chat does not terminate other room sockets in the pool', async () => {
    const pool = new ChatWebSocket({
      multiRoom: true,
      WebSocketClass: MockWebSocket,
      getToken: async (roomId) => `rt_token_${roomId}`
    });

    const pA = pool.connectRoom('chat-A');
    const pB = pool.connectRoom('chat-B');
    await Promise.resolve();
    MockWebSocket.instances[0].simulateOpen();
    MockWebSocket.instances[1].simulateOpen();
    await Promise.all([pA, pB]);

    assert.equal(pool.getActiveRooms().length, 2);

    // Simulate closing chat-A specifically
    pool.disconnect('chat-A');
    assert.equal(MockWebSocket.instances[0].closed, true);
    assert.equal(MockWebSocket.instances[1].closed, false);
    assert.equal(pool.getRoomState('chat-B'), CONNECTION_STATE.CONNECTED);
    assert.equal(pool.state, CONNECTION_STATE.CONNECTED);

    pool.disconnect();
  });

  test('4. Incoming message for unopened chat is received with room context', async () => {
    const pool = new ChatWebSocket({
      multiRoom: true,
      WebSocketClass: MockWebSocket,
      getToken: async (roomId) => `rt_token_${roomId}`
    });

    const p = pool.connectRoom('room-background');
    await Promise.resolve();
    const sock = MockWebSocket.instances[0];
    sock.simulateOpen();
    await p;

    const receivedFrames = [];
    pool.on('frame', (f) => {
      receivedFrames.push(f);
    });

    // Simulate incoming message event frame on the background socket
    sock.simulateMessage({
      type: 'message.created',
      room_id: 'room-background',
      payload: {
        id: 'msg-999',
        sender_id: 'alice',
        content: { text: 'Hello from background!' },
        created_at: new Date().toISOString()
      }
    });

    assert.equal(receivedFrames.length, 1);
    assert.equal(receivedFrames[0].type, 'message.created');
    assert.equal(receivedFrames[0].room_id, 'room-background');
    assert.equal(receivedFrames[0].payload.id, 'msg-999');

    pool.disconnect();
  });

  test('5. Incoming call.started event received across persistent connection routes correctly', async () => {
    const pool = new ChatWebSocket({
      multiRoom: true,
      WebSocketClass: MockWebSocket,
      getToken: async (roomId) => `rt_token_${roomId}`
    });

    const p = pool.connectRoom('room-calls');
    await Promise.resolve();
    const sock = MockWebSocket.instances[0];
    sock.simulateOpen();
    await p;

    let callFrame = null;
    pool.on('frame', (f) => {
      if (f.type === 'call.started') {
        callFrame = f;
      }
    });

    sock.simulateMessage({
      type: 'call.started',
      room_id: 'room-calls',
      payload: {
        call_id: 'call-xyz',
        initiator: 'user-bob',
        call_type: 'video',
        is_video: true
      }
    });

    assert.ok(callFrame);
    assert.equal(callFrame.room_id, 'room-calls');
    assert.equal(callFrame.payload.call_id, 'call-xyz');
    assert.equal(callFrame.payload.call_type, 'video');

    pool.disconnect();
  });

  test('6. Sending message routes to the correct room socket in multi-room pool', async () => {
    const pool = new ChatWebSocket({
      multiRoom: true,
      WebSocketClass: MockWebSocket,
      getToken: async (roomId) => `rt_token_${roomId}`
    });

    const p1 = pool.connectRoom('room-1');
    const p2 = pool.connectRoom('room-2');
    await Promise.resolve();
    MockWebSocket.instances[0].simulateOpen();
    MockWebSocket.instances[1].simulateOpen();
    await Promise.all([p1, p2]);

    // Send to room-2
    pool.send('message.send', { text: 'Hello Room 2' }, 'room-2');

    assert.equal(MockWebSocket.instances[0].sentData.length, 0);
    assert.equal(MockWebSocket.instances[1].sentData.length, 1);

    const sentJson = JSON.parse(MockWebSocket.instances[1].sentData[0]);
    assert.equal(sentJson.type, 'message.send');
    assert.equal(sentJson.payload.text, 'Hello Room 2');

    pool.disconnect();
  });

  test('7. Calling state machine invariants: callee remains camera-off on video incoming call until accepted', async () => {
    const manager = new VoiceCallManager({
      roomId: 'room-invariant-1',
      peerName: 'Bob'
    });

    // Handle incoming video call
    manager.handleIncomingCall({
      roomId: 'room-invariant-1',
      callId: 'call-inv-1',
      initiator: 'Bob',
      isVideo: true,
      callType: 'video'
    });

    assert.equal(manager.state, CALL_STATE.INCOMING_RINGING);
    assert.equal(manager.isVideo, true);
    assert.equal(manager.mode, 'video');
    // Camera MUST remain OFF while ringing!
    assert.equal(manager._localStream, null);
    assert.equal(manager.durationSec, 0);

    // Decline call
    await manager.declineCall();
    assert.equal(manager.state, CALL_STATE.DECLINED);
    assert.equal(manager.durationSec, 0);
  });

  test('8. Calling state machine invariants: caller remains OUTGOING_RINGING and duration is 00:00 until remote accepts', async () => {
    const manager = new VoiceCallManager();

    // Establish a realistic active outgoing call instance before the remote decline.
    manager.roomId = 'room-caller-1';
    manager.peerName = 'Alice';
    const callEpoch = manager._beginCallInstance({ callId: 'call-caller-1' });
    manager.state = CALL_STATE.OUTGOING_RINGING;
    manager._isIncoming = false;

    assert.equal(manager.state, CALL_STATE.OUTGOING_RINGING);
    assert.equal(manager.durationSec, 0);

    // Remote decline for the current authoritative call instance.
    await manager.handleRemoteCallEnded({
      roomId: 'room-caller-1',
      callId: 'call-caller-1',
      callEpoch
    });
    assert.equal(manager.state, CALL_STATE.REMOTE_DECLINED);
    assert.equal(manager.durationSec, 0, 'Duration timer must never start if call was not connected');
  });
});
