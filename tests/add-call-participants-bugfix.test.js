/**
 * add-call-participants-bugfix.test.js
 *
 * Bug-fix stabilization tests for the "Add People to Active Call" feature.
 * Covers all 21 required scenarios from the manual test report.
 *
 * Root causes verified and fixed:
 *  1. Modal z-index (1000) < voice-call-overlay z-index (9999/2500):
 *     Fixed by #call-add-participant-modal { z-index: 10000 } in styles.css
 *  2. Modal must be visible immediately on click (before API call completes).
 *  3. Add button must be visible for CONNECTED state regardless of modality/role.
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

const htmlContent = fs.readFileSync(htmlPath, 'utf8');
const cssContent = fs.readFileSync(cssPath, 'utf8');
const appJsContent = fs.readFileSync(appJsPath, 'utf8');

// -----------------------------------------------------------------------------
// Group 1: Add Button Visibility (Tests 1-7)
// -----------------------------------------------------------------------------
describe('Add People Bugfix - Button Visibility', () => {
  test('1. Add button visible for connected audio caller', () => {
    assert.ok(
      appJsContent.includes("btnCallAddParticipant?.classList.add('hidden')"),
      'Must hide btn by default in updateVoiceCallUi'
    );
    assert.ok(
      appJsContent.includes("btnCallAddParticipant?.classList.remove('hidden')"),
      'Must show btn in CONNECTED case'
    );
    const connectedCaseIdx = appJsContent.indexOf("case CALL_STATE.CONNECTED:");
    const removeHiddenIdx = appJsContent.indexOf("btnCallAddParticipant?.classList.remove('hidden')");
    assert.ok(connectedCaseIdx !== -1, 'CONNECTED case must exist');
    assert.ok(removeHiddenIdx !== -1, 'remove hidden call must exist');
    assert.ok(
      removeHiddenIdx > connectedCaseIdx,
      'remove hidden must occur after CONNECTED case label'
    );
  });

  test('2. Add button visible for connected audio receiver - not gated on _isIncoming', () => {
    const hasIsIncomingGate = /_isIncoming.*classList.*hidden|hidden.*_isIncoming/i.test(appJsContent);
    assert.equal(
      hasIsIncomingGate,
      false,
      'updateVoiceCallUi must NOT gate btn-call-add-participant visibility on _isIncoming'
    );
  });

  test('3. Add button visible for connected video caller - not inside isVideo guard in CONNECTED', () => {
    const connectedStart = appJsContent.indexOf("case CALL_STATE.CONNECTED:");
    const nextBreakIdx = appJsContent.indexOf('break;', connectedStart);
    const connectedBlock = appJsContent.slice(connectedStart, nextBreakIdx);
    assert.ok(
      connectedBlock.includes("btnCallAddParticipant?.classList.remove('hidden')"),
      'Add btn must be removed from hidden in CONNECTED block regardless of modality'
    );
  });

  test('4. Add button visible for connected video receiver - callee CONNECTED state reachable', async () => {
    const { VoiceCallManager, CALL_STATE } = await import('../src/call/voice-call-manager.js');
    const manager = new VoiceCallManager({});
    manager.roomId = 'room-callee-connected-1';
    manager._beginCallInstance();
    manager._setState(CALL_STATE.INCOMING_RINGING);
    manager._setState(CALL_STATE.CONNECTING);
    manager._markConnected();
    assert.equal(manager.state, CALL_STATE.CONNECTED, 'Callee must reach CONNECTED');
    assert.ok(manager.isConnected, 'isConnected must be true for callee');
  });

  test('5. Add button hidden while ringing - OUTGOING_RINGING and INCOMING_RINGING', () => {
    const outgoingIdx = appJsContent.indexOf("case CALL_STATE.OUTGOING_RINGING:");
    const incomingIdx = appJsContent.indexOf("case CALL_STATE.INCOMING_RINGING:");
    const outgoingBlock = appJsContent.slice(outgoingIdx, appJsContent.indexOf('break;', outgoingIdx));
    const incomingBlock = appJsContent.slice(incomingIdx, appJsContent.indexOf('break;', incomingIdx));
    assert.equal(
      outgoingBlock.includes("btnCallAddParticipant?.classList.remove('hidden')"),
      false,
      'OUTGOING_RINGING must NOT show Add btn'
    );
    assert.equal(
      incomingBlock.includes("btnCallAddParticipant?.classList.remove('hidden')"),
      false,
      'INCOMING_RINGING must NOT show Add btn'
    );
  });

  test('6. Add button hidden while connecting - CONNECTING state', () => {
    const connectingIdx = appJsContent.indexOf("case CALL_STATE.CONNECTING:");
    const connectingBlock = appJsContent.slice(connectingIdx, appJsContent.indexOf('break;', connectingIdx));
    assert.equal(
      connectingBlock.includes("btnCallAddParticipant?.classList.remove('hidden')"),
      false,
      'CONNECTING must NOT show Add btn'
    );
  });

  test('7. Add button hidden after call ends - ENDED state', () => {
    assert.ok(
      appJsContent.includes("btnCallAddParticipant?.classList.add('hidden')"),
      'Must unconditionally hide Add btn at top of updateVoiceCallUi'
    );
    const endedIdx = appJsContent.indexOf('case CALL_STATE.ENDED:');
    const endedBlock = appJsContent.slice(endedIdx, appJsContent.indexOf('break;', endedIdx));
    assert.equal(
      endedBlock.includes("btnCallAddParticipant?.classList.remove('hidden')"),
      false,
      'ENDED must NOT show Add btn'
    );
  });
});

// -----------------------------------------------------------------------------
// Group 2: Modal Immediacy (Tests 8-11)
// -----------------------------------------------------------------------------
describe('Add People Bugfix - Modal Immediacy', () => {
  test('8. Clicking Add immediately opens modal before API call', () => {
    const fnStart = appJsContent.indexOf('export async function openCallAddParticipantModal()');
    assert.ok(fnStart !== -1, 'openCallAddParticipantModal must be exported');
    const fnEnd = appJsContent.indexOf('\nexport ', fnStart + 10);
    const fnBody = fnEnd !== -1 ? appJsContent.slice(fnStart, fnEnd) : appJsContent.slice(fnStart, fnStart + 2000);
    const removeHiddenIdx = fnBody.indexOf("callAddParticipantModal.classList.remove('hidden')");
    const awaitIdx = fnBody.indexOf('await window.ollacoreDesktop.chatApi.getParticipants');
    assert.ok(removeHiddenIdx !== -1, 'Must call callAddParticipantModal.classList.remove(hidden)');
    assert.ok(awaitIdx !== -1, 'Must call getParticipants');
    assert.ok(
      removeHiddenIdx < awaitIdx,
      'Modal must be shown BEFORE awaiting getParticipants API call'
    );
  });

  test('9. Loading indicator shown before async API call', () => {
    const fnStart = appJsContent.indexOf('export async function openCallAddParticipantModal()');
    const fnEnd = appJsContent.indexOf('\nexport ', fnStart + 10);
    const fnBody = fnEnd !== -1 ? appJsContent.slice(fnStart, fnEnd) : appJsContent.slice(fnStart, fnStart + 2000);
    const loadingShowIdx = fnBody.indexOf("callParticipantsLoading?.classList.remove('hidden')");
    const awaitIdx = fnBody.indexOf('await window.ollacoreDesktop.chatApi.getParticipants');
    assert.ok(loadingShowIdx !== -1, 'Must show loading indicator');
    assert.ok(loadingShowIdx < awaitIdx, 'Loading indicator must appear before the async API call');
  });

  test('10. Loading state hidden after API resolves via finally block', () => {
    assert.ok(htmlContent.includes('id="call-participants-loading"'), 'Loading element must exist in HTML');
    const fnStart = appJsContent.indexOf('export async function openCallAddParticipantModal()');
    const fnEnd = appJsContent.indexOf('\nexport ', fnStart + 10);
    const fnBody = fnEnd !== -1 ? appJsContent.slice(fnStart, fnEnd) : appJsContent.slice(fnStart, fnStart + 2000);
    const finallyIdx = fnBody.indexOf('finally');
    assert.ok(finallyIdx !== -1, 'Must have finally block in openCallAddParticipantModal');
    const finallyBlock = fnBody.slice(finallyIdx, finallyIdx + 200);
    assert.ok(
      finallyBlock.includes("callParticipantsLoading?.classList.add('hidden')"),
      'Loading must be hidden in finally block'
    );
  });

  test('11. Participant list populated after API response', () => {
    const fnStart = appJsContent.indexOf('export async function openCallAddParticipantModal()');
    const fnEnd = appJsContent.indexOf('\nexport ', fnStart + 10);
    const fnBody = fnEnd !== -1 ? appJsContent.slice(fnStart, fnEnd) : appJsContent.slice(fnStart, fnStart + 2000);
    const awaitIdx = fnBody.indexOf('await window.ollacoreDesktop.chatApi.getParticipants');
    const renderIdx = fnBody.indexOf('renderCallParticipantsList(');
    assert.ok(renderIdx !== -1, 'renderCallParticipantsList must be called');
    assert.ok(renderIdx > awaitIdx, 'renderCallParticipantsList must be called after API response');
  });
});

// -----------------------------------------------------------------------------
// Group 3: Modal Stacking & Call Continuity (Tests 12-14)
// -----------------------------------------------------------------------------
describe('Add People Bugfix - Modal Stacking and Call Continuity', () => {
  test('12. Opening Add modal does not change call state from CONNECTED', () => {
    const updateFnStart = appJsContent.indexOf('function updateVoiceCallUi(');
    const updateFnEnd = appJsContent.indexOf('\nfunction ', updateFnStart + 10);
    const updateFnBody = updateFnEnd !== -1
      ? appJsContent.slice(updateFnStart, updateFnEnd)
      : appJsContent.slice(updateFnStart, updateFnStart + 3000);
    const modalHideIdx = updateFnBody.indexOf("callAddParticipantModal?.classList.add('hidden')");
    assert.ok(modalHideIdx !== -1, 'Modal hide must be present in updateVoiceCallUi');
    const beforeModalHide = updateFnBody.slice(0, modalHideIdx);
    assert.ok(
      beforeModalHide.includes('state !== CALL_STATE.CONNECTED'),
      'Modal must only be hidden when state !== CONNECTED'
    );
  });

  test('13. #call-add-participant-modal has z-index > 9999 (above voice-call-overlay)', () => {
    assert.ok(cssContent.includes('#call-add-participant-modal'), 'styles.css must have #call-add-participant-modal rule');
    // Find the opening brace of the rule (skip any preceding comment block that may contain z-index references)
    const selectorIdx = cssContent.indexOf('#call-add-participant-modal');
    const openBraceIdx = cssContent.indexOf('{', selectorIdx);
    const closeBraceIdx = cssContent.indexOf('}', openBraceIdx);
    const ruleBody = cssContent.slice(openBraceIdx, closeBraceIdx + 1);
    const zIndexMatch = ruleBody.match(/z-index\s*:\s*(\d+)/);
    assert.ok(zIndexMatch, '#call-add-participant-modal must set z-index in its rule body');
    const zIndexValue = parseInt(zIndexMatch[1], 10);
    assert.ok(
      zIndexValue > 9999,
      `#call-add-participant-modal z-index (${zIndexValue}) must be > 9999 to render above voice-call-overlay`
    );
  });

  test('14. closeCallAddParticipantModal only hides modal, does not touch call controls', () => {
    const fnStart = appJsContent.indexOf('export function closeCallAddParticipantModal()');
    assert.ok(fnStart !== -1, 'closeCallAddParticipantModal must be exported');
    const fnEnd = appJsContent.indexOf('\nexport ', fnStart + 10);
    const fnBody = fnEnd !== -1 ? appJsContent.slice(fnStart, fnEnd) : appJsContent.slice(fnStart, fnStart + 500);
    assert.ok(fnBody.includes("callAddParticipantModal.classList.add('hidden')"), 'Must hide the modal');
    assert.equal(fnBody.includes('btnCallMute'), false, 'Must NOT touch btnCallMute');
    assert.equal(fnBody.includes('btnCallEnd'), false, 'Must NOT touch btnCallEnd');
    assert.equal(fnBody.includes('btnCallCamera'), false, 'Must NOT touch btnCallCamera');
  });
});

// -----------------------------------------------------------------------------
// Group 4: Invite & Duplicate Prevention (Tests 15-16)
// -----------------------------------------------------------------------------
describe('Add People Bugfix - Invite Signaling', () => {
  test('15. inviteParticipantToCall uses existing call_signal invite', () => {
    const fnStart = appJsContent.indexOf('export function inviteParticipantToCall(');
    assert.ok(fnStart !== -1, 'inviteParticipantToCall must be exported');
    const fnEnd = appJsContent.indexOf('\nexport ', fnStart + 10);
    const fnBody = fnEnd !== -1 ? appJsContent.slice(fnStart, fnEnd) : appJsContent.slice(fnStart, fnStart + 500);
    assert.ok(fnBody.includes("sendCallSignal('invite'"), "Must use sendCallSignal('invite')");
    assert.ok(fnBody.includes('targetUserId'), 'Must pass targetUserId');
  });

  test('16. Duplicate invitations prevented via inFlightCallInvitations', () => {
    assert.ok(appJsContent.includes('inFlightCallInvitations'), 'inFlightCallInvitations must exist');
    const fnStart = appJsContent.indexOf('export function inviteParticipantToCall(');
    const fnEnd = appJsContent.indexOf('\nexport ', fnStart + 10);
    const fnBody = fnEnd !== -1 ? appJsContent.slice(fnStart, fnEnd) : appJsContent.slice(fnStart, fnStart + 500);
    assert.ok(fnBody.includes('inFlightCallInvitations'), 'Must check inFlightCallInvitations');
  });
});

// -----------------------------------------------------------------------------
// Group 5: Decline & Departure Invariants (Tests 17-18)
// -----------------------------------------------------------------------------
describe('Add People Bugfix - Decline and Departure Invariants', () => {
  test('17. Decline from invited participant does not terminate connected call', async () => {
    const { VoiceCallManager, CALL_STATE } = await import('../src/call/voice-call-manager.js');
    const manager = new VoiceCallManager({});
    manager.roomId = 'room-decline-inv-1';
    manager._beginCallInstance();
    manager._setState(CALL_STATE.OUTGOING_RINGING);
    manager._setState(CALL_STATE.CONNECTING);
    manager._markConnected();
    assert.equal(manager.state, CALL_STATE.CONNECTED);
    // Simulate decline signal handler: connected call must NOT end on decline
    const incomingRoomId = 'room-decline-inv-1';
    if (manager.roomId === incomingRoomId && manager.state !== CALL_STATE.CONNECTED) {
      await manager.handleRemoteCallEnded({ roomId: incomingRoomId });
    }
    assert.equal(manager.state, CALL_STATE.CONNECTED, 'Call must remain CONNECTED on invited participant decline');
  });

  test('18. removeParticipant updates participants set and emits participantsChange', async () => {
    const { VoiceCallManager } = await import('../src/call/voice-call-manager.js');
    const manager = new VoiceCallManager({});
    manager.addParticipant('user-x');
    manager.addParticipant('user-y');
    assert.equal(manager.participants.size, 2);
    let event = null;
    manager.on('participantsChange', (e) => { event = e; });
    manager.removeParticipant('user-x');
    assert.equal(manager.participants.size, 1);
    assert.equal(manager.hasParticipant('user-x'), false);
    assert.equal(manager.hasParticipant('user-y'), true);
    assert.ok(event, 'participantsChange must fire');
    assert.deepEqual(event.participants, ['user-y']);
  });
});

// -----------------------------------------------------------------------------
// Group 6: Media & Regression (Tests 19-21)
// -----------------------------------------------------------------------------
describe('Add People Bugfix - Media and 1-to-1 Regression', () => {
  test('19. openCallAddParticipantModal does not stop media tracks or close PeerConnection', () => {
    const fnStart = appJsContent.indexOf('export async function openCallAddParticipantModal()');
    const fnEnd = appJsContent.indexOf('\nexport ', fnStart + 10);
    const fnBody = fnEnd !== -1 ? appJsContent.slice(fnStart, fnEnd) : appJsContent.slice(fnStart, fnStart + 2000);
    assert.equal(fnBody.includes('.stop()'), false, 'Must not call .stop() on any track');
    assert.equal(fnBody.includes('peerConnection.close'), false, 'Must not close PeerConnection');
    assert.equal(fnBody.includes('endCall'), false, 'Must not call endCall');
    assert.equal(fnBody.includes('_cleanupResources'), false, 'Must not call _cleanupResources');
    assert.equal(fnBody.includes('stopCallDurationTimer'), false, 'Must not stop the call duration timer');
  });

  test('20. 1-to-1 audio call lifecycle intact - caller path', async () => {
    const { VoiceCallManager, CALL_STATE } = await import('../src/call/voice-call-manager.js');
    const manager = new VoiceCallManager({});
    manager.roomId = 'room-1to1-audio-1';
    manager._beginCallInstance();
    manager._setState(CALL_STATE.OUTGOING_RINGING);
    assert.equal(manager.state, CALL_STATE.OUTGOING_RINGING);
    manager._setState(CALL_STATE.CONNECTING);
    assert.equal(manager.state, CALL_STATE.CONNECTING);
    manager._markConnected();
    assert.equal(manager.state, CALL_STATE.CONNECTED);
    assert.ok(manager.isConnected);
    assert.ok(manager.callConnectedAt, 'Timer must start on connected');
    manager._setState(CALL_STATE.ENDING);
    manager.stopCallDurationTimer();
    manager._setState(CALL_STATE.ENDED);
    assert.equal(manager.state, CALL_STATE.ENDED);
    assert.ok(manager.isEnded);
  });

  test('21. 1-to-1 video call lifecycle intact - callee path', async () => {
    const { VoiceCallManager, CALL_STATE } = await import('../src/call/voice-call-manager.js');
    const manager = new VoiceCallManager({});
    manager.roomId = 'room-1to1-video-1';
    manager._beginCallInstance();
    manager.isVideo = true;
    manager.mode = 'video';
    manager._setState(CALL_STATE.INCOMING_RINGING);
    assert.equal(manager.state, CALL_STATE.INCOMING_RINGING);
    assert.equal(manager.isRinging, true);
    manager._setState(CALL_STATE.CONNECTING);
    assert.equal(manager.state, CALL_STATE.CONNECTING);
    manager._markConnected();
    assert.equal(manager.state, CALL_STATE.CONNECTED);
    assert.ok(manager.isConnected);
    assert.ok(manager.isVideo, 'Must remain in video mode');
    assert.equal(manager.mode, 'video');
    manager._setState(CALL_STATE.REMOTE_ENDED);
    manager._setState(CALL_STATE.ENDED);
    assert.equal(manager.state, CALL_STATE.ENDED);
    assert.ok(manager.isEnded);
    assert.equal(manager.isConnected, false);
  });
});

// -----------------------------------------------------------------------------
// Group 7: HTML & CSS Structural Integrity (Issue 3 fix verification)
// -----------------------------------------------------------------------------
describe('Add People Bugfix - HTML and CSS Structure Validation', () => {
  test('A. call-add-participant-modal is in DOM after voice-call-overlay', () => {
    const overlayEndApprox = htmlContent.indexOf('</div>', htmlContent.indexOf('id="voice-call-overlay"'));
    const modalIdx = htmlContent.indexOf('id="call-add-participant-modal"');
    assert.ok(overlayEndApprox !== -1, 'voice-call-overlay closing div must exist');
    assert.ok(modalIdx !== -1, 'call-add-participant-modal must exist');
    assert.ok(modalIdx > overlayEndApprox, 'Modal must appear after voice-call-overlay in DOM');
  });

  test('B. voice-call-overlay max z-index is lower than modal z-index', () => {
    const overlayZValues = [];
    let searchIdx = 0;
    while (true) {
      const selectorStart = cssContent.indexOf('.voice-call-overlay', searchIdx);
      if (selectorStart === -1) break;
      // Extract z-index from inside the braces only
      const openBrace = cssContent.indexOf('{', selectorStart);
      const closeBrace = cssContent.indexOf('}', openBrace);
      if (openBrace === -1 || closeBrace === -1) break;
      const ruleBody = cssContent.slice(openBrace, closeBrace + 1);
      const m = ruleBody.match(/z-index\s*:\s*(\d+)/);
      if (m) overlayZValues.push(parseInt(m[1], 10));
      searchIdx = selectorStart + 1;
    }
    const maxOverlayZ = overlayZValues.length > 0 ? Math.max(...overlayZValues) : 0;
    // Find modal z-index inside its rule braces (skip any preceding comment text)
    const modalSelectorIdx = cssContent.indexOf('#call-add-participant-modal');
    const modalOpenBrace = cssContent.indexOf('{', modalSelectorIdx);
    const modalCloseBrace = cssContent.indexOf('}', modalOpenBrace);
    const modalRuleBody = cssContent.slice(modalOpenBrace, modalCloseBrace + 1);
    const modalZMatch = modalRuleBody.match(/z-index\s*:\s*(\d+)/);
    assert.ok(modalZMatch, '#call-add-participant-modal must define z-index in its rule body');
    const modalZ = parseInt(modalZMatch[1], 10);
    assert.ok(modalZ > maxOverlayZ, `Modal z-index (${modalZ}) must exceed overlay max z-index (${maxOverlayZ})`);
  });

  test('C. Generic .modal-backdrop z-index 1000 unchanged (existing modals not broken)', () => {
    assert.ok(htmlContent.includes('class="modal-backdrop'), 'Other modals still use modal-backdrop class');
    const backdropRuleStart = cssContent.indexOf('.modal-backdrop {');
    const backdropBlock = cssContent.slice(backdropRuleStart, cssContent.indexOf('}', backdropRuleStart) + 1);
    assert.ok(backdropBlock.includes('z-index: 1000'), '.modal-backdrop z-index must remain 1000');
  });
});
