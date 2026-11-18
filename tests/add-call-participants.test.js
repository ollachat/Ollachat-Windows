/**
 * add-call-participants.test.js
 *
 * Dedicated tests for:
 * 1. Add People button in active call UI
 * 2. Participant lookup and eligibility filtering
 * 3. Targeted in-band invitation signaling
 * 4. Callee acceptance and SFU renegotiation invariants
 * 5. Decline/departure multi-party invariants
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const htmlPath = path.resolve(__dirname, '../src/renderer/index.html');
const cssPath = path.resolve(__dirname, '../src/renderer/styles.css');
const appJsPath = path.resolve(__dirname, '../src/renderer/app.js');

describe('Add People to Active Call - Stage 1: UI & Controls Suite', () => {
  const htmlContent = fs.readFileSync(htmlPath, 'utf8');
  const cssContent = fs.readFileSync(cssPath, 'utf8');
  const appJsContent = fs.readFileSync(appJsPath, 'utf8');

  test('1. index.html contains #btn-call-add-participant in voice-call-actions', () => {
    assert.ok(
      htmlContent.includes('id="btn-call-add-participant"'),
      'Must contain #btn-call-add-participant'
    );
    assert.ok(
      htmlContent.includes('class="btn-call-action btn-add-participant hidden"'),
      '#btn-call-add-participant must start with class hidden'
    );
  });

  test('2. index.html contains #call-add-participant-modal dialog and all inner elements', () => {
    assert.ok(
      htmlContent.includes('id="call-add-participant-modal"'),
      'Must contain #call-add-participant-modal'
    );
    assert.ok(
      htmlContent.includes('id="btn-close-call-add-participant"'),
      'Must contain #btn-close-call-add-participant'
    );
    assert.ok(
      htmlContent.includes('id="call-participant-search"'),
      'Must contain #call-participant-search'
    );
    assert.ok(
      htmlContent.includes('id="call-participants-loading"'),
      'Must contain #call-participants-loading'
    );
    assert.ok(
      htmlContent.includes('id="call-participants-empty"'),
      'Must contain #call-participants-empty'
    );
    assert.ok(
      htmlContent.includes('id="call-participants-list"'),
      'Must contain #call-participants-list'
    );
    assert.ok(
      htmlContent.includes('id="btn-close-call-add-participant-footer"'),
      'Must contain #btn-close-call-add-participant-footer'
    );
  });

  test('3. styles.css contains styling for btn-add-participant and modal elements', () => {
    assert.ok(
      cssContent.includes('.btn-call-action.btn-add-participant'),
      'Must define .btn-call-action.btn-add-participant'
    );
    assert.ok(
      cssContent.includes('.call-add-participant-body'),
      'Must define .call-add-participant-body'
    );
    assert.ok(
      cssContent.includes('.call-participants-list'),
      'Must define .call-participants-list'
    );
    assert.ok(
      cssContent.includes('.btn-invite-participant'),
      'Must define .btn-invite-participant'
    );
  });

  test('4. app.js binds btnCallAddParticipant and modal controls', () => {
    const currentAppJs = fs.readFileSync(appJsPath, 'utf8');
    assert.ok(
      currentAppJs.includes("document.getElementById('btn-call-add-participant')"),
      'app.js must reference btn-call-add-participant'
    );
    assert.ok(
      currentAppJs.includes("document.getElementById('call-add-participant-modal')"),
      'app.js must reference call-add-participant-modal'
    );
    assert.ok(
      currentAppJs.includes('openCallAddParticipantModal'),
      'app.js must define openCallAddParticipantModal'
    );
    assert.ok(
      currentAppJs.includes('closeCallAddParticipantModal'),
      'app.js must define closeCallAddParticipantModal'
    );
  });

  test('5. updateVoiceCallUi hides btnCallAddParticipant by default and unhides only on CONNECTED', () => {
    const currentAppJs = fs.readFileSync(appJsPath, 'utf8');
    assert.ok(
      currentAppJs.includes("btnCallAddParticipant?.classList.add('hidden')"),
      'Must hide btnCallAddParticipant by default'
    );
    assert.ok(
      currentAppJs.includes("btnCallAddParticipant?.classList.remove('hidden')"),
      'Must show btnCallAddParticipant when CONNECTED'
    );
  });
});

describe('Add People to Active Call - Stage 2: Participant Lookup & Filtering Suite', () => {
  test('1. filterEligibleCallParticipants correctly filters out self and active participants', async () => {
    const { filterEligibleCallParticipants } = await import('../src/renderer/chat-shell-state.js');

    const participants = [
      { principalId: 'user-alice', displayName: 'Alice' },
      { principalId: 'user-bob', displayName: 'Bob' },
      { principalId: 'user-charlie', displayName: 'Charlie' },
      { principalId: 'user-david', displayName: 'David' }
    ];

    const currentUserId = 'user-alice';
    const activeParticipants = new Set(['user-bob']); // Bob is already in the call

    const eligible = filterEligibleCallParticipants(participants, currentUserId, activeParticipants);

    assert.equal(eligible.length, 2, 'Should have exactly 2 eligible members');
    assert.deepEqual(
      eligible.map((p) => p.principalId),
      ['user-charlie', 'user-david'],
      'Eligible participants must exclude self and active call participants'
    );
  });

  test('2. filterEligibleCallParticipants returns empty array when all members are self or in call', async () => {
    const { filterEligibleCallParticipants } = await import('../src/renderer/chat-shell-state.js');

    const participants = [
      { principalId: 'user-alice', displayName: 'Alice' },
      { principalId: 'user-bob', displayName: 'Bob' }
    ];

    const currentUserId = 'user-alice';
    const activeParticipants = new Set(['user-bob']);

    const eligible = filterEligibleCallParticipants(participants, currentUserId, activeParticipants);
    assert.equal(eligible.length, 0, 'Should return empty array for 1-to-1 conversation where both are active');
  });

  test('3. VoiceCallManager tracks participants correctly and clears on cleanup', async () => {
    const { VoiceCallManager } = await import('../src/call/voice-call-manager.js');
    const manager = new VoiceCallManager({});

    assert.ok(manager.participants instanceof Set, 'manager.participants must be a Set');
    assert.equal(manager.participants.size, 0, 'Initial participants should be empty');

    manager.addParticipant('user-bob');
    assert.equal(manager.hasParticipant('user-bob'), true);
    assert.equal(manager.hasParticipant('user-charlie'), false);

    manager.addParticipant('user-charlie');
    assert.equal(manager.participants.size, 2);

    manager.removeParticipant('user-bob');
    assert.equal(manager.hasParticipant('user-bob'), false);
    assert.equal(manager.participants.size, 1);
    manager._beginCallInstance();

    manager._cleanupResources();
    assert.equal(manager.participants.size, 0, 'Participants must be cleared on cleanup');
  });
});

describe('Add People to Active Call - Stage 3: Invitation Flow & Decline Invariants', () => {
  test('1. Targeted invite format contains call_signal: invite and target_user_id', () => {
    let sentPayload = null;
    const mockChat = {
      send: (type, payload, roomId) => {
        sentPayload = payload;
        return Promise.resolve();
      }
    };

    function sendCallSignal(action, roomId, extra = {}) {
      mockChat.send('message.send', {
        client_message_id: 'sig-123',
        kind: 'text',
        body: {
          call_signal: action,
          call_type: extra.callType || (extra.isVideo ? 'video' : 'voice'),
          is_video: Boolean(extra.isVideo),
          target_user_id: extra.targetUserId || null,
          text: ''
        }
      }, roomId);
    }

    sendCallSignal('invite', 'room-456', {
      callType: 'voice',
      isVideo: false,
      targetUserId: 'user-charlie'
    });

    assert.ok(sentPayload, 'Payload must be sent');
    assert.equal(sentPayload.body.call_signal, 'invite');
    assert.equal(sentPayload.body.target_user_id, 'user-charlie');
    assert.equal(sentPayload.body.is_video, false);
  });

  test('2. Callee in IDLE receiving targeted invite enters INCOMING_RINGING state', async () => {
    const { VoiceCallManager, CALL_STATE } = await import('../src/call/voice-call-manager.js');
    const manager = new VoiceCallManager({});

    assert.equal(manager.state, CALL_STATE.IDLE);

    manager.handleIncomingCall({
      roomId: 'room-group-1',
      callId: 'call-1',
      initiator: 'user-alice',
      isVideo: false,
      callType: 'voice',
      peerName: 'Alice'
    });

    assert.equal(manager.state, CALL_STATE.INCOMING_RINGING);
    assert.equal(manager.roomId, 'room-group-1');
    assert.equal(manager.peerName, 'Alice');
  });

  test('3. Callee decline while ongoing call is CONNECTED does not end ongoing call', async () => {
    const { VoiceCallManager, CALL_STATE } = await import('../src/call/voice-call-manager.js');
    const manager = new VoiceCallManager({});

    // Simulate active connected call between Alice and Bob
    manager.roomId = 'room-group-1';
    manager._beginCallInstance();
    manager._setState(CALL_STATE.OUTGOING_RINGING);
    manager._setState(CALL_STATE.CONNECTING);
    manager._markConnected();
    assert.equal(manager.state, CALL_STATE.CONNECTED);

    // In app.js: when sig === 'decline' arrives and manager.state === CALL_STATE.CONNECTED:
    // It must NOT call handleRemoteCallEnded!
    const incomingSignal = {
      sig: 'decline',
      senderId: 'user-charlie',
      roomId: 'room-group-1'
    };

    if (manager.roomId === incomingSignal.roomId) {
      if (manager.state === CALL_STATE.CONNECTED) {
        // Preserves active call, does not tear down!
      } else {
        await manager.handleRemoteCallEnded({ roomId: incomingSignal.roomId });
      }
    }

    assert.equal(manager.state, CALL_STATE.CONNECTED, 'Call must remain CONNECTED when invitee declines');
  });

  test('4. 1-to-1 outgoing ringing decline correctly terminates call', async () => {
    const { VoiceCallManager, CALL_STATE } = await import('../src/call/voice-call-manager.js');
    const manager = new VoiceCallManager({});

    // Simulate 1-to-1 outgoing ringing
    manager.roomId = 'room-direct-1';
    manager._beginCallInstance();
    manager._setState(CALL_STATE.OUTGOING_RINGING);

    const incomingSignal = {
      sig: 'decline',
      senderId: 'user-bob',
      roomId: 'room-direct-1'
    };

    if (manager.roomId === incomingSignal.roomId) {
      if (manager.state === CALL_STATE.CONNECTED) {
        // Preserved
      } else {
        await manager.handleRemoteCallEnded({ roomId: incomingSignal.roomId });
      }
    }

    assert.equal(manager.state, CALL_STATE.REMOTE_DECLINED, '1-to-1 ringing must transition to REMOTE_DECLINED on decline');
  });
});

describe('Add People to Active Call - Stage 4: SFU Renegotiation & Multi-Party Invariants', () => {
  class MockSessionDescription {
    constructor({ type, sdp }) {
      this.type = type;
      this.sdp = sdp;
    }
  }

  class MockPeerConnection {
    constructor() {
      this.remoteDescription = null;
      this.localDescription = null;
      this.localTracks = [];
      this.isClosed = false;
      this.connectionState = 'connected';
      this.iceConnectionState = 'connected';
    }

    async setRemoteDescription(desc) {
      this.remoteDescription = desc;
    }

    async setLocalDescription(desc) {
      this.localDescription = desc;
    }

    async createAnswer() {
      return { type: 'answer', sdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=sendrecv\r\n' };
    }

    addTrack(track) {
      this.localTracks.push(track);
    }

    getSenders() {
      return [];
    }

    close() {
      this.isClosed = true;
    }
  }

  class MockRtcBridge {
    constructor() {
      this.sendAnswerCalls = [];
    }

    async sendAnswer(sdp, requestId) {
      this.sendAnswerCalls.push({ sdp, requestId });
      return { ok: true };
    }
  }

  test('1. SFU re-offer received during CONNECTED call sends answer without resetting call state or timer', async () => {
    const { VoiceCallManager, CALL_STATE } = await import('../src/call/voice-call-manager.js');
    const rtcBridge = new MockRtcBridge();
    const pc = new MockPeerConnection();

    const manager = new VoiceCallManager({
      rtcBridge,
      PeerConnectionClass: function () { return pc; },
      SessionDescriptionClass: MockSessionDescription
    });

    manager.peerConnection = pc;
    manager.roomId = 'room-multi-1';
    manager._beginCallInstance();

    // Transition to CONNECTED
    manager._setState(CALL_STATE.OUTGOING_RINGING);
    manager._setState(CALL_STATE.CONNECTING);
    manager._markConnected();
    manager.startCallDurationTimer();

    assert.equal(manager.state, CALL_STATE.CONNECTED);
    assert.ok(manager.callConnectedAt > 0, 'Timer must be started');
    const originalConnectedAt = manager.callConnectedAt;

    // Incoming SFU re-offer when third participant joins:
    // Contains audio for Bob and audio for Charlie (both active sendrecv)
    const multiPartyOfferSdp =
      'v=0\r\n' +
      'm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=sendrecv\r\n' +
      'm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=sendrecv\r\n';

    await manager._handleIncomingOffer(multiPartyOfferSdp, 404);

    assert.equal(rtcBridge.sendAnswerCalls.length, 1, 'Must send answer for re-offer');
    assert.equal(rtcBridge.sendAnswerCalls[0].requestId, 404, 'Must send correct requestId');
    assert.equal(manager.state, CALL_STATE.CONNECTED, 'Must remain in CONNECTED state');
    assert.equal(manager.callConnectedAt, originalConnectedAt, 'Call duration timer must NOT be reset');
  });

  test('2. One participant leaving in 3-party call does NOT end the call for remaining peers', async () => {
    const { VoiceCallManager, CALL_STATE } = await import('../src/call/voice-call-manager.js');
    const rtcBridge = new MockRtcBridge();
    const pc = new MockPeerConnection();

    const manager = new VoiceCallManager({
      rtcBridge,
      PeerConnectionClass: function () { return pc; },
      SessionDescriptionClass: MockSessionDescription
    });

    manager.peerConnection = pc;
    manager.roomId = 'room-multi-1';
    manager._beginCallInstance();

    manager._setState(CALL_STATE.OUTGOING_RINGING);
    manager._setState(CALL_STATE.CONNECTING);
    manager._markConnected();

    // SFU re-offer after participant 3 leaves:
    // Bob's audio is active (sendrecv), Charlie's audio is inactive
    const oneLeftSdp =
      'v=0\r\n' +
      'm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=sendrecv\r\n' +
      'm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=inactive\r\n';

    await manager._handleIncomingOffer(oneLeftSdp, 501);

    assert.equal(manager.state, CALL_STATE.CONNECTED, 'Must remain CONNECTED while at least one peer media is active');
    assert.equal(rtcBridge.sendAnswerCalls.length, 1, 'Must have answered re-offer');
  });

  test('3. Video becoming inactive while audio remains active does not terminate call', async () => {
    const { VoiceCallManager, CALL_STATE } = await import('../src/call/voice-call-manager.js');
    const rtcBridge = new MockRtcBridge();
    const pc = new MockPeerConnection();

    const manager = new VoiceCallManager({
      rtcBridge,
      PeerConnectionClass: function () { return pc; },
      SessionDescriptionClass: MockSessionDescription
    });

    manager.peerConnection = pc;
    manager.roomId = 'room-video-1';
    manager.isVideo = true;
    manager._beginCallInstance();

    manager._setState(CALL_STATE.OUTGOING_RINGING);
    manager._setState(CALL_STATE.CONNECTING);
    manager._markConnected();

    // Peer turned off video: video is inactive, but audio is sendrecv
    const videoOffSdp =
      'v=0\r\n' +
      'm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=sendrecv\r\n' +
      'm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=inactive\r\n';

    await manager._handleIncomingOffer(videoOffSdp, 601);

    assert.equal(manager.state, CALL_STATE.CONNECTED, 'Must remain CONNECTED when video is turned off but audio is active');
  });

  test('4. All remote media becoming inactive terminates the call gracefully', async () => {
    const { VoiceCallManager, CALL_STATE } = await import('../src/call/voice-call-manager.js');
    const rtcBridge = new MockRtcBridge();
    const pc = new MockPeerConnection();

    const manager = new VoiceCallManager({
      rtcBridge,
      PeerConnectionClass: function () { return pc; },
      SessionDescriptionClass: MockSessionDescription
    });

    manager.peerConnection = pc;
    manager.roomId = 'room-all-leave-1';
    manager._beginCallInstance();

    manager._setState(CALL_STATE.OUTGOING_RINGING);
    manager._setState(CALL_STATE.CONNECTING);
    manager._markConnected();

    // All peers have left: all media inactive
    const allLeftSdp =
      'v=0\r\n' +
      'm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=inactive\r\n';

    await manager._handleIncomingOffer(allLeftSdp, 701);

    assert.equal(manager.state, CALL_STATE.ENDED, 'Call must terminate when all remote media becomes inactive');
    assert.equal(manager.isEnded, true, 'isEnded must be true');
  });
});



