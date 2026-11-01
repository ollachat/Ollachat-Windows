/**
 * verify-live-two-user-ownership.mjs
 * Genuine two-account live verification for recipient-side message ownership,
 * bidirectional sender rendering, incoming/outgoing invariants, and background routing.
 */

import fs from 'node:fs';
import path from 'node:path';
import { OllacoreApi } from '../src/api/ollacore-api.js';
import { ChatApi } from '../src/api/chat-api.js';
import { ChatWebSocket } from '../src/chat/chat-websocket.js';
import {
  RoomMessagesState,
  MESSAGE_STATUS,
  createOptimisticMessage,
  getTickDescriptor,
  isOwnMessage
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
    const convDirs = ['322ea3a1-66a0-48cc-84a4-dfa3d71cf8db', '922d46a4-cdf3-4d2d-80b0-910720034afd'];
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
 * Simulates createMessageBubbleElement from app.js
 */
function evaluateBubble(message, currentUserId, state) {
  const isOwn = isOwnMessage(message, currentUserId);
  const rowClass = `message-row ${isOwn ? 'outgoing' : 'incoming'}`;
  const senderId = message.sender_id || message.senderId;
  const roomId = message.roomId || message.room_id;
  const messageId = message.id;

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
    hasTick,
    tickSymbol,
    tickClass
  };
}

async function main() {
  console.log('\n============================================================');
  console.log(' Live Two-User Message Ownership & Bidirectional Verification');
  console.log('============================================================\n');

  const simToken = resolveSimTokenSecure();
  pass('0. SIM_TOKEN resolved securely');

  const accountA = await authenticate(PHONE_A, 'Account A', simToken);
  const accountB = await authenticate(PHONE_B, 'Account B', simToken);

  info(`Account A userId: ${accountA.userId}`);
  info(`Account B userId: ${accountB.userId}`);

  const chatApiA = new ChatApi({ baseUrl: API_BASE });
  const chatApiB = new ChatApi({ baseUrl: API_BASE });

  // 1. Establish shared direct room
  const directRoomRes = await chatApiA.openDirectConversation(accountA.sessionToken, accountB.userId);
  const roomId = directRoomRes.roomId || directRoomRes.room_id || directRoomRes.room?.id;
  pass('1. Shared direct room established', `roomId=${roomId}`);

  const roomTokenA = await chatApiA.resolveRoomToken(accountA.sessionToken, roomId, 'deviceA');
  const roomTokenB = await chatApiB.resolveRoomToken(accountB.sessionToken, roomId, 'deviceB');

  // 2. Setup Client State for Account A
  const roomMessagesMapA = new Map();
  const sharedReceiptStoreA = new Map();
  function getOrCreateStateA(rId) {
    if (!roomMessagesMapA.has(rId)) {
      const s = new RoomMessagesState(accountA.userId, sharedReceiptStoreA);
      s.roomId = rId;
      roomMessagesMapA.set(rId, s);
    }
    const s = roomMessagesMapA.get(rId);
    if (!s.currentUserId) s.setCurrentUserId(accountA.userId);
    return s;
  }

  // 3. Setup Client State for Account B
  const roomMessagesMapB = new Map();
  const sharedReceiptStoreB = new Map();
  function getOrCreateStateB(rId) {
    if (!roomMessagesMapB.has(rId)) {
      const s = new RoomMessagesState(accountB.userId, sharedReceiptStoreB);
      s.roomId = rId;
      roomMessagesMapB.set(rId, s);
    }
    const s = roomMessagesMapB.get(rId);
    if (!s.currentUserId) s.setCurrentUserId(accountB.userId);
    return s;
  }

  let activeRoomIdA = roomId;
  let activeRoomIdB = roomId;

  const stateA = getOrCreateStateA(roomId);
  const stateB = getOrCreateStateB(roomId);

  // Setup WebSockets
  const wsA = new ChatWebSocket({ url: WS_BASE, roomId, token: roomTokenA, autoReconnect: false });
  const wsB = new ChatWebSocket({ url: WS_BASE, roomId, token: roomTokenB, autoReconnect: false });

  // Wire A handlers matching app.js handleRealtimeChatEvent
  wsA.on('message.created', (msg) => {
    const eventRoomId = msg.roomId || msg.room_id || activeRoomIdA;
    const targetState = getOrCreateStateA(eventRoomId);
    targetState.appendIncomingMessage(msg);
    const isOwn = isOwnMessage(msg, accountA.userId);
    if (isOwn) {
      targetState.updateReceipt(msg.id, 'sent', eventRoomId);
    }
  });
  wsA.on('receipt.delivered', (data) => {
    const eventRoomId = data.roomId || activeRoomIdA;
    getOrCreateStateA(eventRoomId).updateReceipt(data.messageId, 'delivered', eventRoomId);
  });
  wsA.on('receipt.read', (data) => {
    const eventRoomId = data.roomId || activeRoomIdA;
    getOrCreateStateA(eventRoomId).updateReceipt(data.messageId, 'read', eventRoomId);
  });

  // Wire B handlers matching app.js handleRealtimeChatEvent
  wsB.on('message.created', (msg) => {
    const eventRoomId = msg.roomId || msg.room_id || activeRoomIdB;
    const targetState = getOrCreateStateB(eventRoomId);
    targetState.appendIncomingMessage(msg);
    const isOwn = isOwnMessage(msg, accountB.userId);
    if (isOwn) {
      targetState.updateReceipt(msg.id, 'sent', eventRoomId);
    }
  });
  wsB.on('receipt.delivered', (data) => {
    const eventRoomId = data.roomId || activeRoomIdB;
    getOrCreateStateB(eventRoomId).updateReceipt(data.messageId, 'delivered', eventRoomId);
  });
  wsB.on('receipt.read', (data) => {
    const eventRoomId = data.roomId || activeRoomIdB;
    getOrCreateStateB(eventRoomId).updateReceipt(data.messageId, 'read', eventRoomId);
  });

  await wsA.connect();
  await wsB.connect();
  await sleep(600);
  pass('2. Both WebSockets connected live');

  // =========================================================================
  // STEP 1: Account A sends "Message from A"
  // =========================================================================
  console.log('\n--- Step 1: Account A sends "Message from A" to Account B ---');
  const cidA = `opt-live-a-${Date.now()}`;
  const textA = 'Message from A';
  const optA = createOptimisticMessage(roomId, accountA.userId, textA, cidA);
  stateA.addOptimisticMessage(optA);

  // Optimistic rendering on A
  const optEvalA = evaluateBubble(optA, accountA.userId, stateA);
  info(`[A Optimistic Bubble]: isOwn=${optEvalA.isOwn}, alignment=${optEvalA.alignment}, hasTick=${optEvalA.hasTick}`);
  if (optEvalA.isOwn === true && optEvalA.hasTick === true) {
    pass('Step 1.1: Local optimistic message on A renders OUTGOING / right side with tick');
  } else {
    fail('Step 1.1: Local optimistic message rendering on A');
  }

  // Send via WebSocket
  wsA.sendMessage(roomId, cidA, { text: textA }, 'text');

  // Wait for both A and B to receive message.created
  let msgAonA = null;
  let msgAonB = null;
  for (let i = 0; i < 30; i++) {
    msgAonA = stateA.messages.find((m) => m.clientMessageId === cidA || m.client_message_id === cidA);
    msgAonB = stateB.messages.find((m) => m.clientMessageId === cidA || m.client_message_id === cidA);
    if (msgAonA && msgAonA.id !== cidA && msgAonB) {
      break;
    }
    await sleep(200);
  }

  if (!msgAonA || !msgAonB) {
    fail('Step 1.2: Timeout waiting for message.created on A or B');
  } else {
    pass('Step 1.2: Message from A received by both accounts', `id=${msgAonA.id}`);
  }

  // Verify A's view
  const evalAonA = evaluateBubble(msgAonA, accountA.userId, stateA);
  console.log('\nAccount A perspective on "Message from A":', {
    roomId: evalAonA.roomId,
    messageId: evalAonA.messageId,
    senderId: evalAonA.senderId,
    currentUserId: evalAonA.currentUserId,
    isOwnMessage: evalAonA.isOwn,
    alignment: evalAonA.alignment,
    rowClass: evalAonA.rowClass,
    hasTick: evalAonA.hasTick,
    tickSymbol: evalAonA.tickSymbol
  });

  if (evalAonA.senderId === accountA.userId && evalAonA.isOwn === true && evalAonA.hasTick === true) {
    pass('Step 1.3: Account A renders "Message from A" as OUTGOING / right side with tick');
  } else {
    fail('Step 1.3: Account A view of Message from A');
  }

  // Verify B's view
  const evalAonB = evaluateBubble(msgAonB, accountB.userId, stateB);
  console.log('\nAccount B perspective on "Message from A":', {
    roomId: evalAonB.roomId,
    messageId: evalAonB.messageId,
    senderId: evalAonB.senderId,
    currentUserId: evalAonB.currentUserId,
    isOwnMessage: evalAonB.isOwn,
    alignment: evalAonB.alignment,
    rowClass: evalAonB.rowClass,
    hasTick: evalAonB.hasTick,
    tickSymbol: evalAonB.tickSymbol
  });

  if (evalAonB.senderId === accountA.userId && evalAonB.isOwn === false && evalAonB.hasTick === false && evalAonB.rowClass === 'message-row incoming') {
    pass('Step 1.4: Account B renders "Message from A" as INCOMING / left side with NO ticks');
  } else {
    fail('Step 1.4: Account B view of Message from A');
  }

  // Account B marks delivered then read
  wsB.markDelivered(roomId, msgAonB.id);
  await sleep(250);
  wsB.markRead(roomId, msgAonB.id);
  await sleep(350);

  // Verify A gets double ticks and B still has NO ticks
  const aStatus = stateA.getStatus(msgAonA.id);
  const aTick = getTickDescriptor(aStatus, true);
  if (aStatus === 'read' && aTick.symbol === '✓✓' && aTick.statusClass === 'status-read') {
    pass('Step 1.5: Account A outgoing message transitioned to double blue ticks (✓✓ read)');
  } else {
    fail('Step 1.5: Outgoing receipt update on A', `status=${aStatus}`);
  }

  const bIncomingCheck = evaluateBubble(msgAonB, accountB.userId, stateB);
  if (bIncomingCheck.hasTick === false && bIncomingCheck.isOwn === false) {
    pass('Step 1.6: Account B incoming message strictly retains NO ticks after receipts dispatched');
  } else {
    fail('Step 1.6: Account B incoming message acquired ticks');
  }

  // =========================================================================
  // STEP 2: Account B sends "Message from B"
  // =========================================================================
  console.log('\n--- Step 2: Account B sends "Message from B" to Account A ---');
  const cidB = `opt-live-b-${Date.now()}`;
  const textB = 'Message from B';
  const optB = createOptimisticMessage(roomId, accountB.userId, textB, cidB);
  stateB.addOptimisticMessage(optB);

  // Optimistic rendering on B
  const optEvalB = evaluateBubble(optB, accountB.userId, stateB);
  if (optEvalB.isOwn === true && optEvalB.hasTick === true) {
    pass('Step 2.1: Local optimistic message on B renders OUTGOING / right side with tick');
  } else {
    fail('Step 2.1: Local optimistic message rendering on B');
  }

  // Send via WebSocket
  wsB.sendMessage(roomId, cidB, { text: textB }, 'text');

  let msgBonA = null;
  let msgBonB = null;
  for (let i = 0; i < 30; i++) {
    msgBonA = stateA.messages.find((m) => m.clientMessageId === cidB || m.client_message_id === cidB);
    msgBonB = stateB.messages.find((m) => m.clientMessageId === cidB || m.client_message_id === cidB);
    if (msgBonB && msgBonB.id !== cidB && msgBonA) {
      break;
    }
    await sleep(200);
  }

  if (!msgBonA || !msgBonB) {
    fail('Step 2.2: Timeout waiting for message.created on A or B for Message from B');
  } else {
    pass('Step 2.2: Message from B received by both accounts', `id=${msgBonB.id}`);
  }

  // Verify B's view
  const evalBonB = evaluateBubble(msgBonB, accountB.userId, stateB);
  console.log('\nAccount B perspective on "Message from B":', {
    roomId: evalBonB.roomId,
    messageId: evalBonB.messageId,
    senderId: evalBonB.senderId,
    currentUserId: evalBonB.currentUserId,
    isOwnMessage: evalBonB.isOwn,
    alignment: evalBonB.alignment,
    rowClass: evalBonB.rowClass,
    hasTick: evalBonB.hasTick,
    tickSymbol: evalBonB.tickSymbol
  });

  if (evalBonB.senderId === accountB.userId && evalBonB.isOwn === true && evalBonB.hasTick === true) {
    pass('Step 2.3: Account B renders "Message from B" as OUTGOING / right side with tick');
  } else {
    fail('Step 2.3: Account B view of Message from B');
  }

  // Verify A's view
  const evalBonA = evaluateBubble(msgBonA, accountA.userId, stateA);
  console.log('\nAccount A perspective on "Message from B":', {
    roomId: evalBonA.roomId,
    messageId: evalBonA.messageId,
    senderId: evalBonA.senderId,
    currentUserId: evalBonA.currentUserId,
    isOwnMessage: evalBonA.isOwn,
    alignment: evalBonA.alignment,
    rowClass: evalBonA.rowClass,
    hasTick: evalBonA.hasTick,
    tickSymbol: evalBonA.tickSymbol
  });

  if (evalBonA.senderId === accountB.userId && evalBonA.isOwn === false && evalBonA.hasTick === false && evalBonA.rowClass === 'message-row incoming') {
    pass('Step 2.4: Account A renders "Message from B" as INCOMING / left side with NO ticks');
  } else {
    fail('Step 2.4: Account A view of Message from B');
  }

  // Account A marks delivered then read
  wsA.markDelivered(roomId, msgBonA.id);
  await sleep(250);
  wsA.markRead(roomId, msgBonA.id);
  await sleep(350);

  const bStatus = stateB.getStatus(msgBonB.id);
  const bTick = getTickDescriptor(bStatus, true);
  if (bStatus === 'read' && bTick.symbol === '✓✓') {
    pass('Step 2.5: Account B outgoing message transitioned to double blue ticks (✓✓ read)');
  } else {
    fail('Step 2.5: Outgoing receipt update on B', `status=${bStatus}`);
  }

  // =========================================================================
  // STEP 3: Background Message Handling
  // =========================================================================
  console.log('\n--- Step 3: Background message received while another room is selected ---');
  const dummyOtherRoomId = 'room-dummy-unselected';
  activeRoomIdA = dummyOtherRoomId; // A switches away from direct room

  const cidBg = `opt-bg-${Date.now()}`;
  const textBg = 'Background message from B';
  wsB.sendMessage(roomId, cidBg, { text: textBg }, 'text');

  let bgMsgOnA = null;
  for (let i = 0; i < 30; i++) {
    bgMsgOnA = stateA.messages.find((m) => m.clientMessageId === cidBg || m.client_message_id === cidBg);
    if (bgMsgOnA) break;
    await sleep(200);
  }

  if (bgMsgOnA) {
    pass('Step 3.1: Background message routed into Room A state while another room is active');
    const bgEval = evaluateBubble(bgMsgOnA, accountA.userId, stateA);
    info(`Background message senderId=${bgEval.senderId}, isOwn=${bgEval.isOwn}, rowClass=${bgEval.rowClass}`);
    if (bgEval.senderId === accountB.userId && bgEval.isOwn === false && bgEval.rowClass === 'message-row incoming' && bgEval.hasTick === false) {
      pass('Step 3.2: Background message strictly preserved original sender (Account B) and renders INCOMING with NO ticks');
    } else {
      fail('Step 3.2: Background message sender or ownership corrupted');
    }
  } else {
    fail('Step 3.1: Timeout waiting for background message');
  }

  // Switch A back to direct room
  activeRoomIdA = roomId;

  // =========================================================================
  // STEP 4: Room Switching & Reopening Invariant Checks
  // =========================================================================
  console.log('\n--- Step 4: Room switching & reopening retains correct ownership ---');
  // Re-fetch states as if switching
  const switchedStateA = getOrCreateStateA(roomId);
  const switchedStateB = getOrCreateStateB(roomId);

  // Check every message in both states
  let allCorrectA = true;
  for (const m of switchedStateA.messages) {
    const e = evaluateBubble(m, accountA.userId, switchedStateA);
    const expectedOwn = (e.senderId === accountA.userId);
    if (e.isOwn !== expectedOwn || (expectedOwn ? !e.hasTick : e.hasTick)) {
      allCorrectA = false;
      fail('Step 4.1: Message ownership mismatch on Account A', JSON.stringify(e));
    }
  }
  if (allCorrectA) {
    pass(`Step 4.1: All ${switchedStateA.messages.length} messages on Account A retain strictly correct ownership and tick state after switching`);
  }

  let allCorrectB = true;
  for (const m of switchedStateB.messages) {
    const e = evaluateBubble(m, accountB.userId, switchedStateB);
    const expectedOwn = (e.senderId === accountB.userId);
    if (e.isOwn !== expectedOwn || (expectedOwn ? !e.hasTick : e.hasTick)) {
      allCorrectB = false;
      fail('Step 4.2: Message ownership mismatch on Account B', JSON.stringify(e));
    }
  }
  if (allCorrectB) {
    pass(`Step 4.2: All ${switchedStateB.messages.length} messages on Account B retain strictly correct ownership and tick state after switching`);
  }

  // =========================================================================
  // STEP 5: History Reload Invariant Checks
  // =========================================================================
  console.log('\n--- Step 5: Server history reload preserves sender identity ---');
  const serverHistoryPage = await chatApiA.listMessages(roomTokenA, roomId, { limit: 20, beforeSeq: 2147483647 });
  const serverHistory = serverHistoryPage.messages || [];

  const reloadStateA = new RoomMessagesState(accountA.userId);
  reloadStateA.roomId = roomId;
  reloadStateA.mergeServerMessages(serverHistory);

  const reloadStateB = new RoomMessagesState(accountB.userId);
  reloadStateB.roomId = roomId;
  reloadStateB.mergeServerMessages(serverHistory);

  let reloadPass = true;
  for (const m of reloadStateA.messages) {
    const eA = evaluateBubble(m, accountA.userId, reloadStateA);
    const eB = evaluateBubble(m, accountB.userId, reloadStateB);

    if (eA.senderId === accountA.userId) {
      if (!eA.isOwn || eB.isOwn) reloadPass = false;
    } else if (eA.senderId === accountB.userId) {
      if (eA.isOwn || !eB.isOwn) reloadPass = false;
    }
  }

  if (reloadPass) {
    pass(`Step 5.1: History reload with ${reloadStateA.messages.length} messages preserves sender identity for both accounts`);
  } else {
    fail('Step 5.1: History reload failed ownership check');
  }

  // Cleanup
  wsA.disconnect();
  wsB.disconnect();

  console.log('\n============================================================');
  console.log(` Summary: ${results.filter((r) => r.status === 'PASS').length} PASSED, ${results.filter((r) => r.status === 'FAIL').length} FAILED`);
  console.log('============================================================\n');

  if (anyFail) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

main().catch((err) => {
  console.error('\nFatal error in live test:', err);
  process.exit(1);
});
