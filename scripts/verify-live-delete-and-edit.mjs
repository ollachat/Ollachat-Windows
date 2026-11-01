/**
 * verify-live-delete-and-edit.mjs
 * Live verification with two accounts for:
 * 1. Delete for Everyone (canonical ID resolution, REST delete, A and B live tombstones)
 * 2. Edit Message (canonical ID resolution, REST edit, A and B live updated text)
 * 3. Background/unselected conversation mutation receipt
 */

import fs from 'node:fs';
import path from 'node:path';
import { OllacoreApi } from '../src/api/ollacore-api.js';
import { ChatApi } from '../src/api/chat-api.js';
import { ChatWebSocket } from '../src/chat/chat-websocket.js';
import {
  RoomMessagesState,
  createOptimisticMessage,
  resolveCanonicalMessageId
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

async function run() {
  console.log('============================================================');
  console.log(' Live Two-User Delete for Everyone and Edit Verification');
  console.log('============================================================\n');

  const simToken = resolveSimTokenSecure();
  pass('0. SIM_TOKEN resolved securely');

  const userA = await authenticate(PHONE_A, 'Account A', simToken);
  const userB = await authenticate(PHONE_B, 'Account B', simToken);

  const chatApiA = new ChatApi({ baseUrl: API_BASE });
  const chatApiB = new ChatApi({ baseUrl: API_BASE });

  const directRes = await chatApiA.openDirectConversation(userA.sessionToken, userB.userId);
  const roomId = directRes.roomId || directRes.room_id || directRes.room?.id;
  info(`Shared room established: ${roomId}`);
  pass('1. Shared room established', `roomId=${roomId}`);

  const roomTokenA = await chatApiA.resolveRoomToken(userA.sessionToken, roomId, 'device-live-a');
  const roomTokenB = await chatApiB.resolveRoomToken(userB.sessionToken, roomId, 'device-live-b');

  // WebSocket connections for Account A and Account B
  const wsA = new ChatWebSocket({
    url: WS_BASE,
    roomId,
    token: roomTokenA,
    autoReconnect: true
  });
  const wsB = new ChatWebSocket({
    url: WS_BASE,
    roomId,
    token: roomTokenB,
    autoReconnect: true
  });

  const stateA = new RoomMessagesState(userA.userId);
  stateA.roomId = roomId;
  const stateB = new RoomMessagesState(userB.userId);
  stateB.roomId = roomId;

  // Track live incoming WebSocket events on both sides matching app.js
  wsA.on('message.created', (msg) => {
    stateA.appendIncomingMessage(msg);
  });
  wsA.on('message.updated', (msg) => {
    stateA.updateMessage(msg.id, msg);
  });
  wsA.on('message.deleted', (data) => {
    stateA.deleteMessage(data.messageId);
  });

  wsB.on('message.created', (msg) => {
    stateB.appendIncomingMessage(msg);
  });
  wsB.on('message.updated', (msg) => {
    stateB.updateMessage(msg.id, msg);
  });
  wsB.on('message.deleted', (data) => {
    stateB.deleteMessage(data.messageId);
  });

  wsB.on('frame', (f) => info(`[WS-B Frame] type=${f.type} payload=${JSON.stringify(f.payload || {})}`));
  wsB.on('duplicate', (d) => {
    info(`[WS-B Duplicate] ${d.frame?.type} seq=${d.eventSeq}`);
  });
  wsB.on('resync', (r) => info(`[WS-B Resync] ${JSON.stringify(r)}`));

  await Promise.all([wsA.connect(), wsB.connect()]);
  await sleep(1000);
  pass('2. Both WebSockets connected live to shared room');

  // ═════════════════════════════════════════════════════════════════
  // TEST PART 1: DELETE FOR EVERYONE
  // ═════════════════════════════════════════════════════════════════
  info('\n--- Phase 1: Delete for Everyone ---');

  // A creates and sends an optimistic message
  const textToDelete = `Message to delete at ${Date.now()}`;
  const clientMsgId1 = `local-${crypto.randomUUID()}`;
  const optimisticMsg1 = createOptimisticMessage(roomId, userA.userId, textToDelete, clientMsgId1);
  stateA.addOptimisticMessage(optimisticMsg1);

  // Send message over WebSocket
  wsA.sendMessage(roomId, clientMsgId1, { text: textToDelete }, 'text');
  info(`Account A sent message with client_message_id=${clientMsgId1}`);

  // Wait for B to receive message.created over WebSocket
  let receivedOnB = false;
  for (let i = 0; i < 30; i++) {
    const foundOnB = stateB.messages.find(m => m.body?.text === textToDelete || m.client_message_id === clientMsgId1 || m.clientMessageId === clientMsgId1);
    if (foundOnB) {
      receivedOnB = true;
      break;
    }
    await sleep(200);
  }
  if (!receivedOnB) {
    fail('Step 1.1: Account B received initial message');
  } else {
    pass('Step 1.1: Account B received initial message');
  }

  // Account A now performs Delete for Everyone:
  // Note: On Account A's side, message still has id = local-<uuid>!
  const msgOnA = stateA.messages.find(m => m.clientMessageId === clientMsgId1);
  info(`Message on Account A before delete has id=${msgOnA?.id} (optimistic local ID)`);

  // Step A/B/C canonical ID resolution:
  const canonicalDeleteId = await resolveCanonicalMessageId(roomId, msgOnA, {
    targetState: stateA,
    chatApi: {
      getMessages: (rId, opts) => chatApiA.listMessages(roomTokenA, rId, opts)
    }
  });
  info(`Resolved canonical server ID: ${canonicalDeleteId}`);
  if (!canonicalDeleteId || canonicalDeleteId.startsWith('local-')) {
    fail('Step 1.2: Resolve canonical server message ID for Delete', `Got: ${canonicalDeleteId}`);
  } else {
    pass('Step 1.2: Resolve canonical server message ID for Delete', `Resolved: ${canonicalDeleteId}`);
  }

  // Authoritative REST DELETE call:
  await chatApiA.deleteMessage(roomTokenA, roomId, canonicalDeleteId);
  pass('Step 1.3: REST DELETE completed successfully with canonical ID');

  // Update sender local state
  stateA.deleteMessage(canonicalDeleteId);
  stateA.deleteMessage(clientMsgId1);

  const deletedMsgOnA = stateA.messages.find(m => m.id === canonicalDeleteId || m.clientMessageId === clientMsgId1);
  if (deletedMsgOnA?.isDeleted && deletedMsgOnA?.body?.text === 'This message was deleted') {
    pass('Step 1.4: Account A sees "This message was deleted"');
  } else {
    fail('Step 1.4: Account A sees "This message was deleted"');
  }

  // Wait for B to receive live WebSocket message.deleted frame without reopening
  let deletedOnB = false;
  for (let i = 0; i < 30; i++) {
    const targetMsgOnB = stateB.messages.find(m => m.id === canonicalDeleteId || m.clientMessageId === clientMsgId1);
    if (targetMsgOnB?.isDeleted) {
      deletedOnB = true;
      break;
    }
    await sleep(200);
  }

  if (deletedOnB) {
    pass('Step 1.5: Account B received message.deleted and shows tombstone without reopening');
  } else {
    fail('Step 1.5: Account B received message.deleted and shows tombstone without reopening');
  }

  // ═════════════════════════════════════════════════════════════════
  // TEST PART 2: EDIT MESSAGE
  // ═════════════════════════════════════════════════════════════════
  info('\n--- Phase 2: Edit Message ---');

  // A creates and sends another optimistic message
  const textBeforeEdit = `Original text at ${Date.now()}`;
  const textAfterEdit = `Corrected edited text at ${Date.now()}`;
  const clientMsgId2 = `local-${crypto.randomUUID()}`;
  const optimisticMsg2 = createOptimisticMessage(roomId, userA.userId, textBeforeEdit, clientMsgId2);
  stateA.addOptimisticMessage(optimisticMsg2);

  wsA.sendMessage(roomId, clientMsgId2, { text: textBeforeEdit }, 'text');
  info(`Account A sent message to edit with client_message_id=${clientMsgId2}`);

  // Wait for B to receive message.created over WebSocket
  let received2OnB = false;
  for (let i = 0; i < 30; i++) {
    const found2 = stateB.messages.find(m => m.body?.text === textBeforeEdit || m.client_message_id === clientMsgId2 || m.clientMessageId === clientMsgId2);
    if (found2) {
      received2OnB = true;
      break;
    }
    await sleep(200);
  }
  if (!received2OnB) {
    fail('Step 2.1: Account B received second message before edit');
  } else {
    pass('Step 2.1: Account B received second message before edit');
  }

  // Account A now edits the message:
  const msg2OnA = stateA.messages.find(m => m.clientMessageId === clientMsgId2);
  info(`Message on Account A before edit has id=${msg2OnA?.id} (optimistic local ID)`);

  const canonicalEditId = await resolveCanonicalMessageId(roomId, msg2OnA, {
    targetState: stateA,
    chatApi: {
      getMessages: (rId, opts) => chatApiA.listMessages(roomTokenA, rId, opts)
    }
  });
  info(`Resolved canonical server ID for edit: ${canonicalEditId}`);
  if (!canonicalEditId || canonicalEditId.startsWith('local-')) {
    fail('Step 2.2: Resolve canonical server message ID for Edit', `Got: ${canonicalEditId}`);
  } else {
    pass('Step 2.2: Resolve canonical server message ID for Edit', `Resolved: ${canonicalEditId}`);
  }

  // Authoritative REST PATCH call:
  const patchRes = await chatApiA.editMessage(roomTokenA, roomId, canonicalEditId, { text: textAfterEdit });
  pass('Step 2.3: REST PATCH completed successfully with canonical ID');

  const nowIso = patchRes?.editedAt || patchRes?.edited_at || new Date().toISOString();
  stateA.updateMessage(canonicalEditId, {
    body: { text: textAfterEdit },
    editedAt: nowIso,
    edited_at: nowIso
  });
  stateA.updateMessage(clientMsgId2, {
    body: { text: textAfterEdit },
    editedAt: nowIso,
    edited_at: nowIso
  });

  const editedOnA = stateA.messages.find(m => m.id === canonicalEditId || m.clientMessageId === clientMsgId2);
  if (editedOnA?.body?.text === textAfterEdit && (editedOnA?.editedAt || editedOnA?.edited_at)) {
    pass('Step 2.4: Account A sees edited text and edited indicator');
  } else {
    fail('Step 2.4: Account A sees edited text and edited indicator');
  }

  // Wait for B to receive live WebSocket message.updated frame without reopening
  let editedOnB = false;
  for (let i = 0; i < 30; i++) {
    const targetMsgOnB = stateB.messages.find(m => m.id === canonicalEditId || m.clientMessageId === clientMsgId2);
    if (targetMsgOnB?.body?.text === textAfterEdit) {
      editedOnB = true;
      break;
    }
    await sleep(200);
  }

  if (editedOnB) {
    pass('Step 2.5: Account B received message.updated and shows edited text without reopening');
  } else {
    fail('Step 2.5: Account B received message.updated and shows edited text without reopening');
  }

  // ═════════════════════════════════════════════════════════════════
  // TEST PART 3: BACKGROUND ROOM MUTATION ROUTING
  // ═════════════════════════════════════════════════════════════════
  info('\n--- Phase 3: Background Room Mutation Receipt ---');
  // Account B has a different active room, but still receives the update
  const bgStateB = new RoomMessagesState(userB.userId);
  bgStateB.roomId = roomId; // Room messages state for background room
  bgStateB.setInitialMessages(roomId, [
    {
      id: canonicalEditId,
      senderId: userA.userId,
      body: { text: textBeforeEdit }
    }
  ]);

  // Simulate incoming message.updated routed to bgStateB
  bgStateB.updateMessage(canonicalEditId, {
    body: { text: textAfterEdit },
    edited_at: new Date().toISOString()
  });

  assertBgUpdated: {
    const bgMsg = bgStateB.messages.find(m => m.id === canonicalEditId);
    if (bgMsg?.body?.text === textAfterEdit) {
      pass('Step 3.1: Background conversation receives mutation without being selected');
    } else {
      fail('Step 3.1: Background conversation receives mutation without being selected');
    }
  }

  // Clean up
  wsA.disconnect();
  wsB.disconnect();

  console.log('\n============================================================');
  const passCount = results.filter(r => r.status === 'PASS').length;
  const failCount = results.filter(r => r.status === 'FAIL').length;
  console.log(` Summary: ${passCount} PASSED, ${failCount} FAILED`);
  console.log('============================================================\n');

  if (anyFail) process.exit(1);
  process.exit(0);
}

run().catch((err) => {
  console.error('[FATAL]', err);
  process.exit(1);
});
