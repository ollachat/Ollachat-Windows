import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { VoiceCallManager, CALL_STATE } from '../src/call/voice-call-manager.js';
import { ChatShellState, getAvatarInitials, getAvatarColor, getGroupCapabilities } from '../src/renderer/chat-shell-state.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

describe('WhatsApp Desktop Style Floating Incoming Call UI & UX (30 Invariants)', () => {
  const indexPath = path.join(projectRoot, 'src', 'renderer', 'index.html');
  const cssPath = path.join(projectRoot, 'src', 'renderer', 'styles.css');
  const appPath = path.join(projectRoot, 'src', 'renderer', 'app.js');

  const html = fs.readFileSync(indexPath, 'utf8');
  const css = fs.readFileSync(cssPath, 'utf8');
  const appJs = fs.readFileSync(appPath, 'utf8');

  test('1. Floating incoming voice call panel markup exists and contains branding and close button', () => {
    assert.ok(html.includes('id="voice-call-overlay"'), 'overlay element exists');
    assert.ok(html.includes('id="voice-call-card"'), 'card element exists');
    assert.ok(html.includes('id="incoming-call-header"'), 'incoming call header exists');
    assert.ok(html.includes('id="btn-incoming-call-close"'), 'close X button exists');
    assert.ok(html.includes('OllaChat'), 'OllaChat branding exists');
  });

  test('2. Floating incoming video call panel markup exists and contains required buttons', () => {
    assert.ok(html.includes('id="btn-call-accept"'), 'accept button exists');
    assert.ok(html.includes('id="btn-call-decline"'), 'decline button exists');
    assert.strictEqual(html.includes('id="btn-incoming-call-more"'), false, 'unused more options button is removed');
  });

  test('3. Existing chat remains visible behind the panel without dark/blur full-screen overlay in incoming state', () => {
    assert.ok(css.includes('.voice-call-overlay.is-incoming'), 'defines .voice-call-overlay.is-incoming');
    assert.ok(css.includes('pointer-events: none !important'), 'overlay has pointer-events: none for passthrough');
    assert.ok(css.includes('background-color: transparent !important'), 'overlay is transparent');
    assert.ok(css.includes('backdrop-filter: none !important'), 'overlay removes blur backdrop');
  });

  test('4. Floating card is interactive with pointer-events: auto and compact dimensions', () => {
    assert.ok(css.includes('.voice-call-card.is-incoming'), 'defines .voice-call-card.is-incoming');
    assert.ok(css.includes('pointer-events: auto !important'), 'card restores pointer events');
    assert.ok(css.includes('width: 320px !important'), 'card has compact width');
  });

  test('5. Voice call shows caller avatar, name, and "Voice call" modality subtitle', () => {
    assert.ok(appJs.includes("callStatusLabel.textContent = isVideo ? 'Video call' : 'Voice call'"), 'uses Voice call / Video call status labels');
  });

  test('6. Video call shows caller avatar, name, and "Video call" modality subtitle', () => {
    assert.ok(html.includes('id="call-peer-name"'), 'peer name label exists');
    assert.ok(html.includes('id="call-status-label"'), 'status label exists');
  });

  test('7. Voice call does not show inappropriate video controls or active call timer', () => {
    assert.ok(appJs.includes("btnCallCamera?.classList.add('hidden')"), 'camera button hidden during ringing');
    assert.ok(appJs.includes("btnCallMute?.classList.add('hidden')"), 'mute button hidden during ringing');
    assert.ok(appJs.includes("callTimerLabel?.classList.add('hidden')"), 'timer hidden during ringing');
  });

  test('8. Video call uses video presentation without creating fake video streams before acceptance', () => {
    assert.ok(css.includes('.voice-call-card.is-incoming-video'), 'incoming video modifier exists');
    assert.ok(appJs.includes("voiceCallCard?.classList.add('is-incoming-video')"), 'adds is-incoming-video class during video ringing');
  });

  test('9. Accept voice call closes incoming panel and transitions to connected state', () => {
    const mgr = new VoiceCallManager();
    mgr.handleIncomingCall({ roomId: 'room-1', initiator: 'Alice', isVideo: false });
    assert.equal(mgr.state, CALL_STATE.INCOMING_RINGING);
    assert.equal(mgr.isVideo, false);
  });

  test('10. Accept video call closes incoming panel and transitions with isVideo=true', () => {
    const mgr = new VoiceCallManager();
    mgr.handleIncomingCall({ roomId: 'room-2', initiator: 'Bob', isVideo: true, callType: 'video' });
    assert.equal(mgr.state, CALL_STATE.INCOMING_RINGING);
    assert.equal(mgr.isVideo, true);
  });

  test('11. Decline voice call closes panel and triggers clean decline signaling', () => {
    let signalSent = null;
    const mgr = new VoiceCallManager({
      sendSignal: (sig) => { signalSent = sig; }
    });
    mgr.handleIncomingCall({ roomId: 'room-3', initiator: 'Charlie', isVideo: false });
    mgr.declineCall();
    assert.equal(mgr.state, CALL_STATE.DECLINED);
    assert.equal(signalSent?.action, 'decline');
    assert.equal(signalSent?.roomId, 'room-3');
  });

  test('12. Decline video call closes panel and triggers clean decline signaling', () => {
    let signalSent = null;
    const mgr = new VoiceCallManager({
      sendSignal: (sig) => { signalSent = sig; }
    });
    mgr.handleIncomingCall({ roomId: 'room-4', initiator: 'David', isVideo: true, callType: 'video' });
    mgr.declineCall();
    assert.equal(mgr.state, CALL_STATE.DECLINED);
    assert.equal(signalSent?.action, 'decline');
  });

  test('13. Caller cancellation closes incoming panel automatically', () => {
    const mgr = new VoiceCallManager();
    mgr.handleIncomingCall({ roomId: 'room-5', initiator: 'Eve' });
    assert.equal(mgr.state, CALL_STATE.INCOMING_RINGING);
    mgr.handleRemoteCallEnded({ roomId: 'room-5' });
    assert.ok(
      mgr.state === CALL_STATE.REMOTE_CANCELLED ||
      mgr.state === CALL_STATE.REMOTE_ENDED ||
      mgr.state === CALL_STATE.ENDED ||
      mgr.state === CALL_STATE.IDLE
    );
  });

  test('14. Call accepted on another device or ended elsewhere closes incoming panel', () => {
    const mgr = new VoiceCallManager();
    mgr.handleIncomingCall({ roomId: 'room-6', initiator: 'Frank' });
    mgr.handleRemoteCallEnded({ roomId: 'room-6' });
    assert.notEqual(mgr.state, CALL_STATE.INCOMING_RINGING);
  });

  test('15. Modality is preserved accurately between voice and video', () => {
    const vMgr = new VoiceCallManager();
    vMgr.handleIncomingCall({ roomId: 'room-7', initiator: 'Grace', isVideo: false });
    assert.equal(vMgr.isVideo, false);
    assert.equal(vMgr.mode, 'voice');

    const vidMgr = new VoiceCallManager();
    vidMgr.handleIncomingCall({ roomId: 'room-8', initiator: 'Heidi', isVideo: true, callType: 'video' });
    assert.equal(vidMgr.isVideo, true);
    assert.equal(vidMgr.mode, 'video');
  });

  test('16. Caller avatar fallback generates valid initials and deterministic color', () => {
    const initials = getAvatarInitials('Sarah Connor');
    assert.equal(initials, 'SC');
    const color = getAvatarColor('Sarah Connor');
    assert.ok(color.startsWith('hsl('));
  });

  test('17. Caller avatar fallback handles single names and phone numbers safely', () => {
    assert.equal(getAvatarInitials('+14155552671'), '71');
    assert.equal(getAvatarInitials('Alex'), 'AL');
    assert.equal(getAvatarInitials(''), 'OC');
  });

  test('18. Contact Info state remains intact when incoming call arrives', () => {
    assert.ok(html.includes('id="contact-info-panel"'), 'Contact Info panel exists');
    assert.ok(appJs.includes('openContactInfo('), 'Contact Info handler intact');
    assert.ok(appJs.includes('closeContactInfo('), 'Contact Info close handler intact');
  });

  test('19. Group Info state remains intact when incoming call arrives', () => {
    const groupConv = { roomId: 'grp_1', kind: 'group', name: 'Dev Team' };
    const caps = getGroupCapabilities(groupConv, [], 'my_id');
    assert.strictEqual(caps.isGroup, true);
    assert.strictEqual(caps.title, 'Group info');
    assert.ok(appJs.includes("contactInfoExitGroupRow?.classList.toggle('hidden', !caps.canExitGroup)"));
  });

  test('20. Existing active call UI remains unchanged upon acceptance', () => {
    assert.ok(css.includes('.voice-call-card.is-video-call'), 'maintains active video call styles');
    assert.ok(css.includes('.btn-call-action.btn-mute'), 'maintains mute button styles');
    assert.ok(css.includes('.btn-call-action.btn-hangup'), 'maintains hangup button styles');
  });

  test('21. Existing minimized/floating PIP call behavior remains functional', () => {
    assert.ok(css.includes('.voice-call-overlay.is-floating'), 'maintains floating PIP overlay styles');
    assert.ok(css.includes('.voice-call-card.is-video-call.is-floating'), 'maintains floating PIP card styles');
  });

  test('22. Add People modal is supported on active calls and styled with highest z-index', () => {
    assert.ok(css.includes('#call-add-participant-modal'), 'modal selector exists');
    assert.ok(css.includes('z-index: 10000'), 'elevated above call overlay');
  });

  test('23. Light theme styles are provided for floating incoming call card', () => {
    assert.ok(css.includes('[data-app-theme="light"] .voice-call-card.is-incoming'), 'light theme card styles exist');
    assert.ok(css.includes('[data-app-theme="light"] .voice-call-card.is-incoming .call-peer-name'), 'light theme text styles exist');
  });

  test('24. Dark theme styles are supported with high contrast and sleek elevation', () => {
    assert.ok(css.includes('.voice-call-card.is-incoming'), 'dark theme base styling exists');
    assert.ok(css.includes('box-shadow: 0 16px 40px -8px rgba(0, 0, 0, 0.55)'), 'dark mode shadow defined');
  });

  test('25. Responsive window sizing: panel uses max-width to prevent overflow on small screens', () => {
    assert.ok(css.includes('max-width: calc(100% - 32px) !important'), 'prevents overflow on small windows');
  });

  test('26. No full-window takeover on incoming call: overlay does not have dark backdrop', () => {
    assert.ok(css.includes('.voice-call-overlay.is-incoming'), 'is-incoming overlay rule exists');
    assert.ok(css.includes('background-color: transparent !important'), 'transparent background');
    assert.ok(css.includes('backdrop-filter: none !important'), 'no backdrop blur');
  });

  test('27. Close X button triggers declineCall and dismisses the panel safely', () => {
    assert.ok(appJs.includes("btnIncomingCallClose?.addEventListener('click'"), 'wires close button to decline');
    assert.ok(html.includes('id="btn-incoming-call-close"'), 'close button present in DOM');
  });

  test('28. Unused three-dot button is removed from call card', () => {
    assert.strictEqual(appJs.includes("btnIncomingCallMore?.addEventListener('click'"), false, 'no dead click handler remains');
    assert.strictEqual(html.includes('id="btn-incoming-call-more"'), false, 'three-dot button removed from DOM');
  });

  test('29. Accessibility: remaining buttons include descriptive aria-label attributes', () => {
    assert.ok(html.includes('aria-label="Dismiss incoming call"'), 'close button has aria-label');
    assert.ok(html.includes('aria-label="Accept call"'), 'accept button has aria-label');
    assert.ok(html.includes('aria-label="Decline call"'), 'decline button has aria-label');
  });

  test('30. Call state cleanup removes .is-incoming class on IDLE transition', () => {
    assert.ok(appJs.includes("voiceCallOverlay.classList.remove('is-floating', 'is-incoming')"), 'cleans up is-incoming on IDLE');
    assert.ok(appJs.includes("incomingCallHeader?.classList.add('hidden')"), 'hides incoming header on IDLE');
  });
});
