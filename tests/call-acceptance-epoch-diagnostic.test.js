import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VoiceCallManager, CALL_STATE } from '../src/call/voice-call-manager.js';

class MockTrack {
    constructor(kind = 'audio') {
        this.kind = kind;
        this.readyState = 'live';
        this.enabled = true;
        this.muted = false;
    }

    stop() {
        this.readyState = 'ended';
    }

    getSettings() {
        return {};
    }
}

class MockMediaStream {
    constructor(tracks = []) {
        this.tracks = [...tracks];
    }

    getTracks() {
        return [...this.tracks];
    }

    getAudioTracks() {
        return this.tracks.filter((track) => track.kind === 'audio');
    }

    getVideoTracks() {
        return this.tracks.filter((track) => track.kind === 'video');
    }

    addTrack(track) {
        if (!this.tracks.includes(track)) this.tracks.push(track);
    }
}

class MockPeerConnection {
    constructor() {
        this.connectionState = 'new';
        this.iceConnectionState = 'new';
        this.iceGatheringState = 'new';
        this.signalingState = 'stable';
        this.localDescription = null;
        this.remoteDescription = null;
        this.senders = [];
    }

    addTrack(track, stream) {
        const sender = { track, stream };
        this.senders.push(sender);
        return sender;
    }

    getSenders() {
        return this.senders;
    }

    getTransceivers() {
        return [];
    }

    async createOffer() {
        return { type: 'offer', sdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=sendrecv\r\n' };
    }

    async setLocalDescription(description) {
        this.localDescription = description;
        this.signalingState = description.type === 'offer' ? 'have-local-offer' : 'stable';
    }

    async setRemoteDescription(description) {
        this.remoteDescription = description;
        this.signalingState = 'stable';
    }

    async addIceCandidate() { }

    async getStats() {
        return new Map();
    }

    close() {
        this.connectionState = 'closed';
        this.iceConnectionState = 'closed';
        this.signalingState = 'closed';
    }
}

class MockRtcBridge {
    constructor() {
        this.listeners = new Set();
    }

    async connect(roomId, options = {}) {
        return { ok: true, roomId, options, iceServers: [] };
    }

    async sendOffer() {
        return { ok: true };
    }

    async sendAnswer() {
        return { ok: true };
    }

    async sendCandidate() {
        return { ok: true };
    }

    async leave() {
        return { ok: true };
    }

    async disconnect() {
        return { ok: true };
    }

    onEvent(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }
}

class MockMediaElement {
    constructor() {
        this.srcObject = null;
        this.playCalls = 0;
    }

    play() {
        this.playCalls += 1;
        return Promise.resolve();
    }
}

function createManager({ sendSignal = async () => ({ ok: true }) } = {}) {
    const remoteAudioElement = new MockMediaElement();
    const remoteVideoElement = new MockMediaElement();
    const manager = new VoiceCallManager({
        rtcBridge: new MockRtcBridge(),
        mediaDevices: {
            async getUserMedia() {
                return new MockMediaStream([new MockTrack('audio'), new MockTrack('video')]);
            }
        },
        PeerConnectionClass: MockPeerConnection,
        remoteAudioElement,
        remoteVideoElement,
        sendSignal
    });
    return { manager, remoteAudioElement, remoteVideoElement };
}

async function dispose(manager) {
    manager.stopCallDurationTimer();
    if (manager.callEpoch) await manager.endCall(false, manager.callEpoch);
}

test('receiver suppresses a synthetic local call ID while retaining room and invitation epoch correlation', async () => {
    const sentSignals = [];
    const { manager } = createManager({
        sendSignal: async (signal) => {
            sentSignals.push(signal);
            return { ok: true };
        }
    });

    manager._beginCallInstance();
    manager.handleIncomingCall({
        roomId: 'room-epoch-echo',
        callEpoch: 41,
        initiator: 'Caller',
        isVideo: false,
        callType: 'voice'
    });

    assert.equal(manager.callEpoch, 2, 'receiver ownership remains peer-local');
    assert.equal(manager.signalingEpoch, 41, 'receiver retains invitation correlation');
    assert.equal(manager.callId, 'room-epoch-echo', 'room remains only a local synthetic placeholder');
    assert.equal(manager._callIdIsSynthetic, true);

    await manager.acceptCall();

    const acceptance = sentSignals.find((signal) => signal.action === 'accept');
    assert.equal(acceptance.roomId, 'room-epoch-echo');
    assert.equal(acceptance.callEpoch, 41, 'acceptance echoes invitation correlation, not receiver ownership');
    assert.equal(acceptance.callId, undefined, 'synthetic room placeholder is never emitted as protocol callId');
    assert.notEqual(acceptance.callEpoch, manager.callEpoch);

    await dispose(manager);
});

for (const ordering of ['acceptance-before-media', 'media-before-acceptance']) {
    for (const trackKind of ['audio', 'video']) {
        test(`${ordering}: divergent peer-local epochs connect on shared signaling correlation for ${trackKind}`, async () => {
            const { manager, remoteAudioElement, remoteVideoElement } = createManager();

            manager._beginCallInstance();
            await manager.startCall(`room-${ordering}-${trackKind}`, 'Receiver', {
                isVideo: trackKind === 'video',
                mode: trackKind === 'video' ? 'video' : 'voice'
            });

            const localOwnershipEpoch = manager.callEpoch;
            const invitationSignalingEpoch = manager.signalingEpoch;
            const remotePeerLocalEpoch = 1;
            assert.equal(localOwnershipEpoch, 2, 'caller ownership is intentionally advanced');
            assert.equal(invitationSignalingEpoch, 2);
            assert.notEqual(remotePeerLocalEpoch, localOwnershipEpoch);
            assert.equal(manager.adoptAuthoritativeCallId(`server-${ordering}-${trackKind}`, {
                roomId: `room-${ordering}-${trackKind}`,
                signalingEpoch: invitationSignalingEpoch
            }), true, 'caller adopts the server identity before the ID-less acceptance');

            const currentPc = manager.peerConnection;
            const remoteTrack = new MockTrack(trackKind);
            const remoteStream = new MockMediaStream([remoteTrack]);
            let timerStarts = 0;
            const originalStartTimer = manager.startCallDurationTimer.bind(manager);
            manager.startCallDurationTimer = (...args) => {
                timerStarts += 1;
                return originalStartTimer(...args);
            };

            const accept = () => manager.handleCallAccepted({
                roomId: `room-${ordering}-${trackKind}`,
                callEpoch: invitationSignalingEpoch
            });
            const deliverMedia = () => currentPc.ontrack({
                track: remoteTrack,
                streams: [remoteStream]
            });

            if (ordering === 'acceptance-before-media') {
                accept();
                assert.equal(manager.state, CALL_STATE.CONNECTING);
                deliverMedia();
            } else {
                deliverMedia();
                assert.equal(manager.state, CALL_STATE.OUTGOING_RINGING);
                assert.equal(manager._earlyRemoteMedia, true);
                assert.equal(manager._timerInterval, null);
                accept();
            }
            await Promise.resolve();

            const mediaElement = trackKind === 'video' ? remoteVideoElement : remoteAudioElement;
            assert.equal(manager._calleeAccepted, true);
            assert.equal(manager.state, CALL_STATE.CONNECTED);
            assert.equal(manager._remoteMediaConnected, true);
            assert.equal(mediaElement.srcObject, remoteStream);
            assert.ok(mediaElement.playCalls >= 1);
            assert.ok(Number.isFinite(manager.callConnectedAt));
            assert.ok(manager._timerInterval);
            assert.equal(timerStarts, 1, 'manager timer initializes exactly once');

            manager._noteRemoteMedia({ track: remoteTrack }, localOwnershipEpoch, currentPc);
            assert.equal(timerStarts, 1, 'later current tracks cannot restart the timer');

            await dispose(manager);
        });
    }
}

test('conflicting authoritative acceptance remains rejected after server identity adoption', async () => {
    const { manager } = createManager();
    await manager.startCall('room-authoritative-conflict', 'Receiver');
    const signalingEpoch = manager.signalingEpoch;

    assert.equal(manager.adoptAuthoritativeCallId('server-current-call', {
        roomId: 'room-authoritative-conflict',
        signalingEpoch
    }), true);

    manager.handleCallAccepted({
        roomId: 'room-authoritative-conflict',
        callId: 'server-conflicting-call',
        callEpoch: signalingEpoch
    });

    assert.equal(manager.callId, 'server-current-call');
    assert.equal(manager._calleeAccepted, false);
    assert.equal(manager.state, CALL_STATE.OUTGOING_RINGING);
    assert.equal(manager._timerInterval, null);

    await dispose(manager);
});

test('stale chat acceptance is rejected without changing current local ownership', async () => {
    const { manager } = createManager();
    manager._beginCallInstance();
    await manager.startCall('room-stale-acceptance', 'Receiver');

    const localOwnershipEpoch = manager.callEpoch;
    const signalingEpoch = manager.signalingEpoch;
    manager.handleCallAccepted({
        roomId: 'room-stale-acceptance',
        callEpoch: signalingEpoch - 1
    });

    assert.equal(manager.callEpoch, localOwnershipEpoch);
    assert.equal(manager.signalingEpoch, signalingEpoch);
    assert.equal(manager._calleeAccepted, false);
    assert.equal(manager.state, CALL_STATE.OUTGOING_RINGING);
    assert.equal(manager._timerInterval, null);

    await dispose(manager);
});
