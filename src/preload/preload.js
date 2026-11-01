import { contextBridge, ipcRenderer } from 'electron';

async function handleApiCall(channel, ...args) {
  const result = await ipcRenderer.invoke(channel, ...args);
  if (!result || !result.ok) {
    const err = new Error(result?.error?.message || 'API request failed');
    if (result?.error?.code) err.code = result.error.code;
    if (result?.error?.httpStatus) err.httpStatus = result.error.httpStatus;
    throw err;
  }
  return result.data;
}

// Minimal, controlled API surface exposed to the renderer
contextBridge.exposeInMainWorld('ollacoreDesktop', {
  getInfo: () => ipcRenderer.invoke('app:get-info'),
  ping: () => 'pong',
  session: {
    get: () => ipcRenderer.invoke('session:get'),
    save: (payload) => ipcRenderer.invoke('session:save', payload),
    updateProfile: (profile) => ipcRenderer.invoke('session:update-profile', profile),
    setOnboardingDone: (done) => ipcRenderer.invoke('session:set-onboarding-done', done),
    clear: () => ipcRenderer.invoke('session:clear')
  },
  device: {
    getEphemeralId: () => ipcRenderer.invoke('device:get-ephemeral-id')
  },
  api: {
    requestOtp: (phone) => handleApiCall('api:request-otp', phone),
    verifyOtp: (phone, code) => handleApiCall('api:verify-otp', phone, code),
    getProfile: (token) => handleApiCall('api:get-profile', token),
    updateProfile: (token, profile) => handleApiCall('api:update-profile', token, profile),
    logout: (token, allDevices) => handleApiCall('api:logout', token, allDevices)
  },
  auth: {
    getState: () => ipcRenderer.invoke('auth:get-state'),
    updatePhone: (phone) => ipcRenderer.invoke('auth:update-phone', phone),
    updateOtp: (code) => ipcRenderer.invoke('auth:update-otp', code),
    requestOtp: (phone) => ipcRenderer.invoke('auth:request-otp', phone),
    resendOtp: () => ipcRenderer.invoke('auth:resend-otp'),
    verifyOtp: (code) => ipcRenderer.invoke('auth:verify-otp', code),
    backToPhone: () => ipcRenderer.invoke('auth:back-to-phone'),
    logout: (allDevices) => ipcRenderer.invoke('auth:logout', allDevices),
    getProfile: () => ipcRenderer.invoke('auth:get-profile'),
    updateProfile: (profile) => ipcRenderer.invoke('auth:update-profile', profile),
    onProfileUpdated: (callback) => {
      if (typeof callback !== 'function') return () => {};
      const listener = (_event, session) => callback(session);
      ipcRenderer.on('auth:profile-updated', listener);
      return () => ipcRenderer.removeListener('auth:profile-updated', listener);
    }
  },
  profile: {
    pickPhoto: () => ipcRenderer.invoke('profile:pick-photo'),
    clearPendingPhoto: () => ipcRenderer.invoke('profile:clear-pending-photo'),
    fetchAvatarDataUrl: (userId, avatarVersion) => ipcRenderer.invoke('user:fetch-avatar-data-url', userId, avatarVersion)
  },
  app: {
    writeClipboardText: (text) => ipcRenderer.invoke('clipboard:write-text', text),
    focusWindow: () => ipcRenderer.invoke('app:focus-window'),
    getWindowState: () => ipcRenderer.invoke('app:get-window-state'),
    showNotification: (options) => ipcRenderer.invoke('app:show-notification', options),
    getNotificationSettings: () => ipcRenderer.invoke('app:get-notification-settings'),
    setNotificationSettings: (settings) => ipcRenderer.invoke('app:set-notification-settings', settings),
    getPendingIntent: () => ipcRenderer.invoke('app:get-pending-intent'),
    getPendingNavigation: () => ipcRenderer.invoke('chat:get-pending-navigation'),
    getAutoStart: () => ipcRenderer.invoke('app:get-auto-start'),
    setAutoStart: (enabled) => ipcRenderer.invoke('app:set-auto-start', enabled),
    onIntent: (callback) => {
      if (typeof callback !== 'function') return () => {};
      const listener = (_event, intent) => callback(intent);
      ipcRenderer.on('app:intent', listener);
      return () => ipcRenderer.removeListener('app:intent', listener);
    },
    onWindowStateChange: (callback) => {
      if (typeof callback !== 'function') return () => {};
      const listener = (_event, state) => callback(state);
      ipcRenderer.on('main-window:state-changed', listener);
      return () => ipcRenderer.removeListener('main-window:state-changed', listener);
    },
    onMaximizedState: (callback) => {
      if (typeof callback !== 'function') return () => {};
      const listener = (_event, isMaximized) => callback(isMaximized);
      ipcRenderer.on('floating-call:maximized-state', listener);
      return () => ipcRenderer.removeListener('floating-call:maximized-state', listener);
    }
  },
  notifications: {
    getSettings: () => ipcRenderer.invoke('app:get-notification-settings'),
    setSettings: (settings) => ipcRenderer.invoke('app:set-notification-settings', settings)
  },
  backup: {
    getCurrentAccount: () => ipcRenderer.invoke('backup:get-current-account'),
    selectDestination: (defaultFilename) => ipcRenderer.invoke('backup:select-destination', defaultFilename),
    create: (options) => ipcRenderer.invoke('backup:create', options),
    selectFile: () => ipcRenderer.invoke('backup:select-file'),
    validate: (filePath) => ipcRenderer.invoke('backup:validate', filePath),
    restore: (filePath, confirmed) => ipcRenderer.invoke('backup:restore', { filePath, confirmed }),
    onRestoreCompleted: (callback) => {
      if (typeof callback !== 'function') return () => {};
      const listener = (_event, data) => callback(data);
      ipcRenderer.on('backup:restore-completed', listener);
      return () => ipcRenderer.removeListener('backup:restore-completed', listener);
    }
  },
  chat: {
    connect: (roomId) => ipcRenderer.invoke('chat:connect', roomId),
    reconnect: () => ipcRenderer.invoke('chat:reconnect'),
    disconnect: () => ipcRenderer.invoke('chat:disconnect'),
    getState: () => ipcRenderer.invoke('chat:get-state'),
    send: (type, payload = {}, roomId = null, requestId = null) => ipcRenderer.invoke('chat:send', { type, payload, roomId, requestId }),
    markDelivered: (roomId, messageId) => ipcRenderer.invoke('chat:mark-delivered', { roomId, messageId }),
    markRead: (roomId, messageId) => ipcRenderer.invoke('chat:mark-read', { roomId, messageId }),
    addReaction: (roomId, messageId, emoji) => ipcRenderer.invoke('chat:add-reaction', { roomId, messageId, emoji }),
    removeReaction: (roomId, messageId, emoji) => ipcRenderer.invoke('chat:remove-reaction', { roomId, messageId, emoji }),
    onStateChange: (callback) => {
      if (typeof callback !== 'function') return () => {};
      const listener = (_event, data) => callback(data);
      ipcRenderer.on('chat:state-change', listener);
      return () => ipcRenderer.removeListener('chat:state-change', listener);
    },
    onEvent: (callback) => {
      if (typeof callback !== 'function') return () => {};
      const listener = (_event, frame) => callback(frame);
      ipcRenderer.on('chat:event', listener);
      return () => ipcRenderer.removeListener('chat:event', listener);
    },
    onNavigateRoom: (callback) => {
      if (typeof callback !== 'function') return () => {};
      const listener = (_event, roomId, messageId) => callback(roomId, messageId);
      ipcRenderer.on('chat:navigate-room', listener);
      return () => ipcRenderer.removeListener('chat:navigate-room', listener);
    },
    getPendingNavigation: () => ipcRenderer.invoke('chat:get-pending-navigation'),
    typingStart: (roomId) => ipcRenderer.invoke('chat:typing:start', roomId),
    typingStop: (roomId) => ipcRenderer.invoke('chat:typing:stop', roomId)
  },
  chatApi: {
    listConversations: () => handleApiCall('chat-api:list-conversations'),
    getInbox: (limit = 30) => handleApiCall('chat-api:get-inbox', limit),
    openDirect: (peerUserId) => handleApiCall('chat-api:open-direct', peerUserId),
    createGroup: (name, memberUserIds = []) => handleApiCall('chat-api:create-group', name, memberUserIds),
    lookupContacts: (phones = []) => handleApiCall('chat-api:lookup-contacts', phones),
    blockUser: (userId) => handleApiCall('chat-api:block-user', userId),
    unblockUser: (userId) => handleApiCall('chat-api:unblock-user', userId),
    listBlockedUsers: () => handleApiCall('chat-api:list-blocked-users'),
    muteConversation: (roomId, duration) => handleApiCall('chat-api:mute-conversation', roomId, duration),
    unmuteConversation: (roomId) => handleApiCall('chat-api:unmute-conversation', roomId),
    getRoomToken: (roomId) => handleApiCall('chat-api:get-room-token', roomId),
    getMessages: (roomId, options = {}) => handleApiCall('chat-api:get-messages', roomId, options),
    getParticipants: (roomId) => handleApiCall('chat-api:get-participants', roomId),
    getMembers: (roomId) => handleApiCall('chat-api:get-members', roomId),
    updateGroup: (roomId, updates = {}) => handleApiCall('chat-api:update-group', roomId, updates),
    addMember: (roomId, userId) => handleApiCall('chat-api:add-member', roomId, userId),
    addMembers: (roomId, userIds) => handleApiCall('chat-api:add-members', roomId, userIds),
    removeMember: (roomId, principalId) => handleApiCall('chat-api:remove-member', roomId, principalId),
    removeGroupMember: (roomId, userId) => handleApiCall('chat-api:remove-member', roomId, userId),
    setMemberRole: (roomId, principalId, role) => handleApiCall('chat-api:set-member-role', roomId, principalId, role),
    updateMemberRole: (roomId, userId, role) => handleApiCall('chat-api:set-member-role', roomId, userId, role),
    leaveGroup: (roomId) => handleApiCall('chat-api:leave-group', roomId),
    leaveGroupConversation: (roomId) => handleApiCall('chat-api:leave-group', roomId),
    getUnread: (roomId) => handleApiCall('chat-api:get-unread', roomId),
    markDelivered: (roomId, messageId) => handleApiCall('chat-api:mark-delivered', roomId, messageId),
    markRead: (roomId, messageId) => handleApiCall('chat-api:mark-read', roomId, messageId),
    searchMessages: (roomId, query, options = {}) => handleApiCall('chat-api:search-messages', roomId, query, options),
    editMessage: (roomId, messageId, body) => handleApiCall('chat-api:edit-message', roomId, messageId, body),
    deleteMessage: (roomId, messageId) => handleApiCall('chat-api:delete-message', roomId, messageId),
    initAttachment: (roomId, params = {}) => handleApiCall('chat-api:init-attachment', roomId, params),
    completeAttachment: (roomId, attachmentId) => handleApiCall('chat-api:complete-attachment', roomId, attachmentId),
    downloadAttachment: (roomId, attachmentId) => handleApiCall('chat-api:download-attachment', roomId, attachmentId),
    initMultipartUpload: (roomId, params = {}) => handleApiCall('chat-api:init-multipart-upload', roomId, params),
    completeMultipartUpload: (roomId, attachmentId, parts = []) => handleApiCall('chat-api:complete-multipart-upload', roomId, attachmentId, parts),
    uploadMedia: (params) => handleApiCall('chat-api:upload-media', params),
    cancelUpload: (params) => handleApiCall('chat-api:cancel-upload', typeof params === 'string' ? { sessionId: params } : params),
    onContactUpdated: (callback) => {
      if (typeof callback !== 'function') return () => {};
      const listener = (_event, data) => callback(data);
      ipcRenderer.on('contacts:updated', listener);
      return () => ipcRenderer.removeListener('contacts:updated', listener);
    }
  },
  dialog: {
    openMediaFile: (options = {}) => ipcRenderer.invoke('dialog:open-media-file', options),
    saveMediaFile: (options) => ipcRenderer.invoke('dialog:save-media-file', options),
    openAttachment: (options) => ipcRenderer.invoke('media:open-attachment', options)
  },
  shell: {
    openExternal: (url) => ipcRenderer.invoke('shell:open-external', url),
    openPath: (path) => ipcRenderer.invoke('shell:open-path', path),
    showItemInFolder: (path) => ipcRenderer.invoke('shell:show-item-in-folder', path)
  },
  media: {
    openAttachment: (options) => ipcRenderer.invoke('media:open-attachment', options),
    deleteCachedAttachments: (attachmentIds) => ipcRenderer.invoke('media:delete-cached-attachments', { attachmentIds }),
    onUploadProgress: (callback) => {
      if (typeof callback !== 'function') return () => {};
      const listener = (_event, data) => callback(data);
      ipcRenderer.on('chat:upload-progress', listener);
      return () => ipcRenderer.removeListener('chat:upload-progress', listener);
    }
  },
  rtc: {
    connect: (roomId, options = {}) => ipcRenderer.invoke('rtc:connect', roomId, options),
    disconnect: () => ipcRenderer.invoke('rtc:disconnect'),
    getState: () => ipcRenderer.invoke('rtc:get-state'),
    sendOffer: (sdp, options = {}) => ipcRenderer.invoke('rtc:send-offer', { sdp, ...options }),
    sendAnswer: (sdp, requestId) => ipcRenderer.invoke('rtc:send-answer', { sdp, requestId }),
    sendCandidate: (candidate, sdpMid, sdpMLineIndex) => ipcRenderer.invoke('rtc:send-candidate', { candidate, sdpMid, sdpMLineIndex }),
    leave: () => ipcRenderer.invoke('rtc:leave'),
    getIceServers: (roomId) => ipcRenderer.invoke('rtc:get-ice-servers', roomId),
    supportsMedia: () => ({ audio: true, video: true }),
    getDesktopSources: async (options = {}) => {
      const res = await ipcRenderer.invoke('desktop-capture:get-sources', options);
      if (!res || !res.ok) {
        throw new Error(res?.error || 'Failed to enumerate capture sources');
      }
      return res.sources || [];
    },
    onStateChange: (callback) => {
      if (typeof callback !== 'function') return () => {};
      const listener = (_event, data) => callback(data);
      ipcRenderer.on('rtc:state-change', listener);
      return () => ipcRenderer.removeListener('rtc:state-change', listener);
    },
    onEvent: (callback) => {
      if (typeof callback !== 'function') return () => {};
      const listener = (_event, eventData) => callback(eventData);
      ipcRenderer.on('rtc:event', listener);
      return () => ipcRenderer.removeListener('rtc:event', listener);
    }
  },
  desktopCapture: {
    getSources: async (options = {}) => {
      const res = await ipcRenderer.invoke('desktop-capture:get-sources', options);
      if (!res || !res.ok) {
        throw new Error(res?.error || 'Failed to enumerate capture sources');
      }
      return res.sources || [];
    }
  },
  theme: {
    getRoomTheme: (roomId) => ipcRenderer.invoke('theme:get-room-theme', roomId),
    setRoomTheme: (roomId, theme) => ipcRenderer.invoke('theme:set-room-theme', roomId, theme),
    resetRoomTheme: (roomId) => ipcRenderer.invoke('theme:reset-room-theme', roomId),
    getAppTheme: () => ipcRenderer.invoke('theme:get-app-theme'),
    setAppTheme: (appTheme) => ipcRenderer.invoke('theme:set-app-theme', appTheme),
    pickWallpaper: () => ipcRenderer.invoke('theme:pick-wallpaper'),
    loadWallpaperData: (localPath) => ipcRenderer.invoke('theme:load-wallpaper-data', localPath),
    deleteWallpaper: (localPath) => ipcRenderer.invoke('theme:delete-wallpaper', localPath)
  },
  db: {
    getConversations: (options = {}) => handleApiCall('db:get-conversations', options),
    saveConversation: (conversation) => handleApiCall('db:save-conversation', conversation),
    getMessages: (options = {}) => handleApiCall('db:get-messages', options),
    getMessageById: (params = {}) => handleApiCall('db:get-message-by-id', typeof params === 'string' ? { id: params } : params),
    saveMessage: (message) => handleApiCall('db:save-message', message),
    updateMessageStatus: (params = {}) => handleApiCall('db:update-message-status', params),
    getMessageReceipts: (params = {}) => handleApiCall('db:get-message-receipts', typeof params === 'string' ? { messageId: params } : params),
    updateMessageReaction: (params = {}) => handleApiCall('db:update-message-reaction', params),
    getMessageReactions: (params = {}) => handleApiCall('db:get-message-reactions', typeof params === 'string' ? { messageId: params } : params),
    updateMessageEdit: (params = {}) => handleApiCall('db:update-message-edit', params),
    markMessageDeleted: (params = {}) => handleApiCall('db:mark-message-deleted', params),
    markMessageDeletedForMe: (params = {}) => handleApiCall('db:mark-message-deleted-for-me', params),
    saveCallRecord: (record = {}) => handleApiCall('db:save-call-record', record),
    getCallRecords: (options = {}) => handleApiCall('db:get-call-records', options),
    getPendingOutbox: (options = {}) => handleApiCall('db:get-pending-outbox', options),
    savePendingOutbox: (record = {}) => handleApiCall('db:save-pending-outbox', record),
    updatePendingOutboxAttempt: (params = {}) => handleApiCall('db:update-pending-outbox-attempt', params),
    clearPendingOutboxItem: (params = {}) => handleApiCall('db:clear-pending-outbox-item', params),
    getMetadata: (params = {}) => handleApiCall('db:get-metadata', typeof params === 'string' ? { key: params } : params),
    setMetadata: (params = {}, maybeValue = undefined) => handleApiCall('db:set-metadata', typeof params === 'string' ? { key: params, value: maybeValue } : params),
    getCustomLists: () => handleApiCall('db:get-custom-lists'),
    saveCustomLists: (payload = {}) => handleApiCall('db:save-custom-lists', payload),
    migrateLocalStorage: (payload = {}) => handleApiCall('db:migrate-localstorage', payload),
    saveUploadSession: (session = {}) => handleApiCall('db:save-upload-session', session),
    updateUploadSession: (params = {}) => handleApiCall('db:update-upload-session', params),
    getUploadSession: (params = {}) => handleApiCall('db:get-upload-session', typeof params === 'string' ? { id: params } : params),
    getPendingUploadSessions: (options = {}) => handleApiCall('db:get-pending-upload-sessions', options),
    deleteUploadSession: (params = {}) => handleApiCall('db:delete-upload-session', typeof params === 'string' ? { id: params } : params),
    cleanStaleUploadSessions: (options = {}) => handleApiCall('db:clean-stale-upload-sessions', options),
    getBlockedUsers: () => handleApiCall('db:get-blocked-users'),
    saveBlockedUsers: (users = []) => handleApiCall('db:save-blocked-users', users),
    addBlockedUser: (user) => handleApiCall('db:add-blocked-user', user),
    removeBlockedUser: (userId) => handleApiCall('db:remove-blocked-user', userId)
  },
  floatingCall: {
    show: () => ipcRenderer.invoke('floating-call:show'),
    hide: () => ipcRenderer.invoke('floating-call:hide'),
    minimize: () => ipcRenderer.invoke('floating-call:minimize'),
    maximize: () => ipcRenderer.invoke('floating-call:maximize'),
    close: () => ipcRenderer.invoke('floating-call:close'),
    getState: () => ipcRenderer.invoke('floating-call:get-state'),
    getMode: () => ipcRenderer.invoke('floating-call:get-mode'),
    syncState: (state) => ipcRenderer.invoke('floating-call:sync-state', state),
    sendAction: (action) => ipcRenderer.invoke('floating-call:action', action),
    bridgeSignal: (signal) => {
      if (!signal) return Promise.resolve({ ok: false });
      const safeSignal = { type: signal.type };
      if (signal.offer) {
        safeSignal.offer = { type: signal.offer.type, sdp: signal.offer.sdp };
      }
      if (signal.answer) {
        safeSignal.answer = { type: signal.answer.type, sdp: signal.answer.sdp };
      }
      if (signal.tracks) {
        safeSignal.tracks = signal.tracks;
      }
      if (signal.participants) {
        safeSignal.participants = signal.participants;
      }
      if (signal.error) {
        safeSignal.error = signal.error;
      }
      if (signal.candidate) {
        if (typeof signal.candidate === 'string') {
          safeSignal.candidate = { candidate: signal.candidate };
        } else {
          safeSignal.candidate = {
            candidate: signal.candidate.candidate || '',
            sdpMid: signal.candidate.sdpMid != null ? String(signal.candidate.sdpMid) : null,
            sdpMLineIndex: signal.candidate.sdpMLineIndex != null ? Number(signal.candidate.sdpMLineIndex) : null,
            usernameFragment: signal.candidate.usernameFragment != null ? String(signal.candidate.usernameFragment) : null
          };
        }
      }
      return ipcRenderer.invoke('floating-call:bridge-signal', safeSignal);
    },
    moveBy: (dx, dy) => ipcRenderer.invoke('floating-call:move-by', { dx, dy }),
    setPosition: (x, y) => ipcRenderer.invoke('floating-call:set-position', { x, y }),
    onStateChange: (callback) => {
      if (typeof callback !== 'function') return () => {};
      const listener = (_event, state) => callback(state);
      ipcRenderer.on('floating-call:state-changed', listener);
      return () => ipcRenderer.removeListener('floating-call:state-changed', listener);
    },
    onModeChange: (callback) => {
      if (typeof callback !== 'function') return () => {};
      const listener = (_event, mode) => callback(mode);
      ipcRenderer.on('floating-call:mode-changed', listener);
      return () => ipcRenderer.removeListener('floating-call:mode-changed', listener);
    },
    onAction: (callback) => {
      if (typeof callback !== 'function') return () => {};
      const listener = (_event, action) => callback(action);
      ipcRenderer.on('floating-call:dispatch-action', listener);
      return () => ipcRenderer.removeListener('floating-call:dispatch-action', listener);
    },
    onBridgeSignal: (callback) => {
      if (typeof callback !== 'function') return () => {};
      const listener = (_event, signal) => callback(signal);
      ipcRenderer.on('floating-call:bridge-signal', listener);
      return () => ipcRenderer.removeListener('floating-call:bridge-signal', listener);
    },
    onWindowStateChange: (callback) => {
      if (typeof callback !== 'function') return () => {};
      const listener = (_event, state) => callback(state);
      ipcRenderer.on('main-window:state-changed', listener);
      return () => ipcRenderer.removeListener('main-window:state-changed', listener);
    },
    onMaximizedState: (callback) => {
      if (typeof callback !== 'function') return () => {};
      const listener = (_event, isMaximized) => callback(isMaximized);
      ipcRenderer.on('floating-call:maximized-state', listener);
      return () => ipcRenderer.removeListener('floating-call:maximized-state', listener);
    }
  }
});

