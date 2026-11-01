import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { parseLaunchArgs } from '../src/main/intent-parser.js';
import { PendingIntentManager } from '../src/main/pending-intent.js';
import { VoiceCallManager, CALL_STATE } from '../src/call/voice-call-manager.js';

describe('Phase 1: Cold-Launch & Intent Dispatch Suite', () => {
  let pendingManager;

  beforeEach(() => {
    pendingManager = new PendingIntentManager();
  });

  // 1. Cold-start intent stored until renderer readiness
  test('1. Cold-start intent is stored in PendingIntentManager until queried', () => {
    assert.equal(pendingManager.hasPending(), false);
    assert.equal(pendingManager.peek(), null);

    const intent = { action: 'open_chat', roomId: 'cold_room_1' };
    pendingManager.setIntent(intent);

    assert.equal(pendingManager.hasPending(), true);
    assert.deepEqual(pendingManager.peek(), intent);
  });

  // 2. Intent dispatched exactly once and cleared
  test('2. getAndClear() retrieves the intent and clears it so it is never dispatched twice', () => {
    const intent = { action: 'open_chat', roomId: 'cold_room_2' };
    pendingManager.setIntent(intent);

    const firstRetrieval = pendingManager.getAndClear();
    assert.deepEqual(firstRetrieval, intent);

    // Second call must return null
    const secondRetrieval = pendingManager.getAndClear();
    assert.equal(secondRetrieval, null);
    assert.equal(pendingManager.hasPending(), false);
  });

  // 3. Rejecting invalid intents in PendingIntentManager
  test('3. PendingIntentManager rejects invalid / null intents safely', () => {
    pendingManager.setIntent(null);
    assert.equal(pendingManager.hasPending(), false);

    pendingManager.setIntent('not-an-object');
    assert.equal(pendingManager.hasPending(), false);

    pendingManager.setIntent({}); // Missing action
    assert.equal(pendingManager.hasPending(), false);
  });

  // 4. Second-instance simulation with protocol URL
  test('4. Simulates second-instance argument parsing with protocol URL', () => {
    const secondInstanceArgs = [
      'C:\\Program Files\\OllaChat\\OllaChat.exe',
      'ollachat://chat?roomId=room_second_instance'
    ];
    const parsed = parseLaunchArgs(secondInstanceArgs);
    assert.deepEqual(parsed, {
      action: 'open_chat',
      roomId: 'room_second_instance'
    });
  });

  // 5. Second-instance simulation with incoming call intent
  test('5. Simulates second-instance incoming call intent with voice modality', () => {
    const secondInstanceArgs = [
      'C:\\Program Files\\OllaChat\\OllaChat.exe',
      '--action=incoming_call',
      '--roomId=room_call_running',
      '--callId=call_running_99',
      '--initiator=Doctor',
      '--callType=voice'
    ];
    const parsed = parseLaunchArgs(secondInstanceArgs);
    assert.deepEqual(parsed, {
      action: 'incoming_call',
      roomId: 'room_call_running',
      callId: 'call_running_99',
      initiator: 'Doctor',
      isVideo: false,
      callType: 'voice'
    });
  });

  // 6. Voice Call Manager integration: incoming voice call intent
  test('6. Incoming voice call intent activates VoiceCallManager with camera OFF', () => {
    const voiceIntent = {
      action: 'incoming_call',
      roomId: 'room_intent_voice',
      callId: 'call_intent_v1',
      initiator: 'Alice',
      isVideo: false,
      callType: 'voice'
    };

    const manager = new VoiceCallManager({
      roomId: voiceIntent.roomId,
      peerName: voiceIntent.initiator
    });

    manager.handleIncomingCall({
      roomId: voiceIntent.roomId,
      callId: voiceIntent.callId,
      initiator: voiceIntent.initiator,
      isVideo: voiceIntent.isVideo,
      callType: voiceIntent.callType,
      peerName: voiceIntent.initiator
    });

    assert.equal(manager.state, CALL_STATE.INCOMING_RINGING);
    assert.equal(manager.isVideo, false);
    assert.equal(manager.mode, 'voice');
    // Camera MUST remain OFF!
    assert.equal(manager._localStream, null);
    assert.equal(manager.durationSec, 0);
  });

  // 7. Video Call Manager integration: incoming video call intent
  test('7. Incoming video call intent activates VoiceCallManager with video mode and camera OFF while ringing', async () => {
    const videoIntent = {
      action: 'incoming_call',
      roomId: 'room_intent_video',
      callId: 'call_intent_v2',
      initiator: 'Bob',
      isVideo: true,
      callType: 'video'
    };

    const manager = new VoiceCallManager({
      roomId: videoIntent.roomId,
      peerName: videoIntent.initiator
    });

    manager.handleIncomingCall({
      roomId: videoIntent.roomId,
      callId: videoIntent.callId,
      initiator: videoIntent.initiator,
      isVideo: videoIntent.isVideo,
      callType: videoIntent.callType,
      peerName: videoIntent.initiator
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

  // 8. Reject credentials in second-instance arguments
  test('8. Rejects token parameters in second-instance arguments to prevent leakage', () => {
    const taintedArgs = [
      'C:\\Program Files\\OllaChat\\OllaChat.exe',
      'ollachat://call?roomId=du_token_leak&callId=123&type=voice'
    ];
    const parsed = parseLaunchArgs(taintedArgs);
    assert.equal(parsed, null);
  });
});
