/**
 * OllaChat macOS end-to-end test
 * ==============================
 *
 * Launches TWO real OllaChat instances on this Mac (QA1 and QA2, each with its own data
 * folder), drives their UI with Playwright, and verifies messaging, voice/video calls in both
 * directions, and macOS-specific behaviour. Prints a PASS/FAIL table; on failure it saves
 * screenshots + logs to ~/Library/Logs/OllaChat/e2e/<timestamp>/.
 *
 * PREREQUISITES
 *   export SIM_TOKEN="..."            # OTP simulator token (never commit it)
 *   npm run build                     # (dev mode only; done automatically by `npm run e2e:mac`)
 *   QA1 (+15550001111) and QA2 (+15550002222) must share a direct chat.
 *
 * USAGE
 *   npm run e2e:mac                   # build + run against the source build (fast)
 *   node scripts/e2e-mac.mjs --packaged   # run against release/mac-arm64/OllaChat.app
 *   node scripts/e2e-mac.mjs --only=messaging,voice   # subset: mac,messaging,voice,video,screen
 *   node scripts/e2e-mac.mjs --allow-group            # fall back to a shared group if no direct chat
 *   node scripts/e2e-mac.mjs --keep-open              # leave both windows open at the end
 *
 * NOTES
 *   - Uses Chromium fake camera/mic (--use-fake-device-for-media-stream), so it proves call
 *     signalling + media flow, not real hardware or the macOS permission prompts.
 *   - Logins persist in ~/Library/Application Support/OllaChat-E2E/{A,B}; OTP is only fetched
 *     when an instance is logged out.
 *   - Logging QA2 in here may affect another tester using QA2 at the same time.
 */
import { _electron as electron } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { resolveSimToken, pollOtp } from './get-otp.js';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name) => argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];

const ONLY = (opt('only') || 'mac,messaging,voice,video,screen').split(',').map((s) => s.trim());
const PACKAGED = flag('packaged');
const KEEP_OPEN = flag('keep-open');
const ALLOW_GROUP = flag('allow-group');

const ACCOUNTS = {
  A: { label: 'QA1', phone: '+15550001111', local: '5550001111', country: '+1' },
  B: { label: 'QA2', phone: '+15550002222', local: '5550002222', country: '+1' }
};
const DATA_ROOT = path.join(os.homedir(), 'Library', 'Application Support', 'OllaChat-E2E');
const RUN_ID = new Date().toISOString().replace(/[:.]/g, '-');
const ARTIFACT_DIR = path.join(os.homedir(), 'Library', 'Logs', 'OllaChat', 'e2e', RUN_ID);

// ── Result tracking ─────────────────────────────────────────────────────────
const results = [];
function record(group, name, status, detail = '') {
  results.push({ group, name, status, detail });
  const icon = status === 'PASS' ? '✅' : status === 'SKIP' ? '⏭️ ' : '❌';
  console.log(`${icon} [${group}] ${name}${detail ? ` — ${detail}` : ''}`);
}
async function check(group, name, fn) {
  try {
    const detail = await fn();
    record(group, name, 'PASS', typeof detail === 'string' ? detail : '');
    return true;
  } catch (err) {
    record(group, name, 'FAIL', err?.message || String(err));
    await captureArtifacts(`${group}-${name}`);
    return false;
  }
}
const skip = (group, name, why) => record(group, name, 'SKIP', why);

// ── Helpers ─────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, { timeout = 20000, interval = 250, what = 'condition' } = {}) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeout) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e?.message;
    }
    await sleep(interval);
  }
  throw new Error(`Timed out after ${timeout}ms waiting for ${what}${last !== undefined && last !== false ? ` (last: ${JSON.stringify(last)})` : ''}`);
}

const instances = {};
async function captureArtifacts(tag) {
  try {
    fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
    const safe = tag.replace(/[^a-z0-9_-]+/gi, '_');
    for (const [key, inst] of Object.entries(instances)) {
      if (!inst?.page || inst.page.isClosed()) continue;
      await inst.page.screenshot({ path: path.join(ARTIFACT_DIR, `${safe}-${key}.png`) }).catch(() => { });
    }
  } catch { }
}

async function launchInstance(key) {
  const dataDir = path.join(DATA_ROOT, key);
  fs.mkdirSync(dataDir, { recursive: true });
  const env = { ...process.env, OLLACHAT_USER_DATA_DIR: dataDir };
  delete env.ELECTRON_RUN_AS_NODE; // set by VS Code-based terminals; makes Electron act as Node
  const fakeMedia = ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'];

  const launchOpts = PACKAGED
    ? { executablePath: path.join(ROOT, 'release/mac-arm64/OllaChat.app/Contents/MacOS/OllaChat'), args: fakeMedia, env }
    : { executablePath: require('electron'), args: [ROOT, ...fakeMedia], env };

  const app = await electron.launch({ ...launchOpts, timeout: 60000 });
  const logPath = path.join(ARTIFACT_DIR, `app-${key}.log`);
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  const logStream = fs.createWriteStream(logPath);
  app.process().stdout?.on('data', (d) => logStream.write(d));
  app.process().stderr?.on('data', (d) => logStream.write(d));

  const page = await app.firstWindow();
  // Serialize object arguments so app logs like CALL_LIFECYCLE {...} stay readable.
  page.on('console', async (msg) => {
    const parts = await Promise.all(msg.args().map((h) => h.jsonValue().catch(() => '[unserializable]')));
    const text = parts.map((p) => (p && typeof p === 'object' ? JSON.stringify(p) : String(p))).join(' ');
    logStream.write(`[renderer:${msg.type()}] ${text}\n`);
  });
  await page.waitForLoadState('domcontentloaded');
  return { key, app, page, account: ACCOUNTS[key] };
}

const isVisible = (page, sel) => page.locator(sel).isVisible().catch(() => false);

async function ensureLoggedIn(inst, token) {
  const { page, account } = inst;
  const which = await waitFor(async () => {
    if (await isVisible(page, '#screen-authenticated')) return 'auth';
    if (await isVisible(page, '#screen-phone')) return 'phone';
    if (await isVisible(page, '#screen-otp')) return 'otp';
    return false;
  }, { timeout: 30000, what: `${account.label} first screen` });
  if (which === 'auth') {
    const phone = await page.evaluate(() => window.__TEST_HOOKS__?.shellState?.userProfile?.phone || document.querySelector('#current-user-phone')?.textContent || '');
    if (phone && !phone.replace(/\D/g, '').endsWith(account.local)) {
      throw new Error(`${account.label} data folder is logged in as a different account (${phone}); delete ${path.join(DATA_ROOT, inst.key)} and rerun`);
    }
    return 'already logged in';
  }
  if (which === 'otp') {
    await page.click('#btn-back-phone');
    await page.waitForSelector('#screen-phone', { state: 'visible' });
  }
  await page.selectOption('#country-select', account.country);
  await page.fill('#phone-input', account.local);
  const since = Date.now() - 2000;
  await page.click('#btn-request-otp');
  await page.waitForSelector('#screen-otp', { state: 'visible', timeout: 20000 });
  const code = await pollOtp({ phone: account.phone, since, token, timeoutMs: 45000, logFn: () => { } });
  await page.fill('#otp-input', String(code).trim());
  // The app auto-submits once 6 digits are entered; only click Verify if it is still enabled.
  await sleep(500);
  if (await page.locator('#btn-verify-otp').isEnabled().catch(() => false)) {
    await page.click('#btn-verify-otp', { timeout: 3000 }).catch(() => { });
  }
  await page.waitForSelector('#screen-authenticated', { state: 'visible', timeout: 30000 });
  return 'logged in via OTP simulator';
}

const conversations = (page) => page.evaluate(() =>
  (window.__TEST_HOOKS__?.shellState?.conversations || []).map((c) => ({
    roomId: c.roomId,
    isGroup: c.kind === 'group' || c.isGroup === true,
    title: c.title || c.name || c.displayName || ''
  })));

async function findSharedRoom(a, b) {
  const [ca, cb] = await Promise.all([
    waitFor(async () => { const c = await conversations(a.page); return c.length ? c : false; }, { timeout: 30000, what: 'QA1 conversations' }),
    waitFor(async () => { const c = await conversations(b.page); return c.length ? c : false; }, { timeout: 30000, what: 'QA2 conversations' })
  ]);
  const idsB = new Set(cb.map((c) => c.roomId));
  const shared = ca.filter((c) => idsB.has(c.roomId));
  const direct = shared.find((c) => !c.isGroup);
  if (direct) return direct;
  if (ALLOW_GROUP && shared.length) return shared[0];
  throw new Error(shared.length
    ? 'QA1 and QA2 only share a group chat (calling it would ring other members). Create a direct chat between them, or rerun with --allow-group.'
    : 'QA1 and QA2 share no chat. Create a direct chat between them first.');
}

/**
 * Clicks a call control in whichever window shows it: the main window's call overlay, or the
 * separate floating call window (used for incoming/minimized calls).
 */
async function clickCallControl(inst, mainSel, floatingSels, what) {
  return waitFor(async () => {
    if (await isVisible(inst.page, mainSel)) { await inst.page.click(mainSel, { timeout: 3000 }); return true; }
    for (const win of inst.app.windows()) {
      if (!win.url().includes('floating-call')) continue;
      for (const sel of floatingSels) {
        if (await isVisible(win, sel)) { await win.click(sel, { timeout: 3000 }); return true; }
      }
    }
    return false;
  }, { timeout: 10000, what: `${inst.account.label} ${what} button` });
}

const openRoom = (inst, roomId) => inst.page.evaluate((id) => window.__TEST_HOOKS__.selectConversation(id), roomId);
const callState = (inst) => inst.page.evaluate(() => window.__TEST_HOOKS__?.voiceCallManager?.state);
const IDLE_LIKE = new Set(['idle', 'ended', 'cancelled', 'declined', 'remote_ended', 'remote_cancelled', 'remote_declined', 'no_answer', 'failed']);

async function waitIdle(inst, timeout = 15000) {
  return waitFor(async () => IDLE_LIKE.has(await callState(inst)) ? true : false, { timeout, what: `${inst.account.label} call to end` });
}

async function remoteTracks(inst) {
  return inst.page.evaluate(() => {
    const pc = window.__TEST_HOOKS__?.voiceCallManager?.peerConnection;
    const tracks = pc ? pc.getReceivers().map((r) => r.track).filter(Boolean) : [];
    return tracks.filter((t) => t.readyState === 'live').map((t) => t.kind);
  });
}

async function inboundBytes(inst, kind) {
  return inst.page.evaluate(async (k) => {
    const pc = window.__TEST_HOOKS__?.voiceCallManager?.peerConnection;
    if (!pc) return 0;
    let bytes = 0;
    (await pc.getStats()).forEach((s) => { if (s.type === 'inbound-rtp' && s.kind === k) bytes += s.bytesReceived || 0; });
    return bytes;
  }, kind);
}

/** Full call scenario: caller dials, callee answers, both connected + media flowing, mute, hang up. */
async function runCall(group, caller, callee, roomId, { video = false } = {}) {
  const dir = `${caller.account.label} → ${callee.account.label}`;
  await openRoom(caller, roomId);
  await openRoom(callee, roomId);
  await Promise.all([waitIdle(caller), waitIdle(callee)]);

  const rang = await check(group, `${dir}: callee rings`, async () => {
    await caller.page.click(video ? '#btn-start-video-call' : '#btn-start-voice-call');
    await waitFor(async () => (await callState(callee)) === 'incoming_ringing', { what: 'incoming_ringing on callee' });
    return `caller state: ${await callState(caller)}`;
  });
  if (!rang) {
    await caller.page.evaluate(() => window.__TEST_HOOKS__?.voiceCallManager?.endCall?.()).catch(() => { });
    await sleep(2000);
    return;
  }

  await clickCallControl(callee, '#btn-call-accept', ['#btn-incoming-accept'], 'accept');

  await check(group, `${dir}: callee shows connected`, () =>
    waitFor(async () => (await callState(callee)) === 'connected', { what: 'callee connected' }).then(() => 'connected'));
  // This is the "caller stuck on Ringing" regression check.
  await check(group, `${dir}: caller shows connected (not stuck ringing)`, () =>
    waitFor(async () => (await callState(caller)) === 'connected', { what: 'caller connected', timeout: 15000 }).then(() => 'connected'));

  await check(group, `${dir}: call timer runs on both sides`, async () => {
    await sleep(3000);
    const timers = await Promise.all([caller, callee].map((i) => i.page.locator('#call-timer-label').textContent()));
    if (timers.some((t) => !t || /^0?0:00$/.test(t.trim()))) throw new Error(`timers: ${timers.join(' / ')}`);
    return timers.join(' / ');
  });

  for (const kind of video ? ['audio', 'video'] : ['audio']) {
    await check(group, `${dir}: ${kind} flowing both ways`, async () => {
      const before = await Promise.all([inboundBytes(caller, kind), inboundBytes(callee, kind)]);
      await sleep(2500);
      const after = await Promise.all([inboundBytes(caller, kind), inboundBytes(callee, kind)]);
      const live = await Promise.all([remoteTracks(caller), remoteTracks(callee)]);
      if (!(after[0] > before[0] && after[1] > before[1])) throw new Error(`inbound ${kind} bytes not increasing (caller ${before[0]}→${after[0]}, callee ${before[1]}→${after[1]})`);
      if (!live.every((k) => k.includes(kind))) throw new Error(`live remote tracks: caller [${live[0]}] callee [${live[1]}]`);
      return `caller +${after[0] - before[0]}B, callee +${after[1] - before[1]}B`;
    });
  }

  await check(group, `${dir}: mute / unmute`, async () => {
    const muted = () => caller.page.evaluate(() => Boolean(window.__TEST_HOOKS__?.voiceCallManager?.isMuted));
    const start = await muted();
    await clickCallControl(caller, '#btn-call-mute', ['#btn-audio-mute', '#btn-video-mute'], 'mute');
    await waitFor(async () => (await muted()) !== start, { timeout: 5000, what: 'mute toggle' });
    await clickCallControl(caller, '#btn-call-mute', ['#btn-audio-mute', '#btn-video-mute'], 'mute');
    await waitFor(async () => (await muted()) === start, { timeout: 5000, what: 'unmute toggle' });
    if ((await callState(caller)) !== 'connected') throw new Error('call dropped after mute toggle');
    return 'toggled twice, call still connected';
  });

  if (group === 'screen') return; // caller stays in call for the screen-share step

  await check(group, `${dir}: hang up ends call on both sides`, async () => {
    await clickCallControl(caller, '#btn-call-end', ['#btn-audio-hangup', '#btn-video-hangup', '#btn-outgoing-hangup'], 'hang up');
    await Promise.all([waitIdle(caller), waitIdle(callee)]);
    return `caller ${await callState(caller)}, callee ${await callState(callee)}`;
  });
  await sleep(2500); // let both managers settle back to idle before the next call
}

// ── Test groups ─────────────────────────────────────────────────────────────
async function testMac(a) {
  const info = await a.app.evaluate(({ app, Menu }) => ({
    name: app.name,
    userData: app.getPath('userData'),
    menu: (Menu.getApplicationMenu()?.items || []).map((i) => i.label)
  }));
  await check('mac', 'app name is "OllaChat"', async () => {
    if (info.name !== 'OllaChat') throw new Error(`app.name = "${info.name}"`);
    return info.name;
  });
  await check('mac', 'menu bar has OllaChat / Edit / View / Window', async () => {
    for (const l of ['OllaChat', 'Edit', 'View', 'Window']) if (!info.menu.includes(l)) throw new Error(`menu: ${info.menu.join(', ')}`);
    return info.menu.join(', ');
  });
  await check('mac', 'welcome screen says "OllaChat for Mac"', async () => {
    const t = (await a.page.locator('#chat-welcome-title').textContent().catch(() => '') || '').trim();
    if (t !== 'OllaChat for Mac') throw new Error(`welcome title: "${t}"`);
    return t;
  });
  await check('mac', 'close hides window, Dock click restores it', async () => {
    const vis = () => a.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((w) => w.isVisible() && w.getTitle() !== ''));
    await a.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.isVisible())?.close());
    await waitFor(async () => !(await vis()), { timeout: 5000, what: 'window hidden' });
    if (!(await a.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length))) throw new Error('window was destroyed instead of hidden');
    await a.app.evaluate(({ app }) => app.emit('activate'));
    await waitFor(vis, { timeout: 5000, what: 'window restored' });
    return 'hidden then restored';
  });
}

async function testMessaging(a, b, roomId) {
  await openRoom(a, roomId);
  await openRoom(b, roomId);
  const text = `e2e ${RUN_ID} ${Math.random().toString(36).slice(2, 8)}`;
  await check('messaging', 'QA1 sends text, QA2 receives it', async () => {
    await a.page.fill('#composer-input', text);
    await a.page.click('#btn-send-message');
    await waitFor(() => b.page.locator('#messages-list, .messages-list').getByText(text, { exact: false }).first().isVisible().catch(() => false),
      { timeout: 20000, what: 'message on QA2' });
    return `"${text}"`;
  });
  await check('messaging', 'QA2 replies, QA1 receives it', async () => {
    const reply = `${text} reply`;
    await b.page.fill('#composer-input', reply);
    await b.page.click('#btn-send-message');
    await waitFor(() => a.page.locator('#messages-list, .messages-list').getByText(reply, { exact: false }).first().isVisible().catch(() => false),
      { timeout: 20000, what: 'reply on QA1' });
    return 'received';
  });
  await check('messaging', 'QA1 sends image, QA2 receives it', async () => {
    // 1x1 PNG
    const png = path.join(ARTIFACT_DIR, 'e2e-image.png');
    fs.writeFileSync(png, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
    const countImgs = (i) => i.page.locator('.message-image-container').count();
    const before = await countImgs(b);
    await a.page.setInputFiles('#composer-file-input', png); // upload starts on change
    await waitFor(async () => (await countImgs(b)) > before, { timeout: 30000, what: 'image on QA2' });
    return 'received';
  });
}

async function testScreenShare(a, b, roomId) {
  const status = await a.app.evaluate(({ systemPreferences }) => systemPreferences.getMediaAccessStatus('screen'));
  if (status !== 'granted') {
    skip('screen', 'screen share', `Screen Recording permission is "${status}" for the test runner; grant it to test (manual step)`);
    return;
  }
  // Screen share is offered in the video-call layout (main overlay or floating window).
  await runCall('screen', a, b, roomId, { video: true });
  if ((await callState(a)) !== 'connected') return;
  await check('screen', 'QA1 shares screen, QA2 sees it', async () => {
    await clickCallControl(a, '#btn-call-screenshare', ['#btn-video-screenshare'], 'share screen');
    // Pick the first source in whichever picker opened.
    await waitFor(async () => {
      if (await isVisible(a.page, '#screenshare-sources-grid > *')) {
        await a.page.locator('#screenshare-sources-grid > *').first().click();
        await a.page.click('#btn-confirm-screenshare-picker');
        return true;
      }
      for (const win of a.app.windows()) {
        if (!win.url().includes('floating-call')) continue;
        if (await isVisible(win, '#floating-screenshare-grid > *')) {
          await win.locator('#floating-screenshare-grid > *').first().click();
          await win.click('#btn-confirm-floating-screenshare');
          return true;
        }
      }
      return false;
    }, { timeout: 15000, what: 'screen source picker' });
    await waitFor(() => a.page.evaluate(() => window.__TEST_HOOKS__.voiceCallManager.isScreenSharing), { timeout: 15000, what: 'QA1 isScreenSharing' });
    // In a 1:1 video call the screen replaces the camera track on the same sender (no separate
    // remote flag), so verify QA1 now sends a screen track and QA2 keeps receiving video.
    const sentLabel = await waitFor(() => a.page.evaluate(() => {
      const pc = window.__TEST_HOOKS__.voiceCallManager.peerConnection;
      const t = pc?.getSenders().map((x) => x.track).find((x) => x && x.kind === 'video');
      return t && t.readyState === 'live' && !/fake|camera/i.test(t.label) ? t.label || 'screen track' : false;
    }), { timeout: 10000, what: 'QA1 sending a screen (non-camera) video track' });
    const before = await inboundBytes(b, 'video');
    await sleep(2500);
    const after = await inboundBytes(b, 'video');
    if (!(after > before)) throw new Error(`QA2 inbound video not increasing after share (${before}→${after})`);
    return `QA1 sending "${sentLabel}", QA2 +${after - before}B video`;
  });
  await clickCallControl(a, '#btn-call-end', ['#btn-video-hangup', '#btn-audio-hangup'], 'hang up').catch(() => { });
  await Promise.all([waitIdle(a), waitIdle(b)]).catch(() => { });
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  const token = resolveSimToken();
  console.log(`OllaChat macOS E2E — ${PACKAGED ? 'packaged app' : 'source build'} — groups: ${ONLY.join(', ')}`);
  console.log(`Artifacts: ${ARTIFACT_DIR}\n`);

  instances.A = await launchInstance('A');
  instances.B = await launchInstance('B');
  const { A: a, B: b } = instances;

  const loggedIn = (await check('setup', 'QA1 logged in', () => ensureLoggedIn(a, token)))
    & (await check('setup', 'QA2 logged in', () => ensureLoggedIn(b, token)));
  if (!loggedIn) return;

  let room;
  if (!(await check('setup', 'QA1 and QA2 share a chat', async () => { room = await findSharedRoom(a, b); return `${room.isGroup ? 'group' : 'direct'} ${room.roomId.slice(0, 8)}…`; }))) return;

  if (ONLY.includes('mac')) await testMac(a);
  if (ONLY.includes('messaging')) await testMessaging(a, b, room.roomId);
  if (ONLY.includes('voice')) {
    await runCall('voice', a, b, room.roomId);
    await runCall('voice', b, a, room.roomId);
  }
  if (ONLY.includes('video')) await runCall('video', a, b, room.roomId, { video: true });
  if (ONLY.includes('screen')) await testScreenShare(a, b, room.roomId);
}

let exitCode = 0;
try {
  await main();
} catch (err) {
  record('setup', 'run', 'FAIL', err?.message || String(err));
  await captureArtifacts('fatal');
} finally {
  const pass = results.filter((r) => r.status === 'PASS').length;
  const fail = results.filter((r) => r.status === 'FAIL').length;
  const skipped = results.filter((r) => r.status === 'SKIP').length;
  console.log(`\n${'─'.repeat(60)}\nPASS ${pass}   FAIL ${fail}   SKIP ${skipped}`);
  if (fail) console.log(`Screenshots and logs: ${ARTIFACT_DIR}`);
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  fs.writeFileSync(path.join(ARTIFACT_DIR, 'results.json'), JSON.stringify(results, null, 2));
  exitCode = fail ? 1 : 0;
  if (!KEEP_OPEN) {
    for (const inst of Object.values(instances)) await inst?.app?.close().catch(() => { });
  }
}
process.exit(exitCode);
