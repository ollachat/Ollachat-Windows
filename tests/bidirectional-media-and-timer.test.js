import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { VoiceCallManager, CALL_STATE } from '../src/call/voice-call-manager.js';

class MockTrack {
    constructor(kind, { readyState = 'live' } = {}) {
        this.kind = kind;
        this.readyState = readyState;
        this.enabled = true;
        this.muted = false;
        this.stopped = readyState === 'ended';
    }

    async applyConstraints() { }

    getSettings() {
        return {};
    }

    stop() {
        this.stopped = true;
        this.readyState = 'ended';
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

    removeTrack(track) {
        this.tracks = this.tracks.filter((candidate) => candidate !== track);
    }
}

class MockSender {
    constructor(track) {
        this.track = track;
        this.parameters = { encodings: [{}] };
    }

    async replaceTrack(track) {
        this.track = track;
    }

    getParameters() {
        return this.parameters;
    }

    async setParameters(parameters) {
        this.parameters = parameters;
    }
}

class MockRTCPeerConnection {
    static instances = [];
    static offerCounter = 0;
    static answerCounter = 0;

    constructor(config = {}) {
        this.config = config;
        this.signalingState = 'stable';
        this.connectionState = 'new';
        this.iceConnectionState = 'new';
        this.iceGatheringState = 'new';
        this.localDescription = null;
        this.remoteDescription = null;
        this.senders = [];
        this.transceivers = [];
        this.addedIceCandidates = [];
        this.isClosed = false;
        MockRTCPeerConnection.instances.push(this);
    }

    addTrack(track, stream) {
        const sender = new MockSender(track);
        this.senders.push(sender);
        this.transceivers.push({
            direction: 'sendrecv',
            sender,
            receiver: { track: new MockTrack(track.kind) },
            stream
        });
        return sender;
    }

    addTransceiver(trackOrKind, init = {}) {
        const track = typeof trackOrKind === 'object' ? trackOrKind : null;
        const kind = track?.kind || trackOrKind;
        const sender = new MockSender(track);
        const transceiver = {
            direction: init.direction || 'sendrecv',
            sender,
            receiver: { track: new MockTrack(kind) }
        };
        this.senders.push(sender);
        this.transceivers.push(transceiver);
        return transceiver;
    }

    getSenders() {
        return this.senders;
    }

    getTransceivers() {
        return this.transceivers;
    }

    async createOffer(options = {}) {
        MockRTCPeerConnection.offerCounter += 1;
        return {
            type: 'offer',
            sdp: `v=0\r\no=local-offer-${MockRTCPeerConnection.offerCounter}\r\n`,
            options
        };
    }

    async createAnswer() {
        MockRTCPeerConnection.answerCounter += 1;
        return {
            type: 'answer',
            sdp: `v=0\r\no=local-answer-${MockRTCPeerConnection.answerCounter}\r\n`
        };
    }

    async setLocalDescription(description) {
        this.localDescription = description;
        if (description.type === 'offer') this.signalingState = 'have-local-offer';
        if (description.type === 'answer') this.signalingState = 'stable';
    }

    async setRemoteDescription(description) {
        this.remoteDescription = description;
        if (description.type === 'offer') this.signalingState = 'have-remote-offer';
        if (description.type === 'answer') this.signalingState = 'stable';
    }

    async addIceCandidate(candidate) {
        this.addedIceCandidates.push(candidate);
    }

    async getStats() {
        return new Map();
    }

    close() {
        this.isClosed = true;
        this.connectionState = 'closed';
        this.iceConnectionState = 'closed';
        this.signalingState = 'closed';
    }

    simulateTrack(track, stream = new MockMediaStream([track])) {
        this.ontrack?.({ track, streams: [stream] });
    }

    simulateTransportConnected() {
        this.connectionState = 'connected';
        this.iceConnectionState = 'connected';
        this.onconnectionstatechange?.();
        this.oniceconnectionstatechange?.();
    }
}

class MockMediaDevices {
    constructor(factory = (constraints) => new MockMediaStream([
        new MockTrack('audio'),
        ...(constraints.video ? [new MockTrack('video')] : [])
    ])) {
        this.factory = factory;
        this.calls = [];
    }

    async getUserMedia(constraints) {
        this.calls.push(constraints);
        return this.factory(constraints);
    }
}

class MockRtcBridge {
    constructor() {
        this.connectCalls = [];
        this.sentOffers = [];
        this.sentAnswers = [];
        this.sentCandidates = [];
        this.leaveCalls = [];
        this.disconnectCalls = [];
        this.listeners = new Set();
    }

    async connect(roomId, options = {}) {
        this.connectCalls.push({ roomId, options });
        return { ok: true, roomId, iceServers: [] };
    }

    async sendOffer(sdp, options = {}) {
        this.sentOffers.push({ sdp, options });
        return { ok: true };
    }

    async sendAnswer(sdp, requestId = 0) {
        this.sentAnswers.push({ sdp, requestId });
        return { ok: true };
    }

    async sendCandidate(candidate, sdpMid, sdpMLineIndex) {
        this.sentCandidates.push({ candidate, sdpMid, sdpMLineIndex });
        return { ok: true };
    }

    async leave(options = {}) {
        this.leaveCalls.push(options);
        return { ok: true };
    }

    async disconnect(options = {}) {
        this.disconnectCalls.push(options);
        return { ok: true };
    }

    onEvent(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    async emit(event) {
        for (const listener of [...this.listeners]) {
            await listener(event);
        }
    }
}

class MockMediaElement {
    constructor({ rejectPlayback = false } = {}) {
        this.srcObject = null;
        this.playCalls = 0;
        this.rejectPlayback = rejectPlayback;
    }

    play() {
        this.playCalls += 1;
        if (this.rejectPlayback) {
            const error = new Error('Autoplay blocked');
            error.name = 'NotAllowedError';
            return Promise.reject(error);
        }
        return Promise.resolve();
    }
}

function createHarness({ mediaDevices, remoteAudioElement, remoteVideoElement, sendSignal = null } = {}) {
    const rtcBridge = new MockRtcBridge();
    const manager = new VoiceCallManager({
        rtcBridge,
        mediaDevices: mediaDevices || new MockMediaDevices(),
        PeerConnectionClass: MockRTCPeerConnection,
        remoteAudioElement: remoteAudioElement || null,
        remoteVideoElement: remoteVideoElement || null,
        sendSignal
    });
    return { manager, rtcBridge };
}

async function completePublication(rtcBridge, roomId, suffix = 'publication') {
    await rtcBridge.emit({
        type: 'answer',
        sdp: `v=0\r\no=${suffix}-answer\r\n`,
        roomId
    });
}

async function dispose(manager) {
    manager.stopCallDurationTimer();
    if (manager.callEpoch) await manager.endCall(false, manager.callEpoch);
}

describe('Bidirectional media publication and SFU negotiation regressions', () => {
    test('caller publishes its microphone with a local offer and completes it with the SFU answer', async () => {
        const { manager, rtcBridge } = createHarness();

        await manager.startCall('room-caller-publication', 'Receiver');
        const pc = manager.peerConnection;

        assert.deepEqual(manager.mediaDevices.calls, [{ audio: true, video: false }]);
        assert.deepEqual(pc.getSenders().map((sender) => sender.track.kind), ['audio']);
        assert.equal(pc.localDescription.type, 'offer');
        assert.equal(pc.signalingState, 'have-local-offer');
        assert.equal(rtcBridge.sentOffers.length, 1);
        assert.deepEqual(rtcBridge.sentOffers[0].options, { isVideo: false, callType: 'voice' });
        assert.equal(manager._outstandingLocalOffer.purpose, 'initial-publication');

        await completePublication(rtcBridge, 'room-caller-publication');

        assert.equal(pc.remoteDescription.type, 'answer');
        assert.equal(pc.signalingState, 'stable');
        assert.equal(manager._outstandingLocalOffer, null);
        await dispose(manager);
    });

    test('receiver independently publishes audio and video, queues glare, then answers the exact opaque request ID', async () => {
        const { manager, rtcBridge } = createHarness();
        manager.handleIncomingCall({
            roomId: 'room-receiver-publication',
            callId: 'call-receiver-publication',
            initiator: 'Caller',
            isVideo: true,
            callType: 'video'
        });

        await manager.acceptCall();
        const pc = manager.peerConnection;

        assert.deepEqual(manager.mediaDevices.calls.at(-1), { audio: true, video: true });
        assert.deepEqual(pc.getSenders().map((sender) => sender.track.kind).sort(), ['audio', 'video']);
        assert.equal(pc.localDescription.type, 'offer');
        assert.equal(pc.signalingState, 'have-local-offer');
        assert.equal(rtcBridge.sentOffers.length, 1);

        const opaqueRequestId = 'sfu/request:opaque-7f2c';
        await rtcBridge.emit({
            type: 'offer',
            sdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=sendrecv\r\n',
            requestId: opaqueRequestId,
            roomId: 'room-receiver-publication'
        });

        assert.equal(pc.remoteDescription, null, 'colliding SFU offer remains queued');
        assert.equal(manager._queuedSfuOffers.length, 1);
        assert.equal(rtcBridge.sentAnswers.length, 0);

        await completePublication(rtcBridge, 'room-receiver-publication', 'receiver-publication');

        assert.equal(manager._queuedSfuOffers.length, 0);
        assert.equal(pc.remoteDescription.type, 'offer');
        assert.equal(pc.localDescription.type, 'answer');
        assert.equal(pc.signalingState, 'stable');
        assert.deepEqual(rtcBridge.sentAnswers, [{
            sdp: pc.localDescription.sdp,
            requestId: opaqueRequestId
        }]);
        await dispose(manager);
    });

    test('ICE candidates flow in both directions and queued remote candidates drain in arrival order', async () => {
        const { manager, rtcBridge } = createHarness();
        await manager.startCall('room-ice-order', 'Receiver');
        const pc = manager.peerConnection;

        pc.onicecandidate({
            candidate: { candidate: 'candidate:local-1', sdpMid: '0', sdpMLineIndex: 0 }
        });
        await Promise.resolve();
        assert.deepEqual(rtcBridge.sentCandidates, [{
            candidate: 'candidate:local-1',
            sdpMid: '0',
            sdpMLineIndex: 0
        }]);

        await rtcBridge.emit({
            type: 'candidate',
            candidate: { candidate: 'candidate:remote-1', sdpMid: '0', sdpMLineIndex: 0 },
            roomId: 'room-ice-order'
        });
        await rtcBridge.emit({
            type: 'candidate',
            candidate: { candidate: 'candidate:remote-2', sdpMid: '0', sdpMLineIndex: 0 },
            roomId: 'room-ice-order'
        });

        assert.equal(pc.addedIceCandidates.length, 0);
        assert.equal(manager._pendingIceCandidates.length, 2);

        await completePublication(rtcBridge, 'room-ice-order');

        assert.deepEqual(
            pc.addedIceCandidates.map((candidate) => candidate.candidate),
            ['candidate:remote-1', 'candidate:remote-2']
        );
        await dispose(manager);
    });

    test('reattaching local tracks does not create duplicate RTP senders', async () => {
        const { manager } = createHarness();
        await manager.startCall('room-no-duplicates', 'Receiver', { isVideo: true, mode: 'video' });
        const pc = manager.peerConnection;

        await manager._attachLocalTracks(manager.callEpoch, pc);
        await manager._attachLocalTracks(manager.callEpoch, pc);

        assert.equal(pc.getSenders().filter((sender) => sender.track?.kind === 'audio').length, 1);
        assert.equal(pc.getSenders().filter((sender) => sender.track?.kind === 'video').length, 1);
        await dispose(manager);
    });
});

describe('Media acquisition edge contracts', () => {
    test('audio-only, audio/video, missing-device, and empty streams preserve the tracks actually supplied', async () => {
        const cases = [
            {
                name: 'audio only',
                isVideo: false,
                tracks: [new MockTrack('audio')],
                expectedAudio: true,
                expectedVideo: false
            },
            {
                name: 'audio and video',
                isVideo: true,
                tracks: [new MockTrack('audio'), new MockTrack('video')],
                expectedAudio: true,
                expectedVideo: true
            },
            {
                name: 'missing microphone',
                isVideo: true,
                tracks: [new MockTrack('video')],
                expectedAudio: false,
                expectedVideo: true
            },
            {
                name: 'missing camera',
                isVideo: true,
                tracks: [new MockTrack('audio')],
                expectedAudio: true,
                expectedVideo: false
            },
            {
                name: 'no usable tracks',
                isVideo: false,
                tracks: [],
                expectedAudio: false,
                expectedVideo: false
            }
        ];

        for (const scenario of cases) {
            const mediaDevices = new MockMediaDevices(() => new MockMediaStream(scenario.tracks));
            const { manager } = createHarness({ mediaDevices });
            manager._beginCallInstance();

            const stream = await manager._acquireMedia(scenario.isVideo, manager.callEpoch);

            assert.equal(Boolean(manager._localAudioTrack), scenario.expectedAudio, `${scenario.name}: audio`);
            assert.equal(Boolean(manager._localVideoTrack), scenario.expectedVideo, `${scenario.name}: video`);
            assert.equal(manager._localStream, stream, `${scenario.name}: retained stream`);
            manager._cleanupResources(manager.callEpoch);
        }
    });

    test('permission denial is surfaced with a friendly mode-specific failure', async () => {
        const mediaDevices = new MockMediaDevices(() => {
            const error = new Error('blocked');
            error.name = 'NotAllowedError';
            throw error;
        });
        const { manager } = createHarness({ mediaDevices });
        manager._beginCallInstance();

        await assert.rejects(
            manager._acquireMedia(true, manager.callEpoch),
            /Camera \/ microphone permission denied/
        );
        assert.equal(manager.state, CALL_STATE.FAILED);
    });

    test('media resolving for a stale call is stopped and cannot become the later call owner', async () => {
        let resolveMedia;
        const staleTrack = new MockTrack('audio');
        const mediaDevices = {
            getUserMedia: () => new Promise((resolve) => {
                resolveMedia = resolve;
            })
        };
        const { manager } = createHarness({ mediaDevices });
        const staleEpoch = manager._beginCallInstance();
        const acquisition = manager._acquireMedia(false, staleEpoch);

        manager._beginCallInstance();
        resolveMedia(new MockMediaStream([staleTrack]));

        await assert.rejects(acquisition, (error) => error.code === 'STALE_CALL');
        assert.equal(staleTrack.readyState, 'ended');
        assert.equal(manager._localStream, null);
    });
});

describe('Remote media, timer ownership, playback, and stale callbacks', () => {
    test('transport connectivity alone stays connecting; first live remote track starts one immutable timer epoch', async () => {
        const { manager, rtcBridge } = createHarness({ sendSignal: () => { } });
        await manager.startCall('room-track-connect', 'Receiver');
        manager.handleCallAccepted({ roomId: 'room-track-connect' });
        await completePublication(rtcBridge, 'room-track-connect');
        const pc = manager.peerConnection;

        pc.simulateTransportConnected();
        assert.equal(manager.state, CALL_STATE.CONNECTING);
        assert.equal(manager.callConnectedAt, null);

        const audioTrack = new MockTrack('audio');
        pc.simulateTrack(audioTrack);
        const firstConnectedAt = manager.callConnectedAt;

        assert.equal(manager.state, CALL_STATE.CONNECTED);
        assert.ok(firstConnectedAt > 0);

        await new Promise((resolve) => setTimeout(resolve, 5));
        pc.simulateTrack(new MockTrack('video'));
        manager._noteRemoteMedia({ track: new MockTrack('audio') }, manager.callEpoch, pc);

        assert.equal(manager.callConnectedAt, firstConnectedAt);
        assert.equal(manager._connectedEpoch, firstConnectedAt);
        await dispose(manager);
    });

    test('separate audio and video track events update one retained remote stream', async () => {
        const remoteAudioElement = new MockMediaElement();
        const remoteVideoElement = new MockMediaElement();
        const { manager, rtcBridge } = createHarness({ remoteAudioElement, remoteVideoElement });
        await manager.startCall('room-independent-tracks', 'Receiver', { isVideo: true, mode: 'video' });
        await completePublication(rtcBridge, 'room-independent-tracks');
        manager.handleCallAccepted({ roomId: 'room-independent-tracks' });
        const pc = manager.peerConnection;

        const audioTrack = new MockTrack('audio');
        const videoTrack = new MockTrack('video');
        const audioStream = new MockMediaStream([audioTrack]);
        const videoStream = new MockMediaStream([videoTrack]);
        pc.simulateTrack(audioTrack, audioStream);
        const retainedStream = manager._remoteStream;
        pc.simulateTrack(videoTrack, videoStream);

        assert.equal(manager._remoteStream, retainedStream);
        assert.deepEqual(manager._remoteStream.getTracks(), [audioTrack, videoTrack]);
        assert.equal(remoteAudioElement.srcObject, retainedStream);
        assert.equal(remoteVideoElement.srcObject, retainedStream);
        assert.ok(remoteAudioElement.playCalls >= 1);
        assert.ok(remoteVideoElement.playCalls >= 1);
        await dispose(manager);
    });

    test('playback Promise rejection is diagnostic-only and does not disconnect the call', async () => {
        const remoteAudioElement = new MockMediaElement({ rejectPlayback: true });
        const { manager, rtcBridge } = createHarness({ remoteAudioElement });
        await manager.startCall('room-playback-rejection', 'Receiver');
        await completePublication(rtcBridge, 'room-playback-rejection');
        manager.handleCallAccepted({ roomId: 'room-playback-rejection' });

        manager.peerConnection.simulateTrack(new MockTrack('audio'));
        await new Promise((resolve) => setImmediate(resolve));

        assert.equal(manager.state, CALL_STATE.CONNECTED);
        assert.ok(manager._playbackDiagnostics.has('remote-audio-playback-rejected'));
        await dispose(manager);
    });

    test('ended, stale-epoch, and stale-peer tracks cannot connect a later call', async () => {
        const { manager, rtcBridge } = createHarness({ sendSignal: () => { } });
        await manager.startCall('room-old-owner', 'First receiver');
        const oldPc = manager.peerConnection;
        const staleOnTrack = oldPc.ontrack;
        const oldEpoch = manager.callEpoch;
        await manager.endCall(false, oldEpoch);

        await manager.startCall('room-new-owner', 'Second receiver');
        manager.handleCallAccepted({ roomId: 'room-new-owner' });
        await completePublication(rtcBridge, 'room-new-owner', 'new-owner');
        const newPc = manager.peerConnection;

        staleOnTrack({
            track: new MockTrack('audio'),
            streams: [new MockMediaStream([new MockTrack('audio')])]
        });
        newPc.simulateTrack(new MockTrack('audio', { readyState: 'ended' }));

        assert.equal(manager.state, CALL_STATE.CONNECTING);
        assert.equal(manager.callConnectedAt, null);

        newPc.simulateTrack(new MockTrack('audio'));
        assert.equal(manager.state, CALL_STATE.CONNECTED);
        await dispose(manager);
    });

    test('consecutive caller/receiver role reversal gets a new epoch, peer, media owner, and timer origin', async () => {
        const mediaStreams = [
            new MockMediaStream([new MockTrack('audio')]),
            new MockMediaStream([new MockTrack('audio'), new MockTrack('video')])
        ];
        const mediaDevices = new MockMediaDevices(() => mediaStreams.shift());
        const { manager, rtcBridge } = createHarness({ mediaDevices, sendSignal: () => { } });

        await manager.startCall('room-role-reversal', 'First receiver');
        const firstEpoch = manager.callEpoch;
        const firstPc = manager.peerConnection;
        const firstTrack = manager._localAudioTrack;
        manager.handleCallAccepted({ roomId: 'room-role-reversal' });
        await completePublication(rtcBridge, 'room-role-reversal', 'first');
        firstPc.simulateTrack(new MockTrack('audio'));
        const firstConnectedAt = manager.callConnectedAt;
        assert.equal(manager.state, CALL_STATE.CONNECTED);

        await manager.endCall(false, firstEpoch);
        assert.equal(firstTrack.readyState, 'ended');

        manager.handleIncomingCall({
            roomId: 'room-role-reversal',
            callId: 'call-role-reversal-2',
            initiator: 'Former receiver',
            isVideo: true,
            callType: 'video'
        });
        await manager.acceptCall();
        const secondEpoch = manager.callEpoch;
        const secondPc = manager.peerConnection;

        assert.ok(secondEpoch > firstEpoch);
        assert.notEqual(secondPc, firstPc);
        assert.deepEqual(secondPc.getSenders().map((sender) => sender.track.kind).sort(), ['audio', 'video']);
        assert.equal(manager.callConnectedAt, null);

        await completePublication(rtcBridge, 'room-role-reversal', 'second');
        secondPc.simulateTrack(new MockTrack('audio'));

        assert.equal(manager.state, CALL_STATE.CONNECTED);
        assert.ok(manager.callConnectedAt > 0);
        assert.notEqual(manager.callConnectedAt, firstConnectedAt);
        await dispose(manager);
    });
});

describe('Floating timer authority', () => {
    test('floating renderer only displays manager-synchronized duration and owns no interval ticker', () => {
        const source = readFileSync(new URL('../src/renderer/floating-call.js', import.meta.url), 'utf8');

        assert.match(source, /renderSynchronizedDuration\(state\.state === 'connected' \? \(state\.duration \|\| 0\) : 0\)/);
        assert.doesNotMatch(source, /startDurationTicker/);
        assert.doesNotMatch(source, /setInterval\s*\(/);
    });
});
