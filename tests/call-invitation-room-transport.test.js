import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ChatWebSocket, decodeFrame } from '../src/chat/chat-websocket.js';
import { VoiceCallManager, CALL_STATE } from '../src/call/voice-call-manager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const appJs = fs.readFileSync(path.resolve(__dirname, '../src/renderer/app.js'), 'utf8');
const mainJs = fs.readFileSync(path.resolve(__dirname, '../src/main/main.js'), 'utf8');
const chatSendHandlerStart = mainJs.indexOf("ipcMain.handle('chat:send'");
const chatSendHandlerEnd = mainJs.indexOf("ipcMain.handle('chat:typing:start'", chatSendHandlerStart);
const chatSendHandler = mainJs.slice(chatSendHandlerStart, chatSendHandlerEnd);

class MockTrack {
    constructor(kind = 'audio') {
        this.kind = kind;
        this.enabled = true;
        this.stopped = false;
    }

    stop() {
        this.stopped = true;
    }
}

class MockMediaStream {
    constructor(tracks) {
        this.tracks = tracks;
    }

    getTracks() {
        return this.tracks;
    }

    getAudioTracks() {
        return this.tracks.filter(track => track.kind === 'audio');
    }

    getVideoTracks() {
        return this.tracks.filter(track => track.kind === 'video');
    }
}

class MockMediaDevices {
    async getUserMedia(constraints) {
        const tracks = [new MockTrack('audio')];
        if (constraints.video) tracks.push(new MockTrack('video'));
        return new MockMediaStream(tracks);
    }
}

class MockPeerConnection {
    constructor() {
        this.localDescription = null;
        this.remoteDescription = null;
        this.connectionState = 'new';
        this.iceConnectionState = 'new';
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

    async createOffer() {
        return { type: 'offer', sdp: 'v=0\r\no=room-transport-offer\r\n' };
    }

    async setLocalDescription(description) {
        this.localDescription = description;
    }

    close() {
        this.connectionState = 'closed';
        this.iceConnectionState = 'closed';
    }
}

class MockRtcBridge {
    constructor() {
        this.listeners = new Set();
        this.leaves = 0;
        this.disconnects = 0;
    }

    async connect() {
        return { ok: true, state: 'connected', iceServers: [] };
    }

    async sendOffer() {
        return { ok: true };
    }

    async leave() {
        this.leaves += 1;
        return { ok: true };
    }

    async disconnect() {
        this.disconnects += 1;
        return { ok: true };
    }

    onEvent(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }
}

class RoomTransportWebSocket {
    static instances = [];
    static sequence = 0;

    constructor(_url, protocols = []) {
        this.readyState = 0;
        this.sentData = [];
        this.onopen = null;
        this.onmessage = null;
        this.onerror = null;
        this.onclose = null;
        const bearer = protocols.find(protocol => String(protocol).startsWith('bearer.')) || '';
        const token = bearer.slice('bearer.'.length);
        const [userId, roomId] = token.split('|');
        this.userId = userId;
        this.roomId = roomId;
        RoomTransportWebSocket.instances.push(this);
    }

    simulateOpen() {
        this.readyState = 1;
        this.onopen?.();
    }

    send(rawFrame) {
        if (this.readyState !== 1) throw new Error('socket is not open');
        this.sentData.push(rawFrame);
        const frame = decodeFrame(rawFrame);
        if (frame.room_id !== this.roomId) {
            throw new Error('cross-room frame reached an authenticated socket');
        }
        const body = frame.payload?.body;
        if (!body?.call_signal) return;

        RoomTransportWebSocket.sequence += 1;
        for (const socket of RoomTransportWebSocket.instances) {
            if (socket.readyState !== 1 || socket.roomId !== this.roomId) continue;
            socket.onmessage?.({
                data: JSON.stringify({
                    v: 1,
                    type: 'message.created',
                    room_id: this.roomId,
                    event_seq: RoomTransportWebSocket.sequence,
                    payload: {
                        ...frame.payload,
                        sender_id: this.userId
                    }
                })
            });
        }
    }

    close(code = 1000, reason = '') {
        this.readyState = 3;
        this.onclose?.({ code, reason });
    }
}

function transportResult(send) {
    try {
        return { ok: true, requestId: send() };
    } catch (error) {
        return { ok: false, code: error?.code || 'chat_send_failed' };
    }
}

async function openRooms(chat, userId, roomOrder) {
    const entries = [];
    for (const roomId of roomOrder) {
        const entry = await chat.connectRoom(roomId, { token: `${userId}|${roomId}` });
        entries.push(entry);
    }
    for (const entry of entries) entry.socket.simulateOpen();
}

const activeClients = new Set();

function createClient(userId) {
    const chat = new ChatWebSocket({
        multiRoom: true,
        WebSocketClass: RoomTransportWebSocket,
        connectTimeoutMs: 0,
        heartbeatIntervalMs: 60_000
    });
    const incoming = [];
    const manager = new VoiceCallManager({
        rtcBridge: new MockRtcBridge(),
        mediaDevices: new MockMediaDevices(),
        PeerConnectionClass: MockPeerConnection,
        sendSignal: async ({ action, roomId, callType, isVideo, callId, callEpoch }) => {
            const result = transportResult(() => chat.send('message.send', {
                client_message_id: `call_sig_${userId}_${action}_${callEpoch}`,
                kind: 'text',
                body: {
                    call_signal: action,
                    call_type: callType,
                    is_video: Boolean(isVideo),
                    call_id: callId,
                    call_epoch: callEpoch,
                    text: ''
                }
            }, roomId));
            return result;
        }
    });

    chat.on('message.created', message => {
        const body = message.body;
        if (!body?.call_signal || message.senderId === userId) return;
        if (body.call_signal === 'invite') {
            incoming.push({
                roomId: message.roomId,
                senderId: message.senderId,
                callType: body.call_type,
                isVideo: Boolean(body.is_video)
            });
            manager.handleIncomingCall({
                roomId: message.roomId,
                callId: body.call_id,
                initiator: message.senderId,
                isVideo: Boolean(body.is_video),
                callType: body.call_type
            });
        }
    });

    const client = { userId, chat, manager, incoming };
    activeClients.add(client);
    return client;
}

async function resetManagers(...clients) {
    for (const client of clients) {
        await client.manager.endCall(false);
    }
    await new Promise(resolve => setTimeout(resolve, 850));
}

describe('Room-scoped call invitation transport and propagation', () => {
    beforeEach(() => {
        activeClients.clear();
        RoomTransportWebSocket.instances = [];
        RoomTransportWebSocket.sequence = 0;
    });

    afterEach(() => {
        for (const client of activeClients) {
            client.manager._clearRingingTimer();
            client.manager._clearIceDisconnectTimer();
            client.manager.stopCallDurationTimer();
            client.manager._cleanupResources(client.manager.callEpoch);
            client.chat.disconnect();
        }
        activeClients.clear();
        RoomTransportWebSocket.instances = [];
    });

    test('1. A→B and B→A invitations use exact room sockets in reversed connection order for voice and video', async () => {
        const a = createClient('user-A');
        const b = createClient('user-B');
        await openRooms(a.chat, a.userId, ['decoy-A', 'shared-room']);
        await openRooms(b.chat, b.userId, ['shared-room', 'decoy-B']);

        await a.manager.startCall('shared-room', 'User B');
        assert.equal(a.manager._inviteSent, true);
        assert.equal(b.manager.state, CALL_STATE.INCOMING_RINGING);
        assert.deepEqual(b.incoming.at(-1), {
            roomId: 'shared-room',
            senderId: 'user-A',
            callType: 'voice',
            isVideo: false
        });
        assert.equal(a.incoming.length, 0, 'local echo must not create an incoming call');
        const aDecoy = RoomTransportWebSocket.instances.find(socket => socket.userId === 'user-A' && socket.roomId === 'decoy-A');
        assert.equal(aDecoy.sentData.length, 0, 'invite must not use first connected decoy socket');

        await resetManagers(a, b);

        await b.manager.startVideoCall('shared-room', 'User A');
        assert.equal(b.manager._inviteSent, true);
        assert.equal(a.manager.state, CALL_STATE.INCOMING_RINGING);
        assert.deepEqual(a.incoming.at(-1), {
            roomId: 'shared-room',
            senderId: 'user-B',
            callType: 'video',
            isVideo: true
        });
        const bDecoy = RoomTransportWebSocket.instances.find(socket => socket.userId === 'user-B' && socket.roomId === 'decoy-B');
        assert.equal(bDecoy.sentData.length, 0);
    });

    test('2. Immediate repeated calls and reconnect continue delivering only to the correct recipient', async () => {
        const a = createClient('user-A');
        const b = createClient('user-B');
        const c = createClient('user-C');
        await openRooms(a.chat, a.userId, ['shared-room', 'other-room']);
        await openRooms(b.chat, b.userId, ['other-room', 'shared-room']);
        await openRooms(c.chat, c.userId, ['other-room']);

        await a.manager.startCall('shared-room', 'User B');
        assert.equal(b.incoming.length, 1);
        assert.equal(c.incoming.length, 0);
        await resetManagers(a, b);

        const oldEntry = a.chat._roomSockets.get('shared-room');
        oldEntry.socket.close(1006, 'reconnect test');
        const reconnect = await a.chat.connectRoom('shared-room', {
            token: 'user-A|shared-room',
            forceTokenRefresh: true
        });
        reconnect.socket.simulateOpen();

        await a.manager.startVideoCall('shared-room', 'User B');
        assert.equal(b.incoming.length, 2);
        assert.equal(b.incoming.at(-1).callType, 'video');
        assert.equal(c.incoming.length, 0);
    });

    test('3. Missing exact room propagates resolved transport failure into outgoing startup cleanup', async () => {
        const a = createClient('user-A');
        await openRooms(a.chat, a.userId, ['connected-other-room']);

        await assert.rejects(
            a.manager.startCall('absent-call-room', 'Missing recipient'),
            err => err?.code === 'room_socket_absent'
        );
        assert.equal(a.manager.state, CALL_STATE.FAILED);
        assert.equal(a.manager._inviteSent, false);
        assert.equal(a.manager.peerConnection, null);
        const unrelated = RoomTransportWebSocket.instances.find(socket => socket.roomId === 'connected-other-room');
        assert.equal(unrelated.sentData.length, 0);
    });

    test('4. Renderer and main contracts expose all stable invitation send outcomes without unsafe details', () => {
        assert.match(appJs, /async function sendCallSignal\(action, roomId, extra = \{\}\)/);
        assert.match(appJs, /call_signal_room_required/);
        assert.match(appJs, /call_signal_bridge_unavailable/);
        assert.match(appJs, /call_signal_ipc_rejected/);
        assert.match(appJs, /call_signal_send_failed/);
        assert.match(appJs, /if \(!result \|\| result\.ok !== true\)/);
        assert.match(appJs, /return sendCallSignal\(action, roomId/);
        assert.match(appJs, /inFlightCallInvitations\.delete\(pId\)/);
        assert.match(appJs, /inFlightCallInvitations\.delete\(targetUserId\)/);

        for (const code of [
            'chat_websocket_unavailable',
            'room_required',
            'room_socket_absent',
            'room_socket_error',
            'room_socket_not_connected',
            'socket_send_failed',
            'chat_send_failed'
        ]) {
            assert.ok(mainJs.includes(code), `main chat:send must expose ${code}`);
        }
        assert.ok(chatSendHandlerStart >= 0 && chatSendHandlerEnd > chatSendHandlerStart);
        assert.match(chatSendHandler, /Object\.hasOwn\(CHAT_SEND_ERROR_MESSAGES, err\?\.code\)/);
        assert.doesNotMatch(chatSendHandler, /err\.message/);
    });
});
