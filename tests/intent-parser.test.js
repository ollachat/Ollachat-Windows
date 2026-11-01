import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseProtocolUrl, parseLaunchArgs, sanitizeParam } from '../src/main/intent-parser.js';

describe('Phase 1: Windows Launch Intent & Protocol Parser Suite', () => {
  // 1. Parsing open_chat CLI intent
  test('1. Parses open_chat CLI intent correctly', () => {
    const args = ['OllaChat.exe', '--action=open_chat', '--roomId=room_123'];
    const intent = parseLaunchArgs(args);
    assert.deepEqual(intent, {
      action: 'open_chat',
      roomId: 'room_123'
    });
  });

  // 2. Parsing incoming voice call intent
  test('2. Parses incoming voice call CLI intent correctly', () => {
    const args = [
      'OllaChat.exe',
      '--action=incoming_call',
      '--roomId=room_voice_1',
      '--callId=call_v_99',
      '--initiator=Alice',
      '--callType=voice'
    ];
    const intent = parseLaunchArgs(args);
    assert.deepEqual(intent, {
      action: 'incoming_call',
      roomId: 'room_voice_1',
      callId: 'call_v_99',
      initiator: 'Alice',
      isVideo: false,
      callType: 'voice'
    });
  });

  // 3. Parsing incoming video call intent
  test('3. Parses incoming video call CLI intent correctly', () => {
    const args = [
      'OllaChat.exe',
      '--action=incoming_call',
      '--roomId=room_video_2',
      '--callId=call_vid_101',
      '--initiator=Bob',
      '--callType=video'
    ];
    const intent = parseLaunchArgs(args);
    assert.deepEqual(intent, {
      action: 'incoming_call',
      roomId: 'room_video_2',
      callId: 'call_vid_101',
      initiator: 'Bob',
      isVideo: true,
      callType: 'video'
    });
  });

  // 4. Parsing open_chat protocol URL
  test('4. Parses ollachat://chat?roomId=... protocol URL', () => {
    const url = 'ollachat://chat?roomId=room_abc_456';
    const intent = parseProtocolUrl(url);
    assert.deepEqual(intent, {
      action: 'open_chat',
      roomId: 'room_abc_456'
    });

    // Also parsed when passed inside CLI args
    const cliIntent = parseLaunchArgs(['OllaChat.exe', url]);
    assert.deepEqual(cliIntent, {
      action: 'open_chat',
      roomId: 'room_abc_456'
    });
  });

  // 5. Parsing incoming call protocol URL
  test('5. Parses ollachat://call?... protocol URL for voice and video', () => {
    const voiceUrl = 'ollachat://call?roomId=room_v7&callId=call_v7&type=voice&initiator=Charlie';
    const voiceIntent = parseProtocolUrl(voiceUrl);
    assert.deepEqual(voiceIntent, {
      action: 'incoming_call',
      roomId: 'room_v7',
      callId: 'call_v7',
      initiator: 'Charlie',
      isVideo: false,
      callType: 'voice'
    });

    const videoUrl = 'ollachat://call?roomId=room_v8&callId=call_v8&type=video&initiator=Dana';
    const videoIntent = parseProtocolUrl(videoUrl);
    assert.deepEqual(videoIntent, {
      action: 'incoming_call',
      roomId: 'room_v8',
      callId: 'call_v8',
      initiator: 'Dana',
      isVideo: true,
      callType: 'video'
    });
  });

  // 6. Rejecting malformed intents & URLs
  test('6. Rejects malformed intents, invalid protocols, and empty args', () => {
    assert.equal(parseProtocolUrl('https://ollachat.com/chat'), null);
    assert.equal(parseProtocolUrl('not-a-url'), null);
    assert.equal(parseProtocolUrl('ollachat://chat'), null); // Missing roomId
    assert.equal(parseProtocolUrl('ollachat://unknown_action?roomId=123'), null);
    assert.equal(parseLaunchArgs([]), null);
    assert.equal(parseLaunchArgs(['OllaChat.exe']), null);
  });

  // 7. Rejecting unsupported actions
  test('7. Rejects unsupported actions', () => {
    const args = ['OllaChat.exe', '--action=execute_code', '--code=alert(1)'];
    assert.equal(parseLaunchArgs(args), null);
  });

  // 8. Preserving callType correctly and rejecting invalid modalities
  test('8. Rejects invalid call modalities', () => {
    const args = ['OllaChat.exe', '--action=incoming_call', '--roomId=room_1', '--callType=telepathy'];
    assert.equal(parseLaunchArgs(args), null);

    const url = 'ollachat://call?roomId=room_1&type=unsupported';
    assert.equal(parseProtocolUrl(url), null);
  });

  // 9. Rejection of credential leaks into arguments/payloads
  test('9. Strictly rejects and drops arguments containing credential tokens', () => {
    // Attempting to pass session token
    assert.equal(sanitizeParam('du_session_token_12345'), null);
    // Attempting to pass room token
    assert.equal(sanitizeParam('rt_room_token_67890'), null);
    // Attempting to pass API key
    assert.equal(sanitizeParam('ak_server_secret_abc'), null);

    const taintedArgs = ['OllaChat.exe', '--action=open_chat', '--roomId=du_secret_token'];
    assert.equal(parseLaunchArgs(taintedArgs), null);

    const taintedUrl = 'ollachat://chat?roomId=du_secret_token';
    assert.equal(parseProtocolUrl(taintedUrl), null);
  });

  // 10. Sanitizes path traversal and HTML/script injection attempts
  test('10. Sanitizes path traversal and HTML/script injection attempts', () => {
    assert.equal(sanitizeParam('../../etc/passwd'), null);
    assert.equal(sanitizeParam('<script>alert(1)</script>'), null);
    assert.equal(sanitizeParam('room"evil"'), null);
  });
});
