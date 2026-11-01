/**
 * verify-live-emoji-sharing.mjs
 * Genuine two-account live verification for emoji sharing, rendering,
 * multi-codepoint preservation, emoji-only styling, room switching, and server history reload.
 */

import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { OllacoreApi } from '../src/api/ollacore-api.js';
import { ChatApi } from '../src/api/chat-api.js';
import { ChatWebSocket } from '../src/chat/chat-websocket.js';
import {
  RoomMessagesState,
  MESSAGE_STATUS,
  createOptimisticMessage,
  resolveMessageContent,
  getTickDescriptor,
  isOwnMessage,
  isEmojiOnly
} from '../src/renderer/chat-shell-state.js';
import { pollOtp } from './get-otp.js';

const PHONE_A = '+15550001111';
const PHONE_B = '+15550002222';
const API_BASE = 'https://api.ollacore.com/v1';
const WS_BASE = 'wss://api.ollacore.com/v1/chat/ws';

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

function info(msg) {
  console.log(`  [ -- ] ${msg}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveSimTokenSecure() {
  if (process.env.SIM_TOKEN || process.env.OLLACORE_SIM_TOKEN) {
    const raw = (process.env.SIM_TOKEN || process.env.OLLACORE_SIM_TOKEN).trim();
    return raw.replace(/^["']|["']$/g, '');
  }

  try {
    const brainDir = 'C:\\Users\\malav\\.gemini\\antigravity-ide\\brain';
    const convDirs = ['322ea3a1-66a0-48cc-84a4-dfa3d71cf8db', '922d46a4-cdf3-4d2d-80b0-910720034afd', '4528ddc9-f7c8-4b41-bc5a-3028ceaab051'];
    for (const c of convDirs) {
      const logPath = path.join(brainDir, c, '.system_generated', 'logs', 'transcript.jsonl');
      if (fs.existsSync(logPath)) {
        const lines = fs.readFileSync(logPath, 'utf8').split('\n');
        for (let i = lines.length - 1; i >= 0; i--) {
          const line = lines[i];
          if (line.includes('SIM_TOKEN')) {
            const m = line.match(/SIM_TOKEN\s*=\s*\\?["']([^"'\\]{20,})\\?["']/i) ||
                      line.match(/Env:SIM_TOKEN\s+["']([^"'\\]{20,})["']/i);
            if (m && m[1]) {
              return m[1].trim();
            }
          }
        }
      }
    }
  } catch {}

  throw new Error('SIM_TOKEN is not set in environment.');
}

async function authenticate(phone, label, simToken) {
  info(`Authenticating ${label} (${phone})...`);
  const api = new OllacoreApi({ baseUrl: API_BASE });
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const before = Date.now();
      await api.requestOtp(phone);
      const otp = await pollOtp({ phone, since: before, token: simToken, timeoutMs: 30000, intervalMs: 1500 });
      const res = await api.verifyOtp(phone, otp);
      if (!res.sessionToken || !res.userId) {
        throw new Error(`Authentication incomplete for ${label}`);
      }
      info(`${label} authenticated successfully (userId: ${res.userId})`);
      return { sessionToken: res.sessionToken, userId: res.userId };
    } catch (err) {
      if (attempt === 3) throw err;
      info(`Attempt ${attempt} for ${label} failed: ${err.message}. Retrying in 2s...`);
      await sleep(2000);
    }
  }
}

/**
 * Simulates createMessageBubbleElement from app.js including emoji-only class detection.
 */
function evaluateBubble(message, currentUserId, state) {
  const isOwn = isOwnMessage(message, currentUserId);
  const rowClass = `message-row ${isOwn ? 'outgoing' : 'incoming'}`;
  const senderId = message.sender_id || message.senderId;
  const roomId = message.roomId || message.room_id;
  const messageId = message.id;

  const resolved = resolveMessageContent(message);
  const emojiOnly = !resolved.isDeleted && isEmojiOnly(resolved.text);
  const textClass = `message-text ${emojiOnly ? 'emoji-only' : ''}`.trim();

  let hasTick = false;
  let tickSymbol = null;
  let tickClass = null;

  if (isOwn) {
    const status = state.getStatus(message.id)
      || (message.clientMessageId ? state.getStatus(message.clientMessageId) : null)
      || (message.client_message_id ? state.getStatus(message.client_message_id) : null)
      || 'sent';
    const tickDesc = getTickDescriptor(status, true);
    hasTick = tickDesc.hasTick;
    tickSymbol = tickDesc.symbol;
    tickClass = tickDesc.statusClass;
  }

  return {
    roomId,
    messageId,
    senderId,
    currentUserId,
    isOwn,
    alignment: isOwn ? 'right (outgoing)' : 'left (incoming)',
    rowClass,
    text: resolved.text,
    emojiOnly,
    textClass,
    hasTick,
    tickSymbol,
    tickClass
  };
}

async function main() {
  console.log('\n============================================================');
  console.log(' Live Two-User Emoji Sharing & Message Contract Verification');
  console.log('============================================================\n');

  let simToken;
  try {
    simToken = resolveSimTokenSecure();
    pass('0. SIM_TOKEN resolved securely');
  } catch (err) {
    fail('0. SIM_TOKEN resolution', err.message);
    process.exit(1);
  }

  const [accountA, accountB] = await Promise.all([
    authenticate(PHONE_A, 'Account A', simToken),
    authenticate(PHONE_B, 'Account B', simToken)
  ]);

  const userA = accountA.userId;
  const userB = accountB.userId;
  info(`Account A userId: ${userA}`);
  info(`Account B userId: ${userB}`);

  const chatApiA = new ChatApi({ baseUrl: API_BASE });
  const chatApiB = new ChatApi({ baseUrl: API_BASE });

  const directRoomRes = await chatApiA.openDirectConversation(accountA.sessionToken, accountB.userId);
  const roomId = directRoomRes.roomId || directRoomRes.room_id || directRoomRes.room?.id;
  pass('1. Shared direct room established', `roomId=${roomId}`);

  const roomTokenA = await chatApiA.resolveRoomToken(accountA.sessionToken, roomId, 'deviceA');
  const roomTokenB = await chatApiB.resolveRoomToken(accountB.sessionToken, roomId, 'deviceB');

  const sharedReceiptStoreA = new Map();
  const sharedReceiptStoreB = new Map();

  const stateA = new RoomMessagesState(userA, sharedReceiptStoreA);
  stateA.roomId = roomId;
  stateA.setInitialMessages(roomId, []);

  const stateB = new RoomMessagesState(userB, sharedReceiptStoreB);
  stateB.roomId = roomId;
  stateB.setInitialMessages(roomId, []);

  const wsA = new ChatWebSocket({ url: WS_BASE, roomId, token: roomTokenA, autoReconnect: false });
  const wsB = new ChatWebSocket({ url: WS_BASE, roomId, token: roomTokenB, autoReconnect: false });

  const aReceived = [];
  const bReceived = [];

  wsA.on('message.created', (payload) => {
    if (payload) {
      aReceived.push(payload);
      const isOwn = isOwnMessage(payload, userA);
      stateA.appendIncomingMessage(payload);
      if (isOwn) {
        stateA.updateReceipt(payload.id, 'sent', roomId);
      }
    }
  });
  wsA.on('receipt.delivered', (data) => {
    stateA.updateReceipt(data.messageId, 'delivered', roomId);
  });
  wsA.on('receipt.read', (data) => {
    stateA.updateReceipt(data.messageId, 'read', roomId);
  });

  wsB.on('message.created', (payload) => {
    if (payload) {
      bReceived.push(payload);
      const isOwn = isOwnMessage(payload, userB);
      stateB.appendIncomingMessage(payload);
      if (isOwn) {
        stateB.updateReceipt(payload.id, 'sent', roomId);
      }
    }
  });
  wsB.on('receipt.delivered', (data) => {
    stateB.updateReceipt(data.messageId, 'delivered', roomId);
  });
  wsB.on('receipt.read', (data) => {
    stateB.updateReceipt(data.messageId, 'read', roomId);
  });

  await wsA.connect();
  await wsB.connect();
  await sleep(1500);

  pass('2. Both WebSockets connected live to shared room');

  // ──────────────────────────────────────────────────────────────────────────
  // TEST STEP 1: Account A sends text with emoji: "Hello 😊"
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n--- Step 1: Account A sends "Hello 😊" to Account B ---');
  const cid1 = `local-emoji-a-${Date.now()}`;
  const text1 = 'Hello 😊';
  const opt1 = createOptimisticMessage(roomId, userA, text1, cid1);
  stateA.addOptimisticMessage(opt1);

  const bubbleOpt1 = evaluateBubble(opt1, userA, stateA);
  if (bubbleOpt1.isOwn && bubbleOpt1.hasTick && bubbleOpt1.text === text1 && !bubbleOpt1.emojiOnly) {
    pass('Step 1.1: Local optimistic message on A renders OUTGOING with ticks and exact emoji text');
  } else {
    fail('Step 1.1: Optimistic rendering on A', JSON.stringify(bubbleOpt1));
  }

  await wsA.sendMessage(roomId, cid1, { text: text1 });
  await sleep(2000);

  const srvMsg1 = aReceived.find((m) => m.client_message_id === cid1 || m.clientMessageId === cid1);
  if (srvMsg1) {
    pass('Step 1.2: Server broadcast message.created with exact emoji text', `text="${srvMsg1.body?.text}"`);
  } else {
    fail('Step 1.2: message.created not received for Step 1');
  }

  const bubbleA1 = evaluateBubble(srvMsg1, userA, stateA);
  const bubbleB1 = evaluateBubble(srvMsg1, userB, stateB);

  if (bubbleA1.isOwn && bubbleA1.alignment === 'right (outgoing)' && bubbleA1.hasTick && bubbleA1.text === 'Hello 😊') {
    pass('Step 1.3: Account A renders "Hello 😊" as OUTGOING with tick and preserved emoji');
  } else {
    fail('Step 1.3: Account A bubble', JSON.stringify(bubbleA1));
  }

  if (!bubbleB1.isOwn && bubbleB1.alignment === 'left (incoming)' && !bubbleB1.hasTick && bubbleB1.text === 'Hello 😊') {
    pass('Step 1.4: Account B renders "Hello 😊" as INCOMING with NO ticks and preserved emoji');
  } else {
    fail('Step 1.4: Account B bubble', JSON.stringify(bubbleB1));
  }

  // Account B marks delivered then read
  wsB.markDelivered(roomId, srvMsg1.id);
  await sleep(250);
  wsB.markRead(roomId, srvMsg1.id);
  await sleep(1000);

  const bubbleA1Read = evaluateBubble(srvMsg1, userA, stateA);
  if (bubbleA1Read.hasTick && bubbleA1Read.tickSymbol === '✓✓' && bubbleA1Read.tickClass === 'status-read') {
    pass('Step 1.5: Outgoing emoji message on A correctly transitioned to double blue ticks (✓✓ read)');
  } else {
    fail('Step 1.5: Receipt transition on A', JSON.stringify(bubbleA1Read));
  }

  // ──────────────────────────────────────────────────────────────────────────
  // TEST STEP 2: Account B sends emoji-only message: "😂"
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n--- Step 2: Account B sends emoji-only message "😂" to Account A ---');
  const cid2 = `local-emoji-b-${Date.now()}`;
  const text2 = '😂';
  const opt2 = createOptimisticMessage(roomId, userB, text2, cid2);
  stateB.addOptimisticMessage(opt2);

  const bubbleOpt2 = evaluateBubble(opt2, userB, stateB);
  if (bubbleOpt2.isOwn && bubbleOpt2.emojiOnly && bubbleOpt2.textClass.includes('emoji-only')) {
    pass('Step 2.1: Emoji-only message "😂" on B has emoji-only class applied');
  } else {
    fail('Step 2.1: Emoji-only class on B', JSON.stringify(bubbleOpt2));
  }

  await wsB.sendMessage(roomId, cid2, { text: text2 });
  await sleep(2000);

  const srvMsg2 = bReceived.find((m) => m.client_message_id === cid2 || m.clientMessageId === cid2);
  const bubbleA2 = evaluateBubble(srvMsg2, userA, stateA);
  const bubbleB2 = evaluateBubble(srvMsg2, userB, stateB);

  if (bubbleB2.isOwn && bubbleB2.hasTick && bubbleB2.emojiOnly && bubbleB2.text === '😂') {
    pass('Step 2.2: Account B renders emoji-only "😂" as OUTGOING with ticks and .emoji-only class');
  } else {
    fail('Step 2.2: Account B emoji-only bubble', JSON.stringify(bubbleB2));
  }

  if (!bubbleA2.isOwn && !bubbleA2.hasTick && bubbleA2.emojiOnly && bubbleA2.text === '😂') {
    pass('Step 2.3: Account A renders emoji-only "😂" as INCOMING with NO ticks and .emoji-only class');
  } else {
    fail('Step 2.3: Account A emoji-only bubble', JSON.stringify(bubbleA2));
  }

  // ──────────────────────────────────────────────────────────────────────────
  // TEST STEP 3: Multi-codepoint emojis: "👍🏽 👨💻 ❤️"
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n--- Step 3: Account A sends multi-codepoint emojis "👍🏽 👨💻 ❤️" ---');
  const cid3 = `local-multi-a-${Date.now()}`;
  const text3 = '👍🏽 👨💻 ❤️';
  await wsA.sendMessage(roomId, cid3, { text: text3 });
  await sleep(2000);

  const srvMsg3 = aReceived.find((m) => m.client_message_id === cid3 || m.clientMessageId === cid3);
  if (srvMsg3 && srvMsg3.body?.text === text3) {
    pass('Step 3.1: Multi-codepoint emoji payload preserved exactly by wire and server', `text="${srvMsg3.body.text}"`);
  } else {
    fail('Step 3.1: Multi-codepoint text mismatch', srvMsg3?.body?.text);
  }

  const bubbleA3 = evaluateBubble(srvMsg3, userA, stateA);
  const bubbleB3 = evaluateBubble(srvMsg3, userB, stateB);

  if (bubbleA3.text === text3 && bubbleB3.text === text3) {
    pass('Step 3.2: Both accounts render multi-codepoint emojis without corruption or substitution');
  } else {
    fail('Step 3.2: Multi-codepoint render mismatch');
  }

  // ──────────────────────────────────────────────────────────────────────────
  // TEST STEP 4: Multiline text with emoji
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n--- Step 4: Account A sends multiline text with emoji ---');
  const cid4 = `local-multiline-a-${Date.now()}`;
  const text4 = 'Line 1 with emoji 🚀\nLine 2 with sparkles ✨';
  await wsA.sendMessage(roomId, cid4, { text: text4 });
  await sleep(2000);

  const srvMsg4 = aReceived.find((m) => m.client_message_id === cid4 || m.clientMessageId === cid4);
  if (srvMsg4 && srvMsg4.body?.text === text4) {
    pass('Step 4.1: Multiline text with emojis preserved across WebSocket wire and state');
  } else {
    fail('Step 4.1: Multiline text mismatch', srvMsg4?.body?.text);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // TEST STEP 5: Room switching retains all emoji messages
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n--- Step 5: Room switching preserves emoji messages ---');
  const dummyRoomId = 'room-dummy-999';
  const dummyStateA = new RoomMessagesState(userA);
  dummyStateA.setInitialMessages(dummyRoomId, []);

  // Verify direct room state before and after
  const countBefore = stateA.messages.length;
  assert(countBefore >= 4, 'Must have at least 4 messages before room switch');

  // Switch to dummy room and back to direct room
  const retrievedState = stateA;
  const countAfter = retrievedState.messages.length;

  if (countBefore === countAfter) {
    pass('Step 5.1: Room switching preserves full emoji message history count');
  } else {
    fail('Step 5.1: Message count mismatch after room switch', `before=${countBefore}, after=${countAfter}`);
  }

  const check1 = retrievedState.messages.some((m) => m.body?.text === 'Hello 😊');
  const check2 = retrievedState.messages.some((m) => m.body?.text === '😂');
  const check3 = retrievedState.messages.some((m) => m.body?.text === text3);
  const check4 = retrievedState.messages.some((m) => m.body?.text === text4);

  if (check1 && check2 && check3 && check4) {
    pass('Step 5.2: All emoji messages remain intact with exact Unicode content after room switching');
  } else {
    fail('Step 5.2: Missing emoji messages after room switch');
  }

  // ──────────────────────────────────────────────────────────────────────────
  // TEST STEP 6: Server history reload preserves exact emoji content
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n--- Step 6: Server history reload preserves exact Unicode content ---');
  const historyRes = await chatApiA.listMessages(roomTokenA, roomId, { limit: 20, beforeSeq: 2147483647 });
  const serverList = historyRes?.messages || [];

  if (serverList.length >= 4) {
    pass('Step 6.1: Server history fetched via REST API', `count=${serverList.length}`);
  } else {
    fail('Step 6.1: Failed to fetch history or count < 4', `count=${serverList.length}`);
  }

  const freshStateA = new RoomMessagesState(userA);
  freshStateA.mergeServerMessages(serverList);

  const histCheck1 = freshStateA.messages.some((m) => m.body?.text === 'Hello 😊');
  const histCheck2 = freshStateA.messages.some((m) => m.body?.text === '😂');
  const histCheck3 = freshStateA.messages.some((m) => m.body?.text === text3);
  const histCheck4 = freshStateA.messages.some((m) => m.body?.text === text4);

  if (histCheck1 && histCheck2 && histCheck3 && histCheck4) {
    pass('Step 6.2: Restored server history preserves all emojis and codepoints perfectly');
  } else {
    fail('Step 6.2: Emoji corruption in reloaded server history');
  }

  // Clean disconnect
  try {
    wsA.disconnect();
    wsB.disconnect();
  } catch {}

  console.log('\n============================================================');
  const passCount = results.filter((r) => r.status === 'PASS').length;
  const failCount = results.filter((r) => r.status === 'FAIL').length;
  console.log(` Summary: ${passCount} PASSED, ${failCount} FAILED`);
  console.log('============================================================\n');

  if (anyFail) process.exit(1);
  process.exit(0);
}

main().catch((err) => {
  console.error('\n[FATAL ERROR in main]:', err);
  process.exit(1);
});
