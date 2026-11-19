import {
  app,
  BrowserWindow,
  ipcMain,
  session,
  dialog,
  shell,
  nativeImage,
  Tray,
  Menu,
  Notification,
  powerMonitor,
  clipboard,
  desktopCapturer,
  screen,
  systemPreferences
} from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { SessionStore } from '../storage/session-store.js';
import { ThemeStore } from '../storage/theme-store.js';
import { NotificationStore } from '../storage/notification-store.js';
import { BackupService } from '../storage/backup-service.js';
import { generateEphemeralDeviceId, getOrCreatePersistentDeviceId, getDeviceId } from '../storage/device-id.js';
import { OllacoreApi } from '../api/ollacore-api.js';
import { AuthController } from '../auth/auth-controller.js';
import { ChatWebSocket, CONNECTION_STATE } from '../chat/chat-websocket.js';
import { ChatApi } from '../api/chat-api.js';
import { RtcWebSocket } from '../call/rtc-websocket.js';
import { validateMediaFile, SINGLE_PUT_THRESHOLD, MULTIPART_PART_SIZE, EXTENSION_MIME_MAP } from '../api/mime-validator.js';
import { ensureAttachmentCacheDir, getSafeAttachmentCachePath, isAttachmentCached, saveAttachmentToCache, deleteCachedAttachments } from '../storage/attachment-cache.js';
import { parseLaunchArgs } from './intent-parser.js';
import { PendingIntentManager } from './pending-intent.js';
import { shouldStartHidden, setAutoStart, isAutoStartEnabled } from './auto-start.js';
import { DatabaseService } from '../storage/db/database-service.js';
import { UploadManager } from './upload-manager.js';
import { ContactCacheService } from './contact-cache-service.js';
import { normalizeRtcOwner, rtcOwnerMatches as ownerMatchesRequestedRtc } from './rtc-owner.js';

const _dirname = typeof __dirname !== 'undefined' ? __dirname : path.dirname(fileURLToPath(import.meta.url));

// Disable mDNS candidate hiding so local loopback WebRTC connects immediately between Electron windows
app.commandLine.appendSwitch('disable-features', 'WebRtcHideLocalIpsWithMdns');

let mainWindow = null;
let floatingCallWindow = null;
let currentFloatingCallState = null;
let isCallActive = false;
let sessionStore = null;
let themeStore = null;
let notificationStore = null;
let backupService = null;
const recentNotificationMessageIds = new Set();
const NOTIFICATION_DEDUP_LIMIT = 500;
function isMainProcessDuplicateNotification(id) {
  if (!id) return false;
  const key = String(id);
  if (recentNotificationMessageIds.has(key)) return true;
  recentNotificationMessageIds.add(key);
  if (recentNotificationMessageIds.size > NOTIFICATION_DEDUP_LIMIT) {
    const oldest = recentNotificationMessageIds.values().next().value;
    recentNotificationMessageIds.delete(oldest);
  }
  return false;
}
let databaseService = null;
let contactCacheService = null;
let authController = null;
let chatWebSocket = null;
let rtcWebSocket = null;
let rtcConnectGeneration = 0;
let rtcRequestedOwner = null;
let rtcConnectedOwner = null;
let pendingProfilePhoto = null;
let tray = null;
let isQuitting = false;
let syncInterval = null;
const ollacoreApi = new OllacoreApi();
const chatApi = new ChatApi();
const uploadManager = new UploadManager({ chatApi });

// Ephemeral in-memory store for securely picked media files awaiting upload
// Maps safe fileId -> { filePath, filename, mime, byteSize, kind, createdAt }
const pendingMediaUploads = new Map();

// Pending Intent Manager for cold-start launch routing
const pendingIntentManager = new PendingIntentManager();

// Parse initial cold-start launch arguments
const startupIntent = parseLaunchArgs(process.argv);
if (startupIntent) {
  pendingIntentManager.setIntent(startupIntent);
}

// macOS delivers ollachat:// links via 'open-url' (not argv). Register before 'ready'
// so cold-start links that launch the app are not dropped.
if (process.platform === 'darwin') {
  app.on('open-url', (event, url) => {
    event.preventDefault();
    const intent = parseLaunchArgs([url]);
    if (!intent) return;
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isLoading()) {
      if (!mainWindow.isVisible()) mainWindow.show();
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
      mainWindow.webContents.send('app:intent', intent);
    } else {
      pendingIntentManager.setIntent(intent);
    }
  });
}

/**
 * On macOS, camera/microphone access requires an OS-level (TCC) prompt in addition to
 * Chromium's permission. Resolves true when the OS grants access (always true elsewhere).
 */
async function ensureMacMediaAccess(mediaTypes = []) {
  if (process.platform !== 'darwin') return true;
  const wanted = new Set();
  for (const t of mediaTypes) {
    if (t === 'audio') wanted.add('microphone');
    if (t === 'video') wanted.add('camera');
  }
  for (const kind of wanted) {
    try {
      const status = systemPreferences.getMediaAccessStatus(kind);
      if (status === 'granted') continue;
      if (status === 'denied' || status === 'restricted') return false;
      if (!(await systemPreferences.askForMediaAccess(kind))) return false;
    } catch (err) {
      console.warn(`[main] macOS ${kind} access check failed:`, err?.message || err);
      return false;
    }
  }
  return true;
}

// Single Instance Lock: prevents duplicate application instances
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, commandLine) => {
    if (mainWindow) {
      if (!mainWindow.isVisible()) mainWindow.show();
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();

      const intent = parseLaunchArgs(commandLine);
      if (intent) {
        mainWindow.webContents.send('app:intent', intent);
      }
    }
  });
}

// Windows Custom Protocol Registration: ollachat://
try {
  if (process.defaultApp) {
    if (process.argv.length >= 2) {
      app.setAsDefaultProtocolClient('ollachat', process.execPath, [path.resolve(process.argv[1])]);
    }
  } else {
    app.setAsDefaultProtocolClient('ollachat');
  }
} catch (err) {
  console.warn('[main] Failed to register ollachat:// protocol client:', err?.message || err);
}

// Register App User Model ID on Windows so Action Center displays notifications and groups them with OllaChat
if (process.platform === 'win32') {
  try {
    app.setAppUserModelId('com.ollacore.chat.desktop');
  } catch (err) {
    console.warn('[main] Failed to set AppUserModelId:', err?.message || err);
  }
}

function createWindow() {
  const preloadPath = path.join(_dirname, '../preload/preload.cjs');

  mainWindow = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 850,
    minHeight: 600,
    title: process.platform === 'darwin' ? 'OllaChat' : 'OllaChat Windows',
    backgroundColor: '#0f172a',
    show: false,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      backgroundThrottling: false
    }
  });

  // Enforce Content-Security-Policy
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; media-src 'self' data: blob: https:; connect-src 'self' https: wss:;"
        ]
      }
    });
  });

  // Inject session token for authenticated avatar requests
  session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
    const isAvatar = details.url.includes('/directory/users/') && details.url.includes('/avatar');
    if (isAvatar) {
      const currentSession = sessionStore?.getSession();
      const token = currentSession?.sessionToken;
      if (token && !details.requestHeaders['Authorization'] && !details.requestHeaders['authorization']) {
        details.requestHeaders['Authorization'] = `Bearer ${token}`;
      }
    }
    callback({ requestHeaders: details.requestHeaders });
  });

  // Permission handling: allow audio/microphone, camera/video, screen/desktop capture, and HTML5 video fullscreen for application renderer
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    if (permission === 'fullscreen' || permission === 'automatic-fullscreen') {
      callback(true);
      return;
    }
    if (permission === 'display-capture') {
      callback(true);
      return;
    }
    if (permission === 'media') {
      const mediaTypes = details?.mediaTypes || [];
      // Allow audio (voice calls), video (video calls), and screen/desktop (screen sharing)
      const isAllowed = mediaTypes.length === 0 || mediaTypes.every((t) => t === 'audio' || t === 'video' || t === 'screen' || t === 'desktop');
      if (!isAllowed) {
        callback(false);
        return;
      }
      ensureMacMediaAccess(mediaTypes).then(callback, () => callback(false));
      return;
    }
    if (permission === 'microphone' || permission === 'camera' || permission === 'audioCapture' || permission === 'videoCapture') {
      callback(true);
      return;
    }
    callback(false);
  });

  session.defaultSession.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => {
    if (permission === 'fullscreen' || permission === 'automatic-fullscreen') {
      return true;
    }
    if (permission === 'display-capture') {
      return true;
    }
    if (permission === 'media') {
      if (!details?.mediaType || details.mediaType === 'audio' || details.mediaType === 'video' || details.mediaType === 'screen' || details.mediaType === 'desktop') {
        return true;
      }
    }
    if (permission === 'microphone' || permission === 'camera' || permission === 'audioCapture' || permission === 'videoCapture') {
      return true;
    }
    return false;
  });

  // Prevent navigation away from the application
  mainWindow.webContents.on('will-navigate', (event) => {
    event.preventDefault();
  });

  // Disallow opening new windows directly; open web links in default system browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (typeof url === 'string' && (url.startsWith('https://') || url.startsWith('http://'))) {
      shell.openExternal(url).catch((err) => console.warn('Failed to open external url:', err));
    }
    return { action: 'deny' };
  });

  const indexPath = path.join(_dirname, '../renderer/index.html');
  mainWindow.loadFile(indexPath);

  mainWindow.webContents.on('console-message', (_event, _level, message) => {
    console.log('[RENDERER-CONSOLE]', message);
  });

  mainWindow.once('ready-to-show', async () => {
    if (process.argv.includes('--test-startup')) {
      console.log('[main] Startup verification passed: window ready-to-show.');
      mainWindow.close();
      app.quit();
      return;
    }

    const loginSettings = typeof app.getLoginItemSettings === 'function' ? app.getLoginItemSettings() : null;
    const isHiddenStartup = shouldStartHidden(process.argv, loginSettings);
    if (!isHiddenStartup) {
      mainWindow.show();
    } else {
      console.log('[main] Started in background/hidden mode. Window is hidden, background messaging is active.');
    }
  });

  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('main-window:state-changed', { isMinimized: false, isVisible: false, isFocused: false });
      }
      if (isCallActive) {
        const win = getOrCreateFloatingCallWindow();
        if (win && !win.isDestroyed()) {
          setFloatingCallMode('detailed');
          win.show();
          try { win.setAlwaysOnTop(true, 'screen-saver'); } catch { }
          if (currentFloatingCallState) {
            win.webContents.send('floating-call:state-changed', currentFloatingCallState);
          }
        }
      }
    }
  });

  mainWindow.on('minimize', () => {
    if (isCallActive) {
      const win = getOrCreateFloatingCallWindow();
      if (win && !win.isDestroyed()) {
        setFloatingCallMode('detailed');
        win.show();
        try { win.setAlwaysOnTop(true, 'screen-saver'); } catch { }
        if (currentFloatingCallState) {
          win.webContents.send('floating-call:state-changed', currentFloatingCallState);
        }
      }
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('main-window:state-changed', { isMinimized: true, isVisible: false, isFocused: false });
    }
  });

  mainWindow.on('restore', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('main-window:state-changed', { isMinimized: false, isVisible: true });
    }
  });

  mainWindow.on('focus', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('main-window:state-changed', { isMinimized: false, isVisible: true, isFocused: true });
    }
  });

  mainWindow.on('blur', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('main-window:state-changed', { isFocused: false });
    }
  });

  mainWindow.on('show', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('main-window:state-changed', { isMinimized: false, isVisible: true });
    }
  });

  mainWindow.on('hide', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('main-window:state-changed', { isMinimized: false, isVisible: false, isFocused: false });
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  createTray();
}

const FLOATING_WINDOW_DIMENSIONS = {
  compact: { width: 260, height: 68 },
  detailed: { width: 380, height: 500 },
  incoming: { width: 380, height: 500 },
  outgoing: { width: 380, height: 500 },
  audio: { width: 380, height: 500 },
  video: { width: 680, height: 510 }
};

let currentFloatingMode = 'detailed';
let lastFloatingPosition = null;

function setFloatingCallMode(mode) {
  if (!floatingCallWindow || floatingCallWindow.isDestroyed()) return;
  currentFloatingMode = mode;
  const dims = FLOATING_WINDOW_DIMENSIONS[mode] || FLOATING_WINDOW_DIMENSIONS.detailed;
  const primaryDisplay = screen ? screen.getPrimaryDisplay() : null;
  const workArea = primaryDisplay ? primaryDisplay.workArea : { x: 0, y: 0, width: 1024, height: 768 };

  const bounds = floatingCallWindow.getBounds();
  let newX = lastFloatingPosition ? lastFloatingPosition.x : bounds.x;
  let newY = lastFloatingPosition ? lastFloatingPosition.y : bounds.y;

  if (!lastFloatingPosition) {
    newX = Math.round(workArea.x + (workArea.width - dims.width) / 2);
    newY = Math.round(workArea.y + (workArea.height - dims.height) / 2);
  }

  newX = Math.max(workArea.x + 10, Math.min(newX, workArea.x + workArea.width - dims.width - 10));
  newY = Math.max(workArea.y + 10, Math.min(newY, workArea.y + workArea.height - dims.height - 10));

  floatingCallWindow.setBounds({
    x: newX,
    y: newY,
    width: dims.width,
    height: dims.height
  });

  lastFloatingPosition = { x: newX, y: newY };
  floatingCallWindow.webContents.send('floating-call:mode-changed', mode);
}

function getOrCreateFloatingCallWindow() {
  if (floatingCallWindow && !floatingCallWindow.isDestroyed()) {
    return floatingCallWindow;
  }

  const dims = FLOATING_WINDOW_DIMENSIONS[currentFloatingMode] || FLOATING_WINDOW_DIMENSIONS.detailed;
  const primaryDisplay = screen ? screen.getPrimaryDisplay() : null;
  const workArea = primaryDisplay ? primaryDisplay.workArea : { x: 0, y: 0, width: 1024, height: 768 };
  const width = dims.width;
  const height = dims.height;
  const x = lastFloatingPosition
    ? Math.max(workArea.x + 10, Math.min(lastFloatingPosition.x, workArea.x + workArea.width - width - 10))
    : Math.max(workArea.x + 10, Math.round(workArea.x + (workArea.width - width) / 2));
  const y = lastFloatingPosition
    ? Math.max(workArea.y + 10, Math.min(lastFloatingPosition.y, workArea.y + workArea.height - height - 10))
    : Math.max(workArea.y + 10, Math.round(workArea.y + (workArea.height - height) / 2));

  const preloadPath = path.join(_dirname, '../preload/preload.cjs');

  floatingCallWindow = new BrowserWindow({
    width,
    height,
    x,
    y,
    minWidth: 260,
    minHeight: 68,
    frame: false,
    resizable: true,
    alwaysOnTop: true,
    skipTaskbar: false,
    show: false,
    backgroundColor: '#111b21',
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      backgroundThrottling: false
    }
  });

  try {
    floatingCallWindow.setAlwaysOnTop(true, 'screen-saver');
    floatingCallWindow.setVisibleOnAllWorkspaces?.(true);
  } catch { }

  const floatingHtmlPath = path.join(_dirname, '../renderer/floating-call.html');
  floatingCallWindow.loadFile(floatingHtmlPath);

  floatingCallWindow.on('closed', () => {
    floatingCallWindow = null;
  });

  floatingCallWindow.on('restore', () => {
    if (floatingCallWindow && !floatingCallWindow.isDestroyed()) {
      try {
        floatingCallWindow.setAlwaysOnTop(true, 'screen-saver');
      } catch { }
      floatingCallWindow.webContents.send('floating-call:maximized-state', false);
    }
  });

  floatingCallWindow.on('maximize', () => {
    if (floatingCallWindow && !floatingCallWindow.isDestroyed()) {
      floatingCallWindow.webContents.send('floating-call:maximized-state', true);
    }
  });

  floatingCallWindow.on('unmaximize', () => {
    if (floatingCallWindow && !floatingCallWindow.isDestroyed()) {
      floatingCallWindow.webContents.send('floating-call:maximized-state', false);
    }
  });

  return floatingCallWindow;
}

/**
 * Builds a monochrome template image for the macOS menu bar (auto-adapts to light/dark).
 * Drawn at 2x (32px) as a chat-bubble-like filled circle.
 */
function createMacTrayIcon() {
  const size = 32;
  const buf = Buffer.alloc(size * size * 4);
  const c = (size - 1) / 2;
  const r = 12;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - c, y - c);
      // Tail at bottom-left to suggest a speech bubble
      const inTail = x >= 5 && x <= 12 && y >= 22 && y <= 29 && (x - 5) >= (y - 22);
      const alpha = d <= r ? Math.min(1, r - d + 0.5) : (inTail ? 1 : 0);
      buf[(y * size + x) * 4 + 3] = Math.round(alpha * 255); // BGRA, black w/ alpha
    }
  }
  const img = nativeImage.createFromBitmap(buf, { width: size, height: size, scaleFactor: 2 });
  img.setTemplateImage(true);
  return img;
}

function createTray() {
  if (tray) return;

  const trayIcon = process.platform === 'darwin' ? createMacTrayIcon() : nativeImage.createFromDataURL(
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAcUlEQVR4nO3O2w3AIAxDUZbpaizMQO0CvEzsBFWx5O97SsmBe1p9Zw8LyyBomAqxxk0IVvwIwY5DCFV8GxEKUMeXiFCAV3yISEACEhAO8ER041cAPBDT+BUAJWIrrkJAcTbiKM5CmOIWCC2MQmTh3+4DbKOwFPBjuV4AAAAASUVORK5CYII='
  );

  try {
    tray = new Tray(trayIcon);
  } catch (err) {
    console.warn('[main] Failed to create Tray icon:', err?.message || err);
    return;
  }

  tray.setToolTip('OllaChat');

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Open OllaChat',
      click: () => {
        if (mainWindow) {
          if (!mainWindow.isVisible()) mainWindow.show();
          if (mainWindow.isMinimized()) mainWindow.restore();
          mainWindow.focus();
        }
      }
    },
    { type: 'separator' },
    {
      label: 'Quit OllaChat',
      click: () => {
        isQuitting = true;
        if (syncInterval) {
          clearInterval(syncInterval);
          syncInterval = null;
        }
        if (chatWebSocket) {
          chatWebSocket.disconnect();
        }
        if (rtcWebSocket) {
          try { rtcWebSocket.disconnect(); } catch { }
        }
        app.quit();
      }
    }
  ]);

  tray.setContextMenu(contextMenu);

  tray.on('click', () => {
    if (mainWindow) {
      if (mainWindow.isVisible()) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.focus();
      } else {
        mainWindow.show();
        mainWindow.focus();
      }
    }
  });

  tray.on('double-click', () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

// IPC Handlers
ipcMain.handle('app:get-info', () => {
  return {
    appName: 'OllaChat Windows',
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    electronVersion: process.versions.electron,
    nodeVersion: process.versions.node
  };
});

ipcMain.handle('app:focus-window', () => {
  if (mainWindow) {
    if (!mainWindow.isVisible()) mainWindow.show();
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
  return { ok: true };
});

ipcMain.handle('app:get-window-state', () => {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return { isMinimized: false, isVisible: false, isFocused: false };
  }
  return {
    isMinimized: mainWindow.isMinimized(),
    isVisible: mainWindow.isVisible(),
    isFocused: mainWindow.isFocused()
  };
});

let pendingNavigationRoomId = null;
let pendingNavigationMessageId = null;
const activeNativeNotifications = new Set();

function restoreAndFocusMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    if (typeof createWindow === 'function') {
      createWindow();
    }
    return;
  }
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  if (!mainWindow.isVisible()) {
    mainWindow.show();
  }
  try {
    mainWindow.setAlwaysOnTop(true);
    mainWindow.show();
    mainWindow.focus();
    mainWindow.setAlwaysOnTop(false);
  } catch {
    mainWindow.focus();
  }
}

function navigateToRoom(roomId, messageId = null) {
  if (!roomId) return;
  pendingNavigationRoomId = roomId;
  pendingNavigationMessageId = messageId || null;

  if (!mainWindow || mainWindow.isDestroyed() || !mainWindow.webContents) {
    return;
  }

  const sendNavigation = () => {
    try {
      if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents) {
        mainWindow.webContents.send('chat:navigate-room', roomId, messageId || null);
      }
    } catch (err) {
      console.warn('[main] Failed to send navigate-room:', err?.message || err);
    }
  };

  if (mainWindow.webContents.isLoading()) {
    mainWindow.webContents.once('did-finish-load', sendNavigation);
  } else {
    sendNavigation();
  }
}

ipcMain.handle('chat:get-pending-navigation', () => {
  const pending = pendingNavigationRoomId;
  const pendingMsg = pendingNavigationMessageId;
  pendingNavigationRoomId = null;
  pendingNavigationMessageId = null;
  if (!pending) return null;
  if (pendingMsg) {
    return { roomId: pending, messageId: pendingMsg };
  }
  return pending;
});

ipcMain.handle('app:show-notification', (_event, { title, body, roomId, messageId } = {}) => {
  try {
    if (notificationStore && !notificationStore.getEnabled()) {
      return { ok: false, suppressed: 'disabled' };
    }
    if (messageId && isMainProcessDuplicateNotification(messageId)) {
      return { ok: false, suppressed: 'duplicate' };
    }
    if (Notification.isSupported()) {
      const notif = new Notification({
        title: title || 'OllaChat',
        body: body || '',
        icon: nativeImage.createFromDataURL(
          'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAcUlEQVR4nO3O2w3AIAxDUZbpaizMQO0CvEzsBFWx5O97SsmBe1p9Zw8LyyBomAqxxk0IVvwIwY5DCFV8GxEKUMeXiFCAV3yISEACEhAO8ER041cAPBDT+BUAJWIrrkJAcTbiKM5CmOIWCC2MQmTh3+4DbKOwFPBjuV4AAAAASUVORK5CYII='
        )
      });

      // Retain reference to prevent V8 garbage collection of active notification
      activeNativeNotifications.add(notif);
      notif.once('close', () => activeNativeNotifications.delete(notif));
      notif.once('failed', () => activeNativeNotifications.delete(notif));

      notif.on('click', () => {
        activeNativeNotifications.delete(notif);
        if (mainWindow) {
          if (!mainWindow.isVisible()) mainWindow.show();
          if (mainWindow.isMinimized()) mainWindow.restore();
          mainWindow.focus();
          restoreAndFocusMainWindow();
          if (roomId) {
            navigateToRoom(roomId, messageId || null);
          }
        } else {
          restoreAndFocusMainWindow();
          if (roomId) navigateToRoom(roomId, messageId || null);
        }
      });
      notif.show();
    }
  } catch (err) {
    console.warn('[main] Notification error:', err?.message || err);
  }
  return { ok: true };
});

ipcMain.handle('app:get-notification-settings', async () => {
  if (!notificationStore) {
    return { enabled: true, showPreview: true };
  }
  return notificationStore.getSettings();
});

ipcMain.handle('app:set-notification-settings', async (_event, payload) => {
  if (!notificationStore) {
    return { ok: true, settings: payload || { enabled: true, showPreview: true } };
  }
  return notificationStore.setSettings(payload);
});

// ═══════════════════════════════════════════════════════════════════
// Phase 3: Chat Backup & Restore IPC Handlers
// ═══════════════════════════════════════════════════════════════════

ipcMain.handle('backup:get-current-account', async () => {
  try {
    if (!backupService) {
      return { ok: false, error: 'Backup service not initialized' };
    }
    const account = backupService.getCurrentAccountInfo();
    return { ok: true, account };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('backup:select-destination', async (_event, defaultFilename = '') => {
  try {
    if (!mainWindow || mainWindow.isDestroyed()) return { canceled: true };
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      title: 'Save Chat Backup',
      defaultPath: defaultFilename || `ollachat_backup_${Date.now()}.ollabackup`,
      filters: [
        { name: 'OllaChat Backup (*.ollabackup)', extensions: ['ollabackup', 'tar.gz'] },
        { name: 'All Files (*.*)', extensions: ['*'] }
      ]
    });
    return { canceled: Boolean(canceled), filePath: filePath || null };
  } catch (err) {
    return { canceled: true, error: err.message };
  }
});

ipcMain.handle('backup:create', async (_event, { includeAttachments = false, destinationPath = null } = {}) => {
  try {
    if (!backupService) {
      return { ok: false, error: 'Backup service not initialized' };
    }
    let finalDest = destinationPath;
    if (!finalDest) {
      const account = backupService.getCurrentAccountInfo();
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const defaultName = `ollachat_backup_${account.userId}_${timestamp}.ollabackup`;
      if (mainWindow && !mainWindow.isDestroyed()) {
        const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
          title: 'Save Chat Backup',
          defaultPath: defaultName,
          filters: [
            { name: 'OllaChat Backup (*.ollabackup)', extensions: ['ollabackup', 'tar.gz'] },
            { name: 'All Files (*.*)', extensions: ['*'] }
          ]
        });
        if (canceled || !filePath) {
          return { canceled: true };
        }
        finalDest = filePath;
      }
    }
    const result = await backupService.createBackup({ includeAttachments, destinationPath: finalDest });
    return { ok: true, ...result };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('backup:select-file', async () => {
  try {
    if (!mainWindow || mainWindow.isDestroyed()) return { canceled: true };
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      title: 'Select Chat Backup File',
      properties: ['openFile'],
      filters: [
        { name: 'OllaChat Backup (*.ollabackup, *.tar.gz)', extensions: ['ollabackup', 'tar.gz'] },
        { name: 'All Files (*.*)', extensions: ['*'] }
      ]
    });
    if (canceled || !filePaths || filePaths.length === 0) {
      return { canceled: true };
    }
    return { canceled: false, filePath: filePaths[0] };
  } catch (err) {
    return { canceled: true, error: err.message };
  }
});

ipcMain.handle('backup:validate', async (_event, filePath) => {
  try {
    if (!backupService) {
      return { ok: false, error: 'Backup service not initialized' };
    }
    const result = await backupService.validateBackup(filePath);
    return { ok: true, ...result };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('backup:restore', async (_event, { filePath, confirmed = false } = {}) => {
  try {
    if (!backupService) {
      return { ok: false, error: 'Backup service not initialized' };
    }
    const result = await backupService.restoreBackup(filePath, { confirmed });
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('backup:restore-completed', result);
    }
    return { ok: true, ...result };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('app:get-pending-intent', () => {
  return pendingIntentManager.getAndClear();
});

ipcMain.handle('clipboard:write-text', (_event, text) => {
  clipboard.writeText(text);
  return { ok: true };
});

ipcMain.handle('app:get-auto-start', () => {
  return isAutoStartEnabled(app);
});

ipcMain.handle('app:set-auto-start', (_event, enabled) => {
  return setAutoStart(app, enabled);
});

// Session & Device IPC Handlers
ipcMain.handle('session:get', async () => {
  if (!sessionStore) return null;
  return sessionStore.getSession();
});

ipcMain.handle('session:save', async (_event, payload) => {
  if (!sessionStore) return null;
  return sessionStore.saveSession(payload);
});

ipcMain.handle('session:update-profile', async (_event, profile) => {
  if (!sessionStore) return null;
  return sessionStore.updateProfile(profile);
});

ipcMain.handle('session:set-onboarding-done', async (_event, done) => {
  if (!sessionStore) return null;
  return sessionStore.setOnboardingDone(done);
});

ipcMain.handle('session:clear', async () => {
  if (databaseService?.databaseManager) {
    await databaseService.databaseManager.close().catch(() => { });
  }
  if (!sessionStore) return null;
  return sessionStore.clear();
});

ipcMain.handle('device:get-ephemeral-id', () => {
  return getDeviceId();
});

// REST API Handlers
ipcMain.handle('api:request-otp', async (_event, phone) => {
  try {
    const data = await ollacoreApi.requestOtp(phone);
    return { ok: true, data };
  } catch (err) {
    return {
      ok: false,
      error: {
        message: err.message,
        code: err.code || 'api_error',
        httpStatus: err.httpStatus || null
      }
    };
  }
});

ipcMain.handle('api:verify-otp', async (_event, phone, code) => {
  try {
    const data = await ollacoreApi.verifyOtp(phone, code);
    return { ok: true, data };
  } catch (err) {
    return {
      ok: false,
      error: {
        message: err.message,
        code: err.code || 'api_error',
        httpStatus: err.httpStatus || null
      }
    };
  }
});

ipcMain.handle('api:get-profile', async (_event, token) => {
  try {
    const data = await ollacoreApi.getProfile(token);
    return { ok: true, data };
  } catch (err) {
    return {
      ok: false,
      error: {
        message: err.message,
        code: err.code || 'api_error',
        httpStatus: err.httpStatus || null
      }
    };
  }
});

ipcMain.handle('api:update-profile', async (_event, token, profile) => {
  try {
    const data = await ollacoreApi.updateProfile(token, profile);
    return { ok: true, data };
  } catch (err) {
    return {
      ok: false,
      error: {
        message: err.message,
        code: err.code || 'api_error',
        httpStatus: err.httpStatus || null
      }
    };
  }
});

ipcMain.handle('api:logout', async (_event, token, allDevices) => {
  try {
    const data = await ollacoreApi.logout(token, allDevices);
    return { ok: true, data };
  } catch (err) {
    return {
      ok: false,
      error: {
        message: err.message,
        code: err.code || 'api_error',
        httpStatus: err.httpStatus || null
      }
    };
  }
});

// Authentication Flow Handlers
ipcMain.handle('auth:get-state', () => {
  if (!authController) return null;
  return authController.getState();
});

ipcMain.handle('auth:update-phone', (_event, phone) => {
  if (!authController) return null;
  return authController.updatePhone(phone);
});

ipcMain.handle('auth:update-otp', (_event, code) => {
  if (!authController) return null;
  return authController.updateOtp(code);
});

ipcMain.handle('auth:request-otp', async (_event, phone) => {
  if (!authController) return { ok: false, error: 'Controller not initialized' };
  try {
    const res = await authController.requestOtp(phone);
    return { ok: true, state: res.state };
  } catch (err) {
    return {
      ok: false,
      error: err.message,
      code: err.code || 'auth_error',
      state: authController.getState()
    };
  }
});

ipcMain.handle('auth:resend-otp', async () => {
  if (!authController) return { ok: false, error: 'Controller not initialized' };
  try {
    const res = await authController.resendOtp();
    return { ok: true, state: res.state };
  } catch (err) {
    return {
      ok: false,
      error: err.message,
      code: err.code || 'auth_error',
      state: authController.getState()
    };
  }
});

ipcMain.handle('auth:verify-otp', async (_event, code) => {
  if (!authController) return { ok: false, error: 'Controller not initialized' };
  try {
    const res = await authController.verifyOtp(code);
    if (res?.session?.sessionToken) {
      syncAndConnectUserRooms();
      setAutoStart(app, true);
    }
    return { ok: true, state: res.state, session: res.session };
  } catch (err) {
    return {
      ok: false,
      error: err.message,
      code: err.code || 'auth_error',
      state: authController.getState()
    };
  }
});

ipcMain.handle('auth:logout', async (_event, allDevices) => {
  if (chatWebSocket) {
    chatWebSocket.disconnect();
    chatWebSocket.roomId = null;
    chatWebSocket._token = null;
  }
  if (rtcWebSocket) {
    rtcWebSocket.disconnect();
    rtcWebSocket.roomId = null;
    rtcWebSocket._token = null;
  }
  if (chatApi) {
    chatApi.roomTokenCache.clear();
  }
  if (!authController) return null;
  setAutoStart(app, false);
  const state = await authController.logout(allDevices);
  return { ok: true, state };
});

ipcMain.handle('auth:back-to-phone', () => {
  if (!authController) return null;
  return authController.backToPhone();
});

ipcMain.handle('auth:get-profile', async () => {
  if (!authController) return null;
  const session = await authController.refreshProfile();
  return { ok: Boolean(session), session };
});

/**
 * Uploads a profile avatar using OllaCore's attachment storage system.
 * Resolves an existing conversation room (or provisions one), performs presigned upload,
 * completes the attachment, and polls for the presigned download URL.
 *
 * @param {string} sessionToken Bearer session token
 * @param {Buffer} fileBuffer Image binary buffer
 * @param {string} filename Name of the file
/**
 * Uploads a user avatar directly to the Directory API.
 * Uses POST /v1/directory/me/avatar/init -> PUT upload_url -> POST /v1/directory/me/avatar/complete.
 *
 * @param {string} sessionToken Bearer session token
 * @param {Buffer} fileBuffer Image binary buffer
 * @param {string} filename Original filename
 * @param {string} mimeType MIME type
 * @returns {Promise<{ avatarUrl: string, avatarVersion: string, user: object }>}
 */
async function uploadProfileAvatar(sessionToken, fileBuffer, filename, mimeType) {
  const init = await chatApi.initAvatarUpload(sessionToken, {
    mime: mimeType || 'image/jpeg',
    byteSize: fileBuffer.length
  });

  const uploadUrl = init.uploadUrl || init.upload_url;
  const uploadId = init.uploadId || init.upload_id;
  if (!uploadUrl || !uploadId) {
    throw new Error('Backend failed to initialize avatar upload');
  }

  const putHeaders = {
    'Content-Type': mimeType || 'image/jpeg'
  };

  const putRes = await fetch(uploadUrl, {
    method: 'PUT',
    headers: putHeaders,
    body: fileBuffer
  });

  if (!putRes.ok) {
    throw new Error(`Profile photo upload failed with HTTP ${putRes.status}`);
  }

  const completeRes = await chatApi.completeAvatarUpload(sessionToken, uploadId);
  const avatarVersion = completeRes?.avatarVersion || completeRes?.avatar_version;
  const userId = completeRes?.id || completeRes?.userId || completeRes?.user_id;

  const avatarUrl = chatApi.getAvatarUrl(userId, avatarVersion);
  return { avatarUrl, avatarVersion, user: completeRes };
}

ipcMain.handle('profile:pick-photo', async () => {
  if (!mainWindow) return { ok: false, error: 'Main window not available' };
  try {
    const dialogResult = await dialog.showOpenDialog(mainWindow, {
      title: 'Select Profile Photo',
      buttonLabel: 'Select Photo',
      filters: [
        { name: 'Images (JPG, PNG, WebP)', extensions: ['jpg', 'jpeg', 'png', 'webp'] }
      ],
      properties: ['openFile']
    });

    if (dialogResult.canceled || !dialogResult.filePaths || dialogResult.filePaths.length === 0) {
      return { ok: true, cancelled: true };
    }

    const filePath = dialogResult.filePaths[0];

    // Verify regular file
    const stat = await fsPromises.stat(filePath);
    if (!stat.isFile()) {
      return { ok: false, error: 'Selected path is not a regular file' };
    }

    if (stat.size === 0) {
      return { ok: false, error: 'Selected file is empty (0 bytes)' };
    }

    const MAX_AVATAR_SIZE = 5 * 1024 * 1024; // 5MB limit
    if (stat.size > MAX_AVATAR_SIZE) {
      return { ok: false, error: 'Profile photo cannot exceed 5MB' };
    }

    const filename = path.basename(filePath);
    const ext = (filename.split('.').pop() || '').toLowerCase().trim();
    const ALLOWED_EXTS = new Set(['jpg', 'jpeg', 'png', 'webp']);
    if (!ALLOWED_EXTS.has(ext)) {
      return { ok: false, error: 'Only JPG, PNG, and WebP image files are supported' };
    }

    const buffer = await fsPromises.readFile(filePath);

    // Mime and magic bytes validation
    const validation = validateMediaFile({
      filename,
      byteSize: stat.size,
      declaredMime: EXTENSION_MIME_MAP[ext] || `image/${ext === 'jpg' ? 'jpeg' : ext}`,
      headerBytes: buffer.subarray(0, 32),
      maxSize: MAX_AVATAR_SIZE
    });

    if (!validation.isValid) {
      return { ok: false, error: validation.error || 'Invalid image file' };
    }

    if (validation.kind !== 'image') {
      return { ok: false, error: 'Selected file is not an image' };
    }

    // Image readability and decode verification using Electron nativeImage
    const decodedImg = nativeImage.createFromBuffer(buffer);
    if (decodedImg.isEmpty()) {
      return { ok: false, error: 'Selected file is not a valid or readable image' };
    }

    const effectiveMime = validation.effectiveMime || `image/${ext === 'jpg' ? 'jpeg' : ext}`;
    const previewUrl = `data:${effectiveMime};base64,${buffer.toString('base64')}`;

    pendingProfilePhoto = {
      buffer,
      filename,
      mime: effectiveMime,
      byteSize: stat.size
    };

    return {
      ok: true,
      previewUrl,
      filename,
      byteSize: stat.size,
      mime: effectiveMime
    };
  } catch (err) {
    return { ok: false, error: err.message || 'Failed to select profile photo' };
  }
});

ipcMain.handle('profile:clear-pending-photo', () => {
  pendingProfilePhoto = null;
  return { ok: true };
});

ipcMain.handle('auth:update-profile', async (_event, profileData = {}) => {
  if (!authController) return { ok: false, error: 'Auth controller not initialized' };
  try {
    const payload = { ...profileData };

    if (payload.avatarAction === 'set') {
      if (pendingProfilePhoto) {
        const session = sessionStore?.getSession();
        const token = session?.sessionToken;
        if (!token) throw new Error('Not authenticated');

        const uploadRes = await uploadProfileAvatar(
          token,
          pendingProfilePhoto.buffer,
          pendingProfilePhoto.filename,
          pendingProfilePhoto.mime
        );
        payload.avatarUrl = uploadRes.avatarUrl;
        payload.avatarVersion = uploadRes.avatarVersion;
        payload.avatar_version = uploadRes.avatarVersion;
        pendingProfilePhoto = null;
      }
    } else if (payload.avatarAction === 'remove') {
      const session = sessionStore?.getSession();
      const token = session?.sessionToken;
      if (token && chatApi?.deleteAvatar) {
        try {
          await chatApi.deleteAvatar(token);
        } catch (err) {
          console.warn('Failed to delete avatar on server:', err);
        }
      }
      payload.avatarUrl = null;
      payload.avatarVersion = null;
      payload.avatar_version = null;
      pendingProfilePhoto = null;
    }

    const session = await authController.updateProfile(payload);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('auth:profile-updated', session);
    }
    return { ok: Boolean(session), session };
  } catch (err) {
    return { ok: false, error: err.message || 'Failed to update profile' };
  }
});

ipcMain.handle('user:fetch-avatar-data-url', async (_event, userId, avatarVersion) => {
  if (!userId) return null;
  const currentSession = sessionStore?.getSession();
  const token = currentSession?.sessionToken;
  if (!token) return null;
  try {
    const avatarUrl = chatApi.getAvatarUrl(userId, avatarVersion);
    const res = await fetch(avatarUrl, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!res.ok) return null;
    const arrayBuffer = await res.arrayBuffer();
    const contentType = res.headers.get('content-type') || 'image/jpeg';
    const base64 = Buffer.from(arrayBuffer).toString('base64');
    return `data:${contentType};base64,${base64}`;
  } catch {
    return null;
  }
});

// Real-Time Chat WebSocket Handlers
ipcMain.handle('chat:connect', async (_event, roomId) => {
  if (!chatWebSocket) return { ok: false, error: 'Chat WebSocket not initialized' };
  if (!roomId || typeof roomId !== 'string' || !roomId.trim()) {
    if (chatWebSocket.reconnectAll) {
      chatWebSocket.reconnectAll({ forceTokenRefresh: true, resetBackoff: true });
    }
    syncAndConnectUserRooms();
    return { ok: true, state: chatWebSocket.state };
  }
  const cleanRoomId = roomId.trim();
  try {
    const sessionToken = getAuthenticatedSessionToken();
    const deviceId = getDeviceId();

    // Reconnect any pending background rooms
    if (chatWebSocket.reconnectAll) {
      chatWebSocket.reconnectAll({ forceTokenRefresh: true, resetBackoff: true });
    }

    // Resolve room token (cached in memory or fetched via GET /directory/conversations/{roomId}/token)
    const roomTokenData = await chatApi.getRoomToken(sessionToken, cleanRoomId, deviceId);
    const roomAccessToken = roomTokenData?.access_token;
    if (!roomAccessToken) {
      throw new Error('Failed to resolve room token for chat connection');
    }
    const wsUrl = roomTokenData?.chat_websocket_url || undefined;

    chatWebSocket.roomId = cleanRoomId;
    await chatWebSocket.connectRoom(cleanRoomId, {
      token: roomAccessToken,
      url: wsUrl,
      forceTokenRefresh: true
    });

    const roomState = chatWebSocket.getRoomState(cleanRoomId);
    return { ok: true, state: roomState || chatWebSocket.state, roomId: cleanRoomId };
  } catch (err) {
    return { ok: false, error: err.message, state: chatWebSocket?.state || 'error' };
  }
});

ipcMain.handle('chat:reconnect', async () => {
  if (!chatWebSocket) return { ok: false };
  if (chatWebSocket.reconnectAll) {
    chatWebSocket.reconnectAll({ forceTokenRefresh: true, resetBackoff: true });
  }
  syncAndConnectUserRooms();
  return { ok: true, state: chatWebSocket.state };
});

ipcMain.handle('chat:disconnect', () => {
  if (!chatWebSocket) return { ok: false };
  chatWebSocket.disconnect();
  return { ok: true, state: chatWebSocket.state };
});

ipcMain.handle('chat:get-state', () => {
  if (!chatWebSocket) return 'disconnected';
  return chatWebSocket.state;
});

const CHAT_SEND_ERROR_MESSAGES = Object.freeze({
  chat_websocket_unavailable: 'Chat WebSocket is unavailable',
  room_required: 'A room is required for this send',
  room_socket_absent: 'No WebSocket entry exists for the requested room',
  room_socket_error: 'The requested room WebSocket is in an error state',
  room_socket_not_connected: 'The requested room WebSocket is not connected',
  socket_send_failed: 'The requested room WebSocket could not send the frame',
  chat_send_failed: 'The chat frame could not be sent'
});

ipcMain.handle('chat:send', (_event, { type, payload = {}, roomId = null, requestId = null }) => {
  if (!chatWebSocket) {
    return {
      ok: false,
      code: 'chat_websocket_unavailable',
      error: CHAT_SEND_ERROR_MESSAGES.chat_websocket_unavailable
    };
  }
  try {
    const assignedRequestId = chatWebSocket.send(type, payload, roomId, requestId);
    return { ok: true, requestId: assignedRequestId };
  } catch (err) {
    const code = Object.hasOwn(CHAT_SEND_ERROR_MESSAGES, err?.code)
      ? err.code
      : 'chat_send_failed';
    return { ok: false, code, error: CHAT_SEND_ERROR_MESSAGES[code] };
  }
});

ipcMain.handle('chat:typing:start', async (_event, roomId) => {
  if (!roomId) return { ok: false, error: 'roomId required' };
  if (chatWebSocket && chatWebSocket.state === 'connected') {
    try {
      chatWebSocket.typingStarted(roomId);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }
  return { ok: false, error: 'WebSocket not connected' };
});

ipcMain.handle('chat:typing:stop', async (_event, roomId) => {
  if (!roomId) return { ok: false, error: 'roomId required' };
  if (chatWebSocket && chatWebSocket.state === 'connected') {
    try {
      chatWebSocket.typingStopped(roomId);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }
  return { ok: false, error: 'WebSocket not connected' };
});

ipcMain.handle('chat:mark-delivered', async (_event, { roomId, messageId }) => {
  if (!roomId || !messageId) return { ok: false, error: 'roomId and messageId required' };
  let wsSent = false;
  if (chatWebSocket && chatWebSocket.state === 'connected') {
    try {
      chatWebSocket.markDelivered(roomId, messageId);
      wsSent = true;
    } catch (_) { }
  }
  if (!wsSent && chatApi) {
    try {
      const sessionToken = getAuthenticatedSessionToken();
      const deviceId = getDeviceId();
      const roomToken = await chatApi.resolveRoomToken(sessionToken, roomId, deviceId);
      await chatApi.markDelivered(roomToken, roomId, messageId);
      return { ok: true, method: 'rest' };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }
  return { ok: true, method: wsSent ? 'ws' : 'none' };
});

const inflightMarkReadRest = new Map();

ipcMain.handle('chat:mark-read', async (_event, { roomId, messageId }) => {
  if (!roomId || !messageId) return { ok: false, error: 'roomId and messageId required' };
  let wsSent = false;
  if (chatWebSocket && (chatWebSocket.state === 'connected' || chatWebSocket.getRoomState?.(roomId) === 'connected')) {
    try {
      chatWebSocket.markRead(roomId, messageId);
      wsSent = true;
    } catch (_) {
      wsSent = false;
    }
  }

  // Durably persist read receipt in backend database via REST
  let restOk = false;
  let restError = null;
  if (chatApi) {
    const dedupeKey = `${roomId}:${messageId}`;
    if (inflightMarkReadRest.has(dedupeKey)) {
      try {
        const existingResult = await inflightMarkReadRest.get(dedupeKey);
        restOk = existingResult?.ok === true;
      } catch (err) {
        restError = err?.message;
      }
    } else {
      const restPromise = (async () => {
        try {
          const sessionToken = getAuthenticatedSessionToken();
          const deviceId = getDeviceId();
          const roomToken = await chatApi.resolveRoomToken(sessionToken, roomId, deviceId);
          await chatApi.markRead(roomToken, roomId, messageId);
          return { ok: true, method: 'rest' };
        } catch (err) {
          return { ok: false, error: err?.message || 'REST mark-read failed' };
        } finally {
          inflightMarkReadRest.delete(dedupeKey);
        }
      })();
      inflightMarkReadRest.set(dedupeKey, restPromise);
      try {
        const result = await restPromise;
        restOk = result?.ok === true;
        if (!restOk) restError = result?.error;
      } catch (err) {
        restError = err?.message;
      }
    }
  }

  const ok = wsSent || restOk;
  const method = (wsSent && restOk) ? 'both' : (wsSent ? 'ws' : (restOk ? 'rest' : 'none'));
  return { ok, method, error: !ok ? (restError || 'Failed to dispatch read receipt') : undefined };
});

ipcMain.handle('chat:add-reaction', async (_event, { roomId, messageId, emoji }) => {
  if (!roomId || !messageId || !emoji) {
    return { ok: false, error: 'roomId, messageId, and emoji are required' };
  }
  let wsSent = false;
  if (chatWebSocket && chatWebSocket.state === 'connected') {
    try {
      chatWebSocket.addReaction(roomId, messageId, emoji);
      wsSent = true;
    } catch (_) {
      wsSent = false;
    }
  }

  // If WebSocket is not connected, fall back to REST
  if (!wsSent && chatApi) {
    try {
      const sessionToken = getAuthenticatedSessionToken();
      const deviceId = getDeviceId();
      const roomToken = await chatApi.resolveRoomToken(sessionToken, roomId, deviceId);
      const data = await chatApi.addReaction(roomToken, roomId, messageId, emoji);
      return { ok: true, method: 'rest', data };
    } catch (err) {
      return { ok: false, error: err?.message || 'Failed to add reaction' };
    }
  }

  return { ok: true, method: wsSent ? 'ws' : 'none' };
});

ipcMain.handle('chat:remove-reaction', async (_event, { roomId, messageId, emoji }) => {
  if (!roomId || !messageId || !emoji) {
    return { ok: false, error: 'roomId, messageId, and emoji are required' };
  }
  let wsSent = false;
  if (chatWebSocket && chatWebSocket.state === 'connected') {
    try {
      chatWebSocket.removeReaction(roomId, messageId, emoji);
      wsSent = true;
    } catch (_) {
      wsSent = false;
    }
  }

  // If WebSocket is not connected, fall back to REST
  if (!wsSent && chatApi) {
    try {
      const sessionToken = getAuthenticatedSessionToken();
      const deviceId = getDeviceId();
      const roomToken = await chatApi.resolveRoomToken(sessionToken, roomId, deviceId);
      const data = await chatApi.removeReaction(roomToken, roomId, messageId, emoji);
      return { ok: true, method: 'rest', data };
    } catch (err) {
      return { ok: false, error: err?.message || 'Failed to remove reaction' };
    }
  }

  return { ok: true, method: wsSent ? 'ws' : 'none' };
});

// RTC WebSocket Signaling Handlers (Phase 6A/B/C)
function rtcOwnerMatches(owner = {}) {
  return ownerMatchesRequestedRtc(owner, rtcRequestedOwner);
}

function rtcOwnerDiagnostic(owner = {}) {
  const normalized = normalizeRtcOwner(owner);
  return {
    hasOwnerId: Boolean(normalized.ownerId),
    hasCallId: Boolean(normalized.callId),
    hasRoomId: Boolean(normalized.roomId),
    callEpoch: normalized.callEpoch,
    generation: normalized.generation
  };
}

ipcMain.handle('rtc:connect', async (_event, roomIdOrOptions, maybeOptions = {}) => {
  if (!rtcWebSocket) return { ok: false, error: 'RTC WebSocket not initialized' };
  const options = typeof roomIdOrOptions === 'object' && roomIdOrOptions !== null
    ? roomIdOrOptions
    : maybeOptions;
  const rawRoomId = typeof roomIdOrOptions === 'object' && roomIdOrOptions !== null
    ? roomIdOrOptions.roomId
    : roomIdOrOptions;
  if (!rawRoomId || typeof rawRoomId !== 'string' || !rawRoomId.trim()) {
    return { ok: false, error: 'roomId is required to connect RTC WebSocket' };
  }
  const cleanRoomId = rawRoomId.trim();
  const callType = (options.callType || (options.isVideo ? 'video' : 'voice')) || 'voice';
  const generation = ++rtcConnectGeneration;
  const owner = normalizeRtcOwner(options, cleanRoomId, generation);
  rtcRequestedOwner = owner;
  rtcConnectedOwner = null;
  // Invalidate any older pending/connected socket before awaiting this owner's token.
  rtcWebSocket.disconnect();
  console.log('[main][rtc] Connect requested', rtcOwnerDiagnostic(owner));

  try {
    const sessionToken = getAuthenticatedSessionToken();
    const deviceId = getDeviceId();

    // Fetch room token and rtc_websocket_url using directory session.
    const roomTokenData = await chatApi.getRoomToken(sessionToken, cleanRoomId, deviceId);
    if (generation !== rtcConnectGeneration || rtcRequestedOwner?.generation !== generation) {
      return { ok: false, error: 'RTC connect request superseded', superseded: true };
    }
    const roomAccessToken = roomTokenData?.access_token;
    if (!roomAccessToken) {
      throw new Error('Failed to resolve room token for RTC signaling');
    }
    const rtcUrl = roomTokenData?.rtc_websocket_url || undefined;

    await rtcWebSocket.connect({
      roomId: cleanRoomId,
      token: roomAccessToken,
      url: rtcUrl
    });
    if (generation !== rtcConnectGeneration || rtcRequestedOwner?.generation !== generation) {
      return { ok: false, error: 'RTC connect request superseded', superseded: true };
    }
    rtcConnectedOwner = owner;
    console.log('[main][rtc] Connect completed', rtcOwnerDiagnostic(owner));

    return {
      ok: true,
      state: rtcWebSocket.state,
      roomId: cleanRoomId,
      callType,
      callEpoch: owner.callEpoch,
      ownerId: owner.ownerId,
      connectionGeneration: generation,
      iceServers: roomTokenData?.ice_servers || []
    };
  } catch (err) {
    if (generation !== rtcConnectGeneration) {
      return { ok: false, error: 'RTC connect request superseded', superseded: true };
    }
    return { ok: false, error: err.message, state: rtcWebSocket?.state || 'error' };
  }
});

ipcMain.handle('rtc:get-ice-servers', async (_event, roomId) => {
  if (!roomId || typeof roomId !== 'string' || !roomId.trim()) {
    return { ok: false, error: 'roomId is required', iceServers: [] };
  }
  try {
    const sessionToken = getAuthenticatedSessionToken();
    const deviceId = getDeviceId();
    const roomTokenData = await chatApi.getRoomToken(sessionToken, roomId.trim(), deviceId);
    return { ok: true, iceServers: roomTokenData?.ice_servers || [] };
  } catch (err) {
    return { ok: false, error: err.message, iceServers: [] };
  }
});

ipcMain.handle('rtc:disconnect', (_event, owner = {}) => {
  if (!rtcWebSocket) return { ok: false };
  if (!rtcOwnerMatches(owner)) {
    console.log('[main][rtc] Ignored stale disconnect', rtcOwnerDiagnostic(owner));
    return { ok: false, staleOwner: true, state: rtcWebSocket.state };
  }
  ++rtcConnectGeneration;
  rtcWebSocket.disconnect();
  rtcRequestedOwner = null;
  rtcConnectedOwner = null;
  return { ok: true, state: rtcWebSocket.state };
});

ipcMain.handle('rtc:get-state', () => {
  if (!rtcWebSocket) return 'disconnected';
  return rtcWebSocket.state;
});

ipcMain.handle('rtc:send-offer', (_event, { sdp, callType, isVideo, ...options } = {}) => {
  if (!rtcWebSocket) return { ok: false, error: 'RTC WebSocket not initialized' };
  try {
    rtcWebSocket.sendOffer(sdp, { callType, isVideo, ...options });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('rtc:send-answer', (_event, { sdp, requestId }) => {
  if (!rtcWebSocket) return { ok: false, error: 'RTC WebSocket not initialized' };
  try {
    rtcWebSocket.sendAnswer(sdp, requestId);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('rtc:send-candidate', (_event, { candidate, sdpMid, sdpMLineIndex }) => {
  if (!rtcWebSocket) return { ok: false, error: 'RTC WebSocket not initialized' };
  try {
    rtcWebSocket.sendCandidate(candidate, sdpMid, sdpMLineIndex);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('rtc:leave', (_event, owner = {}) => {
  if (!rtcWebSocket) return { ok: false, error: 'RTC WebSocket not initialized' };
  if (!rtcOwnerMatches(owner)) {
    console.log('[main][rtc] Ignored stale leave', rtcOwnerDiagnostic(owner));
    return { ok: false, staleOwner: true };
  }
  try {
    rtcWebSocket.sendLeave();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// Floating Call Window Handlers (WhatsApp Desktop Mini/PIP Window)
ipcMain.handle('floating-call:show', () => {
  const win = getOrCreateFloatingCallWindow();
  if (win && !win.isDestroyed()) {
    const primaryDisplay = screen ? screen.getPrimaryDisplay() : null;
    const workArea = primaryDisplay ? primaryDisplay.workArea : { x: 0, y: 0, width: 1024, height: 768 };
    const bounds = win.getBounds();
    if (bounds.x < workArea.x || bounds.x + bounds.width > workArea.x + workArea.width ||
      bounds.y < workArea.y || bounds.y + bounds.height > workArea.y + workArea.height) {
      const newX = Math.max(workArea.x + 10, Math.round(workArea.x + (workArea.width - bounds.width) / 2));
      const newY = Math.max(workArea.y + 10, Math.round(workArea.y + (workArea.height - bounds.height) / 2));
      win.setPosition(newX, newY);
      lastFloatingPosition = { x: newX, y: newY };
    }
    win.show();
    try {
      win.setAlwaysOnTop(true, 'screen-saver');
      win.focus();
    } catch { }
    if (currentFloatingCallState) {
      win.webContents.send('floating-call:state-changed', currentFloatingCallState);
    }
  }
  return { ok: true };
});

ipcMain.handle('floating-call:hide', () => {
  if (floatingCallWindow && !floatingCallWindow.isDestroyed()) {
    floatingCallWindow.hide();
  }
  return { ok: true };
});

ipcMain.handle('floating-call:minimize', () => {
  if (floatingCallWindow && !floatingCallWindow.isDestroyed()) {
    try {
      floatingCallWindow.setAlwaysOnTop(false);
      floatingCallWindow.minimize();
    } catch (e) {
      console.warn('[main] floatingCallWindow minimize error:', e);
    }
  }
  return { ok: true };
});

ipcMain.handle('floating-call:maximize', () => {
  if (floatingCallWindow && !floatingCallWindow.isDestroyed()) {
    if (floatingCallWindow.isMaximized()) {
      floatingCallWindow.unmaximize();
    } else {
      floatingCallWindow.maximize();
    }
    return { ok: true, isMaximized: Boolean(floatingCallWindow.isMaximized()) };
  }
  return { ok: false, isMaximized: false };
});

ipcMain.handle('floating-call:close', () => {
  if (floatingCallWindow && !floatingCallWindow.isDestroyed()) {
    floatingCallWindow.hide();
  }
  return { ok: true };
});

ipcMain.handle('floating-call:get-state', () => {
  return currentFloatingCallState || null;
});

ipcMain.handle('floating-call:get-mode', () => {
  return currentFloatingMode;
});

ipcMain.handle('floating-call:move-by', (_event, { dx = 0, dy = 0 } = {}) => {
  if (floatingCallWindow && !floatingCallWindow.isDestroyed()) {
    const [currX, currY] = floatingCallWindow.getPosition();
    const [w, h] = floatingCallWindow.getSize();
    const primaryDisplay = screen ? screen.getPrimaryDisplay() : null;
    const workArea = primaryDisplay ? primaryDisplay.workArea : { x: 0, y: 0, width: 1024, height: 768 };

    let newX = currX + Math.round(dx);
    let newY = currY + Math.round(dy);

    newX = Math.max(workArea.x, Math.min(newX, workArea.x + workArea.width - w));
    newY = Math.max(workArea.y, Math.min(newY, workArea.y + workArea.height - h));

    floatingCallWindow.setPosition(newX, newY);
    lastFloatingPosition = { x: newX, y: newY };
  }
  return { ok: true };
});

ipcMain.handle('floating-call:set-position', (_event, { x, y } = {}) => {
  if (floatingCallWindow && !floatingCallWindow.isDestroyed()) {
    const [w, h] = floatingCallWindow.getSize();
    const primaryDisplay = screen ? screen.getPrimaryDisplay() : null;
    const workArea = primaryDisplay ? primaryDisplay.workArea : { x: 0, y: 0, width: 1024, height: 768 };

    let newX = Math.max(workArea.x, Math.min(Math.round(x), workArea.x + workArea.width - w));
    let newY = Math.max(workArea.y, Math.min(Math.round(y), workArea.y + workArea.height - h));

    floatingCallWindow.setPosition(newX, newY);
    lastFloatingPosition = { x: newX, y: newY };
  }
  return { ok: true };
});

ipcMain.handle('floating-call:sync-state', (_event, state) => {
  currentFloatingCallState = state;
  const activeStates = ['incoming_ringing', 'outgoing_ringing', 'connecting', 'connected'];
  isCallActive = Boolean(state && activeStates.includes(state.state));

  if (isCallActive && (!floatingCallWindow || floatingCallWindow.isDestroyed())) {
    getOrCreateFloatingCallWindow();
  }

  if (floatingCallWindow && !floatingCallWindow.isDestroyed()) {
    floatingCallWindow.webContents.send('floating-call:state-changed', state);
    if (!isCallActive) {
      floatingCallWindow.hide();
    } else {
      if (currentFloatingMode !== 'compact') {
        const targetMode = (state.isVideo && state.state === 'connected') ? 'video' : 'detailed';
        if (targetMode !== currentFloatingMode) {
          setFloatingCallMode(targetMode);
        }
      }
      floatingCallWindow.show();
      try {
        floatingCallWindow.setAlwaysOnTop(true, 'screen-saver');
      } catch { }
    }
  }
  return { ok: true };
});

ipcMain.handle('floating-call:action', (_event, action) => {
  if (action === 'restore') {
    if (currentFloatingCallState) {
      currentFloatingCallState.isCallMinimized = false;
    }
    setFloatingCallMode('detailed');
    if (floatingCallWindow && !floatingCallWindow.isDestroyed()) {
      floatingCallWindow.show();
      try { floatingCallWindow.setAlwaysOnTop(true, 'screen-saver'); } catch { }
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('floating-call:dispatch-action', 'restore');
    }
  } else {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('floating-call:dispatch-action', action);
    }
  }
  return { ok: true };
});

ipcMain.handle('floating-call:bridge-signal', (_event, signal) => {
  const sender = _event.sender;
  if (mainWindow && sender === mainWindow.webContents) {
    if (!floatingCallWindow || floatingCallWindow.isDestroyed()) {
      getOrCreateFloatingCallWindow();
    }
    if (floatingCallWindow && !floatingCallWindow.isDestroyed()) {
      if (floatingCallWindow.webContents.isLoading()) {
        if (!floatingCallWindow._pendingBridgeSignals) {
          floatingCallWindow._pendingBridgeSignals = [];
          floatingCallWindow.webContents.once('did-finish-load', () => {
            if (floatingCallWindow && !floatingCallWindow.isDestroyed()) {
              const queue = floatingCallWindow._pendingBridgeSignals || [];
              floatingCallWindow._pendingBridgeSignals = null;
              for (const sig of queue) {
                try {
                  floatingCallWindow.webContents.send('floating-call:bridge-signal', sig);
                } catch (_) { }
              }
            }
          });
        }
        floatingCallWindow._pendingBridgeSignals.push(signal);
      } else {
        floatingCallWindow.webContents.send('floating-call:bridge-signal', signal);
      }
    }
  } else if (floatingCallWindow && sender === floatingCallWindow.webContents) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('floating-call:bridge-signal', signal);
    }
  }
  return { ok: true };
});

// Desktop / Screen Capture Sources Handler (Phase 1 Screen Sharing)
ipcMain.handle('desktop-capture:get-sources', async (_event, options = {}) => {
  try {
    const rawTypes = Array.isArray(options?.types) && options.types.length > 0
      ? options.types
      : ['screen', 'window'];
    const types = rawTypes.filter((t) => t === 'screen' || t === 'window');
    const safeTypes = types.length > 0 ? types : ['screen', 'window'];

    const thumbW = Number.isInteger(options?.thumbnailWidth) && options.thumbnailWidth > 0 && options.thumbnailWidth <= 1280
      ? options.thumbnailWidth
      : 320;
    const thumbH = Number.isInteger(options?.thumbnailHeight) && options.thumbnailHeight > 0 && options.thumbnailHeight <= 720
      ? options.thumbnailHeight
      : 180;

    const sources = await desktopCapturer.getSources({
      types: safeTypes,
      thumbnailSize: { width: thumbW, height: thumbH },
      fetchWindowIcons: true
    });

    return {
      ok: true,
      sources: sources.map((source) => ({
        id: source.id,
        name: source.name || 'Screen',
        thumbnail: source.thumbnail ? source.thumbnail.toDataURL() : null,
        appIcon: source.appIcon ? source.appIcon.toDataURL() : null,
        display_id: source.display_id || '',
        type: source.id.startsWith('screen:') ? 'screen' : 'window'
      }))
    };
  } catch (err) {
    console.error('[main] Failed to enumerate desktop capture sources:', err);
    return { ok: false, error: err?.message || 'Failed to enumerate capture sources', sources: [] };
  }
});

// Conversations / Rooms REST API Handlers
function getAuthenticatedSessionToken() {
  const token = sessionStore?.getSession()?.sessionToken;
  if (!token) {
    const err = new Error('User not authenticated');
    err.code = 'unauthorized';
    err.httpStatus = 401;
    throw err;
  }
  return token;
}

ipcMain.handle('chat-api:list-conversations', async () => {
  try {
    const token = getAuthenticatedSessionToken();
    const data = await chatApi.listConversations(token);
    return { ok: true, data };
  } catch (err) {
    return {
      ok: false,
      error: { message: err.message, code: err.code || 'api_error', httpStatus: err.httpStatus || null }
    };
  }
});

ipcMain.handle('chat-api:get-inbox', async (_event, limit = 30) => {
  try {
    const token = getAuthenticatedSessionToken();
    const data = await chatApi.getInbox(token, { limit });
    return { ok: true, data };
  } catch (err) {
    return {
      ok: false,
      error: { message: err.message, code: err.code || 'api_error', httpStatus: err.httpStatus || null }
    };
  }
});

ipcMain.handle('chat-api:open-direct', async (_event, peerUserId) => {
  try {
    const token = getAuthenticatedSessionToken();
    const data = await chatApi.openDirectConversation(token, peerUserId);
    const newRoomId = data?.roomId || data?.room_id;
    if (chatWebSocket && newRoomId) {
      chatWebSocket.connectRoom(newRoomId).catch(() => { });
    }
    return { ok: true, data };
  } catch (err) {
    return {
      ok: false,
      error: { message: err.message, code: err.code || 'api_error', httpStatus: err.httpStatus || null }
    };
  }
});

ipcMain.handle('chat-api:create-group', async (_event, name, memberUserIds = []) => {
  try {
    const token = getAuthenticatedSessionToken();
    const data = await chatApi.createGroupConversation(token, { name, memberUserIds });
    const newRoomId = data?.roomId || data?.room_id;
    if (chatWebSocket && newRoomId) {
      chatWebSocket.connectRoom(newRoomId).catch(() => { });
    }
    return { ok: true, data };
  } catch (err) {
    return {
      ok: false,
      error: { message: err.message, code: err.code || 'api_error', httpStatus: err.httpStatus || null }
    };
  }
});

ipcMain.handle('chat-api:lookup-contacts', async (_event, phones = []) => {
  try {
    const token = getAuthenticatedSessionToken();
    if (contactCacheService) {
      const data = await contactCacheService.lookupContacts(phones, { sessionToken: token });
      return { ok: true, data };
    }
    const data = await chatApi.lookupContacts(token, phones);
    return { ok: true, data };
  } catch (err) {
    return {
      ok: false,
      error: { message: err.message, code: err.code || 'api_error', httpStatus: err.httpStatus || null }
    };
  }
});

ipcMain.handle('chat-api:block-user', async (_event, userId) => {
  try {
    const token = getAuthenticatedSessionToken();
    const data = await chatApi.blockUser(token, userId);
    return { ok: true, data };
  } catch (err) {
    return {
      ok: false,
      error: { message: err.message, code: err.code || 'api_error', httpStatus: err.httpStatus || null }
    };
  }
});

ipcMain.handle('chat-api:unblock-user', async (_event, userId) => {
  try {
    const token = getAuthenticatedSessionToken();
    const data = await chatApi.unblockUser(token, userId);
    return { ok: true, data };
  } catch (err) {
    return {
      ok: false,
      error: { message: err.message, code: err.code || 'api_error', httpStatus: err.httpStatus || null }
    };
  }
});

ipcMain.handle('chat-api:list-blocked-users', async () => {
  try {
    const token = getAuthenticatedSessionToken();
    const data = await chatApi.listBlockedUsers(token);
    return { ok: true, data };
  } catch (err) {
    return {
      ok: false,
      error: { message: err.message, code: err.code || 'api_error', httpStatus: err.httpStatus || null }
    };
  }
});

ipcMain.handle('chat-api:mute-conversation', async (_event, roomId, duration) => {
  try {
    const token = getAuthenticatedSessionToken();
    const data = await chatApi.muteConversation(token, roomId, duration);
    return { ok: true, data };
  } catch (err) {
    return {
      ok: false,
      error: { message: err.message, code: err.code || 'api_error', httpStatus: err.httpStatus || null }
    };
  }
});

ipcMain.handle('chat-api:unmute-conversation', async (_event, roomId) => {
  try {
    const token = getAuthenticatedSessionToken();
    const data = await chatApi.unmuteConversation(token, roomId);
    return { ok: true, data };
  } catch (err) {
    return {
      ok: false,
      error: { message: err.message, code: err.code || 'api_error', httpStatus: err.httpStatus || null }
    };
  }
});

ipcMain.handle('chat-api:get-room-token', async (_event, roomId) => {
  try {
    const token = getAuthenticatedSessionToken();
    const deviceId = getDeviceId();
    const roomToken = await chatApi.resolveRoomToken(token, roomId, deviceId);
    const entry = chatApi.roomTokenCache.getEntry(roomId);
    return {
      ok: true,
      data: {
        roomId,
        expiresAt: entry?.expiresAt || null,
        hasToken: Boolean(roomToken)
      }
    };
  } catch (err) {
    return {
      ok: false,
      error: { message: err.message, code: err.code || 'api_error', httpStatus: err.httpStatus || null }
    };
  }
});

ipcMain.handle('chat-api:get-messages', async (_event, roomId, options = {}) => {
  try {
    const token = getAuthenticatedSessionToken();
    const deviceId = getDeviceId();
    const roomToken = await chatApi.resolveRoomToken(token, roomId, deviceId);
    const data = await chatApi.listMessages(roomToken, roomId, options);

    // Reconcile WebSocket room cursor with newest sequence from fetched history
    if (chatWebSocket && roomId && Array.isArray(data?.messages) && data.messages.length > 0) {
      let newest = 0;
      for (const m of data.messages) {
        const seq = m.eventSeq ?? m.event_seq ?? 0;
        if (typeof seq === 'number' && seq > newest) newest = seq;
      }
      if (newest > 0) {
        const current = chatWebSocket.getRoomCursor(roomId);
        if (current === undefined || newest > current) {
          chatWebSocket.setRoomCursor(roomId, newest);
        }
      }
    }

    return { ok: true, data };
  } catch (err) {
    return {
      ok: false,
      error: { message: err.message, code: err.code || 'api_error', httpStatus: err.httpStatus || null }
    };
  }
});

ipcMain.handle('chat-api:get-members', async (_event, roomId) => {
  try {
    const token = getAuthenticatedSessionToken();
    const data = await chatApi.getGroupMembers(token, roomId);
    return { ok: true, data };
  } catch (err) {
    return {
      ok: false,
      error: { message: err.message, code: err.code || 'api_error', httpStatus: err.httpStatus || null }
    };
  }
});

ipcMain.handle('chat-api:get-participants', async (_event, roomId) => {
  try {
    const token = getAuthenticatedSessionToken();
    // Prefer Directory API GET /v1/directory/conversations/{roomId}/members
    const data = await chatApi.getGroupMembers(token, roomId);
    return { ok: true, data };
  } catch (err) {
    try {
      const token = getAuthenticatedSessionToken();
      const deviceId = getDeviceId();
      const roomToken = await chatApi.resolveRoomToken(token, roomId, deviceId);
      const data = await chatApi.getParticipants(roomToken, roomId);
      return { ok: true, data };
    } catch {
      return {
        ok: false,
        error: { message: err.message, code: err.code || 'api_error', httpStatus: err.httpStatus || null }
      };
    }
  }
});

ipcMain.handle('chat-api:update-group', async (_event, roomId, updates = {}) => {
  try {
    const token = getAuthenticatedSessionToken();
    const data = await chatApi.updateGroup(token, roomId, updates);
    return { ok: true, data };
  } catch (err) {
    return {
      ok: false,
      error: { message: err.message, code: err.code || 'api_error', httpStatus: err.httpStatus || null }
    };
  }
});

ipcMain.handle('chat-api:add-members', async (_event, roomId, userIds) => {
  try {
    const token = getAuthenticatedSessionToken();
    const data = await chatApi.addGroupMembers(token, roomId, userIds);
    return { ok: true, data };
  } catch (err) {
    return {
      ok: false,
      error: { message: err.message, code: err.code || 'api_error', httpStatus: err.httpStatus || null }
    };
  }
});

ipcMain.handle('chat-api:add-member', async (_event, roomId, userId) => {
  try {
    const token = getAuthenticatedSessionToken();
    const data = await chatApi.addGroupMembers(token, roomId, [userId]);
    return { ok: true, data };
  } catch (err) {
    return {
      ok: false,
      error: { message: err.message, code: err.code || 'api_error', httpStatus: err.httpStatus || null }
    };
  }
});

ipcMain.handle('chat-api:remove-member', async (_event, roomId, principalId) => {
  try {
    const token = getAuthenticatedSessionToken();
    const data = await chatApi.removeGroupMember(token, roomId, principalId);
    return { ok: true, data };
  } catch (err) {
    return {
      ok: false,
      error: { message: err.message, code: err.code || 'api_error', httpStatus: err.httpStatus || null }
    };
  }
});

ipcMain.handle('chat-api:set-member-role', async (_event, roomId, principalId, role) => {
  try {
    const token = getAuthenticatedSessionToken();
    const data = await chatApi.updateMemberRole(token, roomId, principalId, role);
    return { ok: true, data };
  } catch (err) {
    return {
      ok: false,
      error: { message: err.message, code: err.code || 'api_error', httpStatus: err.httpStatus || null }
    };
  }
});

ipcMain.handle('chat-api:leave-group', async (_event, roomId) => {
  try {
    const token = getAuthenticatedSessionToken();
    const data = await chatApi.leaveGroupConversation(token, roomId);
    return { ok: true, data };
  } catch (err) {
    return {
      ok: false,
      error: { message: err.message, code: err.code || 'api_error', httpStatus: err.httpStatus || null }
    };
  }
});

ipcMain.handle('chat-api:get-unread', async (_event, roomId) => {
  try {
    const token = getAuthenticatedSessionToken();
    const deviceId = getDeviceId();
    const roomToken = await chatApi.resolveRoomToken(token, roomId, deviceId);
    const data = await chatApi.getUnread(roomToken, roomId);
    return { ok: true, data };
  } catch (err) {
    return {
      ok: false,
      error: { message: err.message, code: err.code || 'api_error', httpStatus: err.httpStatus || null }
    };
  }
});

ipcMain.handle('chat-api:search-messages', async (_event, roomId, query, options = {}) => {
  try {
    const token = getAuthenticatedSessionToken();
    const deviceId = getDeviceId();
    const roomToken = await chatApi.resolveRoomToken(token, roomId, deviceId);
    const data = await chatApi.searchMessages(roomToken, roomId, query, options);
    return { ok: true, data };
  } catch (err) {
    return {
      ok: false,
      error: { message: err.message, code: err.code || 'api_error', httpStatus: err.httpStatus || null }
    };
  }
});

ipcMain.handle('chat-api:mark-delivered', async (_event, roomId, messageId) => {
  try {
    const token = getAuthenticatedSessionToken();
    const deviceId = getDeviceId();
    const roomToken = await chatApi.resolveRoomToken(token, roomId, deviceId);
    const data = await chatApi.markDelivered(roomToken, roomId, messageId);
    return { ok: true, data };
  } catch (err) {
    return {
      ok: false,
      error: { message: err.message, code: err.code || 'api_error', httpStatus: err.httpStatus || null }
    };
  }
});

ipcMain.handle('chat-api:mark-read', async (_event, roomId, messageId) => {
  try {
    const token = getAuthenticatedSessionToken();
    const deviceId = getDeviceId();
    const roomToken = await chatApi.resolveRoomToken(token, roomId, deviceId);
    const data = await chatApi.markRead(roomToken, roomId, messageId);
    return { ok: true, data };
  } catch (err) {
    return {
      ok: false,
      error: { message: err.message, code: err.code || 'api_error', httpStatus: err.httpStatus || null }
    };
  }
});

ipcMain.handle('chat-api:edit-message', async (_event, roomId, messageId, body) => {
  try {
    const token = getAuthenticatedSessionToken();
    const deviceId = getDeviceId();
    const roomToken = await chatApi.resolveRoomToken(token, roomId, deviceId);
    const data = await chatApi.editMessage(roomToken, roomId, messageId, body);
    return { ok: true, data };
  } catch (err) {
    return {
      ok: false,
      error: { message: err.message, code: err.code || 'api_error', httpStatus: err.httpStatus || null }
    };
  }
});

ipcMain.handle('chat-api:delete-message', async (_event, roomId, messageId) => {
  try {
    const token = getAuthenticatedSessionToken();
    const deviceId = getDeviceId();
    const roomToken = await chatApi.resolveRoomToken(token, roomId, deviceId);
    const data = await chatApi.deleteMessage(roomToken, roomId, messageId);
    return { ok: true, data };
  } catch (err) {
    return {
      ok: false,
      error: { message: err.message, code: err.code || 'api_error', httpStatus: err.httpStatus || null }
    };
  }
});

// ═════════════════════════════════════════════════════════════════
// ATTACHMENT & MEDIA IPC HANDLERS
// ═════════════════════════════════════════════════════════════════

ipcMain.handle('chat-api:init-attachment', async (_event, roomId, params = {}) => {
  try {
    const token = getAuthenticatedSessionToken();
    const deviceId = getDeviceId();
    const roomToken = await chatApi.resolveRoomToken(token, roomId, deviceId);
    const data = await chatApi.initAttachment(roomToken, roomId, params);
    return { ok: true, data };
  } catch (err) {
    return {
      ok: false,
      error: { message: err.message, code: err.code || 'api_error', httpStatus: err.httpStatus || null }
    };
  }
});

ipcMain.handle('chat-api:complete-attachment', async (_event, roomId, attachmentId) => {
  try {
    const token = getAuthenticatedSessionToken();
    const deviceId = getDeviceId();
    const roomToken = await chatApi.resolveRoomToken(token, roomId, deviceId);
    const data = await chatApi.completeAttachment(roomToken, roomId, attachmentId);
    return { ok: true, data };
  } catch (err) {
    return {
      ok: false,
      error: { message: err.message, code: err.code || 'api_error', httpStatus: err.httpStatus || null }
    };
  }
});

ipcMain.handle('chat-api:download-attachment', async (_event, roomId, attachmentId) => {
  try {
    const token = getAuthenticatedSessionToken();
    const deviceId = getDeviceId();
    const roomToken = await chatApi.resolveRoomToken(token, roomId, deviceId);
    const data = await chatApi.downloadAttachment(roomToken, roomId, attachmentId);
    return { ok: true, data };
  } catch (err) {
    return {
      ok: false,
      error: { message: err.message, code: err.code || 'api_error', httpStatus: err.httpStatus || null }
    };
  }
});

ipcMain.handle('chat-api:init-multipart-upload', async (_event, roomId, params = {}) => {
  try {
    const token = getAuthenticatedSessionToken();
    const deviceId = getDeviceId();
    const roomToken = await chatApi.resolveRoomToken(token, roomId, deviceId);
    const data = await chatApi.initMultipartUpload(roomToken, roomId, params);
    return { ok: true, data };
  } catch (err) {
    return {
      ok: false,
      error: { message: err.message, code: err.code || 'api_error', httpStatus: err.httpStatus || null }
    };
  }
});

ipcMain.handle('chat-api:complete-multipart-upload', async (_event, roomId, attachmentId, parts = []) => {
  try {
    const token = getAuthenticatedSessionToken();
    const deviceId = getDeviceId();
    const roomToken = await chatApi.resolveRoomToken(token, roomId, deviceId);
    const data = await chatApi.completeMultipartUpload(roomToken, roomId, attachmentId, parts);
    return { ok: true, data };
  } catch (err) {
    return {
      ok: false,
      error: { message: err.message, code: err.code || 'api_error', httpStatus: err.httpStatus || null }
    };
  }
});

ipcMain.handle('chat-api:upload-media', async (event, payload = {}) => {
  const { roomId, filePath, fileId, fileBuffer, filename, declaredMime, byteSize, sourceAttachmentId, sourceRoomId, sessionId, uploadSessionId } = payload;
  try {
    if (!roomId) throw new Error('roomId is required');
    let buffer = null;
    let size = byteSize;
    let name = filename;
    let targetFilePath = filePath || null;

    if (!targetFilePath && fileId && pendingMediaUploads.has(fileId)) {
      const pending = pendingMediaUploads.get(fileId);
      targetFilePath = pending.filePath;
      name = name || pending.filename;
      size = size || pending.byteSize;
    }

    if (!targetFilePath && !fileBuffer && sourceAttachmentId) {
      const cacheDir = path.join(app.getPath('userData'), 'attachments_cache');
      await ensureAttachmentCacheDir(cacheDir);
      const isCached = await isAttachmentCached(cacheDir, sourceAttachmentId, name, declaredMime);
      if (isCached) {
        targetFilePath = getSafeAttachmentCachePath(cacheDir, sourceAttachmentId, name, declaredMime);
      } else if (sourceRoomId) {
        const token = getAuthenticatedSessionToken();
        const deviceId = getDeviceId();
        const sourceRoomToken = await chatApi.resolveRoomToken(token, sourceRoomId, deviceId);
        const dl = await chatApi.downloadAttachment(sourceRoomToken, sourceRoomId, sourceAttachmentId);
        const targetUrl = dl?.downloadUrl || dl?.download_url;
        if (!targetUrl) {
          throw new Error('Could not resolve download URL for source attachment');
        }
        const resp = await fetch(targetUrl);
        if (!resp.ok) {
          throw new Error(`Failed to download source attachment: HTTP ${resp.status}`);
        }
        const arrayBuf = await resp.arrayBuffer();
        targetFilePath = await saveAttachmentToCache(cacheDir, sourceAttachmentId, name, Buffer.from(arrayBuf), declaredMime);
      } else {
        throw new Error('Source attachment is not cached and sourceRoomId was not provided');
      }
    }

    if (targetFilePath) {
      if (!fs.existsSync(targetFilePath)) throw new Error('File does not exist');
      const stat = await fsPromises.stat(targetFilePath);
      size = stat.size;
      name = name || path.basename(targetFilePath);

      // Read first 64 bytes for magic byte validation
      const fd = await fsPromises.open(targetFilePath, 'r');
      const headerBuf = Buffer.alloc(Math.min(64, size));
      await fd.read(headerBuf, 0, headerBuf.length, 0);
      await fd.close();

      const validation = validateMediaFile({
        filename: name,
        byteSize: size,
        declaredMime,
        headerBytes: headerBuf
      });
      if (!validation.isValid) {
        throw new Error(validation.error || 'Media file validation failed');
      }
    } else if (fileBuffer) {
      buffer = Buffer.from(fileBuffer);
      size = buffer.length;
      const headerBuf = buffer.subarray(0, Math.min(64, buffer.length));
      const validation = validateMediaFile({
        filename: name,
        byteSize: size,
        declaredMime,
        headerBytes: headerBuf
      });
      if (!validation.isValid) {
        throw new Error(validation.error || 'Media file validation failed');
      }
    } else {
      throw new Error('Either fileId, filePath, or fileBuffer is required');
    }

    const token = getAuthenticatedSessionToken();
    const deviceId = getDeviceId();
    const roomToken = await chatApi.resolveRoomToken(token, roomId, deviceId);

    const validation = validateMediaFile({ filename: name, byteSize: size, declaredMime });
    const mime = validation.effectiveMime;
    const kind = validation.kind;

    const uploadRes = await uploadManager.uploadMedia({
      roomToken,
      roomId,
      filePath: targetFilePath,
      buffer,
      filename: name,
      mime,
      byteSize: size,
      kind,
      sessionId: sessionId || uploadSessionId,
      onProgress: (p) => {
        event.sender.send('chat:upload-progress', {
          roomId: p.roomId,
          attachmentId: p.attachmentId,
          progress: p.progress,
          filename: p.filename,
          uploadedBytes: p.uploadedBytes,
          totalBytes: p.totalBytes
        });
      }
    });

    if (fileId) pendingMediaUploads.delete(fileId);
    return uploadRes;
  } catch (err) {
    if (fileId) pendingMediaUploads.delete(fileId);
    return {
      ok: false,
      error: { message: err.message, code: err.code || 'upload_failed', httpStatus: err.httpStatus || null }
    };
  }
});

ipcMain.handle('chat-api:cancel-upload', async (_event, payload = {}) => {
  try {
    const sessionId = typeof payload === 'string' ? payload : (payload?.sessionId || payload?.uploadSessionId);
    const res = await uploadManager.cancelUpload(sessionId);
    return { ok: true, data: res };
  } catch (err) {
    return { ok: false, error: { message: err.message } };
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// CHAT THEME IPC HANDLERS
// All wallpaper file operations are sandboxed to userData/themes/wallpapers/.
// The renderer never receives arbitrary filesystem paths — only safe data URLs.
// ─────────────────────────────────────────────────────────────────────────────

const WALLPAPER_ALLOWED_EXTS = new Set(['png', 'jpg', 'jpeg', 'webp']);
const MAX_WALLPAPER_SIZE = 20 * 1024 * 1024; // 20 MB

async function getWallpaperDir() {
  const dir = path.join(app.getPath('userData'), 'themes', 'wallpapers');
  await fsPromises.mkdir(dir, { recursive: true });
  return dir;
}

/** Secure wallpaper file picker — returns data URL for preview; saves copy to userData. */
ipcMain.handle('theme:pick-wallpaper', async () => {
  if (!mainWindow) return { ok: false, error: 'Main window not available' };
  try {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose Wallpaper Image',
      buttonLabel: 'Use as Wallpaper',
      filters: [{ name: 'Images (PNG, JPG, WebP)', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
      properties: ['openFile']
    });

    if (res.canceled || !res.filePaths || res.filePaths.length === 0) {
      return { ok: true, canceled: true };
    }

    const filePath = res.filePaths[0];
    const stat = await fsPromises.stat(filePath);

    if (!stat.isFile()) return { ok: false, error: 'Selected path is not a regular file' };
    if (stat.size === 0) return { ok: false, error: 'Selected file is empty' };
    if (stat.size > MAX_WALLPAPER_SIZE) return { ok: false, error: 'Wallpaper image cannot exceed 20 MB' };

    const filename = path.basename(filePath);
    const ext = (filename.split('.').pop() || '').toLowerCase().trim();
    if (!WALLPAPER_ALLOWED_EXTS.has(ext)) {
      return { ok: false, error: 'Only PNG, JPG, and WebP images are supported' };
    }

    const buffer = await fsPromises.readFile(filePath);

    // Magic byte validation
    const header = buffer.subarray(0, 16);
    const isPng = header[0] === 0x89 && header[1] === 0x50;
    const isJpg = header[0] === 0xFF && header[1] === 0xD8;
    const isWebP = header.slice(8, 12).toString('ascii') === 'WEBP';
    if (!isPng && !isJpg && !isWebP) {
      return { ok: false, error: 'File does not appear to be a valid image' };
    }

    // Validate with nativeImage decode
    const img = nativeImage.createFromBuffer(buffer);
    if (img.isEmpty()) return { ok: false, error: 'Image file could not be decoded' };

    const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : (ext === 'webp' ? 'image/webp' : 'image/png');
    const dataUrl = `data:${mime};base64,${buffer.toString('base64')}`;

    // Save to userData/themes/wallpapers with a safe generated name
    const wallpaperDir = await getWallpaperDir();
    const safeFilename = `wp_${Date.now()}_${path.basename(filePath, path.extname(filePath)).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 32)}.${ext}`;
    const destPath = path.join(wallpaperDir, safeFilename);
    await fsPromises.writeFile(destPath, buffer);

    return { ok: true, canceled: false, previewDataUrl: dataUrl, localPath: destPath, safeFilename, mime };
  } catch (err) {
    return { ok: false, error: err.message || 'Failed to select wallpaper' };
  }
});

/** Load a previously saved wallpaper as a data URL. */
ipcMain.handle('theme:load-wallpaper-data', async (_event, localPath) => {
  try {
    if (!localPath || typeof localPath !== 'string') return { ok: false, error: 'Invalid path' };

    // Safety: must be inside userData/themes/wallpapers/
    const wallpaperDir = await getWallpaperDir();
    const resolved = path.resolve(localPath);
    if (!resolved.startsWith(wallpaperDir)) {
      return { ok: false, error: 'Access denied: path outside wallpaper directory' };
    }

    const ext = (path.extname(resolved).replace('.', '') || '').toLowerCase();
    if (!WALLPAPER_ALLOWED_EXTS.has(ext)) return { ok: false, error: 'Unsupported file type' };

    const stat = await fsPromises.stat(resolved);
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_WALLPAPER_SIZE) {
      return { ok: false, error: 'Invalid wallpaper file' };
    }

    const buffer = await fsPromises.readFile(resolved);
    const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : (ext === 'webp' ? 'image/webp' : 'image/png');
    const dataUrl = `data:${mime};base64,${buffer.toString('base64')}`;
    return { ok: true, dataUrl };
  } catch (err) {
    return { ok: false, error: err.message || 'Failed to load wallpaper' };
  }
});

/** Delete a stored wallpaper file. */
ipcMain.handle('theme:delete-wallpaper', async (_event, localPath) => {
  try {
    if (!localPath || typeof localPath !== 'string') return { ok: false, error: 'Invalid path' };
    const wallpaperDir = await getWallpaperDir();
    const resolved = path.resolve(localPath);
    if (!resolved.startsWith(wallpaperDir)) {
      return { ok: false, error: 'Access denied: path outside wallpaper directory' };
    }
    await fsPromises.unlink(resolved).catch(() => { });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

/** Get the stored theme for a room. */
ipcMain.handle('theme:get-room-theme', async (_event, roomId) => {
  try {
    if (!themeStore) return { ok: true, theme: null };
    const theme = await themeStore.getRoomTheme(roomId);
    return { ok: true, theme };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

/** Persist the theme for a room. */
ipcMain.handle('theme:set-room-theme', async (_event, roomId, theme) => {
  try {
    if (!themeStore) return { ok: false, error: 'ThemeStore not initialized' };
    const saved = await themeStore.setRoomTheme(roomId, theme);
    return { ok: true, theme: saved };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

/** Reset/remove custom theme for a room. */
ipcMain.handle('theme:reset-room-theme', async (_event, roomId) => {
  try {
    if (!themeStore) return { ok: false, error: 'ThemeStore not initialized' };
    const saved = await themeStore.resetRoomTheme(roomId);
    return { ok: true, theme: saved };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

/** Get the global app theme preference. */
ipcMain.handle('theme:get-app-theme', async () => {
  try {
    if (!themeStore) return { ok: true, theme: 'system' };
    const theme = await themeStore.getAppTheme();
    return { ok: true, theme };
  } catch (err) {
    return { ok: false, error: err.message, theme: 'system' };
  }
});

/** Set and persist global app theme preference. */
ipcMain.handle('theme:set-app-theme', async (_event, appTheme) => {
  try {
    if (!themeStore) return { ok: false, error: 'ThemeStore not initialized' };
    const saved = await themeStore.setAppTheme(appTheme);
    return { ok: true, theme: saved };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// Native Windows file selection dialog
ipcMain.handle('dialog:open-media-file', async (event, { category = 'all' } = {}) => {
  try {
    let filters = [];
    if (category === 'photos_videos') {
      filters = [
        { name: 'Photos & Videos', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'tiff', 'tif', 'mp4', 'webm', 'mov'] },
        { name: 'All Files', extensions: ['*'] }
      ];
    } else if (category === 'documents') {
      filters = [
        { name: 'Documents & Files', extensions: ['pdf', 'zip', 'rar', 'gz', 'tar', 'txt', 'csv', 'json', 'xml', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx'] },
        { name: 'All Files', extensions: ['*'] }
      ];
    } else if (category === 'audio') {
      filters = [
        { name: 'Audio Files', extensions: ['mp3', 'ogg', 'wav', 'flac', 'aac'] },
        { name: 'All Files', extensions: ['*'] }
      ];
    } else {
      filters = [
        { name: 'Supported Media & Files', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'mp4', 'webm', 'mov', 'mp3', 'ogg', 'wav', 'pdf', 'zip', 'txt', 'csv', 'doc', 'docx', 'xls', 'xlsx'] },
        { name: 'All Files', extensions: ['*'] }
      ];
    }

    const parentWin = (event?.sender ? BrowserWindow.fromWebContents(event.sender) : null) || mainWindow;
    const res = await dialog.showOpenDialog(parentWin, {
      title: 'Select file to send',
      properties: ['openFile'],
      filters
    });

    if (res.canceled || !res.filePaths || res.filePaths.length === 0) {
      return { canceled: true, ok: true };
    }

    const filePath = res.filePaths[0];
    const stat = await fsPromises.stat(filePath);
    if (!stat.isFile()) {
      return { canceled: false, ok: false, error: 'Selected path is not a regular file' };
    }
    if (stat.size === 0) {
      return { canceled: false, ok: false, error: 'Selected file is empty (0 bytes)' };
    }

    const filename = path.basename(filePath);

    // Read first 64 bytes for magic byte validation
    const fd = await fsPromises.open(filePath, 'r');
    const headerBuf = Buffer.alloc(Math.min(64, stat.size));
    await fd.read(headerBuf, 0, headerBuf.length, 0);
    await fd.close();

    const validation = validateMediaFile({
      filename,
      byteSize: stat.size,
      headerBytes: headerBuf
    });

    if (!validation.isValid) {
      return {
        canceled: false,
        ok: false,
        error: validation.error || 'Media file validation failed'
      };
    }

    const effectiveMime = validation.effectiveMime;
    const kind = validation.kind;

    // Prune stale pending uploads older than 30 minutes
    const now = Date.now();
    for (const [id, item] of pendingMediaUploads) {
      if (now - item.createdAt > 30 * 60 * 1000) {
        pendingMediaUploads.delete(id);
      }
    }

    // Generate ephemeral safe fileId
    const fileId = 'att-pick-' + crypto.randomUUID();
    pendingMediaUploads.set(fileId, {
      filePath,
      filename,
      mime: effectiveMime,
      byteSize: stat.size,
      kind,
      createdAt: now
    });

    // Provide safe preview data required by attachment rendering system:
    // - For images <= 15MB: base64 data URL
    // - For small audio <= 5MB: base64 data URL
    // - For small video <= 10MB: base64 data URL
    // - For documents/PDFs: null (no unnecessary preview generated)
    let previewUrl = null;
    if (kind === 'image' && stat.size <= 15 * 1024 * 1024) {
      const imgBuf = await fsPromises.readFile(filePath);
      previewUrl = `data:${effectiveMime};base64,${imgBuf.toString('base64')}`;
    } else if (kind === 'audio' && stat.size <= 5 * 1024 * 1024) {
      const audioBuf = await fsPromises.readFile(filePath);
      previewUrl = `data:${effectiveMime};base64,${audioBuf.toString('base64')}`;
    } else if (kind === 'video' && stat.size <= 10 * 1024 * 1024) {
      const videoBuf = await fsPromises.readFile(filePath);
      previewUrl = `data:${effectiveMime};base64,${videoBuf.toString('base64')}`;
    }

    // Notice: raw host filePath is NEVER exposed to the renderer!
    return {
      canceled: false,
      ok: true,
      fileId,
      filename,
      byteSize: stat.size,
      mime: effectiveMime,
      kind,
      previewUrl
    };
  } catch (err) {
    return { canceled: false, ok: false, error: err.message };
  }
});

// Safe file download via Save Dialog (never auto-executing)
ipcMain.handle('dialog:save-media-file', async (_event, { defaultFilename = 'download', downloadUrl }) => {
  try {
    if (!downloadUrl) throw new Error('downloadUrl is required');
    const res = await dialog.showSaveDialog(mainWindow, {
      title: 'Save Attachment',
      defaultPath: defaultFilename
    });
    if (res.canceled || !res.filePath) return { canceled: true };

    const response = await fetch(downloadUrl);
    if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}`);
    const arrayBuffer = await response.arrayBuffer();
    await fsPromises.writeFile(res.filePath, Buffer.from(arrayBuffer));
    return { ok: true, savedPath: res.filePath };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// Secure media attachment open handler: checks cache, downloads if needed, and opens with default app
ipcMain.handle('media:open-attachment', async (_event, { attachmentId, filename, downloadUrl, roomId, mime = '' } = {}) => {
  try {
    if (!attachmentId && !downloadUrl) {
      return { ok: false, error: 'attachmentId or downloadUrl is required' };
    }

    const cacheDir = path.join(app.getPath('userData'), 'attachments_cache');
    await ensureAttachmentCacheDir(cacheDir);

    const cachedPath = getSafeAttachmentCachePath(cacheDir, attachmentId, filename, mime);

    // 1. Check if already cached locally
    const alreadyCached = await isAttachmentCached(cacheDir, attachmentId, filename, mime);

    if (!alreadyCached) {
      // 2. Resolve presigned download URL if not provided
      let targetUrl = downloadUrl;
      if (!targetUrl && attachmentId && roomId) {
        const token = getAuthenticatedSessionToken();
        const deviceId = getDeviceId();
        const roomToken = await chatApi.resolveRoomToken(token, roomId, deviceId);
        const dl = await chatApi.downloadAttachment(roomToken, roomId, attachmentId);
        targetUrl = dl.downloadUrl || dl.download_url;
      }

      if (!targetUrl) {
        return { ok: false, error: 'Attachment download URL could not be resolved' };
      }

      // Download file to temp then atomically save to cache
      const resp = await fetch(targetUrl);
      if (!resp.ok) {
        return { ok: false, error: `Download failed: HTTP ${resp.status}` };
      }

      const arrayBuffer = await resp.arrayBuffer();
      if (!arrayBuffer || arrayBuffer.byteLength === 0) {
        return { ok: false, error: 'Downloaded file is empty' };
      }

      await saveAttachmentToCache(cacheDir, attachmentId, filename, Buffer.from(arrayBuffer), mime);
    }

    // 3. Open the file with Windows default handler (e.g. Edge or Adobe Acrobat for PDF)
    const openError = await shell.openPath(cachedPath);
    if (openError) {
      return { ok: false, error: `Failed to open with default application: ${openError}` };
    }

    return { ok: true, cachedPath };
  } catch (err) {
    console.error('[media:open-attachment] Failed:', err.message);
    return { ok: false, error: err.message };
  }
});

// Secure cached media deletion handler: deletes only matching files inside managed cache directory
ipcMain.handle('media:delete-cached-attachments', async (_event, payload = {}) => {
  try {
    const rawIds = (payload && typeof payload === 'object' && 'attachmentIds' in payload)
      ? payload.attachmentIds
      : payload;

    if (!Array.isArray(rawIds) && !(rawIds instanceof Set)) {
      return { success: true, count: 0, ok: true, deletedCount: 0, deletedFiles: [] };
    }
    const ids = Array.isArray(rawIds) ? rawIds : Array.from(rawIds);
    if (ids.length === 0) {
      return { success: true, count: 0, ok: true, deletedCount: 0, deletedFiles: [] };
    }
    const cacheDir = path.join(app.getPath('userData'), 'attachments_cache');
    const result = await deleteCachedAttachments(cacheDir, ids);
    return {
      success: true,
      count: result.deletedCount,
      ok: true,
      deletedCount: result.deletedCount,
      deletedFiles: result.deletedFiles
    };
  } catch (err) {
    console.error('[media:delete-cached-attachments] Error:', err.message);
    return { success: false, count: 0, ok: false, error: err.message };
  }
});

// Shell IPC handlers for safe external opening and revealing in File Explorer
ipcMain.handle('shell:open-external', async (_event, url) => {
  if (typeof url === 'string' && (url.startsWith('https://') || url.startsWith('http://'))) {
    try {
      await shell.openExternal(url);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }
  return { ok: false, error: 'Invalid URL' };
});

ipcMain.handle('shell:open-path', async (_event, filePath) => {
  if (typeof filePath === 'string') {
    const error = await shell.openPath(filePath);
    return { ok: !error, error };
  }
  return { ok: false, error: 'Invalid file path' };
});

ipcMain.handle('shell:show-item-in-folder', async (_event, filePath) => {
  if (typeof filePath === 'string') {
    shell.showItemInFolder(filePath);
    return { ok: true };
  }
  return { ok: false, error: 'Invalid file path' };
});

async function syncAndConnectUserRooms() {
  const sessionToken = getAuthenticatedSessionToken();
  if (!sessionToken || !chatWebSocket) return;
  try {
    const data = await chatApi.listConversations(sessionToken);
    const convs = Array.isArray(data?.conversations) ? data.conversations : [];
    if (convs.length === 0) {
      chatWebSocket._setState(CONNECTION_STATE.CONNECTED);
      return;
    }
    for (const c of convs) {
      const rId = c.roomId || c.id || c.room_id;
      if (rId) {
        chatWebSocket.connectRoom(rId).catch((err) => {
          console.warn(`[main] Failed to connect room ${rId}:`, err?.message || err);
        });
      }
    }
  } catch (err) {
    console.warn('[main] syncAndConnectUserRooms failed:', err?.message || err);
  }
}

app.whenReady().then(async () => {
  const userDataPath = app.getPath('userData');
  getOrCreatePersistentDeviceId(userDataPath);
  sessionStore = new SessionStore(userDataPath);
  themeStore = new ThemeStore(app.getPath('userData'));
  notificationStore = new NotificationStore(userDataPath);
  await notificationStore.load();
  databaseService = new DatabaseService({
    storageDir: app.getPath('userData'),
    sessionStore
  });
  databaseService.registerIpcHandlers(ipcMain);
  backupService = new BackupService({
    databaseService,
    storageDir: userDataPath,
    sessionStore
  });
  contactCacheService = new ContactCacheService({
    databaseService,
    chatApi,
    sessionStore,
    onContactUpdated: (updatedContact) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('contacts:updated', updatedContact);
      }
    }
  });
  uploadManager.setDatabaseService(databaseService);
  databaseService.cleanStaleUploadSessions().catch(err => {
    console.warn('[main] cleanStaleUploadSessions warning:', err.message);
  });
  contactCacheService.pruneOldCache().catch(err => {
    console.warn('[main] pruneOldCache warning:', err.message);
  });
  authController = new AuthController({ api: ollacoreApi, sessionStore });
  await authController.init();

  // Initialize ChatWebSocket with multiRoom enabled for persistent background connectivity
  chatWebSocket = new ChatWebSocket({
    multiRoom: true,
    maxReconnectAttempts: Infinity,
    getToken: async (roomId) => {
      const targetRoomId = roomId || chatWebSocket?.roomId;
      if (!targetRoomId) return null;
      const sessionToken = sessionStore?.getSession()?.sessionToken;
      if (!sessionToken) return null;
      const deviceId = getDeviceId();
      const tokenData = await chatApi.getRoomToken(sessionToken, targetRoomId, deviceId);
      if (tokenData?.chat_websocket_url) {
        chatWebSocket.url = tokenData.chat_websocket_url;
      }
      return tokenData?.access_token || null;
    }
  });

  // Forward connection state and frames to renderer securely
  chatWebSocket.on('stateChange', (data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('chat:state-change', data);
    }
  });

  chatWebSocket.on('frame', (frame) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('chat:event', frame);
    }
  });

  // Initialize RtcWebSocket for Phase 6A signaling
  rtcWebSocket = new RtcWebSocket();

  rtcWebSocket.on('state_change', (data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      const owner = rtcConnectedOwner || rtcRequestedOwner;
      mainWindow.webContents.send('rtc:state-change', {
        ...data,
        callEpoch: owner?.callEpoch ?? null,
        ownerId: owner?.ownerId ?? null,
        connectionGeneration: owner?.generation ?? null
      });
    }
  });

  rtcWebSocket.on('event', (data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      const owner = rtcConnectedOwner || rtcRequestedOwner;
      mainWindow.webContents.send('rtc:event', {
        ...data,
        callEpoch: owner?.callEpoch ?? null,
        callId: owner?.callId ?? null,
        ownerId: owner?.ownerId ?? null,
        connectionGeneration: owner?.generation ?? null
      });
    }
  });

  createWindow();

  // If user has an existing authenticated session, connect conversations immediately and configure auto-start
  if (sessionStore?.getSession()?.sessionToken) {
    syncAndConnectUserRooms();
    setAutoStart(app, true);
  }

  // Windows Sleep/Wake Recovery: re-verify and re-sync connections on resume
  if (powerMonitor && typeof powerMonitor.on === 'function') {
    powerMonitor.on('resume', () => {
      console.log('[main] System resumed from sleep: verifying connections and syncing rooms...');
      if (sessionStore?.getSession()?.sessionToken) {
        syncAndConnectUserRooms();
      }
    });
  }

  // Periodic sync to discover new direct chats or groups created externally
  if (!syncInterval) {
    syncInterval = setInterval(() => {
      if (sessionStore?.getSession()?.sessionToken) {
        syncAndConnectUserRooms();
      }
    }, 15000);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    } else if (mainWindow) {
      if (!mainWindow.isVisible()) mainWindow.show();
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
});

app.on('before-quit', () => {
  isQuitting = true;
  if (syncInterval) {
    clearInterval(syncInterval);
    syncInterval = null;
  }
  if (chatWebSocket) {
    chatWebSocket.disconnect();
  }
  if (rtcWebSocket) {
    try { rtcWebSocket.disconnect(); } catch { }
  }
  if (databaseService?.databaseManager) {
    try { databaseService.databaseManager.close(); } catch { }
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && isQuitting) {
    app.quit();
  }
});

const handleTerminationSignal = () => {
  if (isQuitting) return;
  isQuitting = true;
  if (syncInterval) {
    clearInterval(syncInterval);
    syncInterval = null;
  }
  if (chatWebSocket) {
    chatWebSocket.disconnect();
  }
  if (rtcWebSocket) {
    try { rtcWebSocket.disconnect(); } catch { }
  }
  if (databaseService?.databaseManager) {
    try {
      databaseService.databaseManager.close().finally(() => {
        process.exit(0);
      });
      return;
    } catch { }
  }
  process.exit(0);
};

process.on('SIGINT', handleTerminationSignal);
process.on('SIGTERM', handleTerminationSignal);
