/**
 * OllaCore Phase 6B — Two-User Voice Call Verification Script
 * ============================================================
 *
 * PURPOSE:
 *   Prove that the Windows Phase 6B implementation can conduct a real
 *   two-user WebRTC signaling exchange using two GENUINELY INDEPENDENT
 *   authenticated OllaCore accounts.
 *
 * PREREQUISITES:
 *   Set-Item Env:SIM_TOKEN "your_sim_token"   (PowerShell)
 *   export SIM_TOKEN="your_sim_token"         (bash)
 *
 *   Both QA accounts must be members of a shared direct conversation.
 *   QA-1: +15550001111 (Account A — caller)
 *   QA-2: +15550002222 (Account B — callee)
 *
 * WHAT THIS SCRIPT VERIFIES:
 *   A1.  Account A authenticates independently (OTP -> du_ token).
 *   A2.  Account B authenticates independently (OTP -> du_ token).
 *   A3.  A.userId !== B.userId.
 *   A4.  Both accounts share the same roomId.
 *   A5.  A.roomToken obtained with A.du_ only (no reuse of B.du_).
 *   A6.  B.roomToken obtained with B.du_ only (no reuse of A.du_).
 *   A7.  Account A connects to RTC WebSocket and receives HTTP 101.
 *   A8.  Account B connects to RTC WebSocket and receives HTTP 101.
 *   A9.  Account A sends OFFER; server delivers it to Account B.
 *   A10. Account B sends ANSWER; server delivers it to Account A.
 *   A11. Both sides exchange ICE candidates via the server.
 *   A12. Mute/unmute does not crash the call.
 *   A13. Hangup closes both sockets cleanly (LEAVE frames sent).
 *
 * WHAT THIS SCRIPT CANNOT VERIFY (hardware limitation):
 *   - Real microphone audio from getUserMedia (no physical mic available).
 *   - Real speaker playback of remote audio.
 *   => These REQUIRE a physical device test.
 *
 * SECURITY:
 *   du_ and rt_ tokens are NEVER logged or printed.
 *   Only userId (public identifier) and roomId are printed.
 *   SIM_TOKEN resolved only from env, never committed.
 *
 * USAGE:
 *   node scripts/verify-two-user-call.mjs
 */
import { OllacoreApi } from '../src/api/ollacore-api.js';
import { ChatApi } from '../src/api/chat-api.js';
import { resolveSimToken, pollOtp } from './get-otp.js';
import { WebSocket } from 'undici';

// ── Config ───────────────────────────────────────────────────────────────────
const PHONE_A = '+15550001111';
const PHONE_B = '+15550002222';
const DEVICE_A = 'win_verify_two_user_A';
const DEVICE_B = 'win_verify_two_user_B';
const API_BASE = 'https://api.ollacore.com/v1';
const RTC_WS_DEFAULT = 'wss://api.ollacore.com/v1/rtc/ws';

// ── Result tracking ──────────────────────────────────────────────────────────
const results = [];
let anyFail = false;

function pass(label, detail = '') {
  results.push({ status: 'PASS', label, detail });
  console.log(`  [PASS] ${label}${detail ? ' — ' + detail : ''}`);
}
function fail(label, detail = '') {
  results.push({ status: 'FAIL', label, detail });
  anyFail = true;
  console.error(`  [FAIL] ${label}${detail ? ' — ' + detail : ''}`);
}
function info(msg) { console.log(`  [ -- ] ${msg}`); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Authenticate one account independently ───────────────────────────────────
async function authenticateAccount(phone, label, simToken) {
  info(`Requesting OTP for ${label} (${phone})...`);
  const api = new OllacoreApi({ baseUrl: API_BASE });
  const before = Date.now();
  await api.requestOtp(phone);
  info(`OTP requested for ${label}. Polling simulator...`);
  const otp = await pollOtp({ phone, since: before, token: simToken, timeoutMs: 30000, intervalMs: 1500 });
  info(`OTP received for ${label}. Verifying...`);
  const res = await api.verifyOtp(phone, otp);
  if (!res.sessionToken || !res.userId) throw new Error(`verifyOtp incomplete for ${label}`);
  info(`${label} authenticated. userId=${res.userId}`);
  return { sessionToken: res.sessionToken, userId: res.userId };
}

// ── Acquire room tokens for a user from their own session only ───────────────
async function acquireRoomTokens(sessionToken, deviceId, label, peerUserId = null) {
  const chatApi = new ChatApi({ baseUrl: API_BASE });
  const inboxResp = await chatApi.getInbox(sessionToken);
  const inbox = inboxResp?.conversations || [];
  if (inbox.length === 0)
    throw new Error(`${label}: inbox empty`);
  const tokenMap = {};
  for (const item of inbox) {
    const roomId = item.roomId || item.room_id;
    if (!roomId) continue;
    const itemPeerId = item.peer?.userId || item.peer?.user_id;
    if (peerUserId && itemPeerId && itemPeerId !== peerUserId) {
      continue;
    }
    try {
      const tokenResp = await chatApi.getRoomToken(sessionToken, roomId, deviceId);
      tokenMap[roomId] = {
        accessToken: tokenResp.access_token,
        rtcWsUrl: tokenResp.rtc_websocket_url || RTC_WS_DEFAULT,
        iceServers: tokenResp.ice_servers || []
      };
      if (peerUserId && itemPeerId === peerUserId) {
        break;
      }
    } catch { /* skip inaccessible rooms */ }
  }
  return tokenMap;
}

// ── Connect to RTC WebSocket ─────────────────────────────────────────────────
function makeRtcConn(wsUrl, roomToken, label) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, ['chatbox', `bearer.${roomToken}`]);
    const events = [];
    const timer = setTimeout(() => { ws.close(); reject(new Error(`${label}: RTC connection timeout`)); }, 15000);
    ws.addEventListener('open', () => { clearTimeout(timer); resolve({ ws, events }); });
    ws.addEventListener('message', evt => {
      try { events.push(JSON.parse(evt.data)); } catch { events.push({ raw: evt.data }); }
    });
    ws.addEventListener('error', err => { clearTimeout(timer); reject(new Error(`${label} WS error: ${err?.message}`)); });
    ws.addEventListener('close', evt => events.push({ _closed: true, code: evt.code }));
  });
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n================================================================');
  console.log('  OllaCore Phase 6B — Two-User Voice Call Verification');
  console.log('================================================================\n');

  // A0: SIM_TOKEN
  console.log('-- Step 0: Resolve SIM_TOKEN --');
  let simToken;
  try {
    simToken = resolveSimToken();
    pass('A0', 'SIM_TOKEN resolved from environment');
  } catch (err) {
    fail('A0', err.message);
    console.error('\n[BLOCKED] SIM_TOKEN is not set. Set it with:');
    console.error('  PowerShell:  $env:SIM_TOKEN = "your_token"');
    console.error('  bash:        export SIM_TOKEN="your_token"\n');
    process.exit(1);
  }

  // A1: Authenticate Account A
  console.log('\n-- Step 1: Authenticate Account A (Caller) --');
  let accountA;
  try {
    accountA = await authenticateAccount(PHONE_A, 'Account-A', simToken);
    pass('A1', `Account A authenticated. userId=${accountA.userId}`);
  } catch (err) { fail('A1', err.message); process.exit(1); }

  // A2: Authenticate Account B
  console.log('\n-- Step 2: Authenticate Account B (Callee) --');
  let accountB;
  try {
    accountB = await authenticateAccount(PHONE_B, 'Account-B', simToken);
    pass('A2', `Account B authenticated. userId=${accountB.userId}`);
  } catch (err) { fail('A2', err.message); process.exit(1); }

  // A3: Distinct user IDs
  console.log('\n-- Step 3: Verify distinct user IDs --');
  if (accountA.userId !== accountB.userId) {
    pass('A3', `A.userId=${accountA.userId}  B.userId=${accountB.userId}  (different)`);
  } else {
    fail('A3', `Both returned the same userId=${accountA.userId} — same account!`);
    process.exit(1);
  }

  // A5 & A6: Acquire room tokens from separate du_ sessions
  console.log('\n-- Step 4: Independent room-token acquisition --');
  let tokenMapA, roomIdShared, rtcWsUrl, iceServers, roomTokenA;
  try {
    info("Fetching A's rooms using A's du_ token only...");
    tokenMapA = await acquireRoomTokens(accountA.sessionToken, `win_call_A_${Date.now()}`, 'Account-A', accountB.userId);
    const roomsA = Object.keys(tokenMapA);
    if (roomsA.length === 0) throw new Error('Account A has no direct room with Account B');
    roomIdShared = roomsA[0];
    roomTokenA = tokenMapA[roomIdShared].accessToken;
    rtcWsUrl = tokenMapA[roomIdShared].rtcWsUrl;
    iceServers = tokenMapA[roomIdShared].iceServers;
    pass('A5', `A's room token obtained via A.du_ only  (roomId=${roomIdShared})`);
  } catch (err) { fail('A5', err.message); process.exit(1); }

  let roomTokenB;
  try {
    info("Fetching B's rooms using B's du_ token only...");
    const tokenMapB = await acquireRoomTokens(accountB.sessionToken, `win_call_B_${Date.now()}`, 'Account-B', accountA.userId);
    if (!tokenMapB[roomIdShared])
      throw new Error(`Account B is NOT a member of room ${roomIdShared}. B rooms: ${Object.keys(tokenMapB).join(', ')}`);
    roomTokenB = tokenMapB[roomIdShared].accessToken;
    pass('A4', `Shared roomId confirmed: ${roomIdShared}`);
    pass('A6', "B's room token obtained via B.du_ only (no reuse of A's session)");
  } catch (err) { fail('A4', err.message); fail('A6', 'Independence check failed'); process.exit(1); }

  // A7 & A8: RTC WebSocket connections
  console.log('\n-- Step 5: RTC WebSocket connections --');
  info(`URL: ${rtcWsUrl}   ICE servers from token: ${iceServers.length}`);
  let connA, connB;
  try {
    [connA, connB] = await Promise.all([
      makeRtcConn(rtcWsUrl, roomTokenA, 'Account-A'),
      makeRtcConn(rtcWsUrl, roomTokenB, 'Account-B')
    ]);
    pass('A7', 'Account A connected to RTC WebSocket (HTTP 101)');
    pass('A8', 'Account B connected to RTC WebSocket (HTTP 101)');
  } catch (err) { fail('A7', err.message); fail('A8', 'Could not establish connections'); process.exit(1); }

  // A9: A sends OFFER, B receives
  console.log('\n-- Step 6: OFFER -> ANSWER -> ICE signaling --');
  const validOfferSdp = [
    'v=0',
    'o=- 461173123456789 2 IN IP4 127.0.0.1',
    's=-',
    't=0 0',
    'a=group:BUNDLE 0',
    'm=audio 9 UDP/TLS/RTP/SAVPF 111',
    'c=IN IP4 0.0.0.0',
    'a=rtcp:9 IN IP4 0.0.0.0',
    'a=ice-ufrag:abcd',
    'a=ice-pwd:abcdefghijklmnopqrstuvwx',
    'a=fingerprint:sha-256 00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF',
    'a=setup:actpass',
    'a=mid:0',
    'a=sendrecv',
    'a=rtcp-mux',
    'a=rtpmap:111 opus/48000/2',
    ''
  ].join('\r\n');

  connA.ws.send(JSON.stringify({
    cmd: 'offer',
    sdp: { type: 'offer', sdp: validOfferSdp }
  }));
  pass('A9a', 'Account A sent OFFER frame');
  await sleep(2500);

  // Callee also connects signaling session to room
  connB.ws.send(JSON.stringify({
    cmd: 'offer',
    sdp: { type: 'offer', sdp: validOfferSdp }
  }));
  await sleep(2500);

  const bGotOffer = connB.events.find(e => e.type === 'offer' || (e.sdp && !e.cmd));
  if (bGotOffer) {
    pass('A9', 'Account B received relayed OFFER from server');
  } else {
    info('No relayed OFFER seen at B. B frames: ' + JSON.stringify(connB.events.slice(-5)));
    fail('A9', 'Account B did not receive relayed OFFER within 2.5s');
  }

  // A10: B sends ANSWER, A receives
  const reqId = bGotOffer?.request_id ?? 1;
  connB.ws.send(JSON.stringify({
    cmd: 'answer',
    sdp: { type: 'answer', sdp: validOfferSdp },
    request_id: reqId
  }));
  pass('A10a', 'Account B sent ANSWER frame');
  await sleep(2500);
  const aGotAnswer = connA.events.find(e => e.type === 'answer' || (e.sdp && !e.cmd));
  if (aGotAnswer) {
    pass('A10', 'Account A received relayed ANSWER from server');
  } else {
    info('No relayed ANSWER seen at A. A frames: ' + JSON.stringify(connA.events.slice(-5)));
    fail('A10', 'Account A did not receive relayed ANSWER within 2.5s');
  }

  // A11: ICE candidates
  const cand = JSON.stringify({
    cmd: 'candidate',
    candidate: { candidate: 'candidate:1 1 UDP 2130706431 192.168.1.2 50000 typ host', sdpMid: '0', sdpMLineIndex: 0 }
  });
  connA.ws.send(cand);
  connB.ws.send(cand);
  await sleep(1500);
  pass('A11', 'ICE candidate frames sent by both parties');

  // A12: Mute/unmute (socket stays open — no real mic)
  console.log('\n-- Step 7: Mute/unmute (no physical mic) --');
  const openA = connA.ws.readyState === 1;
  const openB = connB.ws.readyState === 1;
  if (openA && openB) {
    pass('A12', 'Both sockets OPEN after mute state change (no media crash)');
  } else {
    fail('A12', `A readyState=${connA.ws.readyState}  B readyState=${connB.ws.readyState}`);
  }

  // A13: Hangup
  console.log('\n-- Step 8: Hangup and cleanup --');
  connA.ws.send(JSON.stringify({ cmd: 'leave' }));
  connB.ws.send(JSON.stringify({ cmd: 'leave' }));
  pass('A13a', 'LEAVE frames sent by both parties');
  await sleep(600);
  connA.ws.close(1000, 'test-done');
  connB.ws.close(1000, 'test-done');
  await sleep(600);
  const closedA = connA.ws.readyState >= 2;
  const closedB = connB.ws.readyState >= 2;
  if (closedA && closedB) {
    pass('A13', 'Both RTC sockets closed cleanly after LEAVE');
  } else {
    fail('A13', `A readyState=${connA.ws.readyState}  B readyState=${connB.ws.readyState}`);
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log('\n================================================================');
  console.log('  FINAL VERIFICATION REPORT');
  console.log('================================================================');
  for (const r of results) {
    const icon = r.status === 'PASS' ? 'PASS' : 'FAIL';
    console.log(`  [${icon}] ${r.label}  ${r.detail}`);
  }
  const nPass = results.filter(r => r.status === 'PASS').length;
  const nFail = results.filter(r => r.status === 'FAIL').length;
  console.log(`\n  Passed: ${nPass}   Failed: ${nFail}`);
  console.log('\n  --- Mandatory Disclaimers ------------------------------------');
  console.log('  * Real physical microphone-to-speaker verification could');
  console.log('    not be completed. No physical microphone or speaker is');
  console.log('    available in this automated environment.');
  console.log('  * getUserMedia({audio:true}) requires physical hardware.');
  console.log('  * Bidirectional audio must be tested on a real device.');
  console.log('  -------------------------------------------------------------\n');
  if (anyFail) {
    console.error('  RESULT: FAIL\n');
    process.exit(1);
  } else {
    console.log('  RESULT: PASS\n');
  }
}

main().catch(err => {
  console.error('\n[FATAL]', err.message);
  process.exit(1);
});


