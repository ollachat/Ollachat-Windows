import {
  ChatShellState,
  getConversationTitle,
  getConversationSubtitle,
  getConversationHeaderStatus,
  getDirectPeerUserId,
  getAvatarInitials,
  getAvatarColor,
  formatConversationTime,
  getConversationPreview,
  formatCallDuration,
  formatCallTimelineDuration,
  isCallSignalMessage,
  saveRoomCallRecord,
  getRoomCallRecords,
  validatePhone,
  validateGroupName,
  validateGroupDescription,
  DirectChatDraft,
  GroupCreationDraft,
  RoomMessagesState,
  formatMessageTime,
  formatFullDateTime,
  formatDayDivider,
  groupMessagesByDay,
  getCalendarDateKey,
  formatCalendarDayLabel,
  calculateVisibleDateLabel,
  resolveMessageContent,
  isOwnMessage,
  MESSAGE_ACTION_LIMITS,
  canEditMessage,
  canDeleteMessageForEveryone,
  MESSAGE_STATUS,
  STATUS_RANKS,
  isWindowActiveAndVisible,
  validateComposerText,
  createOptimisticMessage,
  createOptimisticMediaMessage,
  createOptimisticVoiceMessage,
  formatFileSize,
  normalizeToE164,
  getTickDescriptor,
  isEmojiOnly,
  isCanonicalServerId,
  resolveCanonicalMessageId,
  isParticipantAdmin,
  isParticipantSelf,
  filterEligibleCallParticipants,
  formatBackendGroupError,
  cleanUrl,
  extractUrls,
  parseTextWithUrls,
  getGroupCapabilities,
  getParticipantCapabilities,
  formatGroupMembershipSystemText,
  formatGroupDescriptionSystemText,
  collectAttachmentIdsFromMessage,
  collectAttachmentIdsFromMessages,
  getEligibleAttachmentIdsForDeletion,
  isDeletableForChatsOnly,
  PIN_DURATIONS,
  PIN_DURATION_MAP,
  MAX_PINS_PER_CHAT,
  formatPinExpiration,
  formatPinRemainingTime,
  getMessagePinPreview,
  formatReplyPreview,
  getReplySenderName,
  resolveGroupSenderName,
  isForwardedMessage,
  getCleanForwardedText,
  partitionGroupReceiptMembers,
  resolveMemberDisplayName,
  getMemberInitials,
  REACTION_EMOJIS,
  formatNotificationContent,
  formatMessageNotificationPreview,
  findLatestUnreadMessage,
  findFirstUnreadMessage,
  generateUuid,
  loadPersistentReceiptStore,
  savePersistentReceipt
} from './chat-shell-state.js';
import { EmojiPicker } from './emoji-picker.js';
import { VoiceRecorder, RECORDING_STATE } from './voice-recorder.js';
import { scheduleCallPresentation } from './call-presentation-guard.js';
import { VoiceCallManager, CALL_STATE, isInternalIdOrUuid } from '../call/voice-call-manager.js';
import { validateMediaFile, categorizeMediaKind } from '../api/mime-validator.js';
import {
  PRESET_THEMES,
  BUBBLE_STYLES,
  PRESET_WALLPAPERS,
  LIGHT_DEFAULT_THEME,
  DARK_DEFAULT_THEME,
  getPresetTheme,
  getBubbleStyle,
  getPresetWallpaper,
  applyRoomTheme,
  resetThemeToDefault,
  loadAndApplyThemeForRoom,
  getAppThemeSetting,
  getResolvedAppTheme,
  applyAppTheme,
  initSystemThemeListener,
  getEffectiveChatTheme
} from './theme-manager.js';
import {
  sqliteRowToConversation,
  conversationToSqlitePayload,
  sqliteRowToMessage,
  messageToSqlitePayload,
  loadConversationsFromDb,
  persistConversationToDb,
  persistConversationsToDb,
  deleteConversationFromDb,
  loadMessagesFromDb,
  loadMessageByIdFromDb,
  persistMessageToDb,
  persistMessagesToDb,
  persistMessageStatusToDb,
  persistMessageEditToDb,
  persistMessageDeletedToDb,
  persistMessageDeletedForMeToDb,
  loadStarredMessagesFromDb,
  persistMessageStarredToDb,
  persistCustomListsToDb,
  runLocalStorageMigration,
  hydrateMigratedStateFromDb,
  persistOutboxItemToDb,
  clearOutboxItemFromDb,
  outboxManager,
  persistReactionToDb
} from './db-sync.js';

// Polyfill crypto.randomUUID for environments where file:// protocol is considered insecure by Chromium
if (typeof crypto !== 'undefined' && typeof crypto.randomUUID !== 'function') {
  try {
    crypto.randomUUID = generateUuid;
  } catch { }
}

// ═══════════════════════════════════════════════════════════════════
// DOM Elements
// ═══════════════════════════════════════════════════════════════════

// Auth Screens
const screenPhone = document.getElementById('screen-phone');
const screenOtp = document.getElementById('screen-otp');
const screenAuthenticated = document.getElementById('screen-authenticated');

const countrySelect = document.getElementById('country-select');
const countryPrefix = document.getElementById('country-prefix');
const phoneInput = document.getElementById('phone-input');
const btnRequestOtp = document.getElementById('btn-request-otp');
const phoneError = document.getElementById('phone-error');

const displayOtpPhone = document.getElementById('display-otp-phone');
const otpInput = document.getElementById('otp-input');
const btnVerifyOtp = document.getElementById('btn-verify-otp');
const btnBackPhone = document.getElementById('btn-back-phone');
const btnResendOtp = document.getElementById('btn-resend-otp');
const cooldownText = document.getElementById('cooldown-text');
const cooldownSeconds = document.getElementById('cooldown-seconds');
const otpError = document.getElementById('otp-error');

// Shell: Header & WebSocket Indicator
const wsIndicator = document.getElementById('ws-indicator');
const wsStatusLabel = document.getElementById('ws-status-label');

// Shell: Sidebar Elements
const btnNewChat = document.getElementById('btn-new-chat');
const conversationSearch = document.getElementById('conversation-search');
const btnClearSearch = document.getElementById('btn-clear-search');
const conversationList = document.getElementById('conversation-list');
const inboxLoading = document.getElementById('inbox-loading');
const inboxError = document.getElementById('inbox-error');
const inboxErrorMessage = document.getElementById('inbox-error-message');
const btnRetryInbox = document.getElementById('btn-retry-inbox');
const inboxEmpty = document.getElementById('inbox-empty');
const inboxNoSearch = document.getElementById('inbox-no-search');

// Shell: Left Navigation Rail & Profile
const navRail = document.getElementById('nav-rail');
const navItemChats = document.getElementById('nav-item-chats');
const navItemCalls = document.getElementById('nav-item-calls');
const navItemArchived = document.getElementById('nav-item-archived');
const userProfileTrigger = document.getElementById('user-profile-trigger');
const currentUserAvatar = document.getElementById('current-user-avatar');
const currentUserName = document.getElementById('current-user-name');
const currentUserPhone = document.getElementById('current-user-phone');
const btnSettings = document.getElementById('btn-settings');
const btnLogout = document.getElementById('btn-logout');

// Shell: Sidebar and Main Views
const chatSidebar = document.getElementById('chat-sidebar') || document.querySelector('.chat-sidebar');
const chatMainArea = document.getElementById('chat-main-area') || document.querySelector('.chat-main-area');

// Shell: Archived Chats Elements
const archivedSidebar = document.getElementById('archived-sidebar');
const archivedSearch = document.getElementById('archived-search');
const btnClearArchivedSearch = document.getElementById('btn-clear-archived-search');
const archivedListContainer = document.getElementById('archived-list-container');
const archivedEmpty = document.getElementById('archived-empty');
const archivedNoSearch = document.getElementById('archived-no-search');
const archivedConversationList = document.getElementById('archived-conversation-list');
const archivedContextMenu = document.getElementById('archived-context-menu');
const ctxArchivedPinText = document.getElementById('ctx-archived-pin-text');
const ctxArchivedPinIcon = document.getElementById('ctx-archived-pin-icon');
const ctxArchivedFavText = document.getElementById('ctx-archived-fav-text');
const ctxArchivedFavIcon = document.getElementById('ctx-archived-fav-icon');
const ctxArchivedUnreadText = document.getElementById('ctx-archived-unread-text');
const ctxArchivedUnreadIcon = document.getElementById('ctx-archived-unread-icon');
let contextMenuTargetArchivedConversation = null;

// Shell: Dedicated Calls Elements
const callsView = document.getElementById('calls-view');
const callsSidebar = document.getElementById('calls-sidebar');
const callsSearch = document.getElementById('calls-search');
const btnClearCallsSearch = document.getElementById('btn-clear-calls-search');
const callsListContainer = document.getElementById('calls-list-container');
const callsEmpty = document.getElementById('calls-empty');
const callsNoSearch = document.getElementById('calls-no-search');
const callsHistoryList = document.getElementById('calls-history-list');

let currentNavigationDestination = 'chats'; // 'chats' | 'calls' | 'archived'
let activeCallSession = null;

// Shell: Main Chat Area Panels
const chatEmptyPanel = document.getElementById('chat-empty-panel');
const chatSelectedPanel = document.getElementById('chat-selected-panel');
const selectedChatAvatar = document.getElementById('selected-chat-avatar');
const selectedChatName = document.getElementById('selected-chat-name');
const selectedChatSubtitle = document.getElementById('selected-chat-subtitle');
const selectedChatWelcomeName = document.getElementById('selected-chat-welcome-name');

// Chat Header Search Elements
const btnChatSearch = document.getElementById('btn-chat-search');
const chatSearchBar = document.getElementById('chat-search-bar');
const chatSearchInput = document.getElementById('chat-search-input');
const btnClearChatSearch = document.getElementById('btn-clear-chat-search');
const chatSearchCount = document.getElementById('chat-search-count');
const btnPrevSearchResult = document.getElementById('btn-prev-search-result');
const btnNextSearchResult = document.getElementById('btn-next-search-result');
const btnCloseChatSearch = document.getElementById('btn-close-chat-search');
const chatSearchResultsPanel = document.getElementById('chat-search-results-panel');
const chatSearchStatus = document.getElementById('chat-search-status');
const chatSearchResultsList = document.getElementById('chat-search-results-list');

// Phase 4C: Message Area Elements
const messagesLoading = document.getElementById('messages-loading');
const messagesError = document.getElementById('messages-error');
const messagesErrorText = document.getElementById('messages-error-text');
const btnRetryMessages = document.getElementById('btn-retry-messages');
const messagesEmpty = document.getElementById('messages-empty');
const messagesScrollArea = document.getElementById('messages-scroll-area');
const olderMessagesLoader = document.getElementById('older-messages-loader');
const messagesList = document.getElementById('messages-list');
const scrollBottomBtn = document.getElementById('scroll-bottom-btn');
const scrollBottomBadge = document.getElementById('scroll-bottom-badge');
const floatingDateIndicator = document.getElementById('floating-date-indicator');
const floatingDatePill = document.getElementById('floating-date-pill');

// Phase 4D / Phase A: Message Composer & Voice Recording Elements
const composerInput = document.getElementById('composer-input');
const btnSendMessage = document.getElementById('btn-send-message');
const btnVoiceRecord = document.getElementById('btn-voice-record');
const composerBox = document.querySelector('.composer-box');
const composerRecordingBar = document.getElementById('composer-recording-bar');
const btnCancelRecording = document.getElementById('btn-cancel-recording');
const btnSendRecording = document.getElementById('btn-send-recording');
const recordingTimer = document.getElementById('recording-timer');
const recordingVisualizer = document.getElementById('recording-visualizer');
const voiceRecorder = new VoiceRecorder();
let activeVoiceAudio = null;
const btnEmojiPicker = document.getElementById('btn-emoji-picker');
const emojiPickerPopover = document.getElementById('emoji-picker-popover');
const emojiSearchInput = document.getElementById('emoji-search-input');
const emojiPickerCategories = document.getElementById('emoji-picker-categories');
const emojiPickerGrid = document.getElementById('emoji-picker-grid');
const emojiPreviewChar = document.getElementById('emoji-preview-char');
const emojiPreviewName = document.getElementById('emoji-preview-name');
const btnCloseEmojiPicker = document.getElementById('btn-close-emoji-picker');
let emojiPicker = null;

// Media Sharing & Attachment Elements (Phase 4-10)
const btnAttachmentPicker = document.getElementById('btn-attachment-picker');
const attachmentMenuPopover = document.getElementById('attachment-menu-popover');
const composerFileInput = document.getElementById('composer-file-input');
const composerUploadBar = document.getElementById('composer-upload-bar');
const uploadFilename = document.getElementById('upload-filename');
const uploadPercent = document.getElementById('upload-percent');
const uploadProgressFill = document.getElementById('upload-progress-fill');

// Image Preview Lightbox Elements
const imagePreviewModal = document.getElementById('image-preview-modal');
const previewBackdrop = document.getElementById('preview-backdrop');
const previewImgElement = document.getElementById('preview-img-element');
const previewFilename = document.getElementById('preview-filename');
const previewCaption = document.getElementById('preview-caption');
const btnDownloadPreview = document.getElementById('btn-download-preview');
const btnClosePreview = document.getElementById('btn-close-preview');

// In-memory cache for resolved attachment download URLs & errors
const attachmentUrls = new Map();
const attachmentErrors = new Map(); // attachmentId -> errorMessage
const pendingUrlResolutions = new Set();

// WhatsApp Message Actions Elements (Context Menu, Edit/Reply Banners, Message Info)
const messageContextMenu = document.getElementById('message-context-menu');
const ctxStarIcon = document.getElementById('ctx-star-icon');
const ctxStarText = document.getElementById('ctx-star-text');
const ctxPinText = document.getElementById('ctx-pin-text');
const composerReplyBanner = document.getElementById('composer-reply-banner');
const composerReplySender = document.getElementById('composer-reply-sender');
const composerReplyPreview = document.getElementById('composer-reply-preview');
const btnCancelReply = document.getElementById('btn-cancel-reply');
const composerEditBanner = document.getElementById('composer-edit-banner');
const composerEditPreview = document.getElementById('composer-edit-preview');
const btnCancelEdit = document.getElementById('btn-cancel-edit');
const messageInfoModal = document.getElementById('message-info-modal');
const btnCloseMessageInfo = document.getElementById('btn-close-message-info');
const infoMessagePreviewContainer = document.getElementById('info-message-preview-container');
const infoReadRow = document.getElementById('info-read-row');
const infoReadTime = document.getElementById('info-read-time');
const infoDeliveredRow = document.getElementById('info-delivered-row');
const infoDeliveredTime = document.getElementById('info-delivered-time');
const infoSentTime = document.getElementById('info-sent-time');
const infoEditedRow = document.getElementById('info-edited-row');
const infoEditedTime = document.getElementById('info-edited-time');
const info1to1Sections = document.getElementById('info-1to1-sections');
const infoGroupSections = document.getElementById('info-group-sections');
const infoGroupSentTime = document.getElementById('info-group-sent-time');
const infoGroupReadTitle = document.getElementById('info-group-read-title');
const infoGroupReadList = document.getElementById('info-group-read-list');
const infoGroupDeliveredTitle = document.getElementById('info-group-delivered-title');
const infoGroupDeliveredList = document.getElementById('info-group-delivered-list');
const infoGroupPendingTitle = document.getElementById('info-group-pending-title');
const infoGroupPendingList = document.getElementById('info-group-pending-list');
let activeMessageInfoState = null;

// Pinned Messages Bar DOM elements
const chatPinnedBar = document.getElementById('chat-pinned-bar');
const chatPinnedBarContent = document.getElementById('chat-pinned-bar-content');
const chatPinnedBarSnippet = document.getElementById('chat-pinned-bar-snippet');
const chatPinnedBarExpiry = document.getElementById('chat-pinned-bar-expiry');
const chatPinnedBarCounter = document.getElementById('chat-pinned-bar-counter');
const btnPinnedPrev = document.getElementById('btn-pinned-prev');
const btnPinnedNext = document.getElementById('btn-pinned-next');
const btnPinnedUnpin = document.getElementById('btn-pinned-unpin');

// Pin Duration Modal Elements
const pinDurationModal = document.getElementById('pin-duration-modal');
const btnClosePinDuration = document.getElementById('btn-close-pin-duration');
const btnCancelPinDuration = document.getElementById('btn-cancel-pin-duration');
const btnConfirmPinDuration = document.getElementById('btn-confirm-pin-duration');
const pinDurationExpiry = document.getElementById('pin-duration-expiry');

// Pin Limit Modal Elements
const pinLimitModal = document.getElementById('pin-limit-modal');
const btnClosePinLimit = document.getElementById('btn-close-pin-limit');
const btnCancelPinLimit = document.getElementById('btn-cancel-pin-limit');

// Message Selection Bar DOM elements
const messageSelectionBar = document.getElementById('message-selection-bar');
const selectionCountBadge = document.getElementById('selection-count-label') || document.getElementById('selection-count-badge');
const btnCancelSelection = document.getElementById('btn-cancel-selection');
const btnDeleteSelected = document.getElementById('btn-delete-selected');
const btnForwardSelected = document.getElementById('btn-forward-selected');

// Forward Message Modal Elements
const forwardModal = document.getElementById('forward-modal');
const forwardModalTitle = document.getElementById('forward-modal-title');
const btnCloseForwardModal = document.getElementById('btn-close-forward-modal');
const forwardChatSearch = document.getElementById('forward-chat-search');
const forwardChatList = document.getElementById('forward-chat-list');
const forwardSelectionCount = document.getElementById('forward-selection-count');
const btnCancelForward = document.getElementById('btn-cancel-forward');
const btnConfirmForward = document.getElementById('btn-confirm-forward');
const forwardSpinner = document.getElementById('forward-spinner');

// Pinned Messages Panel Elements
const pinnedMessagesPanel = document.getElementById('pinned-messages-panel');
const btnClosePinnedMessages = document.getElementById('btn-close-pinned-messages');
const pinnedList = document.getElementById('pinned-list');
const pinnedEmpty = document.getElementById('pinned-empty');
const contactInfoPinnedRow = document.getElementById('contact-info-pinned-row');

let contextMenuTargetMessage = null;
let editingMessage = null;
let replyingToMessage = null;

// Pinned bar navigation state
let currentPinnedBarIndex = 0;
let pendingPinMessageId = null; // messageId waiting for duration choice

// Chat List Filter & Conversation Context Menu Elements
const chatFilterRow = document.getElementById('chat-filter-row');
const filterBtnAll = document.getElementById('filter-btn-all');
const filterBtnUnread = document.getElementById('filter-btn-unread');
const filterCountUnread = document.getElementById('filter-count-unread');
const filterBtnFavourites = document.getElementById('filter-btn-favourites');
const filterBtnGroups = document.getElementById('filter-btn-groups');
const filterCountGroups = document.getElementById('filter-count-groups');
const filterBtnAdd = document.getElementById('filter-btn-add');
const customFiltersContainer = document.getElementById('custom-filters-container');
const inboxEmptyCustomList = document.getElementById('inbox-empty-custom-list');
const emptyCustomListTitle = document.getElementById('empty-custom-list-title');
const btnEmptyEditList = document.getElementById('btn-empty-edit-list');

const customListContextMenu = document.getElementById('custom-list-context-menu');
let contextMenuTargetList = null;

const customListModal = document.getElementById('custom-list-modal');
const customListModalTitle = document.getElementById('custom-list-modal-title');
const btnCloseCustomListModal = document.getElementById('btn-close-custom-list-modal');
const customListError = document.getElementById('custom-list-error');
const customListNameInput = document.getElementById('custom-list-name-input');
const customListChatItems = document.getElementById('custom-list-chat-items');
const btnCancelCustomList = document.getElementById('btn-cancel-custom-list');
const btnSaveCustomList = document.getElementById('btn-save-custom-list');

const customListDeleteModal = document.getElementById('custom-list-delete-modal');
const btnCloseDeleteCustomList = document.getElementById('btn-close-delete-custom-list');
const customListDeleteMessage = document.getElementById('custom-list-delete-message');
const btnCancelDeleteCustomList = document.getElementById('btn-cancel-delete-custom-list');
const btnConfirmDeleteCustomList = document.getElementById('btn-confirm-delete-custom-list');

let currentCustomListMode = 'create'; // 'create' | 'edit-chats' | 'rename'
let currentEditingListId = null;
let currentDeletingListId = null;

const conversationContextMenu = document.getElementById('conversation-context-menu');
const ctxChatPinText = document.getElementById('ctx-chat-pin-text');
const ctxChatPinIcon = document.getElementById('ctx-chat-pin-icon');
const ctxChatFavText = document.getElementById('ctx-chat-fav-text');
const ctxChatFavIcon = document.getElementById('ctx-chat-fav-icon');
const ctxChatUnreadText = document.getElementById('ctx-chat-unread-text');
const ctxChatUnreadIcon = document.getElementById('ctx-chat-unread-icon');
const ctxChatDeleteBtn = document.getElementById('ctx-chat-delete-btn');
const ctxChatDeleteText = document.getElementById('ctx-chat-delete-text');
const ctxChatDeleteIcon = document.getElementById('ctx-chat-delete-icon');
const ctxChatMuteBtn = document.getElementById('ctx-chat-mute-btn');
const ctxChatMuteText = document.getElementById('ctx-chat-mute-text');
let contextMenuTargetConversation = null;

// Phase 6B/6C: Voice & Video Call Elements
const btnStartVoiceCall = document.getElementById('btn-start-voice-call');
const btnStartVideoCall = document.getElementById('btn-start-video-call');
const voiceCallOverlay = document.getElementById('voice-call-overlay');
const voiceCallCard = document.getElementById('voice-call-card');
const videoStage = document.getElementById('video-stage');
const localVideo = document.getElementById('local-video');
const remoteVideo = document.getElementById('remote-video');
const remoteVideoPlaceholder = document.getElementById('remote-video-placeholder');
const localVideoOffBadge = document.getElementById('local-video-off-badge');
const callPeerAvatar = document.getElementById('call-peer-avatar');
const callPeerName = document.getElementById('call-peer-name');
const callPeerPhone = document.getElementById('call-peer-phone');
const callStatusLabel = document.getElementById('call-status-label');
const callTimerLabel = document.getElementById('call-timer-label');
const callErrorBanner = document.getElementById('call-error-banner');
const btnCallMute = document.getElementById('btn-call-mute');
const callMuteIcon = document.getElementById('call-mute-icon');
const callMuteText = document.getElementById('call-mute-text');
const btnCallCamera = document.getElementById('btn-call-camera');
const callCameraIcon = document.getElementById('call-camera-icon');
const callCameraText = document.getElementById('call-camera-text');
const btnCallScreenShare = document.getElementById('btn-call-screenshare');
const callScreenShareIcon = document.getElementById('call-screenshare-icon');
const callScreenShareText = document.getElementById('call-screenshare-text');
const screenshareActiveBanner = document.getElementById('screenshare-active-banner');
const btnStopScreenshareBanner = document.getElementById('btn-stop-screenshare-banner');
const screensharePickerModal = document.getElementById('screenshare-picker-modal');
const btnCloseScreensharePicker = document.getElementById('btn-close-screenshare-picker');
const btnCancelScreensharePicker = document.getElementById('btn-cancel-screenshare-picker');
const btnConfirmScreensharePicker = document.getElementById('btn-confirm-screenshare-picker');
const tabScreenshareEntire = document.getElementById('tab-screenshare-entire');
const tabScreenshareWindows = document.getElementById('tab-screenshare-windows');
const screenshareSourcesGrid = document.getElementById('screenshare-sources-grid');
const screenshareSourcesLoading = document.getElementById('screenshare-sources-loading');
const screenshareSourcesEmpty = document.getElementById('screenshare-sources-empty');
const btnCallEnd = document.getElementById('btn-call-end');
const btnCallAccept = document.getElementById('btn-call-accept');
const btnCallDecline = document.getElementById('btn-call-decline');
const remoteVoiceAudio = document.getElementById('remote-voice-audio');
const btnCallMaximize = document.getElementById('btn-call-maximize');
const callMaximizeIcon = document.getElementById('call-maximize-icon');
const btnCallPopout = document.getElementById('btn-call-popout');
const callPopoutIcon = document.getElementById('call-popout-icon');
const btnCallMinimize = document.getElementById('btn-call-minimize');
const btnCallRequestVideo = document.getElementById('btn-call-request-video');
const btnCallRestore = document.getElementById('btn-call-restore');
const btnCallMinimizedMute = document.getElementById('btn-call-minimized-mute');
const callMinimizedMuteIcon = document.getElementById('call-minimized-mute-icon');
const btnCallMinimizedEnd = document.getElementById('btn-call-minimized-end');
const callMinimizedControls = document.getElementById('call-minimized-controls');
const btnCallAddParticipant = document.getElementById('btn-call-add-participant');
const callAddParticipantModal = document.getElementById('call-add-participant-modal');
const btnCloseCallAddParticipant = document.getElementById('btn-close-call-add-participant');
const btnCloseCallAddParticipantFooter = document.getElementById('btn-close-call-add-participant-footer');
const callParticipantSearch = document.getElementById('call-participant-search');
const callParticipantsLoading = document.getElementById('call-participants-loading');
const callParticipantsEmpty = document.getElementById('call-participants-empty');
const callParticipantsList = document.getElementById('call-participants-list');
const callAddParticipantError = document.getElementById('call-add-participant-error');
const incomingCallHeader = document.getElementById('incoming-call-header');
const btnIncomingCallClose = document.getElementById('btn-incoming-call-close');
let isCallMaximized = false;
let isCallFloating = false;
let isCallMinimized = false;
let isFullCallUiOpen = false;
let minimizedTileCoords = { x: null, y: null };
let callDragState = { isDragging: false, startX: 0, startY: 0, tileInitialX: 0, tileInitialY: 0 };
let hasDraggedCallTile = false;

// Consistent SVG Line Icon Set for Dynamic UI State
const UI_ICONS = {
  popout: '<svg class="ui-icon ui-icon-xs" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>',
  restorePopout: '<svg class="ui-icon ui-icon-xs" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="14" y1="10" x2="21" y2="3"/><line x1="3" y1="21" x2="10" y2="14"/></svg>',
  maximize: '<svg class="ui-icon ui-icon-xs" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/></svg>',
  restoreMaximize: '<svg class="ui-icon ui-icon-xs" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="12" height="12" x="4" y="8" rx="2"/><path d="M8 4h10a2 2 0 0 1 2 2v10"/></svg>',
  mic: '<svg class="ui-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="22"/></svg>',
  micOff: '<svg class="ui-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="2" y1="2" x2="22" y2="22"/><path d="M18.89 13.23A7.12 7.12 0 0 0 19 12v-2"/><path d="M5 10v2a7 7 0 0 0 12 5"/><path d="M15 9.34V5a3 3 0 0 0-5.68-1.33"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12"/><line x1="12" y1="19" x2="12" y2="22"/></svg>',
  camera: '<svg class="ui-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m22 8-6 4 6 4V8Z"/><rect width="14" height="12" x="2" y="6" rx="2" ry="2"/></svg>',
  cameraOff: '<svg class="ui-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="2" y1="2" x2="22" y2="22"/><path d="M10.41 10.41a2 2 0 0 0 2.83 2.83"/><path d="M16 16v1a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2"/><path d="m22 8-6 4 6 4V8Z"/><rect width="14" height="12" x="2" y="6" rx="2" ry="2"/></svg>',
  screenShare: '<svg class="ui-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="20" height="14" x="2" y="3" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/><path d="m10 9 4-4 4 4"/><line x1="14" y1="5" x2="14" y2="13"/></svg>',
  screenShareStop: '<svg class="ui-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="20" height="14" x="2" y="3" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/><rect x="9" y="7" width="6" height="6" rx="1"/></svg>',
  phone: '<svg class="ui-icon ui-icon-lg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>',
  send: '<svg class="ui-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/></svg>',
  check: '<svg class="ui-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>'
};

// Settings Modal & Profile Edit Elements
const settingsModal = document.getElementById('settings-modal');
const btnCloseSettings = document.getElementById('btn-close-settings');
const btnCloseSettingsFooter = document.getElementById('btn-close-settings-footer');
const btnModalLogout = document.getElementById('btn-modal-logout');
const modalUserAvatar = document.getElementById('modal-user-avatar');
const userDisplayName = document.getElementById('user-display-name');
const userPhone = document.getElementById('user-phone');
const userId = document.getElementById('user-id');
const userAbout = document.getElementById('user-about');
const settingClient = document.getElementById('setting-client');
const settingToggleNotifications = document.getElementById('setting-toggle-notifications');
const settingToggleNotificationPreview = document.getElementById('setting-toggle-notification-preview');
const settingItemNotificationPreview = document.getElementById('setting-item-notification-preview');

let notificationSettings = { enabled: true, showPreview: true };

// Bounded deduplication cache for renderer notifications (up to 500 entries)
const recentNotifiedMessageIds = new Set();
const MAX_NOTIFIED_MESSAGE_CACHE_SIZE = 500;

export function isRendererDuplicateNotification(messageId) {
  if (!messageId || typeof messageId !== 'string') return false;
  const normalizedId = String(messageId).trim();
  if (!normalizedId) return false;
  if (recentNotifiedMessageIds.has(normalizedId)) {
    return true;
  }
  if (recentNotifiedMessageIds.size >= MAX_NOTIFIED_MESSAGE_CACHE_SIZE) {
    const oldestKey = recentNotifiedMessageIds.values().next().value;
    recentNotifiedMessageIds.delete(oldestKey);
  }
  recentNotifiedMessageIds.add(normalizedId);
  return false;
}

export function updateNotificationSettingsUI(settings) {
  if (!settings) return;
  if (settingToggleNotifications) {
    settingToggleNotifications.checked = Boolean(settings.enabled);
  }
  if (settingToggleNotificationPreview) {
    settingToggleNotificationPreview.checked = Boolean(settings.showPreview);
    settingToggleNotificationPreview.disabled = !settings.enabled;
  }
  if (settingItemNotificationPreview) {
    if (settings.enabled) {
      settingItemNotificationPreview.classList.remove('disabled');
    } else {
      settingItemNotificationPreview.classList.add('disabled');
    }
  }
}

export async function loadNotificationSettings() {
  try {
    const api = window.ollacoreDesktop?.notifications?.getSettings || window.ollacoreDesktop?.app?.getNotificationSettings;
    if (typeof api === 'function') {
      const res = await api();
      if (res && typeof res === 'object') {
        notificationSettings = {
          enabled: typeof res.enabled === 'boolean' ? res.enabled : true,
          showPreview: typeof res.showPreview === 'boolean' ? res.showPreview : true
        };
      }
    }
  } catch (err) {
    console.warn('[app] loadNotificationSettings error:', err);
  }
  updateNotificationSettingsUI(notificationSettings);
  return notificationSettings;
}

export async function saveNotificationSettings(partial) {
  notificationSettings = { ...notificationSettings, ...partial };
  updateNotificationSettingsUI(notificationSettings);
  try {
    const api = window.ollacoreDesktop?.notifications?.setSettings || window.ollacoreDesktop?.app?.setNotificationSettings;
    if (typeof api === 'function') {
      await api(notificationSettings);
    }
  } catch (err) {
    console.warn('[app] saveNotificationSettings error:', err);
  }
  return notificationSettings;
}

const profileEditStatus = document.getElementById('profile-edit-status');
const profileViewMode = document.getElementById('profile-view-mode');
const profileEditMode = document.getElementById('profile-edit-mode');
const profileEditForm = document.getElementById('profile-edit-form');
const profileViewFooter = document.getElementById('profile-view-footer');
const profileEditFooter = document.getElementById('profile-edit-footer');
const btnEditProfile = document.getElementById('btn-edit-profile');
const btnCancelEditProfile = document.getElementById('btn-cancel-edit-profile');
const btnSaveProfile = document.getElementById('btn-save-profile');
const editProfileName = document.getElementById('edit-profile-name');
const editProfileAbout = document.getElementById('edit-profile-about');
const modalUserAvatarEdit = document.getElementById('modal-user-avatar-edit');
const modalUserAvatarEditText = document.getElementById('modal-user-avatar-edit-text');
const btnChangePhoto = document.getElementById('btn-change-photo');
const btnRemovePhoto = document.getElementById('btn-remove-photo');
const userPhoneEdit = document.getElementById('user-phone-edit');
const userIdEdit = document.getElementById('user-id-edit');
const settingClientEdit = document.getElementById('setting-client-edit');

// Phase 3: Backup & Restore Modal Elements
const settingItemBackupRestore = document.getElementById('setting-item-backup-restore');
const backupModal = document.getElementById('backup-modal');
const btnCloseBackupModal = document.getElementById('btn-close-backup-modal');
const btnCloseBackupFooter = document.getElementById('btn-close-backup-footer');
const backupAccountId = document.getElementById('backup-account-id');
const tabBackup = document.getElementById('tab-backup');
const tabRestore = document.getElementById('tab-restore');
const panelBackup = document.getElementById('panel-backup');
const panelRestore = document.getElementById('panel-restore');
const backupIncludeAttachments = document.getElementById('backup-include-attachments');
const btnCreateBackup = document.getElementById('btn-create-backup');
const backupStatusBanner = document.getElementById('backup-status-banner');
const btnSelectRestoreFile = document.getElementById('btn-select-restore-file');
const restoreSelectedFilename = document.getElementById('restore-selected-filename');
const restoreStatusBanner = document.getElementById('restore-status-banner');
const restorePreflightView = document.getElementById('restore-preflight-view');
const preflightCreatedAt = document.getElementById('preflight-created-at');
const preflightAccount = document.getElementById('preflight-account');
const preflightConversations = document.getElementById('preflight-conversations');
const preflightMessages = document.getElementById('preflight-messages');
const preflightAttachments = document.getElementById('preflight-attachments');
const preflightIntegrity = document.getElementById('preflight-integrity');
const btnCancelRestore = document.getElementById('btn-cancel-restore');
const btnConfirmRestore = document.getElementById('btn-confirm-restore');

let selectedRestoreFilePath = null;

// Phase 4B: New Chat & Create Group Modal
const newChatModal = document.getElementById('new-chat-modal');
const btnCloseNewChat = document.getElementById('btn-close-new-chat');
const tabDirect = document.getElementById('tab-direct');
const tabGroup = document.getElementById('tab-group');
const panelDirect = document.getElementById('panel-direct');
const panelGroup = document.getElementById('panel-group');

// Direct Chat Form Elements
const directError = document.getElementById('direct-error');
const directPhoneInput = document.getElementById('direct-phone-input');
const btnLookupDirect = document.getElementById('btn-lookup-direct');
const directMatchedContact = document.getElementById('direct-matched-contact');
const directContactAvatar = document.getElementById('direct-contact-avatar');
const directContactName = document.getElementById('direct-contact-name');
const directContactPhone = document.getElementById('direct-contact-phone');
const btnStartDirectChat = document.getElementById('btn-start-direct-chat');

// Create Group Form Elements
const groupError = document.getElementById('group-error');
const groupNameInput = document.getElementById('group-name-input');
const groupMemberPhone = document.getElementById('group-member-phone');
const btnAddGroupMember = document.getElementById('btn-add-group-member');
const groupMembersCount = document.getElementById('group-members-count');
const groupMembersChips = document.getElementById('group-members-chips');
const groupAddPeopleContacts = document.getElementById('group-add-people-contacts');
const btnCreateGroup = document.getElementById('btn-create-group');

// Group Info & Settings Modal Elements
const chatHeaderInfo = document.getElementById('chat-header-info');
const btnGroupInfo = document.getElementById('btn-group-info');
const groupInfoModal = document.getElementById('group-info-modal');
const btnCloseGroupInfo = document.getElementById('btn-close-group-info');
const btnCloseGroupInfoFooter = document.getElementById('btn-close-group-info-footer');
const groupInfoError = document.getElementById('group-info-error');
const groupInfoSuccess = document.getElementById('group-info-success');
const groupInfoAvatar = document.getElementById('group-info-avatar');
const groupInfoName = document.getElementById('group-info-name');
const btnStartEditGroupName = document.getElementById('btn-start-edit-group-name');
const groupInfoRenameForm = document.getElementById('group-info-rename-form');
const groupRenameInput = document.getElementById('group-rename-input');
const btnSaveGroupName = document.getElementById('btn-save-group-name');
const btnCancelGroupName = document.getElementById('btn-cancel-group-name');
const groupInfoMemberCount = document.getElementById('group-info-member-count');
const groupInfoUserRoleBadge = document.getElementById('group-info-user-role-badge');
const groupAddMemberSection = document.getElementById('group-add-member-section');
const groupAddMemberPhone = document.getElementById('group-add-member-phone');
const btnSubmitAddMember = document.getElementById('btn-submit-add-member');
const groupAddMemberStatus = document.getElementById('group-add-member-status');
const groupMembersListCount = document.getElementById('group-members-list-count');
const groupMembersLoading = document.getElementById('group-members-loading');
const groupMembersList = document.getElementById('group-members-list');

// Contact Info Panel Elements (WhatsApp-style Right Side Panel)
const contactInfoPanel = document.getElementById('contact-info-panel');
const btnCloseContactInfo = document.getElementById('btn-close-contact-info');
const contactInfoHeaderTitle = document.getElementById('contact-info-header-title');
const contactInfoBody = document.getElementById('contact-info-body');
const contactInfoAvatar = document.getElementById('contact-info-avatar');
const contactInfoName = document.getElementById('contact-info-name');
const contactInfoIdentifier = document.getElementById('contact-info-identifier');
const contactInfoGroupMeta = document.getElementById('contact-info-group-meta');
const btnContactActionVoice = document.getElementById('btn-contact-action-voice');
const btnContactActionVideo = document.getElementById('btn-contact-action-video');
const btnContactActionSearch = document.getElementById('btn-contact-action-search');
const contactInfoAboutSection = document.getElementById('contact-info-about-section');
const contactInfoAboutTitle = document.getElementById('contact-info-about-title');
const contactInfoAboutText = document.getElementById('contact-info-about-text');
const contactInfoDetailsSection = document.getElementById('contact-info-details-section');
const contactInfoPhoneRow = document.getElementById('contact-info-phone-row');
const contactInfoPhoneValue = document.getElementById('contact-info-phone-value');
const contactInfoUsernameRow = document.getElementById('contact-info-username-row');
const contactInfoUsernameValue = document.getElementById('contact-info-username-value');
const contactInfoParticipantsSection = document.getElementById('contact-info-participants-section');
const contactInfoParticipantsCount = document.getElementById('contact-info-participants-count');
const contactInfoParticipantsLoading = document.getElementById('contact-info-participants-loading');
const contactInfoParticipantsList = document.getElementById('contact-info-participants-list');

// Contact Info WhatsApp-style Group & Action Elements
const btnContactInfoEditName = document.getElementById('btn-contact-info-edit-name');
const contactInfoRenameForm = document.getElementById('contact-info-rename-form');
const contactInfoRenameInput = document.getElementById('contact-info-rename-input');
const btnContactInfoSaveName = document.getElementById('btn-contact-info-save-name');
const btnContactInfoCancelName = document.getElementById('btn-contact-info-cancel-name');
const btnContactInfoEditDesc = document.getElementById('btn-contact-info-edit-desc');
const contactInfoDescForm = document.getElementById('contact-info-desc-form');
const contactInfoDescInput = document.getElementById('contact-info-desc-input');
const contactInfoDescCounter = document.getElementById('contact-info-desc-counter');
const btnContactInfoSaveDesc = document.getElementById('btn-contact-info-save-desc');
const btnContactInfoCancelDesc = document.getElementById('btn-contact-info-cancel-desc');
let isSavingGroupDescription = false;
const btnGroupAddPeople = document.getElementById('btn-group-add-people');
const contactInfoFavRow = document.getElementById('contact-info-fav-row');
const contactInfoFavIcon = document.getElementById('contact-info-fav-icon');
const contactInfoFavLabel = document.getElementById('contact-info-fav-label');
const contactInfoListsRow = document.getElementById('contact-info-lists-row');
const contactInfoClearChatRow = document.getElementById('contact-info-clear-chat-row');
const contactInfoExitGroupRow = document.getElementById('contact-info-exit-group-row');
const contactInfoDeleteChatRow = document.getElementById('contact-info-delete-chat-row');

// Contact Info Personal Nickname Elements
const btnContactInfoNicknameAction = document.getElementById('btn-contact-info-nickname-action');
const contactInfoNicknameActionLabel = document.getElementById('contact-info-nickname-action-label');
const contactInfoNicknameForm = document.getElementById('contact-info-nickname-form');
const contactInfoNicknameInput = document.getElementById('contact-info-nickname-input');
const btnContactInfoSaveNickname = document.getElementById('btn-contact-info-save-nickname');
const btnContactInfoCancelNickname = document.getElementById('btn-contact-info-cancel-nickname');
const btnContactInfoRemoveNickname = document.getElementById('btn-contact-info-remove-nickname');
const contactInfoServerNameRow = document.getElementById('contact-info-server-name-row');
const contactInfoServerNameValue = document.getElementById('contact-info-server-name-value');

// Participant Action Menu Elements
const participantActionMenu = document.getElementById('participant-action-menu');
const partMenuViewContact = document.getElementById('part-menu-view-contact');
const partMenuMakeAdmin = document.getElementById('part-menu-make-admin');
const partMenuMakeAdminText = document.getElementById('part-menu-make-admin-text');
const partMenuDismissAdmin = document.getElementById('part-menu-dismiss-admin');
const partMenuDismissAdminText = document.getElementById('part-menu-dismiss-admin-text');
const partMenuSeparator = document.getElementById('part-menu-separator');
const partMenuRemove = document.getElementById('part-menu-remove');
const partMenuRemoveText = document.getElementById('part-menu-remove-text');

// Add People to Group Modal Dialog Elements
const groupAddPeopleModal = document.getElementById('group-add-people-modal');
const btnCloseGroupAddPeople = document.getElementById('btn-close-group-add-people');
const btnCancelGroupAddPeople = document.getElementById('btn-cancel-group-add-people');
const btnConfirmGroupAddPeople = document.getElementById('btn-confirm-group-add-people');
const groupAddPeopleInput = document.getElementById('group-add-people-input');
const btnLookupGroupAddPeople = document.getElementById('btn-lookup-group-add-people');
const groupAddPeopleMatched = document.getElementById('group-add-people-matched');
const btnSelectMatchedContact = document.getElementById('btn-select-matched-contact');
const groupAddPeopleAvatar = document.getElementById('group-add-people-avatar');
const groupAddPeopleName = document.getElementById('group-add-people-name');
const groupAddPeoplePhone = document.getElementById('group-add-people-phone');
const groupAddPeopleContactsList = document.getElementById('group-add-people-contacts-list');
const groupAddPeopleError = document.getElementById('group-add-people-error');

// Group Confirm Dialog Elements
const groupConfirmModal = document.getElementById('group-confirm-modal');
const confirmModalTitle = document.getElementById('confirm-modal-title');
const confirmModalMessage = document.getElementById('confirm-modal-message');
const btnCloseConfirm = document.getElementById('btn-close-confirm');
const btnConfirmCancel = document.getElementById('btn-confirm-cancel');
const btnConfirmProceed = document.getElementById('btn-confirm-proceed');

// Leave Group Confirmation Dialog Elements
const leaveGroupConfirmModal = document.getElementById('leave-group-confirm-modal');
const leaveGroupModalTitle = document.getElementById('leave-group-modal-title');
const leaveGroupModalMessage = document.getElementById('leave-group-modal-message');
const btnCloseLeaveGroup = document.getElementById('btn-close-leave-group');
const btnLeaveGroupCancel = document.getElementById('btn-leave-group-cancel');
const btnLeaveGroupDelete = document.getElementById('btn-leave-group-delete');
const btnLeaveGroupConfirm = document.getElementById('btn-leave-group-confirm');
let pendingLeaveGroupRoomId = null;

// Clear Chat Options Modal Elements
const clearChatModal = document.getElementById('clear-chat-modal');
const btnCloseClearChat = document.getElementById('btn-close-clear-chat');
const btnClearChatCancel = document.getElementById('btn-clear-chat-cancel');
const btnClearChatProceed = document.getElementById('btn-clear-chat-proceed');
const clearChatOptionMessagesOnly = document.getElementById('clear-chat-option-messages-only');
const clearChatOptionMessagesAndMedia = document.getElementById('clear-chat-option-messages-and-media');

// Chat Theme Modal Elements
const btnChatTheme = document.getElementById('btn-chat-theme');
const settingItemChatTheme = document.getElementById('setting-item-chat-theme');
const chatThemeModal = document.getElementById('chat-theme-modal');
const btnCloseTheme = document.getElementById('btn-close-theme');
const btnCancelTheme = document.getElementById('btn-cancel-theme');
const btnSaveTheme = document.getElementById('btn-save-theme');
const btnResetTheme = document.getElementById('btn-reset-theme');
const themePresetsScroll = document.getElementById('theme-presets-scroll');
const bubbleStylesGallery = document.getElementById('bubble-styles-gallery');
const wallpaperGrid = document.getElementById('wallpaper-grid');
const btnUploadCustomWallpaper = document.getElementById('btn-upload-custom-wallpaper');
const btnRemoveCustomWallpaper = document.getElementById('btn-remove-custom-wallpaper');
const customWallpaperThumb = document.getElementById('custom-wallpaper-thumb');
const customWallpaperStatus = document.getElementById('custom-wallpaper-status');
const themePreviewScreen = document.getElementById('theme-preview-screen');
const themePreviewIncoming = document.getElementById('theme-preview-incoming');
const themePreviewOutgoing = document.getElementById('theme-preview-outgoing');
const themePreviewMedia = document.getElementById('theme-preview-media');
const themePreviewStatusName = document.getElementById('theme-preview-status-name');
const themePreviewChatTitle = document.getElementById('theme-preview-chat-title');
const themePreviewAvatar = document.getElementById('theme-preview-avatar');
const chatThemeSubtitle = document.getElementById('chat-theme-subtitle');

// Chat Header Three-Dot Options Menu Elements
const btnChatMenu = document.getElementById('btn-chat-menu');
const chatHeaderMenu = document.getElementById('chat-header-menu');
const menuItemContactInfo = document.getElementById('menu-item-contact-info');
const menuContactInfoText = document.getElementById('menu-contact-info-text');
const menuItemChatSearch = document.getElementById('menu-item-chat-search');
const menuItemStarredMessages = document.getElementById('menu-item-starred-messages');
const menuItemChatTheme = document.getElementById('menu-item-chat-theme');
const menuItemToggleFav = document.getElementById('menu-item-toggle-favourite');
const menuFavText = document.getElementById('menu-fav-text');
const menuItemChangeList = document.getElementById('menu-item-change-list');
const menuItemToggleArchive = document.getElementById('menu-item-toggle-archive');
const menuArchiveText = document.getElementById('menu-archive-text');
const menuItemClearChat = document.getElementById('menu-item-clear-chat');
const menuItemExitGroup = document.getElementById('menu-item-exit-group');
const menuItemDeleteChat = document.getElementById('menu-item-delete-chat');
const menuItemToggleMute = document.getElementById('menu-item-toggle-mute');
const menuMuteText = document.getElementById('menu-mute-text');
const menuItemBlockContact = document.getElementById('menu-item-block-contact');
const menuBlockText = document.getElementById('menu-block-text');

// Mute Duration Modal Elements
const muteDurationModal = document.getElementById('mute-duration-modal');
const btnCloseMuteDuration = document.getElementById('btn-close-mute-duration');
const btnCancelMuteDuration = document.getElementById('btn-cancel-mute-duration');
const btnConfirmMuteDuration = document.getElementById('btn-confirm-mute-duration');
const muteModalError = document.getElementById('mute-modal-error');
const muteSpinner = document.getElementById('mute-spinner');

// Block Contact Confirmation Modal Elements
const blockContactConfirmModal = document.getElementById('block-contact-confirm-modal');
const btnCloseBlockConfirm = document.getElementById('btn-close-block-confirm');
const btnCancelBlockConfirm = document.getElementById('btn-cancel-block-confirm');
const btnConfirmBlock = document.getElementById('btn-confirm-block');
const blockModalError = document.getElementById('block-modal-error');
const blockSpinner = document.getElementById('block-spinner');
const blockConfirmDesc = document.getElementById('block-confirm-desc');

// Blocked Contacts Modal Elements
const blockedContactsModal = document.getElementById('blocked-contacts-modal');
const btnCloseBlockedContacts = document.getElementById('btn-close-blocked-contacts');
const btnDoneBlockedContacts = document.getElementById('btn-done-blocked-contacts');
const blockedContactsList = document.getElementById('blocked-contacts-list');
const blockedContactsLoading = document.getElementById('blocked-contacts-loading');
const blockedContactsEmpty = document.getElementById('blocked-contacts-empty');
const blockedContactsError = document.getElementById('blocked-contacts-error');
const settingItemBlockedContacts = document.getElementById('setting-item-blocked-contacts');
const settingBlockedCountHint = document.getElementById('setting-blocked-count-hint');

// Contact Info Block/Mute Elements
const contactInfoMuteRow = document.getElementById('contact-info-mute-row');
const contactInfoMuteLabel = document.getElementById('contact-info-mute-label');
const contactInfoMuteValue = document.getElementById('contact-info-mute-value');
const contactInfoBlockRow = document.getElementById('contact-info-block-row');
const contactInfoBlockLabel = document.getElementById('contact-info-block-label');

// Composer Blocked Banner Elements
const composerBlockedBanner = document.getElementById('composer-blocked-banner');
const btnUnblockComposer = document.getElementById('btn-unblock-composer') || document.getElementById('btn-blocked-banner-unblock');

// Composer Exited Group Banner Elements
const composerExitedBanner = document.getElementById('composer-exited-banner');
const composerExitedText = document.getElementById('composer-exited-text');

let activeMuteModalRoomId = null;
let activeBlockModalUserId = null;

// Change Chat Lists Modal Elements
const changeChatListsModal = document.getElementById('change-chat-lists-modal');
const btnCloseChangeChatLists = document.getElementById('btn-close-change-chat-lists');
const btnDoneChangeChatLists = document.getElementById('btn-done-change-chat-lists');
const btnCreateListFromChangeModal = document.getElementById('btn-create-list-from-change-modal');
const changeChatListsItems = document.getElementById('change-chat-lists-items');

// Appearance Theme Elements
const themeBtnLight = document.getElementById('theme-btn-light');
const themeBtnDark = document.getElementById('theme-btn-dark');
const themeBtnSystem = document.getElementById('theme-btn-system');

// ═══════════════════════════════════════════════════════════════════
// State Management
// ═══════════════════════════════════════════════════════════════════
const shellState = new ChatShellState();
const directDraft = new DirectChatDraft();
const groupDraft = new GroupCreationDraft();

// Per-room messages state map & shared receipt store
const sharedRoomReceiptStore = new Map(); // roomId -> Map<messageId, status>
loadPersistentReceiptStore(sharedRoomReceiptStore);
const roomMessagesMap = new Map(); // roomId -> RoomMessagesState
let activeRoomMessagesState = new RoomMessagesState(null, sharedRoomReceiptStore);

function getOrCreateRoomMessagesState(roomId) {
  if (!roomId) return null;
  const currentUserId = shellState.currentUser?.userId || shellState.userProfile?.userId || null;
  if (!roomMessagesMap.has(roomId)) {
    const s = new RoomMessagesState(currentUserId, sharedRoomReceiptStore);
    s.roomId = roomId;
    roomMessagesMap.set(roomId, s);
  } else if (currentUserId) {
    const s = roomMessagesMap.get(roomId);
    if (!s.currentUserId || s.currentUserId !== currentUserId) {
      s.setCurrentUserId(currentUserId);
    }
  }
  return roomMessagesMap.get(roomId);
}

// Backwards-compatible proxy to active room messages state
const roomMessagesState = new Proxy({}, {
  get(_target, prop) {
    const val = activeRoomMessagesState[prop];
    return typeof val === 'function' ? val.bind(activeRoomMessagesState) : val;
  },
  set(_target, prop, value) {
    activeRoomMessagesState[prop] = value;
    return true;
  }
});

const pendingRoomModalities = new Map();

async function sendCallSignal(action, roomId, extra = {}) {
  const modality = extra.callType || (extra.isVideo ? 'video' : 'voice');
  const epoch = extra.callEpoch ?? extra.call_epoch ?? null;
  const logResult = (result, code = null) => {
    console.info('[VoiceCall] SIGNAL_SEND', {
      stage: 'renderer_signal_send',
      action,
      modality,
      epoch,
      result,
      code
    });
  };
  const fail = (code, message, cause = null) => {
    logResult('failed', code);
    const error = new Error(message);
    error.code = code;
    if (cause) error.cause = cause;
    throw error;
  };
  const cleanRoomId = typeof roomId === 'string' ? roomId.trim() : '';
  if (!cleanRoomId) {
    fail('call_signal_room_required', 'A room is required to send a call signal');
  }
  const send = window.ollacoreDesktop?.chat?.send;
  if (typeof send !== 'function') {
    fail('call_signal_bridge_unavailable', 'The chat bridge is unavailable');
  }

  const rawId = generateUuid();
  const clientMessageId = rawId.startsWith('call_sig_') ? rawId : `call_sig_${rawId}`;
  let result;
  try {
    result = await send('message.send', {
      client_message_id: clientMessageId,
      kind: 'text',
      body: {
        call_signal: action,
        call_type: modality,
        is_video: Boolean(extra.isVideo),
        call_id: extra.callId || extra.call_id || null,
        call_epoch: epoch,
        target_user_id: extra.targetUserId || extra.target_user_id || null,
        text: ''
      }
    }, cleanRoomId);
  } catch (err) {
    fail('call_signal_ipc_rejected', 'The call signal request was rejected', err);
  }
  if (!result || result.ok !== true) {
    const error = new Error('The call signal was not sent');
    error.code = 'call_signal_send_failed';
    error.transportCode = typeof result?.code === 'string' ? result.code : null;
    logResult('failed', error.transportCode || error.code);
    throw error;
  }
  logResult('sent');
  return result;
}

// Phase 6B/6C Voice & Video Call Manager Instance
const voiceCallManager = new VoiceCallManager({
  rtcBridge: typeof window !== 'undefined' ? window.ollacoreDesktop?.rtc : null,
  mediaDevices: typeof navigator !== 'undefined' ? navigator.mediaDevices : null,
  PeerConnectionClass: typeof window !== 'undefined' ? window.RTCPeerConnection : null,
  SessionDescriptionClass: typeof window !== 'undefined' ? window.RTCSessionDescription : null,
  IceCandidateClass: typeof window !== 'undefined' ? window.RTCIceCandidate : null,
  remoteAudioElement: remoteVoiceAudio,
  localVideoElement: localVideo,
  remoteVideoElement: remoteVideo,
  sendSignal: ({ action, roomId, callType, isVideo, callId, callEpoch }) => {
    return sendCallSignal(action, roomId, { callType, isVideo, callId, callEpoch });
  }
});

export const recentlyInitiatedCalls = new Map(); // roomId -> timestamp ms

// Wrap startCall and startVideoCall to automatically record outgoing call intention for direction tracking
const originalStartCall = voiceCallManager.startCall.bind(voiceCallManager);
voiceCallManager.startCall = function (roomId, ...args) {
  const conv = shellState.conversations?.find((c) => (c.roomId || c.room_id || c.id) === roomId);
  if (conv?.isExited || conv?.exited) {
    console.warn('[VoiceCall] Blocked outgoing call to exited group:', roomId);
    return Promise.reject(new Error('Cannot make calls to an exited group'));
  }
  if (roomId) {
    recentlyInitiatedCalls.set(String(roomId).trim(), Date.now());
  }
  isCallMinimized = false;
  isCallFloating = false;
  isCallMaximized = false;
  isFullCallUiOpen = true;
  if (typeof window !== 'undefined' && window.ollacoreDesktop?.floatingCall) {
    window.ollacoreDesktop.floatingCall.show().catch(() => { });
    syncFloatingCallState();
  }
  return originalStartCall(roomId, ...args);
};

const originalStartVideoCall = voiceCallManager.startVideoCall.bind(voiceCallManager);
voiceCallManager.startVideoCall = function (roomId, ...args) {
  const conv = shellState.conversations?.find((c) => (c.roomId || c.room_id || c.id) === roomId);
  if (conv?.isExited || conv?.exited) {
    console.warn('[VideoCall] Blocked outgoing call to exited group:', roomId);
    return Promise.reject(new Error('Cannot make calls to an exited group'));
  }
  if (roomId) {
    recentlyInitiatedCalls.set(String(roomId).trim(), Date.now());
  }
  isCallMinimized = false;
  isCallFloating = false;
  isCallMaximized = false;
  isFullCallUiOpen = true;
  if (typeof window !== 'undefined' && window.ollacoreDesktop?.floatingCall) {
    window.ollacoreDesktop.floatingCall.show().catch(() => { });
    syncFloatingCallState();
  }
  return originalStartVideoCall(roomId, ...args);
};

function clampMinimizedTilePosition() {
  if (!voiceCallCard) return;
  const margin = 10;
  const rect = voiceCallCard.getBoundingClientRect();
  const width = rect.width || (voiceCallManager?.isVideo ? 240 : 280);
  const height = rect.height || (voiceCallManager?.isVideo ? 170 : 64);

  const winW = typeof window !== 'undefined' ? window.innerWidth : 1024;
  const winH = typeof window !== 'undefined' ? window.innerHeight : 768;

  const minX = margin;
  const maxX = Math.max(margin, winW - width - margin);
  const minY = margin;
  const maxY = Math.max(margin, winH - height - margin);

  if (minimizedTileCoords.x === null || minimizedTileCoords.y === null) {
    minimizedTileCoords.x = maxX;
    minimizedTileCoords.y = margin + 14;
  }

  minimizedTileCoords.x = Math.min(Math.max(minX, minimizedTileCoords.x), maxX);
  minimizedTileCoords.y = Math.min(Math.max(minY, minimizedTileCoords.y), maxY);
}

function applyMinimizedTilePosition() {
  if (!voiceCallCard || !isCallMinimized) return;
  voiceCallCard.style.left = `${minimizedTileCoords.x}px`;
  voiceCallCard.style.top = `${minimizedTileCoords.y}px`;
  voiceCallCard.style.right = 'auto';
  voiceCallCard.style.bottom = 'auto';
  voiceCallCard.style.position = 'fixed';
}

function minimizeCall() {
  if (!voiceCallOverlay || !voiceCallCard) return;
  isCallMinimized = true;
  isCallFloating = true;
  isFullCallUiOpen = false;
  isCallMaximized = false;
  voiceCallCard.classList.remove('is-maximized');
  if (callMaximizeIcon) callMaximizeIcon.innerHTML = UI_ICONS.maximize;

  voiceCallOverlay.classList.remove('hidden');
  voiceCallOverlay.classList.add('is-minimized', 'is-floating');
  voiceCallOverlay.classList.remove('is-incoming', 'is-outgoing');

  voiceCallCard.classList.add('is-minimized', 'is-floating');
  voiceCallCard.classList.remove('is-incoming', 'is-outgoing');

  callMinimizedControls?.classList.remove('hidden');

  clampMinimizedTilePosition();
  applyMinimizedTilePosition();

  if (voiceCallManager) {
    if (voiceCallManager.state === CALL_STATE.CONNECTED) {
      callStatusLabel?.classList.add('hidden');
      callTimerLabel?.classList.remove('hidden');
      if (callTimerLabel) callTimerLabel.textContent = voiceCallManager.getFormattedDuration();
    } else {
      callStatusLabel?.classList.remove('hidden');
      callTimerLabel?.classList.add('hidden');
    }
  }

  // Hide desktop floating call window while main app is open
  if (typeof window !== 'undefined' && window.ollacoreDesktop?.floatingCall) {
    window.ollacoreDesktop.floatingCall.hide().catch(() => { });
    syncFloatingCallState();
  }
}

function restoreCall() {
  if (!voiceCallOverlay || !voiceCallCard) return;
  isCallMinimized = false;
  isCallFloating = false;
  isCallMaximized = false;
  isFullCallUiOpen = true;

  voiceCallOverlay.classList.remove('is-minimized', 'is-floating');
  voiceCallCard.classList.remove('is-minimized', 'is-floating', 'is-maximized');
  if (callMaximizeIcon) callMaximizeIcon.innerHTML = UI_ICONS.maximize;

  callMinimizedControls?.classList.add('hidden');
  voiceCallCard.style.left = '';
  voiceCallCard.style.top = '';
  voiceCallCard.style.right = '';
  voiceCallCard.style.bottom = '';
  voiceCallCard.style.position = '';

  const hasFloatingBridge = (typeof window !== 'undefined' && Boolean(window.ollacoreDesktop?.floatingCall));
  if (hasFloatingBridge) {
    voiceCallOverlay.classList.add('hidden');
    syncFloatingCallState();
    if (voiceCallManager && voiceCallManager.state === CALL_STATE.CONNECTED && (voiceCallManager.isVideo || voiceCallManager.remoteScreenSharing)) {
      startFloatingVideoBridge();
    }
  } else if (voiceCallManager && voiceCallManager.state !== CALL_STATE.IDLE && !voiceCallManager.isEnded) {
    voiceCallOverlay.classList.remove('hidden');
    updateVoiceCallUi(voiceCallManager.state, voiceCallManager.peerName, voiceCallManager.error);
    if (remoteVideo && voiceCallManager._remoteStream) {
      if (remoteVideo.srcObject !== voiceCallManager._remoteStream) {
        remoteVideo.srcObject = voiceCallManager._remoteStream;
      }
      remoteVideo.play?.().catch(() => { });
    }
  }

  // Only hide desktop floating window if running without floating bridge
  if (!hasFloatingBridge && typeof window !== 'undefined' && window.ollacoreDesktop?.floatingCall) {
    window.ollacoreDesktop.floatingCall.hide().catch(() => { });
    syncFloatingCallState();
  }

  if (localVideoBridgePc) {
    try { localVideoBridgePc.close(); } catch { }
    localVideoBridgePc = null;
  }
}

let isMainWindowMinimized = false;
let isMainWindowVisible = true;
let isMainWindowFocused = typeof document !== 'undefined' && typeof document.hasFocus === 'function' ? document.hasFocus() : true;
let localVideoBridgePc = null;
let lastMainCallUiDiagnostic = '';
let lastFloatingCallSyncDiagnostic = '';

function getCallUiLifecycleMetadata(state = voiceCallManager?.state || 'idle') {
  const direction = voiceCallManager?._isIncoming ? 'incoming' : 'outgoing';
  const localOwnershipEpoch = voiceCallManager?.callEpoch || 0;
  const signalingCorrelation = voiceCallManager?.signalingEpoch == null
    ? 'expected_unavailable'
    : (direction === 'outgoing'
      ? (voiceCallManager?._calleeAccepted ? 'accepted' : 'pending')
      : 'retained');

  return {
    direction,
    state,
    localOwnershipEpoch,
    signalingCorrelation,
    ownsManagerState: state === voiceCallManager?.state,
    ownsPeer: Boolean(voiceCallManager?.peerConnection)
  };
}

function logCallUiSynchronization(event, metadata, extra = {}) {
  const diagnosticKey = [
    event,
    metadata.direction,
    metadata.state,
    metadata.localOwnershipEpoch,
    metadata.signalingCorrelation,
    metadata.ownsManagerState,
    metadata.ownsPeer,
    extra.hasFloatingBridge ?? ''
  ].join('|');
  const previousKey = event === 'main_ui_synchronized'
    ? lastMainCallUiDiagnostic
    : lastFloatingCallSyncDiagnostic;
  if (diagnosticKey === previousKey) return;

  if (event === 'main_ui_synchronized') {
    lastMainCallUiDiagnostic = diagnosticKey;
  } else {
    lastFloatingCallSyncDiagnostic = diagnosticKey;
  }

  console.info('[VoiceCall] CALL_UI_LIFECYCLE', {
    event,
    ...metadata,
    ...extra
  });
}

export function isAppActiveAndFocused() {
  return isWindowActiveAndVisible(typeof document !== 'undefined' ? document : null, {
    isMinimized: isMainWindowMinimized,
    isVisible: isMainWindowVisible,
    isFocused: isMainWindowFocused
  });
}

function syncFloatingCallState() {
  if (typeof window === 'undefined' || !window.ollacoreDesktop?.floatingCall) return;
  const state = voiceCallManager?.state || 'idle';
  const lifecycle = getCallUiLifecycleMetadata(state);
  const isVideo = Boolean(voiceCallManager?.isVideo || voiceCallManager?.mode === 'video');
  const isMuted = Boolean(voiceCallManager?.isMuted);
  const isCameraOff = Boolean(voiceCallManager?.isCameraOff);
  const duration = voiceCallManager?.durationSec ?? voiceCallManager?.duration ?? 0;
  const callConnectedAt = voiceCallManager?.callConnectedAt || null;
  const roomId = voiceCallManager?.roomId || null;
  const peerName = voiceCallManager?.peerName || 'Contact';
  const peerUserId = voiceCallManager?.peerUserId || null;
  const isScreenSharing = Boolean(voiceCallManager?.isScreenSharing);

  logCallUiSynchronization('floating_ui_state_sent', lifecycle, {
    hasFloatingBridge: true
  });

  window.ollacoreDesktop.floatingCall.syncState({
    state,
    direction: lifecycle.direction,
    localOwnershipEpoch: lifecycle.localOwnershipEpoch,
    signalingCorrelation: lifecycle.signalingCorrelation,
    ownsManagerState: lifecycle.ownsManagerState,
    ownsPeer: lifecycle.ownsPeer,
    isVideo,
    isMuted,
    isCameraOff,
    duration,
    callConnectedAt,
    roomId,
    peerName,
    peerUserId,
    isScreenSharing,
    isCallMinimized: Boolean(isCallMinimized)
  }).catch(() => { });

  if ((isVideo || voiceCallManager?.remoteScreenSharing) && !localVideoBridgePc) {
    startFloatingVideoBridge();
  }
}

function startFloatingVideoBridge() {
  if (typeof window === 'undefined' || !window.ollacoreDesktop?.floatingCall || typeof RTCPeerConnection === 'undefined') return;
  const isVideo = Boolean(voiceCallManager?.isVideo || voiceCallManager?.mode === 'video' || voiceCallManager?.remoteScreenSharing);
  if (!isVideo) return;

  const stream = voiceCallManager?._remoteStream || remoteVideo?.srcObject;
  const localStream = voiceCallManager?._localStream || localVideo?.srcObject;

  if (localVideoBridgePc) {
    try { localVideoBridgePc.close(); } catch { }
    localVideoBridgePc = null;
  }

  const pc = new RTCPeerConnection();
  localVideoBridgePc = pc;

  let remoteTrackId = null;
  let localTrackId = null;

  if (stream && stream !== localStream && typeof stream.getVideoTracks === 'function') {
    const videoTracks = stream.getVideoTracks();
    const videoTrack = videoTracks.find((t) => t.readyState === 'live') || videoTracks[0];
    if (videoTrack) {
      remoteTrackId = videoTrack.id;
      pc.addTrack(videoTrack, stream);
    }
  }

  if (localStream && typeof localStream.getVideoTracks === 'function') {
    const localVideoTracks = localStream.getVideoTracks();
    const localVideoTrack = localVideoTracks.find((t) => t.readyState === 'live') || localVideoTracks[0];
    if (localVideoTrack) {
      localTrackId = localVideoTrack.id;
      pc.addTrack(localVideoTrack, localStream);
    }
  }

  pc.onicecandidate = (e) => {
    if (e.candidate && e.candidate.candidate) {
      window.ollacoreDesktop.floatingCall.bridgeSignal({
        type: 'candidate',
        candidate: {
          candidate: e.candidate.candidate,
          sdpMid: e.candidate.sdpMid,
          sdpMLineIndex: e.candidate.sdpMLineIndex
        }
      }).catch(() => { });
    }
  };

  pc.createOffer().then((offer) => {
    return pc.setLocalDescription(offer).then(() => {
      let remoteMid = null;
      let localMid = null;
      try {
        const transceivers = pc.getTransceivers ? pc.getTransceivers() : [];
        for (const tc of transceivers) {
          if (remoteTrackId && tc.sender?.track?.id === remoteTrackId) {
            remoteMid = tc.mid;
          } else if (localTrackId && tc.sender?.track?.id === localTrackId) {
            localMid = tc.mid;
          }
        }
      } catch (_) { }

      return window.ollacoreDesktop.floatingCall.bridgeSignal({
        type: 'offer',
        offer: {
          type: offer.type,
          sdp: offer.sdp
        },
        tracks: {
          remoteId: remoteTrackId,
          localId: localTrackId,
          remoteMid,
          localMid,
          remoteStreamId: (remoteTrackId && stream?.id) ? stream.id : null,
          localStreamId: (localTrackId && localStream?.id) ? localStream.id : null,
          remoteIndex: remoteTrackId ? 0 : -1,
          localIndex: localTrackId ? (remoteTrackId ? 1 : 0) : -1
        }
      });
    });
  }).catch((err) => {
    console.warn('[FloatingBridge] createOffer error:', err);
  });
}

function resolveCallerIdentity(roomId, initiatorId) {
  let displayName = '';
  let phone = '';

  const conv = shellState.conversations?.find((c) => c.roomId === roomId || c.id === roomId);
  if (conv) {
    if (conv.name && !isInternalIdOrUuid(conv.name)) {
      displayName = conv.name.trim();
    } else if (conv.peer?.displayName && !isInternalIdOrUuid(conv.peer.displayName)) {
      displayName = conv.peer.displayName.trim();
    }
    if (conv.peer?.phone) {
      phone = conv.peer.phone.trim();
    } else if (conv.phone) {
      phone = conv.phone.trim();
    }
  }

  if (!displayName && initiatorId && !isInternalIdOrUuid(initiatorId)) {
    displayName = initiatorId.trim();
  }

  // Hierarchy: 1. display name -> 2. phone number -> 3. safe generic fallback
  if (!displayName && phone) {
    displayName = phone;
  } else if (!displayName) {
    displayName = 'Incoming Caller';
  }

  return { displayName, phone };
}

function updateVoiceCallUi(state, peerName, error) {
  if (!voiceCallOverlay) return;

  const isVideo = Boolean(voiceCallManager.isVideo || voiceCallManager.mode === 'video');
  const hasFloatingBridge = (typeof window !== 'undefined' && Boolean(window.ollacoreDesktop?.floatingCall));
  const lifecycle = getCallUiLifecycleMetadata(state);

  const isFailed = (state === CALL_STATE.FAILED || voiceCallManager.state === CALL_STATE.FAILED);
  if ((state === CALL_STATE.IDLE || voiceCallManager.isEnded) && !isFailed) {
    isFullCallUiOpen = false;
    restoreCall();
    voiceCallOverlay.classList.add('hidden');
    voiceCallOverlay.classList.remove('is-floating', 'is-incoming');
    voiceCallOverlay.classList.remove('is-outgoing');
    voiceCallOverlay.classList.remove('is-minimized');
    videoStage?.classList.add('hidden');
    voiceCallCard?.classList.remove('is-video-call', 'is-maximized', 'is-floating', 'is-minimized', 'is-incoming', 'is-outgoing', 'is-incoming-voice', 'is-incoming-video');
    incomingCallHeader?.classList.add('hidden');
    btnCallMaximize?.classList.add('hidden');
    btnCallPopout?.classList.add('hidden');
    btnCallMinimize?.classList.add('hidden');
    btnCallRequestVideo?.classList.add('hidden');
    callTimerLabel?.classList.add('hidden');
    if (callTimerLabel) callTimerLabel.textContent = '00:00';
    if (callPeerPhone) {
      callPeerPhone.textContent = '';
      callPeerPhone.classList.add('hidden');
    }
    if (callPeerAvatar) {
      callPeerAvatar.innerHTML = UI_ICONS.phone;
      callPeerAvatar.style.backgroundColor = '';
    }
    isCallMaximized = false;
    isCallFloating = false;
    if (callMaximizeIcon) callMaximizeIcon.innerHTML = UI_ICONS.maximize;
    if (callPopoutIcon) callPopoutIcon.innerHTML = UI_ICONS.popout;
    if (hasFloatingBridge) {
      window.ollacoreDesktop.floatingCall.hide().catch(() => { });
    }
    logCallUiSynchronization('main_ui_synchronized', lifecycle, {
      hasFloatingBridge
    });
    return;
  }

  const isIncoming = (state === CALL_STATE.INCOMING_RINGING);
  const isOutgoing = (state === CALL_STATE.OUTGOING_RINGING);
  const isRinging = (isIncoming || isOutgoing);

  if (hasFloatingBridge) {
    // Dedicated Desktop Standalone Window handles call presentation (WhatsApp Desktop model)
    voiceCallOverlay.classList.add('hidden');
    window.ollacoreDesktop.floatingCall.show().catch(() => { });
    syncFloatingCallState();
    if (state === CALL_STATE.CONNECTED && isVideo) {
      startFloatingVideoBridge();
    }
  } else if (isRinging) {
    if (isCallMinimized) {
      voiceCallOverlay.classList.remove('hidden');
      voiceCallOverlay.classList.add('is-minimized', 'is-floating');
      voiceCallCard?.classList.add('is-minimized', 'is-floating');
      callMinimizedControls?.classList.remove('hidden');
      clampMinimizedTilePosition();
      applyMinimizedTilePosition();
    } else {
      voiceCallOverlay.classList.remove('hidden', 'is-minimized', 'is-floating');
      voiceCallCard?.classList.remove('is-minimized', 'is-floating');
      callMinimizedControls?.classList.add('hidden');
    }
  } else if (state === CALL_STATE.CONNECTED) {
    if (!isCallMinimized) {
      isFullCallUiOpen = true;
      voiceCallOverlay.classList.remove('hidden', 'is-minimized', 'is-floating');
      voiceCallCard?.classList.remove('is-minimized', 'is-floating');
      callMinimizedControls?.classList.add('hidden');
    } else {
      voiceCallOverlay.classList.remove('hidden');
      voiceCallOverlay.classList.add('is-minimized', 'is-floating');
      voiceCallCard?.classList.add('is-minimized', 'is-floating');
      callMinimizedControls?.classList.remove('hidden');
      clampMinimizedTilePosition();
      applyMinimizedTilePosition();
    }
  } else {
    if (isCallMinimized) {
      voiceCallOverlay.classList.remove('hidden');
      voiceCallOverlay.classList.add('is-minimized', 'is-floating');
      voiceCallCard?.classList.add('is-minimized', 'is-floating');
      callMinimizedControls?.classList.remove('hidden');
      clampMinimizedTilePosition();
      applyMinimizedTilePosition();
    } else {
      voiceCallOverlay.classList.remove('hidden', 'is-minimized', 'is-floating');
      voiceCallCard?.classList.remove('is-minimized', 'is-floating');
      callMinimizedControls?.classList.add('hidden');
    }
  }

  // Display Name: sanitized, never UUID
  let cleanName = peerName;
  if (!cleanName || isInternalIdOrUuid(cleanName)) {
    cleanName = isVideo ? 'Video Call' : 'Voice Call';
  }
  if (callPeerName) callPeerName.textContent = cleanName;

  // Phone number line: show if available and distinct from display name
  const peerPhone = voiceCallManager.peerPhone || '';
  if (callPeerPhone) {
    if (peerPhone && peerPhone !== cleanName) {
      callPeerPhone.textContent = peerPhone;
      callPeerPhone.classList.remove('hidden');
    } else {
      callPeerPhone.textContent = '';
      callPeerPhone.classList.add('hidden');
    }
  }

  // Incoming / Outgoing Call State Handling vs Active Call
  if (isIncoming) {
    voiceCallOverlay.classList.add('is-incoming');
    voiceCallOverlay.classList.remove('is-outgoing');
    voiceCallCard?.classList.add('is-incoming');
    voiceCallCard?.classList.remove('is-outgoing');
    incomingCallHeader?.classList.remove('hidden');
  } else if (isOutgoing) {
    voiceCallOverlay.classList.add('is-outgoing');
    voiceCallOverlay.classList.remove('is-incoming');
    voiceCallCard?.classList.add('is-outgoing');
    voiceCallCard?.classList.remove('is-incoming', 'is-maximized');
    incomingCallHeader?.classList.add('hidden');
    isCallMaximized = false;
    isFullCallUiOpen = true;
  } else {
    voiceCallOverlay.classList.remove('is-incoming', 'is-outgoing');
    voiceCallCard?.classList.remove('is-incoming', 'is-outgoing');
    incomingCallHeader?.classList.add('hidden');
  }

  // Modality styling and video stage
  voiceCallCard?.classList.remove('is-incoming-voice', 'is-incoming-video');
  const isScreenActive = Boolean(voiceCallManager.isScreenSharing || voiceCallManager.remoteScreenSharing);
  if (isVideo || isScreenActive) {
    if (state === CALL_STATE.CONNECTED) {
      voiceCallCard?.classList.add('is-video-call');
      voiceCallCard?.classList.toggle('is-screenshare-active', isScreenActive);
      videoStage?.classList.remove('hidden');
      videoStage?.classList.toggle('is-screenshare-active', isScreenActive);
      videoStage?.classList.toggle('is-local-screenshare', Boolean(voiceCallManager.isScreenSharing));
      videoStage?.classList.toggle('is-remote-screenshare', Boolean(voiceCallManager.remoteScreenSharing));
      callPeerAvatar?.classList.add('hidden');
      btnCallMaximize?.classList.add('hidden');
      btnCallPopout?.classList.add('hidden');
    } else {
      voiceCallCard?.classList.remove('is-video-call', 'is-screenshare-active', 'is-maximized', 'is-floating');
      videoStage?.classList.add('hidden');
      videoStage?.classList.remove('is-screenshare-active', 'is-local-screenshare', 'is-remote-screenshare');
      callPeerAvatar?.classList.remove('hidden');
      if (callPeerAvatar) {
        const initials = getAvatarInitials(cleanName);
        const color = getAvatarColor(cleanName);
        callPeerAvatar.textContent = initials;
        callPeerAvatar.style.backgroundColor = color;
      }
      if (state === CALL_STATE.INCOMING_RINGING) {
        voiceCallCard?.classList.add('is-incoming-video');
      }
      btnCallMaximize?.classList.add('hidden');
      btnCallPopout?.classList.add('hidden');
    }
  } else {
    voiceCallCard?.classList.remove('is-video-call', 'is-screenshare-active', 'is-maximized', 'is-floating');
    voiceCallOverlay.classList.remove('is-floating');
    videoStage?.classList.add('hidden');
    videoStage?.classList.remove('is-screenshare-active', 'is-local-screenshare', 'is-remote-screenshare');
    if (remoteVideo && !isVideo) {
      remoteVideo.srcObject = null;
      try { remoteVideo.load?.(); } catch (_) { }
    }
    callPeerAvatar?.classList.remove('hidden');
    if (callPeerAvatar) {
      const initials = getAvatarInitials(cleanName);
      const color = getAvatarColor(cleanName);
      callPeerAvatar.textContent = initials;
      callPeerAvatar.style.backgroundColor = color;
    }
    if (state === CALL_STATE.INCOMING_RINGING) {
      voiceCallCard?.classList.add('is-incoming-voice');
    }
    btnCallMaximize?.classList.add('hidden');
    btnCallPopout?.classList.add('hidden');
  }

  // Update mute button presentation matching manager track state
  if (callMuteIcon) callMuteIcon.innerHTML = voiceCallManager.isMuted ? UI_ICONS.micOff : UI_ICONS.mic;
  if (callMuteText) callMuteText.textContent = voiceCallManager.isMuted ? 'Unmute' : 'Mute';
  if (btnCallMute) btnCallMute.classList.toggle('is-muted', Boolean(voiceCallManager.isMuted));
  if (callMinimizedMuteIcon) callMinimizedMuteIcon.innerHTML = voiceCallManager.isMuted ? UI_ICONS.micOff : UI_ICONS.mic;
  if (btnCallMinimizedMute) btnCallMinimizedMute.classList.toggle('is-muted', Boolean(voiceCallManager.isMuted));

  // Update camera button presentation matching manager track state
  if (callCameraIcon) callCameraIcon.innerHTML = voiceCallManager.isCameraOff ? UI_ICONS.cameraOff : UI_ICONS.camera;
  if (callCameraText) callCameraText.textContent = voiceCallManager.isCameraOff ? 'Camera On' : 'Camera Off';
  if (btnCallCamera) btnCallCamera.classList.toggle('is-camera-off', Boolean(voiceCallManager.isCameraOff));

  // Update screen share button and banner presentation matching manager state
  const isLocalSharing = Boolean(voiceCallManager.isScreenSharing);
  const isRemoteSharing = Boolean(voiceCallManager.remoteScreenSharing);
  if (callScreenShareIcon) callScreenShareIcon.innerHTML = isLocalSharing ? UI_ICONS.screenShareStop : UI_ICONS.screenShare;
  if (callScreenShareText) callScreenShareText.textContent = isLocalSharing ? 'Stop' : 'Share';
  if (btnCallScreenShare) {
    btnCallScreenShare.classList.toggle('is-sharing', isLocalSharing);
    if (isRemoteSharing) {
      btnCallScreenShare.disabled = true;
      btnCallScreenShare.classList.add('is-disabled');
      btnCallScreenShare.title = 'Screen is being shared by another participant';
    } else {
      btnCallScreenShare.disabled = false;
      btnCallScreenShare.classList.remove('is-disabled');
      btnCallScreenShare.title = isLocalSharing ? 'Stop sharing screen' : 'Share screen';
    }
  }
  if (screenshareActiveBanner) screenshareActiveBanner.classList.toggle('hidden', !isLocalSharing);

  if (error && callErrorBanner) {
    callErrorBanner.textContent = error;
    callErrorBanner.classList.remove('hidden');
  } else if (callErrorBanner) {
    callErrorBanner.classList.add('hidden');
  }

  btnCallAddParticipant?.classList.add('hidden');
  if (state !== CALL_STATE.CONNECTED && state !== CALL_STATE.OUTGOING_RINGING && state !== CALL_STATE.INCOMING_RINGING) {
    callAddParticipantModal?.classList.add('hidden');
    btnCallMinimize?.classList.add('hidden');
    btnCallRequestVideo?.classList.add('hidden');
    btnCallScreenShare?.classList.add('hidden');
    screenshareActiveBanner?.classList.add('hidden');
    screensharePickerModal?.classList.add('hidden');
  }

  switch (state) {
    case CALL_STATE.OUTGOING_RINGING:
      if (callStatusLabel) callStatusLabel.textContent = isVideo ? 'Calling (video)...' : 'Calling...';
      btnCallMute?.classList.remove('hidden');
      btnCallCamera?.classList.add('hidden');
      btnCallEnd?.classList.remove('hidden');
      btnCallAccept?.classList.add('hidden');
      btnCallDecline?.classList.add('hidden');
      btnCallMinimize?.classList.remove('hidden');
      btnCallRequestVideo?.classList.add('hidden');
      callTimerLabel?.classList.add('hidden');
      if (callTimerLabel) callTimerLabel.textContent = '00:00';
      break;

    case CALL_STATE.INCOMING_RINGING:
      if (callStatusLabel) callStatusLabel.textContent = isVideo ? 'Video call' : 'Voice call';
      btnCallMute?.classList.remove('hidden');
      btnCallCamera?.classList.add('hidden');
      btnCallEnd?.classList.add('hidden');
      btnCallAccept?.classList.remove('hidden');
      btnCallDecline?.classList.remove('hidden');
      btnCallMinimize?.classList.remove('hidden');
      btnCallRequestVideo?.classList.add('hidden');
      callTimerLabel?.classList.add('hidden');
      if (callTimerLabel) callTimerLabel.textContent = '00:00';
      break;

    case CALL_STATE.CONNECTING:
      if (callStatusLabel) callStatusLabel.textContent = 'Connecting...';
      btnCallMute?.classList.remove('hidden');
      btnCallCamera?.classList.add('hidden');
      btnCallEnd?.classList.remove('hidden');
      btnCallAccept?.classList.add('hidden');
      btnCallDecline?.classList.add('hidden');
      btnCallMinimize?.classList.remove('hidden');
      btnCallRequestVideo?.classList.add('hidden');
      callTimerLabel?.classList.add('hidden');
      if (callTimerLabel) callTimerLabel.textContent = '00:00';
      break;

    case CALL_STATE.CONNECTED:
      if (callStatusLabel) callStatusLabel.textContent = 'Connected';
      btnCallMute?.classList.remove('hidden');
      if (isVideo || voiceCallManager.isScreenSharing) {
        btnCallCamera?.classList.remove('hidden');
      } else {
        btnCallCamera?.classList.add('hidden');
      }
      btnCallRequestVideo?.classList.add('hidden');
      btnCallScreenShare?.classList.remove('hidden');
      btnCallMinimize?.classList.remove('hidden');
      btnCallAddParticipant?.classList.remove('hidden');
      btnCallEnd?.classList.remove('hidden');
      btnCallAccept?.classList.add('hidden');
      btnCallDecline?.classList.add('hidden');
      callTimerLabel?.classList.remove('hidden');
      if (callTimerLabel) callTimerLabel.textContent = voiceCallManager.getFormattedDuration();
      break;

    case CALL_STATE.ENDING:
      if (callStatusLabel) callStatusLabel.textContent = 'Ending call...';
      btnCallMute?.classList.add('hidden');
      btnCallCamera?.classList.add('hidden');
      btnCallEnd?.classList.add('hidden');
      btnCallAccept?.classList.add('hidden');
      btnCallDecline?.classList.add('hidden');
      btnCallMinimize?.classList.add('hidden');
      btnCallRequestVideo?.classList.add('hidden');
      callTimerLabel?.classList.add('hidden');
      break;

    case CALL_STATE.DECLINED:
    case CALL_STATE.REMOTE_DECLINED:
      if (callStatusLabel) callStatusLabel.textContent = 'Call declined';
      btnCallMute?.classList.add('hidden');
      btnCallCamera?.classList.add('hidden');
      btnCallEnd?.classList.add('hidden');
      btnCallAccept?.classList.add('hidden');
      btnCallDecline?.classList.add('hidden');
      btnCallMinimize?.classList.add('hidden');
      btnCallRequestVideo?.classList.add('hidden');
      callTimerLabel?.classList.add('hidden');
      break;

    case CALL_STATE.CANCELLED:
    case CALL_STATE.REMOTE_CANCELLED:
      if (callStatusLabel) callStatusLabel.textContent = 'Call cancelled';
      btnCallMute?.classList.add('hidden');
      btnCallCamera?.classList.add('hidden');
      btnCallEnd?.classList.add('hidden');
      btnCallAccept?.classList.add('hidden');
      btnCallDecline?.classList.add('hidden');
      btnCallMinimize?.classList.add('hidden');
      btnCallRequestVideo?.classList.add('hidden');
      callTimerLabel?.classList.add('hidden');
      break;

    case CALL_STATE.NO_ANSWER:
      if (callStatusLabel) callStatusLabel.textContent = 'No answer';
      btnCallMute?.classList.add('hidden');
      btnCallCamera?.classList.add('hidden');
      btnCallEnd?.classList.add('hidden');
      btnCallAccept?.classList.add('hidden');
      btnCallDecline?.classList.add('hidden');
      btnCallMinimize?.classList.add('hidden');
      btnCallRequestVideo?.classList.add('hidden');
      callTimerLabel?.classList.add('hidden');
      break;

    case CALL_STATE.ENDED:
    case CALL_STATE.REMOTE_ENDED:
      if (callStatusLabel) callStatusLabel.textContent = 'Call ended';
      btnCallMute?.classList.add('hidden');
      btnCallCamera?.classList.add('hidden');
      btnCallEnd?.classList.add('hidden');
      btnCallAccept?.classList.add('hidden');
      btnCallDecline?.classList.add('hidden');
      btnCallMinimize?.classList.add('hidden');
      btnCallRequestVideo?.classList.add('hidden');
      callTimerLabel?.classList.add('hidden');
      break;

    case CALL_STATE.FAILED:
      if (callStatusLabel) callStatusLabel.textContent = 'Call failed';
      if (callErrorBanner) {
        callErrorBanner.textContent = error || voiceCallManager.error || 'Call failed';
        callErrorBanner.classList.remove('hidden');
      }
      btnCallMute?.classList.add('hidden');
      btnCallCamera?.classList.add('hidden');
      btnCallEnd?.classList.remove('hidden');
      btnCallAccept?.classList.add('hidden');
      btnCallDecline?.classList.add('hidden');
      btnCallMinimize?.classList.add('hidden');
      btnCallRequestVideo?.classList.add('hidden');
      callTimerLabel?.classList.add('hidden');
      if (hasFloatingBridge) {
        syncFloatingCallState();
      }
      scheduleCallPresentation(voiceCallManager, () => {
        if (voiceCallManager.state === CALL_STATE.FAILED || voiceCallManager.state === CALL_STATE.IDLE || voiceCallManager.isEnded) {
          updateVoiceCallUi(CALL_STATE.IDLE);
        }
      }, 3500);
      break;
  }

  // Ensure minimized state presentation is preserved across updates
  if (isCallMinimized) {
    voiceCallOverlay.classList.remove('hidden');
    voiceCallOverlay.classList.add('is-minimized', 'is-floating');
    voiceCallCard?.classList.add('is-minimized', 'is-floating');
    callMinimizedControls?.classList.remove('hidden');
    if (state === CALL_STATE.CONNECTED) {
      callStatusLabel?.classList.add('hidden');
      callTimerLabel?.classList.remove('hidden');
      if (callTimerLabel) callTimerLabel.textContent = voiceCallManager.getFormattedDuration();
    } else {
      callStatusLabel?.classList.remove('hidden');
      callTimerLabel?.classList.add('hidden');
    }
    clampMinimizedTilePosition();
    applyMinimizedTilePosition();
  } else {
    callMinimizedControls?.classList.add('hidden');
  }

  logCallUiSynchronization('main_ui_synchronized', lifecycle, {
    hasFloatingBridge
  });
  syncFloatingCallState();
}

// Phase 4D State: Drafts, ACK correlation, and retry payloads
const roomComposerDrafts = new Map(); // roomId -> string
const requestToClient = new Map();    // requestId -> clientMessageId
const pendingPayloads = new Map();    // clientMessageId -> { roomId, text, clientMessageId }

let activeLoadToken = 0;
let activeConversationOpeningState = null;
let isPaginatingOlder = false;
let cooldownInterval = null;

// WhatsApp Contact Presence & Real-Time Typing State
const remoteTypingTimeouts = new Map(); // key `${roomId}:${principalId}` -> timerId
let isLocalTyping = false;
let activeTypingRoomId = null;
let lastLocalTypingSent = 0;
let localTypingInactivityTimer = null;

/**
 * Updates the chat header subtitle with WhatsApp-style real-time status:
 * - Group: member count (e.g. "3 members") or group subtitle
 * - Direct:
 *   - "typing…" if remote peer is typing
 *   - "online" if remote peer is online
 *   - Phone number / default identifier if offline
 */
function updateChatHeaderSubtitle() {
  if (!selectedChatSubtitle) return;
  const selected = shellState.getSelectedConversation();
  if (!selected) {
    selectedChatSubtitle.textContent = '';
    selectedChatSubtitle.classList.remove('is-typing', 'is-online');
    return;
  }

  const isGroup = selected.kind === 'group' || selected.isGroup === true;
  if (isGroup) {
    selectedChatSubtitle.textContent = getConversationHeaderStatus(selected);
    selectedChatSubtitle.classList.remove('is-typing', 'is-online');
    return;
  }

  const peerId = shellState.getDirectPeerUserId(selected);
  const isTyping = peerId ? shellState.isUserTyping(selected.roomId, peerId) : false;
  const isOnline = peerId ? shellState.isUserOnline(selected.roomId, peerId) : false;
  const statusText = getConversationHeaderStatus(selected, { isTyping, isOnline });

  selectedChatSubtitle.textContent = statusText;
  if (isTyping) {
    selectedChatSubtitle.classList.add('is-typing');
    selectedChatSubtitle.classList.remove('is-online');
  } else if (isOnline) {
    selectedChatSubtitle.classList.add('is-online');
    selectedChatSubtitle.classList.remove('is-typing');
  } else {
    selectedChatSubtitle.classList.remove('is-typing', 'is-online');
  }
}

/**
 * Stops local user typing state and dispatches typing.stopped if active.
 * @param {string|null} [roomId=null]
 */
function stopLocalTyping(roomId = null) {
  if (localTypingInactivityTimer) {
    clearTimeout(localTypingInactivityTimer);
    localTypingInactivityTimer = null;
  }
  const targetRoom = roomId || activeTypingRoomId || shellState.selectedRoomId;
  const wasTyping = isLocalTyping;
  isLocalTyping = false;
  activeTypingRoomId = null;
  lastLocalTypingSent = 0;

  if (wasTyping && targetRoom && window.ollacoreDesktop?.chat?.typingStop) {
    window.ollacoreDesktop.chat.typingStop(targetRoom).catch(() => { });
  }
}

/**
 * Handles composer input typing with throttle and inactivity timeout:
 * - If text is empty: immediately stops typing.
 * - Otherwise: dispatches typing.started (throttled to at most once every 3s)
 * - Resets 3s inactivity timeout to automatically stop typing when user pauses.
 * @param {string|null} [roomId=null]
 */
function handleLocalUserTyping(roomId = null) {
  const targetRoom = roomId || shellState.selectedRoomId;
  if (!targetRoom || !composerInput) return;

  const text = composerInput.value || '';
  if (!text.trim()) {
    stopLocalTyping(targetRoom);
    return;
  }

  const now = Date.now();
  if (!isLocalTyping || activeTypingRoomId !== targetRoom || now - lastLocalTypingSent > 3000) {
    isLocalTyping = true;
    activeTypingRoomId = targetRoom;
    lastLocalTypingSent = now;
    if (window.ollacoreDesktop?.chat?.typingStart) {
      window.ollacoreDesktop.chat.typingStart(targetRoom).catch(() => { });
    }
  }

  if (localTypingInactivityTimer) {
    clearTimeout(localTypingInactivityTimer);
  }
  localTypingInactivityTimer = setTimeout(() => {
    stopLocalTyping(targetRoom);
  }, 3000);
}

// ═══════════════════════════════════════════════════════════════════
// WebSocket Status Indicator
// ═══════════════════════════════════════════════════════════════════

/**
 * Updates the subtle real-time WebSocket connection pill in the app bar.
 * Strict room-scoped indicator: only updates for the currently active room.
 * When no room is active, remains disconnected/neutral.
 *
 * @param {string} state
 * @param {object} [details=null]
 * @param {string|null} [roomId=null]
 */
function updateWsIndicator(state, details = null, roomId = null) {
  // If an event is tagged with a roomId and does not match the active conversation, ignore
  if (roomId && shellState.selectedRoomId && roomId !== shellState.selectedRoomId) {
    return;
  }

  shellState.setWsState(state, details);
  if (!wsIndicator || !wsStatusLabel) return;

  const normalized = shellState.wsState;
  wsIndicator.className = `ws-status-pill state-${normalized}`;

  const labels = {
    connected: 'Connected',
    connecting: 'Connecting...',
    reconnecting: 'Reconnecting...',
    disconnected: 'Disconnected',
    error: 'Connection Error'
  };

  let labelText = labels[normalized] || normalized;
  if (details?.label) {
    labelText = details.label;
  } else if (details?.message === 'Waiting for network' || (typeof navigator !== 'undefined' && !navigator.onLine)) {
    labelText = 'Waiting for network';
  } else if (normalized === 'reconnecting' || details?.message === 'Reconnecting...') {
    labelText = 'Reconnecting...';
  }

  wsStatusLabel.textContent = labelText;

  if (details?.message) {
    wsIndicator.title = `Gateway: ${normalized} (${details.message})`;
  } else {
    wsIndicator.title = `Gateway status: ${normalized}`;
  }
}

// ═══════════════════════════════════════════════════════════════════
// Screen Visibility
// ═══════════════════════════════════════════════════════════════════

/**
 * Switches the active screen view.
 * @param {'phone'|'otp'|'authenticated'} view
 */
function showScreen(view) {
  screenPhone?.classList.remove('active');
  screenOtp?.classList.remove('active');
  screenAuthenticated?.classList.remove('active');

  if (view === 'phone') {
    screenPhone?.classList.add('active');
    phoneInput?.focus();
  } else if (view === 'otp') {
    screenOtp?.classList.add('active');
    if (otpInput) {
      otpInput.value = '';
      otpInput.focus();
    }
  } else if (view === 'authenticated') {
    screenAuthenticated?.classList.add('active');
    onAuthenticatedScreenLoaded();
  }
}

function setButtonLoading(button, isLoading) {
  if (!button) return;
  button.disabled = isLoading;
  const spinner = button.querySelector('.spinner, .spinner-inline-sm');
  if (spinner) {
    if (isLoading) spinner.classList.remove('hidden');
    else spinner.classList.add('hidden');
  }
}

function showError(el, message) {
  if (!el) return;
  if (message) {
    el.textContent = message;
    el.classList.remove('hidden');
  } else {
    el.textContent = '';
    el.classList.add('hidden');
  }
}

function showUserError(message) {
  if (typeof window !== 'undefined' && typeof window.alert === 'function') {
    try {
      window.alert(message);
    } catch (_) {
      console.error(message);
    }
  } else {
    console.error(message);
  }
}

function startCooldownTimer(initialSeconds = 60) {
  clearInterval(cooldownInterval);
  let remaining = initialSeconds;

  function update() {
    if (remaining > 0) {
      if (cooldownSeconds) cooldownSeconds.textContent = remaining;
      cooldownText?.classList.remove('hidden');
      btnResendOtp?.classList.add('hidden');
      remaining--;
    } else {
      clearInterval(cooldownInterval);
      cooldownText?.classList.add('hidden');
      if (btnResendOtp) {
        btnResendOtp.classList.remove('hidden');
        btnResendOtp.disabled = false;
      }
    }
  }

  update();
  cooldownInterval = setInterval(update, 1000);
}

// ═══════════════════════════════════════════════════════════════════
// User Profile Display
// ═══════════════════════════════════════════════════════════════════

const editProfileState = {
  avatarAction: 'none', // 'none' | 'set' | 'remove'
  previewUrl: null
};

/**
 * Renders an avatar element, supporting image URL or initials fallback.
 * @param {HTMLElement} el
 * @param {string|null} avatarUrl
 * @param {string} initials
 * @param {string} color
 * @param {boolean} [isEdit=false]
 */
function renderAvatarElement(el, avatarUrl, initials, color, isEdit = false) {
  if (!el) return;
  if (avatarUrl) {
    el.innerHTML = `<img src="${escapeHtml(avatarUrl)}" alt="Avatar" class="avatar-img" onerror="this.onerror=null; this.remove(); if (this.parentElement) { this.parentElement.style.backgroundColor='${color}'; this.parentElement.textContent='${escapeHtml(initials)}'; }" />`;
    el.style.backgroundColor = 'transparent';
    if (isEdit) {
      el.innerHTML += `<div class="avatar-overlay"><span class="avatar-overlay-icon">📷</span></div>`;
    }
  } else {
    el.innerHTML = '';
    if (isEdit) {
      el.innerHTML = `<span id="modal-user-avatar-edit-text">${escapeHtml(initials)}</span><div class="avatar-overlay"><span class="avatar-overlay-icon">📷</span></div>`;
    } else {
      el.textContent = initials;
    }
    el.style.backgroundColor = color;
  }
}

/**
 * Resolves avatar URL for a conversation item, direct peer, or user object.
 * @param {object} item
 * @returns {string|null}
 */
function getConversationAvatarUrl(item) {
  if (!item || typeof item !== 'object') return null;

  // Contact Blocking Privacy: if contact is blocked by local user, hide profile photo
  const roomId = item.roomId || item.room_id || item.id;
  if (roomId && typeof shellState !== 'undefined' && typeof shellState.isRoomBlocked === 'function' && shellState.isRoomBlocked(roomId)) {
    return null;
  }
  const peerId = (typeof shellState !== 'undefined' && typeof shellState.getDirectPeerUserId === 'function')
    ? shellState.getDirectPeerUserId(item)
    : (item.peerUserId || item.peer_user_id || item.peer?.userId || item.peer?.user_id || null);
  if (peerId && typeof shellState !== 'undefined' && typeof shellState.isUserBlocked === 'function' && shellState.isUserBlocked(peerId)) {
    return null;
  }
  if (item.isBlocked || item.blocked || item.peer?.isBlocked || item.peer?.is_blocked || item.peer?.blocked) {
    return null;
  }

  if (item.avatarUrl) return item.avatarUrl;
  if (item.avatar_url) return item.avatar_url;
  if (item.peer && typeof item.peer === 'object') {
    if (item.peer.avatarUrl) return item.peer.avatarUrl;
    if (item.peer.avatar_url) return item.peer.avatar_url;
    const pId = item.peer.userId || item.peer.user_id;
    const pVer = item.peer.avatarVersion || item.peer.avatar_version;
    if (pId && pVer) {
      return `https://api.ollacore.com/v1/directory/users/${encodeURIComponent(pId)}/avatar?v=${encodeURIComponent(pVer)}`;
    }
  }
  return null;
}

function updateProfileDisplay(session) {
  shellState.setCurrentUser(session);
  roomMessagesState.setCurrentUserId(session?.userId);
  for (const s of roomMessagesMap.values()) {
    s.setCurrentUserId(session?.userId);
  }

  // Phase 4B: Run safe, idempotent LocalStorage -> SQLite migration in the background
  if (session?.userId) {
    runLocalStorageMigration(session.userId).then((res) => {
      if (res?.ok) {
        hydrateMigratedStateFromDb(shellState).then(() => {
          renderConversationList();
          renderCustomListFilters();
          updateChatFilterCounts();
        }).catch(() => { });
      }
    }).catch((err) => {
      console.warn('[Migrator] Background migration encountered an error:', err);
    });
    // Phase 4C: Recover pending outbox messages from SQLite upon startup/login
    outboxManager.recoverOnStartup({
      shellState,
      getOrCreateRoomMessagesState: (rId) => getOrCreateRoomMessagesState(rId),
      defaultStatus: 'pending'
    }).then((restored) => {
      if (restored > 0 && shellState.selectedRoomId) {
        renderMessages();
      }
      window.ollacoreDesktop?.chat?.getState?.().then((st) => {
        if (st === 'connected') {
          outboxManager.flush({
            chatBridge: window.ollacoreDesktop?.chat,
            dbBridge: window.ollacoreDesktop?.db,
            requestToClientMap: requestToClient,
            getRoomState: (rId) => getOrCreateRoomMessagesState(rId),
            onStatusUpdate: (cid, status, rId) => {
              const targetState = getOrCreateRoomMessagesState(rId);
              targetState?.updateReceipt(cid, status, rId);
              if (shellState.selectedRoomId === rId) {
                updateMessageStatusInDom(cid, status);
              }
            }
          });
        }
      });
    }).catch(() => { });
  }
  const name = session?.displayName || session?.phone || 'OllaChat User';
  const phone = session?.phone || '';
  const initials = getAvatarInitials(name);
  const color = getAvatarColor(name);
  const aboutText = session?.about || 'Available on OllaChat';
  const userIdVal = session?.userId || 'N/A';
  const avatarUrl = session?.avatarUrl || null;

  // Navigation rail profile trigger
  if (currentUserName) currentUserName.textContent = name;
  if (currentUserPhone) currentUserPhone.textContent = phone;
  if (currentUserAvatar) {
    renderAvatarElement(currentUserAvatar, avatarUrl, initials, color, false);
  }
  if (userProfileTrigger) {
    userProfileTrigger.title = name ? `${name} (Profile)` : 'Profile';
  }
  const railProfileTooltip = document.getElementById('rail-profile-tooltip');
  if (railProfileTooltip) {
    railProfileTooltip.textContent = name || 'Profile';
  }

  // Settings modal view mode details
  if (userDisplayName) userDisplayName.textContent = name;
  if (userPhone) userPhone.textContent = phone || 'N/A';
  if (userId) userId.textContent = userIdVal;
  if (userAbout) userAbout.textContent = aboutText;
  if (modalUserAvatar) {
    renderAvatarElement(modalUserAvatar, avatarUrl, initials, color, false);
  }

  // Settings modal edit mode details
  if (userPhoneEdit) userPhoneEdit.textContent = phone || 'N/A';
  if (userIdEdit) userIdEdit.textContent = userIdVal;
  if (modalUserAvatarEdit) {
    renderAvatarElement(modalUserAvatarEdit, avatarUrl, initials, color, true);
  }

  if (btnChangePhoto) {
    btnChangePhoto.textContent = avatarUrl ? 'Change photo' : 'Add photo';
    btnChangePhoto.title = avatarUrl ? 'Change profile photo' : 'Add profile photo';
  }
  if (modalUserAvatarEdit) {
    modalUserAvatarEdit.setAttribute('aria-label', avatarUrl ? 'Change profile photo' : 'Add profile photo');
    modalUserAvatarEdit.setAttribute('title', avatarUrl ? 'Change profile photo' : 'Add profile photo');
  }
  if (btnRemovePhoto) {
    if (avatarUrl) {
      btnRemovePhoto.classList.remove('hidden');
    } else {
      btnRemovePhoto.classList.add('hidden');
    }
  }
}

/**
 * Toggles between Settings view mode and Edit Profile mode.
 * @param {boolean} isEditing
 */
function setProfileEditMode(isEditing) {
  if (isEditing) {
    profileViewMode?.classList.add('hidden');
    profileViewFooter?.classList.add('hidden');
    profileEditMode?.classList.remove('hidden');
    profileEditFooter?.classList.remove('hidden');

    const currentSession = shellState.currentUser || shellState.userProfile;
    editProfileState.avatarAction = 'none';
    editProfileState.previewUrl = currentSession?.avatarUrl || null;

    if (editProfileName) {
      editProfileName.value = currentSession?.displayName || '';
    }
    if (editProfileAbout) {
      editProfileAbout.value = currentSession?.about || '';
    }

    const name = currentSession?.displayName || currentSession?.phone || 'OllaChat User';
    const initials = getAvatarInitials(name);
    const color = getAvatarColor(name);
    renderAvatarElement(modalUserAvatarEdit, currentSession?.avatarUrl, initials, color, true);

    if (btnChangePhoto) {
      btnChangePhoto.textContent = currentSession?.avatarUrl ? 'Change photo' : 'Add photo';
      btnChangePhoto.title = currentSession?.avatarUrl ? 'Change profile photo' : 'Add profile photo';
    }
    if (modalUserAvatarEdit) {
      modalUserAvatarEdit.setAttribute('aria-label', currentSession?.avatarUrl ? 'Change profile photo' : 'Add profile photo');
      modalUserAvatarEdit.setAttribute('title', currentSession?.avatarUrl ? 'Change profile photo' : 'Add profile photo');
    }
    if (btnRemovePhoto) {
      if (currentSession?.avatarUrl) {
        btnRemovePhoto.classList.remove('hidden');
      } else {
        btnRemovePhoto.classList.add('hidden');
      }
    }

    hideProfileEditStatus();
    editProfileName?.focus();
  } else {
    profileEditMode?.classList.add('hidden');
    profileEditFooter?.classList.add('hidden');
    profileViewMode?.classList.remove('hidden');
    profileViewFooter?.classList.remove('hidden');
    editProfileState.avatarAction = 'none';
    editProfileState.previewUrl = null;
    window.ollacoreDesktop?.profile?.clearPendingPhoto?.();
    hideProfileEditStatus();
  }
}

/**
 * Prompts user to pick a new profile photo via native dialog and sets up instant preview.
 */
async function handlePickProfilePhoto() {
  hideProfileEditStatus();
  try {
    const res = await window.ollacoreDesktop?.profile?.pickPhoto();
    if (!res) return;
    if (res.cancelled) return;

    if (!res.ok) {
      showProfileEditStatus(res.error || 'Failed to select image', 'error');
      return;
    }

    if (res.previewUrl) {
      editProfileState.avatarAction = 'set';
      editProfileState.previewUrl = res.previewUrl;

      const currentSession = shellState.currentUser || shellState.userProfile;
      const name = editProfileName?.value?.trim() || currentSession?.displayName || 'User';
      const initials = getAvatarInitials(name);
      const color = getAvatarColor(name);

      renderAvatarElement(modalUserAvatarEdit, res.previewUrl, initials, color, true);

      if (btnChangePhoto) {
        btnChangePhoto.textContent = 'Change photo';
        btnChangePhoto.title = 'Change profile photo';
      }
      if (modalUserAvatarEdit) {
        modalUserAvatarEdit.setAttribute('aria-label', 'Change profile photo');
        modalUserAvatarEdit.setAttribute('title', 'Change profile photo');
      }
      if (btnRemovePhoto) {
        btnRemovePhoto.classList.remove('hidden');
      }
    }
  } catch (err) {
    showProfileEditStatus(err?.message || 'Failed to open file picker', 'error');
  }
}

/**
 * Removes the profile photo in edit preview mode.
 */
function handleRemoveProfilePhoto() {
  hideProfileEditStatus();
  editProfileState.avatarAction = 'remove';
  editProfileState.previewUrl = null;

  const currentSession = shellState.currentUser || shellState.userProfile;
  const name = editProfileName?.value?.trim() || currentSession?.displayName || 'User';
  const initials = getAvatarInitials(name);
  const color = getAvatarColor(name);

  renderAvatarElement(modalUserAvatarEdit, null, initials, color, true);

  if (btnChangePhoto) {
    btnChangePhoto.textContent = 'Add photo';
    btnChangePhoto.title = 'Add profile photo';
  }
  if (modalUserAvatarEdit) {
    modalUserAvatarEdit.setAttribute('aria-label', 'Add profile photo');
    modalUserAvatarEdit.setAttribute('title', 'Add profile photo');
  }
  if (btnRemovePhoto) {
    btnRemovePhoto.classList.add('hidden');
  }
}

/**
 * Displays an inline status or error banner in the Settings modal.
 * @param {string} message
 * @param {'saving'|'success'|'error'} [type='error']
 */
function showProfileEditStatus(message, type = 'error') {
  if (!profileEditStatus) return;
  profileEditStatus.className = `status-banner ${type}`;
  if (type === 'saving') {
    profileEditStatus.innerHTML = `<span class="spinner spinner-sm"></span><span>${message}</span>`;
  } else {
    profileEditStatus.textContent = message;
  }
  profileEditStatus.classList.remove('hidden');
}

/**
 * Hides the inline status banner in the Settings modal.
 */
function hideProfileEditStatus() {
  if (!profileEditStatus) return;
  profileEditStatus.classList.add('hidden');
  profileEditStatus.textContent = '';
  profileEditStatus.className = 'status-banner hidden';
}

/**
 * Saves edited profile information (Display Name, About, and Photo) using PATCH /v1/directory/me.
 */
async function handleSaveProfile() {
  const nameVal = editProfileName?.value?.trim() || '';
  const aboutVal = editProfileAbout?.value?.trim() || '';

  if (!nameVal) {
    showProfileEditStatus('Display name cannot be empty', 'error');
    editProfileName?.focus();
    return;
  }

  if (btnSaveProfile) {
    btnSaveProfile.disabled = true;
    btnSaveProfile.innerHTML = '<span class="spinner spinner-sm"></span> Saving...';
  }
  if (btnCancelEditProfile) btnCancelEditProfile.disabled = true;

  showProfileEditStatus('Saving changes...', 'saving');

  try {
    let res;
    if (window.ollacoreDesktop?.auth?.updateProfile) {
      res = await window.ollacoreDesktop.auth.updateProfile({
        displayName: nameVal,
        about: aboutVal,
        avatarAction: editProfileState.avatarAction
      });
    } else if (window.ollacoreDesktop?.session?.updateProfile) {
      const updated = await window.ollacoreDesktop.session.updateProfile({ displayName: nameVal, about: aboutVal });
      res = { ok: true, session: updated };
    }

    if (res?.ok && res.session) {
      updateProfileDisplay(res.session);
      showProfileEditStatus('Profile updated successfully!', 'success');
      setTimeout(() => {
        setProfileEditMode(false);
      }, 600);
    } else {
      const errMsg = res?.error || 'Failed to update profile';
      showProfileEditStatus(errMsg, 'error');
    }
  } catch (err) {
    console.error('Profile update failed:', err);
    showProfileEditStatus(err?.message || 'Failed to update profile', 'error');
  } finally {
    if (btnSaveProfile) {
      btnSaveProfile.disabled = false;
      btnSaveProfile.textContent = 'Save';
    }
    if (btnCancelEditProfile) btnCancelEditProfile.disabled = false;
  }
}

// ═══════════════════════════════════════════════════════════════════
// Conversation List Rendering, Filters & Selection
// ═══════════════════════════════════════════════════════════════════

/**
 * Updates dynamic counter badges on the chat filter buttons.
 */
function updateChatFilterCounts() {
  if (filterCountUnread) {
    const unreadCount = shellState.getUnreadConversationsCount();
    filterCountUnread.textContent = unreadCount > 99 ? '99+' : unreadCount;
    if (unreadCount > 0) {
      filterCountUnread.classList.remove('hidden');
    } else {
      filterCountUnread.classList.add('hidden');
    }
  }

  if (filterCountGroups) {
    const groupsCount = shellState.getGroupsCount();
    filterCountGroups.textContent = groupsCount;
  }
}

/**
 * Changes active chat list filter ('all', 'unread', 'favourites', 'groups', or custom list ID)
 * @param {string} filterName
 */
function setActiveChatFilter(filterName) {
  shellState.setActiveFilter(filterName);
  renderCustomListFilters();

  if (chatFilterRow) {
    const buttons = chatFilterRow.querySelectorAll('.chat-filter-btn');
    buttons.forEach((btn) => {
      const f = btn.getAttribute('data-filter');
      const isActive = f === shellState.activeFilter;
      btn.classList.toggle('active', isActive);
      btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
    });
  }

  renderConversationList();
}

/**
 * Renders custom list pill buttons inside the chat filter row.
 */
function renderCustomListFilters() {
  if (!customFiltersContainer) return;
  customFiltersContainer.innerHTML = '';

  const lists = shellState.getCustomLists();
  for (const list of lists) {
    const btn = document.createElement('button');
    btn.type = 'button';
    const isActive = shellState.activeFilter === list.id;
    btn.className = `chat-filter-btn custom-filter-btn ${isActive ? 'active' : ''}`;
    btn.setAttribute('data-filter', list.id);
    btn.setAttribute('data-list-id', list.id);
    btn.setAttribute('role', 'tab');
    btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
    btn.title = `${list.name} (Right-click to manage)`;

    btn.innerHTML = `<span class="custom-filter-name">${escapeHtml(list.name)}</span>`;

    btn.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openCustomListContextMenu(e, list);
    });

    customFiltersContainer.appendChild(btn);
  }
}

/**
 * Closes the custom list context menu.
 */
function closeCustomListContextMenu() {
  if (customListContextMenu) {
    customListContextMenu.classList.add('hidden');
  }
  contextMenuTargetList = null;
}

/**
 * Opens context menu for a custom list pill.
 * @param {MouseEvent} e
 * @param {object} list
 */
function openCustomListContextMenu(e, list) {
  if (!customListContextMenu || !list) return;
  closeConversationContextMenu();
  closeContextMenu();

  contextMenuTargetList = list;
  customListContextMenu.classList.remove('hidden');

  const menuWidth = 170;
  const menuHeight = customListContextMenu.offsetHeight || 120;
  let left = e.clientX;
  let top = e.clientY;

  if (left + menuWidth > window.innerWidth - 10) {
    left = window.innerWidth - menuWidth - 10;
  }
  if (top + menuHeight > window.innerHeight - 10) {
    top = window.innerHeight - menuHeight - 10;
  }
  if (left < 10) left = 10;
  if (top < 10) top = 10;

  customListContextMenu.style.left = `${left}px`;
  customListContextMenu.style.top = `${top}px`;
}

/**
 * Opens custom list creation/editing modal dialog.
 * @param {object|null} list
 * @param {'create'|'edit-chats'|'rename'} mode
 */
function openCustomListModal(list = null, mode = 'create') {
  if (!customListModal) return;
  closeCustomListContextMenu();
  closeConversationContextMenu();

  currentCustomListMode = mode;
  currentEditingListId = list ? list.id : null;

  if (customListError) {
    customListError.textContent = '';
    customListError.classList.add('hidden');
  }

  const selectGroup = customListModal.querySelector('.custom-list-select-group');

  if (mode === 'create') {
    if (customListModalTitle) customListModalTitle.textContent = 'Create new list';
    if (btnSaveCustomList) btnSaveCustomList.textContent = 'Create list';
    if (customListNameInput) {
      customListNameInput.value = '';
      customListNameInput.disabled = false;
    }
    if (selectGroup) selectGroup.classList.remove('hidden');
  } else if (mode === 'rename') {
    if (customListModalTitle) customListModalTitle.textContent = 'Rename list';
    if (btnSaveCustomList) btnSaveCustomList.textContent = 'Save name';
    if (customListNameInput) {
      customListNameInput.value = list ? list.name : '';
      customListNameInput.disabled = false;
    }
    if (selectGroup) selectGroup.classList.add('hidden');
  } else {
    // 'edit-chats'
    if (customListModalTitle) customListModalTitle.textContent = 'Edit list';
    if (btnSaveCustomList) btnSaveCustomList.textContent = 'Save changes';
    if (customListNameInput) {
      customListNameInput.value = list ? list.name : '';
      customListNameInput.disabled = false;
    }
    if (selectGroup) selectGroup.classList.remove('hidden');
  }

  // Populate conversation selection items
  if (customListChatItems) {
    customListChatItems.innerHTML = '';
    const conversations = Array.isArray(shellState.conversations) ? shellState.conversations : [];

    if (conversations.length === 0) {
      const emptyNotice = document.createElement('div');
      emptyNotice.style.cssText = 'padding: 16px; text-align: center; color: var(--text-muted); font-size: 0.85rem;';
      emptyNotice.textContent = 'No conversations available to add.';
      customListChatItems.appendChild(emptyNotice);
    } else {
      for (const conv of conversations) {
        const title = getConversationTitle(conv);
        const initials = getAvatarInitials(title);
        const color = getAvatarColor(title);
        const isGroup = conv.kind === 'group' || conv.isGroup;
        const isChecked = list && Array.isArray(list.roomIds) && list.roomIds.includes(String(conv.roomId));

        const itemEl = document.createElement('label');
        itemEl.className = 'custom-list-chat-item';
        itemEl.innerHTML = `
          <input type="checkbox" class="custom-list-checkbox" value="${escapeHtml(conv.roomId)}" ${isChecked ? 'checked' : ''} />
          <div class="avatar custom-list-chat-avatar" style="background-color: ${color};">${initials}</div>
          <div class="custom-list-chat-meta">
            <span class="custom-list-chat-name">${escapeHtml(title)}</span>
            <span class="custom-list-chat-kind">${isGroup ? 'Group' : 'Direct'}</span>
          </div>
        `;
        customListChatItems.appendChild(itemEl);
      }
    }
  }

  customListModal.classList.remove('hidden');
  setTimeout(() => {
    customListNameInput?.focus();
  }, 50);
}

/**
 * Closes custom list creation/editing modal dialog.
 */
function closeCustomListModal() {
  if (customListModal) {
    customListModal.classList.add('hidden');
  }
  if (customListError) {
    customListError.textContent = '';
    customListError.classList.add('hidden');
  }
  currentEditingListId = null;
}

/**
 * Saves a new or edited custom chat list.
 */
function handleSaveCustomList() {
  const name = customListNameInput ? customListNameInput.value.trim() : '';

  const checkedBoxes = customListChatItems
    ? customListChatItems.querySelectorAll('.custom-list-checkbox:checked')
    : [];
  const roomIds = Array.from(checkedBoxes).map((cb) => cb.value);

  try {
    if (currentCustomListMode === 'create') {
      const newList = shellState.createCustomList(name, roomIds);
      closeCustomListModal();
      renderCustomListFilters();
      setActiveChatFilter(newList.id);
    } else if (currentCustomListMode === 'rename') {
      shellState.updateCustomList(currentEditingListId, { name });
      closeCustomListModal();
      renderCustomListFilters();
      renderConversationList();
    } else {
      // 'edit-chats'
      shellState.updateCustomList(currentEditingListId, { name, roomIds });
      closeCustomListModal();
      renderCustomListFilters();
      renderConversationList();
    }
    persistCustomListsToDb(shellState.customLists).catch(() => { });
  } catch (err) {
    if (customListError) {
      customListError.textContent = err.message || 'Failed to save custom list.';
      customListError.classList.remove('hidden');
    }
  }
}

/**
 * Opens confirmation modal for deleting a custom list.
 * @param {object} list
 */
function openDeleteCustomListModal(list) {
  if (!customListDeleteModal || !list) return;
  closeCustomListContextMenu();
  currentDeletingListId = list.id;

  if (customListDeleteMessage) {
    customListDeleteMessage.textContent = `Are you sure you want to delete "${list.name}"? Conversations will not be deleted.`;
  }
  customListDeleteModal.classList.remove('hidden');
}

/**
 * Closes confirmation modal for deleting a custom list.
 */
function closeDeleteCustomListModal() {
  if (customListDeleteModal) {
    customListDeleteModal.classList.add('hidden');
  }
  currentDeletingListId = null;
}

/**
 * Confirms deletion of the targeted custom list.
 */
function handleConfirmDeleteCustomList() {
  if (currentDeletingListId) {
    shellState.deleteCustomList(currentDeletingListId);
    persistCustomListsToDb(shellState.customLists).catch(() => { });
    closeDeleteCustomListModal();
    renderCustomListFilters();
    setActiveChatFilter(shellState.activeFilter);
  }
}

/**
 * Closes the chat header options three-dot menu.
 */
function closeChatHeaderMenu() {
  if (chatHeaderMenu) {
    chatHeaderMenu.classList.add('hidden');
  }
  if (btnChatMenu) {
    btnChatMenu.setAttribute('aria-expanded', 'false');
  }
}

/**
 * Toggles or opens the chat header options three-dot menu anchored to the button.
 */
function openChatHeaderMenu() {
  if (!chatHeaderMenu || !btnChatMenu) return;

  // Toggle behavior if already open
  if (!chatHeaderMenu.classList.contains('hidden')) {
    closeChatHeaderMenu();
    return;
  }

  const roomId = shellState.selectedRoomId;
  if (!roomId) return;

  // Close any other open context menus
  closeContextMenu();
  closeConversationContextMenu();
  closeArchivedContextMenu();
  closeCustomListContextMenu();

  const conv = shellState.getSelectedConversation() || shellState.conversations?.find((c) => c.roomId === roomId);
  const isGroup = conv?.kind === 'group' || conv?.isGroup;
  const isFav = shellState.isFavourite(roomId);
  const isArchived = shellState.isArchived(roomId);

  // Dynamic label for contact info vs group info
  if (menuContactInfoText) {
    menuContactInfoText.textContent = isGroup ? 'Group info' : 'Contact info';
  }

  // Dynamic label for favourites
  if (menuFavText) {
    menuFavText.textContent = isFav ? 'Remove from favourites' : 'Add to favourites';
  }

  // Dynamic label for archive
  if (menuArchiveText) {
    menuArchiveText.textContent = isArchived ? 'Unarchive chat' : 'Archive chat';
  }

  // Dynamic label for mute notifications
  const isMuted = shellState.isConversationMuted(conv);
  if (menuMuteText) {
    menuMuteText.textContent = isMuted ? 'Unmute notifications' : 'Mute notifications';
  }

  // Dynamic visibility and label for block contact
  if (isGroup) {
    menuItemBlockContact?.classList.add('hidden');
  } else {
    menuItemBlockContact?.classList.remove('hidden');
    const isBlocked = shellState.isRoomBlocked(roomId);
    if (menuBlockText) {
      menuBlockText.textContent = isBlocked ? 'Unblock contact' : 'Block contact';
    }
  }

  const isExited = Boolean(conv?.isExited || conv?.exited);
  if (isGroup) {
    if (isExited) {
      menuItemExitGroup?.classList.add('hidden');
      menuItemDeleteChat?.classList.remove('hidden');
    } else {
      menuItemExitGroup?.classList.remove('hidden');
      menuItemDeleteChat?.classList.add('hidden');
    }
  } else {
    menuItemExitGroup?.classList.add('hidden');
    menuItemDeleteChat?.classList.remove('hidden');
  }

  chatHeaderMenu.classList.remove('hidden');
  btnChatMenu.setAttribute('aria-expanded', 'true');

  const menuWidth = chatHeaderMenu.offsetWidth || 210;
  const menuHeight = chatHeaderMenu.offsetHeight || 220;
  const rect = btnChatMenu.getBoundingClientRect();

  // Position anchored below the button, aligning to right edge of button
  let left = rect.right - menuWidth;
  let top = rect.bottom + 6;

  // Viewport boundary clamping
  if (left + menuWidth > window.innerWidth - 10) {
    left = window.innerWidth - menuWidth - 10;
  }
  if (top + menuHeight > window.innerHeight - 10) {
    top = rect.top - menuHeight - 6;
  }
  if (left < 10) left = 10;
  if (top < 10) top = 10;

  chatHeaderMenu.style.left = `${left}px`;
  chatHeaderMenu.style.top = `${top}px`;
}

let activeChangeChatListsRoomId = null;

/**
 * Opens modal dialog to configure which custom lists include the specified room.
 * @param {string} roomId
 */
function openChangeChatListsModal(roomId) {
  if (!changeChatListsModal || !roomId) return;
  activeChangeChatListsRoomId = roomId;

  closeChatHeaderMenu();
  closeConversationContextMenu();
  closeArchivedContextMenu();
  closeCustomListContextMenu();

  if (changeChatListsItems) {
    changeChatListsItems.innerHTML = '';
    const customLists = Array.isArray(shellState.customLists) ? shellState.customLists : [];

    if (customLists.length === 0) {
      const emptyNotice = document.createElement('div');
      emptyNotice.className = 'change-chat-lists-empty';
      emptyNotice.textContent = 'No custom lists created yet. Click "+ New list" below to create one.';
      changeChatListsItems.appendChild(emptyNotice);
    } else {
      const rId = String(roomId);
      for (const list of customLists) {
        const isIncluded = Array.isArray(list.roomIds) && list.roomIds.includes(rId);
        const count = Array.isArray(list.roomIds) ? list.roomIds.length : 0;

        const row = document.createElement('label');
        row.className = 'change-chat-list-item';
        row.innerHTML = `
          <input type="checkbox" class="change-chat-list-checkbox" data-list-id="${escapeHtml(list.id)}" ${isIncluded ? 'checked' : ''} />
          <div class="change-chat-list-meta">
            <span class="change-chat-list-name">${escapeHtml(list.name)}</span>
            <span class="change-chat-list-count">${count} chat${count === 1 ? '' : 's'}</span>
          </div>
        `;

        const checkbox = row.querySelector('.change-chat-list-checkbox');
        checkbox?.addEventListener('change', () => {
          shellState.toggleRoomInCustomList(list.id, roomId);
          const updatedList = shellState.getCustomList(list.id);
          const updatedCount = Array.isArray(updatedList?.roomIds) ? updatedList.roomIds.length : 0;
          const countEl = row.querySelector('.change-chat-list-count');
          if (countEl) countEl.textContent = `${updatedCount} chat${updatedCount === 1 ? '' : 's'}`;

          renderCustomListFilters();
          renderConversationList();
          updateChatFilterCounts();
        });

        changeChatListsItems.appendChild(row);
      }
    }
  }

  changeChatListsModal.classList.remove('hidden');
}

/**
 * Closes the change custom lists modal.
 */
function closeChangeChatListsModal() {
  if (changeChatListsModal) {
    changeChatListsModal.classList.add('hidden');
  }
  activeChangeChatListsRoomId = null;
}

/**
 * Closes the conversation context menu.
 */
export function closeConversationContextMenu() {
  if (conversationContextMenu) {
    conversationContextMenu.classList.add('hidden');
  }
  contextMenuTargetConversation = null;
}

/**
 * Opens the mute duration selection modal for a conversation.
 * @param {string} roomId
 */
function openMuteDurationModal(roomId) {
  if (!muteDurationModal || !roomId) return;
  activeMuteModalRoomId = roomId;
  muteModalError?.classList.add('hidden');
  if (muteModalError) muteModalError.textContent = '';
  const radio8h = muteDurationModal.querySelector('input[name="mute-duration-choice"][value="8h"]');
  if (radio8h) radio8h.checked = true;
  muteDurationModal.classList.remove('hidden');
}

/**
 * Closes the mute duration selection modal.
 */
function closeMuteDurationModal() {
  if (muteDurationModal) {
    muteDurationModal.classList.add('hidden');
  }
  activeMuteModalRoomId = null;
}

/**
 * Confirms and submits conversation mute to the server with selected duration.
 */
async function confirmMuteConversation() {
  if (!activeMuteModalRoomId) return;
  const roomId = activeMuteModalRoomId;
  const selectedRadio = muteDurationModal?.querySelector('input[name="mute-duration-choice"]:checked');
  const duration = selectedRadio?.value || '8h';

  btnConfirmMuteDuration?.setAttribute('disabled', 'true');
  muteSpinner?.classList.remove('hidden');
  muteModalError?.classList.add('hidden');

  try {
    const res = await window.ollacoreDesktop.chatApi.muteConversation(roomId, duration);
    const mutedUntil = res?.muted_until || res?.mutedUntil || null;
    const conv = shellState.conversations?.find((c) => c.roomId === roomId);
    if (conv) {
      conv.mutedUntil = mutedUntil;
      conv.muted_until = mutedUntil;
      persistConversationToDb(conv).catch(() => { });
    }
    shellState.setConversationMuted(roomId, mutedUntil);
    renderConversationList();
    if (shellState.selectedRoomId === roomId) {
      updateChatHeaderSubtitle();
      if (activeContactInfoRoomId === roomId) {
        openContactInfo(roomId);
      }
    }
    closeMuteDurationModal();
  } catch (err) {
    if (muteModalError) {
      muteModalError.textContent = err?.message || 'Failed to mute conversation';
      muteModalError.classList.remove('hidden');
    }
  } finally {
    btnConfirmMuteDuration?.removeAttribute('disabled');
    muteSpinner?.classList.add('hidden');
  }
}

/**
 * Submits conversation unmute request to the server and refreshes state.
 * @param {string} roomId
 */
async function handleUnmuteConversation(roomId) {
  if (!roomId || !window.ollacoreDesktop?.chatApi?.unmuteConversation) return;
  try {
    await window.ollacoreDesktop.chatApi.unmuteConversation(roomId);
    const conv = shellState.conversations?.find((c) => c.roomId === roomId);
    if (conv) {
      conv.mutedUntil = null;
      conv.muted_until = null;
      persistConversationToDb(conv).catch(() => { });
    }
    shellState.setConversationMuted(roomId, null);
    renderConversationList();
    if (shellState.selectedRoomId === roomId) {
      updateChatHeaderSubtitle();
      if (activeContactInfoRoomId === roomId) {
        openContactInfo(roomId);
      }
    }
  } catch (err) {
    showUserError(err?.message || 'Failed to unmute conversation');
  }
}

/**
 * Opens confirmation modal before blocking a user.
 * @param {string} userId
 * @param {string} [displayName]
 */
function openBlockContactModal(userId, displayName) {
  if (!blockContactConfirmModal || !userId) {
    return;
  }
  activeBlockModalUserId = userId;
  blockModalError?.classList.add('hidden');
  if (blockModalError) blockModalError.textContent = '';
  if (blockConfirmDesc) {
    blockConfirmDesc.textContent = displayName
      ? `Block ${displayName}? Blocked contacts will no longer be able to call you or send you messages.`
      : 'Blocked contacts will no longer be able to call you or send you messages.';
  }
  blockContactConfirmModal.classList.remove('hidden');
}

/**
 * Closes the block contact confirmation modal.
 */
function closeBlockContactModal() {
  if (blockContactConfirmModal) {
    blockContactConfirmModal.classList.add('hidden');
  }
  activeBlockModalUserId = null;
}

/**
 * Confirms and executes blocking a contact through the server API.
 */
async function confirmBlockContact() {
  if (!activeBlockModalUserId) return;
  const userId = activeBlockModalUserId;

  btnConfirmBlock?.setAttribute('disabled', 'true');
  blockSpinner?.classList.remove('hidden');
  blockModalError?.classList.add('hidden');

  try {
    const res = await window.ollacoreDesktop.chatApi.blockUser(userId);
    const conv = (shellState.getSelectedConversation && shellState.getSelectedConversation()) ||
      shellState.conversations?.find((c) => {
        const pId = getDirectPeerUserId(c, shellState.currentUser?.userId) ||
          c?.peerUserId || c?.peer_user_id || c?.peer?.userId || c?.peer?.user_id || c?.peer?.id;
        return pId === userId;
      });
    const displayName = conv ? getConversationTitle(conv) : (conv?.peer?.displayName || conv?.peer?.display_name || userId);
    const phone = conv?.peer?.phone || conv?.phone || '';

    shellState.addBlockedUser({
      userId,
      user_id: userId,
      displayName,
      display_name: displayName,
      phone,
      since: res?.since || new Date().toISOString()
    });

    if (window.ollacoreDesktop?.db?.addBlockedUser) {
      await window.ollacoreDesktop.db.addBlockedUser({
        userId,
        displayName,
        phone,
        since: res?.since || new Date().toISOString()
      }).catch(() => { });
    }

    updateBlockedCountHint();
    closeBlockContactModal();
    renderConversationList();

    if (shellState.selectedRoomId && shellState.isRoomBlocked(shellState.selectedRoomId)) {
      composerBlockedBanner?.classList.remove('hidden');
      composerBox?.classList.add('hidden');
      if (activeContactInfoRoomId === shellState.selectedRoomId) {
        openContactInfo(shellState.selectedRoomId);
      }
    }
    const sel = shellState.getSelectedConversation();
    if (sel) {
      const title = getConversationTitle(sel);
      const initials = getAvatarInitials(title);
      const color = getAvatarColor(title);
      renderAvatarElement(selectedChatAvatar, getConversationAvatarUrl(sel), initials, color, false);
      updateChatHeaderSubtitle();
    }
    if (chatHeaderMenu && !chatHeaderMenu.classList.contains('hidden')) {
      if (menuBlockText) {
        menuBlockText.textContent = 'Unblock contact';
      }
    }
  } catch (err) {
    if (blockModalError) {
      blockModalError.textContent = err?.message || 'Failed to block contact';
      blockModalError.classList.remove('hidden');
    }
  } finally {
    btnConfirmBlock?.removeAttribute('disabled');
    blockSpinner?.classList.add('hidden');
  }
}

/**
 * Unblocks a contact via server API, updating local state and database.
 * @param {string} userId
 */
async function handleUnblockContact(userId) {
  if (!userId || !window.ollacoreDesktop?.chatApi?.unblockUser) return;
  try {
    await window.ollacoreDesktop.chatApi.unblockUser(userId);
    shellState.removeBlockedUser(userId);
    if (window.ollacoreDesktop?.db?.removeBlockedUser) {
      await window.ollacoreDesktop.db.removeBlockedUser(userId).catch(() => { });
    }
    updateBlockedCountHint();
    renderConversationList();

    if (shellState.selectedRoomId && !shellState.isRoomBlocked(shellState.selectedRoomId)) {
      composerBlockedBanner?.classList.add('hidden');
      composerBox?.classList.remove('hidden');
      if (activeContactInfoRoomId === shellState.selectedRoomId) {
        openContactInfo(shellState.selectedRoomId);
      }
    }

    const sel = shellState.getSelectedConversation();
    if (sel) {
      const title = getConversationTitle(sel);
      const initials = getAvatarInitials(title);
      const color = getAvatarColor(title);
      renderAvatarElement(selectedChatAvatar, getConversationAvatarUrl(sel), initials, color, false);
      updateChatHeaderSubtitle();
    }

    if (blockedContactsModal && !blockedContactsModal.classList.contains('hidden')) {
      renderBlockedContactsList();
    }
  } catch (err) {
    showUserError(err?.message || 'Failed to unblock contact');
  }
}

/**
 * Updates hint text in settings modal privacy row.
 */
function updateBlockedCountHint() {
  if (settingBlockedCountHint) {
    const count = shellState.blockedUserIds?.size || 0;
    settingBlockedCountHint.textContent = `${count} contact${count === 1 ? '' : 's'}`;
  }
}

/**
 * Opens the blocked contacts list modal.
 */
async function openBlockedContactsModal() {
  if (!blockedContactsModal) return;
  blockedContactsModal.classList.remove('hidden');
  await renderBlockedContactsList();
}

/**
 * Closes the blocked contacts list modal.
 */
function closeBlockedContactsModal() {
  if (blockedContactsModal) {
    blockedContactsModal.classList.add('hidden');
  }
}

/**
 * Renders list of blocked contacts in the modal dialog.
 */
async function renderBlockedContactsList() {
  if (!blockedContactsList) return;
  blockedContactsList.innerHTML = '';
  blockedContactsError?.classList.add('hidden');

  const blockedList = shellState.getBlockedUsers();
  if (blockedList.length === 0) {
    blockedContactsEmpty?.classList.remove('hidden');
    return;
  }
  blockedContactsEmpty?.classList.add('hidden');

  for (const user of blockedList) {
    const userId = user.userId || user.user_id;
    const name = user.displayName || user.display_name || user.phone || userId;
    const phone = user.phone || '';
    const initials = getAvatarInitials(name);
    const color = getAvatarColor(name);

    const row = document.createElement('div');
    row.className = 'blocked-contact-item';
    row.innerHTML = `
      <div style="display: flex; align-items: center; gap: 12px; min-width: 0;">
        <div class="avatar avatar-sm" style="background-color: ${color}; flex-shrink: 0;">${initials}</div>
        <div class="blocked-contact-meta">
          <span class="blocked-contact-name">${escapeHtml(name)}</span>
          ${phone ? `<span class="blocked-contact-phone">${escapeHtml(phone)}</span>` : ''}
        </div>
      </div>
      <button type="button" class="btn btn-secondary btn-sm btn-unblock-item" data-user-id="${escapeHtml(userId)}">Unblock</button>
    `;

    const unblockBtn = row.querySelector('.btn-unblock-item');
    unblockBtn?.addEventListener('click', async () => {
      unblockBtn.setAttribute('disabled', 'true');
      unblockBtn.textContent = 'Unblocking...';
      try {
        await handleUnblockContact(userId);
      } catch {
        unblockBtn.removeAttribute('disabled');
        unblockBtn.textContent = 'Unblock';
      }
    });

    blockedContactsList.appendChild(row);
  }
}

/**
 * Loads authoritative blocked contacts from server with SQLite fallback.
 */
async function loadBlockedUsers() {
  let updated = false;
  if (window.ollacoreDesktop?.db?.getBlockedUsers) {
    try {
      const local = await window.ollacoreDesktop.db.getBlockedUsers();
      if (Array.isArray(local) && local.length > 0) {
        shellState.setBlockedUsers(local);
        updateBlockedCountHint();
        updated = true;
      }
    } catch (e) {
      console.warn('[DB] Failed to load cached blocked users:', e);
    }
  }

  if (window.ollacoreDesktop?.chatApi?.listBlockedUsers) {
    try {
      const res = await window.ollacoreDesktop.chatApi.listBlockedUsers();
      const blocks = Array.isArray(res?.blocks) ? res.blocks : [];
      shellState.setBlockedUsers(blocks);
      updateBlockedCountHint();
      updated = true;
      if (window.ollacoreDesktop?.db?.saveBlockedUsers) {
        await window.ollacoreDesktop.db.saveBlockedUsers(blocks).catch(() => { });
      }
    } catch (err) {
      console.warn('[ChatAPI] Failed to fetch blocked users from server:', err);
    }
  }

  if (updated) {
    renderConversationList();
    if (shellState.selectedRoomId) {
      const sel = shellState.getSelectedConversation();
      if (sel && selectedChatAvatar) {
        const title = getConversationTitle(sel);
        const initials = getAvatarInitials(title);
        const color = getAvatarColor(title);
        renderAvatarElement(selectedChatAvatar, getConversationAvatarUrl(sel), initials, color, false);
      }
      updateChatHeaderSubtitle();
    }
  }
}

/**
 * Opens the conversation context menu for a specific conversation item.
 * @param {MouseEvent|null} e
 * @param {object} item
 * @param {HTMLElement|null} anchorEl
 */
export function openConversationContextMenu(e, item, anchorEl = null) {
  if (!conversationContextMenu || !item) return;
  closeContextMenu();

  contextMenuTargetConversation = item;
  const roomId = item.roomId;
  const isPinned = shellState.isPinned(roomId);
  const isFav = shellState.isFavourite(roomId);
  const unread = shellState.getRoomUnreadCount(roomId);

  if (ctxChatPinText) {
    ctxChatPinText.textContent = isPinned ? 'Unpin chat' : 'Pin chat';
  }
  if (ctxChatFavText) {
    ctxChatFavText.textContent = isFav ? 'Remove from favourites' : 'Add to favourites';
  }
  if (ctxChatUnreadText) {
    ctxChatUnreadText.textContent = unread > 0 ? 'Mark as read' : 'Mark as unread';
  }
  const isMuted = shellState.isConversationMuted(item);
  if (ctxChatMuteText) {
    ctxChatMuteText.textContent = isMuted ? 'Unmute notifications' : 'Mute notifications';
  }

  const isGroup = Boolean(item.kind === 'group' || item.type === 'group');
  const isExited = Boolean(item.isExited || item.exited);

  if (isGroup && !isExited) {
    if (ctxChatDeleteText) {
      ctxChatDeleteText.textContent = 'Leave group';
    }
    if (ctxChatDeleteBtn) {
      ctxChatDeleteBtn.setAttribute('data-action', 'leave-group');
      ctxChatDeleteBtn.title = 'Leave group';
    }
    if (ctxChatDeleteIcon) {
      ctxChatDeleteIcon.innerHTML = '<svg class="ui-icon ui-icon-xs" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>';
    }
  } else {
    if (ctxChatDeleteText) {
      ctxChatDeleteText.textContent = 'Delete chat';
    }
    if (ctxChatDeleteBtn) {
      ctxChatDeleteBtn.setAttribute('data-action', 'delete-chat');
      ctxChatDeleteBtn.title = 'Delete chat';
    }
    if (ctxChatDeleteIcon) {
      ctxChatDeleteIcon.innerHTML = '<svg class="ui-icon ui-icon-xs" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>';
    }
  }

  conversationContextMenu.classList.remove('hidden');
  const menuWidth = 190;
  const menuHeight = conversationContextMenu.offsetHeight || 190;

  let left = 0;
  let top = 0;

  if (anchorEl) {
    const rect = anchorEl.getBoundingClientRect();
    left = rect.right - menuWidth;
    top = rect.bottom + 4;
  } else if (e) {
    left = e.clientX;
    top = e.clientY;
  }

  if (left + menuWidth > window.innerWidth - 10) {
    left = window.innerWidth - menuWidth - 10;
  }
  if (top + menuHeight > window.innerHeight - 10) {
    top = window.innerHeight - menuHeight - 10;
  }
  if (left < 10) left = 10;
  if (top < 10) top = 10;

  conversationContextMenu.style.left = `${left}px`;
  conversationContextMenu.style.top = `${top}px`;
}

/**
 * Closes the archived context menu.
 */
function closeArchivedContextMenu() {
  if (archivedContextMenu) {
    archivedContextMenu.classList.add('hidden');
  }
  contextMenuTargetArchivedConversation = null;
}

/**
 * Opens context menu for an archived conversation item.
 * @param {MouseEvent|null} e
 * @param {object} item
 * @param {HTMLElement|null} anchorEl
 */
function openArchivedContextMenu(e, item, anchorEl = null) {
  if (!archivedContextMenu || !item) return;
  closeConversationContextMenu();
  closeContextMenu();
  closeCustomListContextMenu();

  contextMenuTargetArchivedConversation = item;
  const roomId = item.roomId;
  const isPinned = shellState.isPinned(roomId);
  const isFav = shellState.isFavourite(roomId);
  const unread = shellState.getRoomUnreadCount(roomId);

  if (ctxArchivedPinText) {
    ctxArchivedPinText.textContent = isPinned ? 'Unpin chat' : 'Pin chat';
  }
  if (ctxArchivedFavText) {
    ctxArchivedFavText.textContent = isFav ? 'Remove from favourites' : 'Add to favourites';
  }
  if (ctxArchivedUnreadText) {
    ctxArchivedUnreadText.textContent = unread > 0 ? 'Mark as read' : 'Mark as unread';
  }

  archivedContextMenu.classList.remove('hidden');
  const menuWidth = 190;
  const menuHeight = archivedContextMenu.offsetHeight || 180;

  let left = 0;
  let top = 0;

  if (anchorEl) {
    const rect = anchorEl.getBoundingClientRect();
    left = rect.right - menuWidth;
    top = rect.bottom + 4;
  } else if (e) {
    left = e.clientX;
    top = e.clientY;
  }

  if (left + menuWidth > window.innerWidth - 10) {
    left = window.innerWidth - menuWidth - 10;
  }
  if (top + menuHeight > window.innerHeight - 10) {
    top = window.innerHeight - menuHeight - 10;
  }
  if (left < 10) left = 10;
  if (top < 10) top = 10;

  archivedContextMenu.style.left = `${left}px`;
  archivedContextMenu.style.top = `${top}px`;
}

/**
 * Switches the left navigation rail between Chats, Calls, and Archived destinations.
 * Preserves all conversation state, messages, filters, theme, and ongoing calls.
 * @param {'chats'|'calls'|'archived'} destination
 */
function switchNavigationRail(destination) {
  currentNavigationDestination = destination;
  closeChatHeaderMenu();
  closeChangeChatListsModal();

  navItemChats?.classList.toggle('active', destination === 'chats');
  navItemCalls?.classList.toggle('active', destination === 'calls');
  navItemArchived?.classList.toggle('active', destination === 'archived');

  if (destination === 'chats') {
    navItemChats?.setAttribute('aria-current', 'page');
    navItemCalls?.removeAttribute('aria-current');
    navItemArchived?.removeAttribute('aria-current');

    chatSidebar?.classList.remove('hidden');
    archivedSidebar?.classList.add('hidden');
    callsView?.classList.add('hidden');
    chatMainArea?.classList.remove('hidden');
    if (activeContactInfoRoomId) {
      contactInfoPanel?.classList.remove('hidden');
    }
    renderConversationList();
  } else if (destination === 'calls') {
    navItemCalls?.setAttribute('aria-current', 'page');
    navItemChats?.removeAttribute('aria-current');
    navItemArchived?.removeAttribute('aria-current');

    chatSidebar?.classList.add('hidden');
    archivedSidebar?.classList.add('hidden');
    callsView?.classList.remove('hidden');
    chatMainArea?.classList.add('hidden');
    contactInfoPanel?.classList.add('hidden');
    renderCallsHistory();
  } else if (destination === 'archived') {
    navItemArchived?.setAttribute('aria-current', 'page');
    navItemChats?.removeAttribute('aria-current');
    navItemCalls?.removeAttribute('aria-current');

    chatSidebar?.classList.add('hidden');
    archivedSidebar?.classList.remove('hidden');
    callsView?.classList.add('hidden');
    chatMainArea?.classList.remove('hidden');
    if (activeContactInfoRoomId) {
      contactInfoPanel?.classList.remove('hidden');
    }
    renderArchivedList();
  }
}

/**
 * Renders archived conversations into #archived-conversation-list.
 */
function renderArchivedList() {
  if (!archivedConversationList) return;
  archivedConversationList.innerHTML = '';

  const query = (archivedSearch?.value || '').trim();
  const items = shellState.getArchivedConversations(query);

  if (items.length === 0) {
    if (query !== '') {
      archivedNoSearch?.classList.remove('hidden');
      archivedEmpty?.classList.add('hidden');
    } else {
      archivedNoSearch?.classList.add('hidden');
      archivedEmpty?.classList.remove('hidden');
    }
    return;
  }

  archivedNoSearch?.classList.add('hidden');
  archivedEmpty?.classList.add('hidden');

  for (const item of items) {
    const isSelected = item.roomId === shellState.selectedRoomId;
    const isPinned = shellState.isPinned(item.roomId);
    const isFav = shellState.isFavourite(item.roomId);
    const title = getConversationTitle(item);
    const initials = getAvatarInitials(title);
    const color = getAvatarColor(title);
    const time = formatConversationTime(item.lastMessage?.createdAt || item.lastMessage?.created_at);
    const preview = getConversationPreview(item);
    const unread = typeof item.unreadCount === 'number' ? item.unreadCount : (item.unread_count || 0);

    const el = document.createElement('div');
    el.className = `conversation-item ${isSelected ? 'selected' : ''} ${isPinned ? 'is-pinned' : ''} ${isFav ? 'is-favourite' : ''}`;
    el.setAttribute('role', 'button');
    el.setAttribute('tabindex', '0');
    el.setAttribute('data-room-id', item.roomId);

    const avatarUrl = getConversationAvatarUrl(item);
    const avatarContent = avatarUrl
      ? `<img src="${escapeHtml(avatarUrl)}" alt="${escapeHtml(title)}" class="avatar-img" onerror="this.onerror=null; this.remove(); if (this.parentElement) { this.parentElement.style.backgroundColor='${color}'; this.parentElement.textContent='${escapeHtml(initials)}'; }" />`
      : escapeHtml(initials);

    el.innerHTML = `
      <div class="avatar" style="background-color: ${avatarUrl ? 'transparent' : color};">${avatarContent}</div>
      <div class="conversation-meta">
        <div class="meta-row-top">
          <span class="conversation-title">${escapeHtml(title)}</span>
          ${time ? `<span class="conversation-time">${escapeHtml(time)}</span>` : ''}
        </div>
        <div class="meta-row-bottom">
          <span class="conversation-preview">${escapeHtml(preview)}</span>
          <div class="conversation-badges">
            ${shellState.isConversationMuted(item) ? `<span class="chat-muted-badge" title="Muted notifications"><svg class="ui-icon ui-icon-xs" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 5 6 9H2v6h4l5 4V5z"/><line x1="22" y1="9" x2="16" y2="15"/><line x1="16" y1="9" x2="22" y2="15"/></svg></span>` : ''}
            ${isFav ? `<span class="chat-fav-badge" title="Favourite"><svg class="ui-icon ui-icon-xs" viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg></span>` : ''}
            ${isPinned ? `<span class="chat-pin-badge" title="Pinned chat"><svg class="ui-icon ui-icon-xs" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="12" y1="17" x2="12" y2="22"/><path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a1 1 0 0 0 0-2H8a1 1 0 0 0 0 2h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z"/></svg></span>` : ''}
            ${unread > 0 ? `<span class="unread-badge">${unread > 99 ? '99+' : unread}</span>` : ''}
          </div>
        </div>
      </div>
    `;

    el.addEventListener('click', () => {
      selectConversation(item.roomId);
    });

    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openArchivedContextMenu(e, item);
    });

    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        selectConversation(item.roomId);
      }
    });

    archivedConversationList.appendChild(el);
  }
}

/**
 * Initiates voice or video call again from a call history record.
 * Fails gracefully if roomId is invalid or unavailable.
 * @param {object} record
 */
function initiateCallFromRecord(record) {
  if (!record || typeof record !== 'object') return;
  const roomId = record.roomId;
  if (!roomId) {
    console.warn('[Calls] Cannot call back: record has no roomId');
    return;
  }
  const isVideo = record.callType === 'video';
  const { displayName, phone } = resolveCallerIdentity(roomId, record.participantId);
  const resolvedName = displayName || record.participantName || (isVideo ? 'Video Call' : 'Voice Call');
  const resolvedPhone = phone || record.participantPhone || '';

  voiceCallManager.peerPhone = resolvedPhone;
  if (isVideo) {
    voiceCallManager.startVideoCall(roomId, resolvedName, { peerPhone: resolvedPhone }).catch((err) => {
      console.warn('[Calls] Failed to start video call from history:', err?.message || err);
    });
  } else {
    voiceCallManager.startCall(roomId, resolvedName, { peerPhone: resolvedPhone }).catch((err) => {
      console.warn('[Calls] Failed to start voice call from history:', err?.message || err);
    });
  }
}

/**
 * Renders call history items into #calls-history-list.
 */
function renderCallsHistory() {
  if (!callsHistoryList) return;
  callsHistoryList.innerHTML = '';

  const query = (callsSearch?.value || '').trim();
  const history = shellState.getCallHistory(query);

  if (history.length === 0) {
    if (query !== '') {
      callsNoSearch?.classList.remove('hidden');
      callsEmpty?.classList.add('hidden');
    } else {
      callsNoSearch?.classList.add('hidden');
      callsEmpty?.classList.remove('hidden');
    }
    return;
  }

  callsNoSearch?.classList.add('hidden');
  callsEmpty?.classList.add('hidden');

  for (const item of history) {
    const isVideo = item.callType === 'video';
    const isIncoming = item.direction === 'incoming';
    const isMissed = item.status === 'missed';
    const isDeclined = item.status === 'declined';
    const title = item.participantName || (isVideo ? 'Video Call' : 'Voice Call');
    const initials = getAvatarInitials(title);
    const color = getAvatarColor(title);
    const time = formatConversationTime(item.startedAt);
    const durationText = item.status === 'completed' && item.duration > 0 ? formatCallDuration(item.duration) : '';

    let directionSvg = '';
    if (isIncoming) {
      directionSvg = `<svg class="ui-icon ui-icon-xs call-direction-icon call-direction-incoming" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="17" y1="7" x2="7" y2="17"/><polyline points="17 17 7 17 7 7"/></svg>`;
    } else {
      directionSvg = `<svg class="ui-icon ui-icon-xs call-direction-icon call-direction-outgoing" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="7" y1="17" x2="17" y2="7"/><polyline points="7 7 17 7 17 17"/></svg>`;
    }

    let statusLabel = '';
    if (isMissed) {
      statusLabel = '<span class="call-status-missed">Missed</span>';
    } else if (isDeclined) {
      statusLabel = '<span class="call-status-declined">Declined</span>';
    } else {
      statusLabel = `<span>${isIncoming ? 'Incoming' : 'Outgoing'} · ${isVideo ? 'Video' : 'Voice'}</span>`;
      if (durationText) {
        statusLabel += ` <span class="call-duration-tag">(${escapeHtml(durationText)})</span>`;
      }
    }

    const el = document.createElement('div');
    el.className = `call-item ${isMissed ? 'call-missed' : ''}`;
    el.setAttribute('role', 'button');
    el.setAttribute('tabindex', '0');
    el.setAttribute('data-call-id', item.id);
    if (item.roomId) {
      el.setAttribute('data-room-id', item.roomId);
    }

    el.innerHTML = `
      <div class="avatar" style="background-color: ${color};">${initials}</div>
      <div class="call-meta">
        <div class="call-meta-top">
          <span class="call-participant-name">${escapeHtml(title)}</span>
          ${time ? `<span class="call-time">${escapeHtml(time)}</span>` : ''}
        </div>
        <div class="call-meta-bottom">
          ${directionSvg}
          ${statusLabel}
        </div>
      </div>
      <button type="button" class="call-item-action" title="Call back (${isVideo ? 'video' : 'voice'})" aria-label="Call back">
        ${isVideo
        ? `<svg class="ui-icon ui-icon-xs" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m22 8-6 4 6 4V8Z"/><rect width="14" height="12" x="2" y="6" rx="2" ry="2"/></svg>`
        : `<svg class="ui-icon ui-icon-xs" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>`
      }
      </button>
    `;

    const actionBtn = el.querySelector('.call-item-action');
    actionBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      initiateCallFromRecord(item);
    });

    el.addEventListener('click', () => {
      initiateCallFromRecord(item);
    });

    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        initiateCallFromRecord(item);
      }
    });

    callsHistoryList.appendChild(el);
  }
}

/**
 * Renders the filtered conversation list items into the sidebar.
 */
function renderConversationList() {
  if (!conversationList) return;
  conversationList.innerHTML = '';

  updateChatFilterCounts();
  renderCustomListFilters();

  const items = shellState.getFilteredConversations();

  // Handle empty search or filter result state
  if (items.length === 0) {
    if (shellState.searchQuery.trim() !== '') {
      inboxNoSearch?.classList.remove('hidden');
      inboxEmpty?.classList.add('hidden');
      inboxEmptyCustomList?.classList.add('hidden');
    } else {
      inboxNoSearch?.classList.add('hidden');
      const activeCustomList = shellState.getCustomList(shellState.activeFilter);
      if (activeCustomList) {
        inboxEmpty?.classList.add('hidden');
        inboxEmptyCustomList?.classList.remove('hidden');
        if (emptyCustomListTitle) {
          emptyCustomListTitle.textContent = `No chats in ${activeCustomList.name}`;
        }
      } else {
        inboxEmptyCustomList?.classList.add('hidden');
        inboxEmpty?.classList.remove('hidden');
        const emptyTitle = inboxEmpty?.querySelector('.state-title');
        const emptyDesc = inboxEmpty?.querySelector('.state-desc');
        if (shellState.activeFilter === 'unread') {
          if (emptyTitle) emptyTitle.textContent = 'No unread chats';
          if (emptyDesc) emptyDesc.textContent = "You're all caught up! No unread messages.";
        } else if (shellState.activeFilter === 'favourites') {
          if (emptyTitle) emptyTitle.textContent = 'No favourite chats';
          if (emptyDesc) emptyDesc.textContent = 'Right-click any chat to add it to your favourites.';
        } else if (shellState.activeFilter === 'groups') {
          if (emptyTitle) emptyTitle.textContent = 'No group chats';
          if (emptyDesc) emptyDesc.textContent = 'Create a new group to start chatting with multiple people.';
        } else {
          if (emptyTitle) emptyTitle.textContent = 'No conversations yet';
          if (emptyDesc) emptyDesc.textContent = 'When you connect with contacts, your chats will appear here.';
        }
      }
    }
    return;
  }

  inboxNoSearch?.classList.add('hidden');
  inboxEmpty?.classList.add('hidden');
  inboxEmptyCustomList?.classList.add('hidden');

  for (const item of items) {
    const isSelected = item.roomId === shellState.selectedRoomId;
    const isPinned = shellState.isPinned(item.roomId);
    const isFav = shellState.isFavourite(item.roomId);
    const title = getConversationTitle(item);
    const initials = getAvatarInitials(title);
    const color = getAvatarColor(title);
    const time = formatConversationTime(item.lastMessage?.createdAt || item.lastMessage?.created_at);
    const preview = getConversationPreview(item);
    const unread = typeof item.unreadCount === 'number' ? item.unreadCount : (item.unread_count || 0);

    const el = document.createElement('div');
    el.className = `conversation-item ${isSelected ? 'selected' : ''} ${isPinned ? 'is-pinned' : ''} ${isFav ? 'is-favourite' : ''}`;
    el.setAttribute('role', 'button');
    el.setAttribute('tabindex', '0');
    el.setAttribute('data-room-id', item.roomId);

    const avatarUrl = getConversationAvatarUrl(item);
    const avatarContent = avatarUrl
      ? `<img src="${escapeHtml(avatarUrl)}" alt="${escapeHtml(title)}" class="avatar-img" onerror="this.onerror=null; this.remove(); if (this.parentElement) { this.parentElement.style.backgroundColor='${color}'; this.parentElement.textContent='${escapeHtml(initials)}'; }" />`
      : escapeHtml(initials);

    el.innerHTML = `
      <div class="avatar" style="background-color: ${avatarUrl ? 'transparent' : color};">${avatarContent}</div>
      <div class="conversation-meta">
        <div class="meta-row-top">
          <span class="conversation-title">${escapeHtml(title)}</span>
          ${time ? `<span class="conversation-time">${escapeHtml(time)}</span>` : ''}
        </div>
        <div class="meta-row-bottom">
          <span class="conversation-preview">${escapeHtml(preview)}</span>
          <div class="conversation-badges">
            ${shellState.isConversationMuted(item) ? `<span class="chat-muted-badge" title="Muted notifications"><svg class="ui-icon ui-icon-xs" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 5 6 9H2v6h4l5 4V5z"/><line x1="22" y1="9" x2="16" y2="15"/><line x1="16" y1="9" x2="22" y2="15"/></svg></span>` : ''}
            ${isFav ? `<span class="chat-fav-badge" title="Favourite"><svg class="ui-icon ui-icon-xs" viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg></span>` : ''}
            ${isPinned ? `<span class="chat-pin-badge" title="Pinned chat"><svg class="ui-icon ui-icon-xs" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="12" y1="17" x2="12" y2="22"/><path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a1 1 0 0 0 0-2H8a1 1 0 0 0 0 2h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z"/></svg></span>` : ''}
            ${unread > 0 ? `<span class="unread-badge">${unread > 99 ? '99+' : unread}</span>` : ''}
          </div>
        </div>
      </div>
    `;

    el.addEventListener('click', () => {
      selectConversation(item.roomId);
    });

    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openConversationContextMenu(e, item);
    });

    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        selectConversation(item.roomId);
      }
    });

    conversationList.appendChild(el);
  }
}

/**
 * Stores the last viewed scroll position and top-visible anchor message for each conversation.
 * Key: roomId (string), Value: { scrollTop, scrollHeight, clientHeight, isNearBottom, anchorMessageId, anchorOffsetTop, savedAt }
 */
export const roomSavedScrollPositions = new Map();
let isRestoringScroll = false;
let isRebuildingMessagesDom = false;

export const recentUnmatchedAcks = new Map();
export function recordUnmatchedAck(reqId, frame) {
  if (!reqId) return;
  recentUnmatchedAcks.set(reqId, { frame, timestamp: Date.now() });
  if (recentUnmatchedAcks.size > 200) {
    const cutoff = Date.now() - 10000;
    for (const [k, v] of recentUnmatchedAcks.entries()) {
      if (v.timestamp < cutoff) recentUnmatchedAcks.delete(k);
    }
  }
}

export let lastUserScrollActionTime = 0;
export function markUserScrolled() {
  lastUserScrollActionTime = Date.now();
}

export const roomUnseenMessageIds = new Map();

export function getUnseenMessagesCount(roomId = shellState?.selectedRoomId) {
  if (!roomId) return 0;
  return roomUnseenMessageIds.get(String(roomId))?.size || 0;
}

export let unseenIncomingMessagesCount = 0;

export function updateScrollBottomBadge(target = shellState?.selectedRoomId) {
  let count = 0;
  if (typeof target === 'number') {
    count = Math.max(0, target);
  } else {
    count = getUnseenMessagesCount(target || shellState?.selectedRoomId);
  }
  unseenIncomingMessagesCount = count;
  if (!scrollBottomBadge) return;
  if (count > 0) {
    scrollBottomBadge.textContent = count > 99 ? '99+' : String(count);
    scrollBottomBadge.classList.remove('hidden');
  } else {
    scrollBottomBadge.textContent = '0';
    scrollBottomBadge.classList.add('hidden');
  }
}

export function recordUnseenIncomingMessage(roomId, msgId) {
  if (!roomId || !msgId) return;
  const rKey = String(roomId);
  if (!roomUnseenMessageIds.has(rKey)) {
    roomUnseenMessageIds.set(rKey, new Set());
  }
  roomUnseenMessageIds.get(rKey).add(String(msgId));
  if (shellState?.selectedRoomId && String(shellState.selectedRoomId) === rKey) {
    updateScrollBottomBadge(rKey);
  }
}

export function clearUnseenIncomingMessages(roomId = shellState?.selectedRoomId) {
  if (!roomId) return;
  const rKey = String(roomId);
  if (roomUnseenMessageIds.has(rKey)) {
    roomUnseenMessageIds.get(rKey).clear();
  }
  if (!shellState?.selectedRoomId || String(shellState.selectedRoomId) === rKey) {
    updateScrollBottomBadge(rKey);
  }
}

export function captureScrollAnchor() {
  if (!messagesScrollArea || !messagesList) return null;
  const distFromBottom = messagesScrollArea.scrollHeight - messagesScrollArea.scrollTop - messagesScrollArea.clientHeight;
  const isNearBottom = distFromBottom <= 140 || messagesScrollArea.scrollHeight <= (messagesScrollArea.clientHeight + 5);
  if (isNearBottom) {
    return { isNearBottom: true };
  }
  const areaRect = messagesScrollArea.getBoundingClientRect();
  const messageRows = messagesList.querySelectorAll('.message-row[data-message-id], .message-row, [data-message-id]');
  let anchorMessageId = null;
  let anchorOffsetTop = 0;
  for (const el of messageRows) {
    const rect = el.getBoundingClientRect();
    if (rect.bottom >= areaRect.top + 5) {
      anchorMessageId = el.getAttribute('data-message-id') || el.dataset?.messageId || el.getAttribute('data-client-message-id') || el.id?.replace(/^msg-/, '');
      anchorOffsetTop = rect.top - areaRect.top;
      break;
    }
  }
  return {
    isNearBottom: false,
    anchorMessageId,
    anchorOffsetTop,
    prevScrollTop: messagesScrollArea.scrollTop,
    prevScrollHeight: messagesScrollArea.scrollHeight
  };
}

export function restoreScrollAnchor(anchor) {
  if (!anchor || !messagesScrollArea || !messagesList) return;
  if (anchor.isNearBottom) {
    messagesScrollArea.scrollTop = messagesScrollArea.scrollHeight;
    scrollBottomBtn?.classList.add('hidden');
    requestAnimationFrame(() => {
      if (messagesScrollArea) {
        messagesScrollArea.scrollTop = messagesScrollArea.scrollHeight;
        scrollBottomBtn?.classList.add('hidden');
      }
    });
    return;
  }
  if (anchor.anchorMessageId) {
    const el = findMessageDomElement(anchor.anchorMessageId);
    if (el) {
      const areaRect = messagesScrollArea.getBoundingClientRect();
      const elRect = el.getBoundingClientRect();
      const currentDiff = elRect.top - areaRect.top;
      const adjustment = currentDiff - anchor.anchorOffsetTop;
      messagesScrollArea.scrollTop += adjustment;
      return;
    }
  }
  if (typeof anchor.prevScrollHeight === 'number' && typeof anchor.prevScrollTop === 'number') {
    const deltaH = messagesScrollArea.scrollHeight - anchor.prevScrollHeight;
    messagesScrollArea.scrollTop = anchor.prevScrollTop + deltaH;
  }
}

export function saveRoomScrollPosition(roomId, { forceNearBottom = false } = {}) {
  if (!roomId || !messagesScrollArea || !messagesList) return;
  if (isRebuildingMessagesDom || isRestoringScroll || isPaginatingOlder) return;
  if (shellState.selectedRoomId !== roomId) return;

  const areaRect = messagesScrollArea.getBoundingClientRect();
  const messageRows = messagesList.querySelectorAll('.message-row[data-message-id], .message-row, [data-message-id]');
  if (messageRows.length === 0) return;

  const scrollTop = messagesScrollArea.scrollTop;
  const scrollHeight = messagesScrollArea.scrollHeight;
  const clientHeight = messagesScrollArea.clientHeight;
  const distFromBottom = scrollHeight - scrollTop - clientHeight;
  let isNearBottom = forceNearBottom || distFromBottom <= 140 || scrollHeight <= (clientHeight + 5);

  let isViewingLatest = isNearBottom;
  let lastMessageId = null;

  if (messageRows.length > 0) {
    const lastRow = messageRows[messageRows.length - 1];
    lastMessageId = lastRow.getAttribute('data-message-id') || lastRow.dataset?.messageId || lastRow.getAttribute('data-client-message-id') || lastRow.id?.replace(/^msg-/, '');
    const lastRect = lastRow.getBoundingClientRect();
    if (lastRect.top < areaRect.bottom && (lastRect.bottom >= areaRect.top || lastRect.bottom >= (areaRect.bottom - 100))) {
      isViewingLatest = true;
    }
  }

  const openingState = (activeConversationOpeningState && activeConversationOpeningState.roomId === roomId)
    ? activeConversationOpeningState
    : null;
  if (openingState?.targetMessageId && lastMessageId && openingState.targetMessageId === lastMessageId) {
    isViewingLatest = true;
  }

  if (isViewingLatest || isNearBottom) {
    isNearBottom = true;
    isViewingLatest = true;
  }

  let anchorMessageId = null;
  let anchorOffsetTop = 0;

  for (const row of messageRows) {
    const rect = row.getBoundingClientRect();
    if (rect.bottom > areaRect.top) {
      anchorMessageId = row.getAttribute('data-message-id') || row.dataset?.messageId || row.getAttribute('data-client-message-id') || row.id?.replace(/^msg-/, '');
      anchorOffsetTop = rect.top - areaRect.top;
      break;
    }
  }

  roomSavedScrollPositions.set(String(roomId), {
    scrollTop,
    scrollHeight,
    clientHeight,
    isNearBottom,
    isViewingLatest,
    lastMessageId: lastMessageId || null,
    anchorMessageId: anchorMessageId || null,
    anchorOffsetTop,
    savedAt: Date.now()
  });
}

export function restoreRoomScrollPosition(roomId) {
  if (!roomId || !messagesScrollArea || !messagesList) return false;
  const saved = roomSavedScrollPositions.get(String(roomId));
  if (!saved) return false;

  isRestoringScroll = true;
  try {
    if (saved.isViewingLatest || saved.isNearBottom) {
      messagesScrollArea.scrollTop = messagesScrollArea.scrollHeight;
      scrollBottomBtn?.classList.add('hidden');
      clearUnseenIncomingMessages(roomId);
      requestAnimationFrame(() => {
        if (shellState.selectedRoomId === roomId && messagesScrollArea) {
          messagesScrollArea.scrollTop = messagesScrollArea.scrollHeight;
          scrollBottomBtn?.classList.add('hidden');
          clearUnseenIncomingMessages(roomId);
        }
      });
      return true;
    }

    if (saved.anchorMessageId) {
      const el = findMessageDomElement(saved.anchorMessageId);
      if (el) {
        const areaRect = messagesScrollArea.getBoundingClientRect();
        const elRect = el.getBoundingClientRect();
        const currentDiff = elRect.top - areaRect.top;
        const adjustment = currentDiff - saved.anchorOffsetTop;
        messagesScrollArea.scrollTop += adjustment;

        requestAnimationFrame(() => {
          if (shellState.selectedRoomId === roomId && messagesScrollArea) {
            const reEl = findMessageDomElement(saved.anchorMessageId);
            if (reEl) {
              const rArea = messagesScrollArea.getBoundingClientRect();
              const rEl = reEl.getBoundingClientRect();
              const rDiff = rEl.top - rArea.top;
              messagesScrollArea.scrollTop += (rDiff - saved.anchorOffsetTop);
            }
            const distFromBottom = messagesScrollArea.scrollHeight - messagesScrollArea.scrollTop - messagesScrollArea.clientHeight;
            if (distFromBottom > 150) {
              scrollBottomBtn?.classList.remove('hidden');
              updateScrollBottomBadge(roomId);
            } else {
              scrollBottomBtn?.classList.add('hidden');
              clearUnseenIncomingMessages(roomId);
            }
          }
        });

        const distFromBottom = messagesScrollArea.scrollHeight - messagesScrollArea.scrollTop - messagesScrollArea.clientHeight;
        if (distFromBottom > 150) {
          scrollBottomBtn?.classList.remove('hidden');
          updateScrollBottomBadge(roomId);
        } else {
          scrollBottomBtn?.classList.add('hidden');
          clearUnseenIncomingMessages(roomId);
        }
        return true;
      }
    }

    if (typeof saved.scrollTop === 'number') {
      messagesScrollArea.scrollTop = saved.scrollTop;
      const distFromBottom = messagesScrollArea.scrollHeight - messagesScrollArea.scrollTop - messagesScrollArea.clientHeight;
      if (distFromBottom > 150) {
        scrollBottomBtn?.classList.remove('hidden');
      } else {
        scrollBottomBtn?.classList.add('hidden');
      }
      return true;
    }
  } finally {
    requestAnimationFrame(() => {
      isRestoringScroll = false;
    });
  }
  return false;
}

/**
 * Updates composer and calling UI controls for exited group status.
 * @param {object} [conv]
 */
export function updateExitedGroupUI(conv) {
  const isExited = Boolean(conv?.isExited || conv?.exited);
  if (isExited) {
    composerBox?.classList.add('hidden');
    composerBlockedBanner?.classList.add('hidden');
    composerRecordingBar?.classList.add('hidden');
    composerExitedBanner?.classList.remove('hidden');
    btnStartVoiceCall?.setAttribute('disabled', 'true');
    btnStartVoiceCall?.classList.add('is-disabled');
    btnStartVoiceCall?.setAttribute('title', 'You left this group');
    btnStartVideoCall?.setAttribute('disabled', 'true');
    btnStartVideoCall?.classList.add('is-disabled');
    btnStartVideoCall?.setAttribute('title', 'You left this group');
  } else {
    composerExitedBanner?.classList.add('hidden');
    btnStartVoiceCall?.removeAttribute('disabled');
    btnStartVoiceCall?.classList.remove('is-disabled');
    btnStartVoiceCall?.setAttribute('title', 'Start voice call');
    btnStartVideoCall?.removeAttribute('disabled');
    btnStartVideoCall?.classList.remove('is-disabled');
    btnStartVideoCall?.setAttribute('title', 'Start video call');
    if (conv?.roomId && shellState.isRoomBlocked(conv.roomId)) {
      composerBlockedBanner?.classList.remove('hidden');
      composerBox?.classList.add('hidden');
    } else {
      composerBlockedBanner?.classList.add('hidden');
      composerBox?.classList.remove('hidden');
    }
  }
}

/**
 * Handles selecting a conversation.
 * @param {string} roomId
 */
function selectConversation(roomId, { forceReload = false } = {}) {
  closeChatHeaderMenu();
  const targetMessageId = (arguments[1] && typeof arguments[1] === 'object' && arguments[1].targetMessageId)
    ? arguments[1].targetMessageId
    : (arguments[2] || null);

  const previousRoomId = shellState.selectedRoomId;
  if (previousRoomId !== roomId) {
    if (unreadDividerDismissTimer) {
      clearTimeout(unreadDividerDismissTimer);
      unreadDividerDismissTimer = null;
    }
    exitMessageSelectionMode();
    if (previousRoomId) {
      saveRoomScrollPosition(previousRoomId);
      stopLocalTyping(previousRoomId);
      if (composerInput) {
        roomComposerDrafts.set(previousRoomId, composerInput.value);
      }
    }
    updateScrollBottomBadge(roomId);
  }

  // Explicit notification-driven target message intentionally overrides saved position
  if (targetMessageId && roomId) {
    roomSavedScrollPositions.delete(String(roomId));
  }
  const hasSavedPosition = Boolean(roomId && !targetMessageId && roomSavedScrollPositions.has(String(roomId)));

  const isSameRoom = shellState.selectedRoomId === roomId && activeRoomMessagesState.roomId === roomId && !activeRoomMessagesState.isLoadingInitial;
  shellState.selectConversation(roomId);
  let selected = shellState.getSelectedConversation();
  if (!selected && roomId) {
    const provisional = {
      roomId,
      room_id: roomId,
      title: 'Chat',
      kind: 'direct',
      unreadCount: 0,
      unread_count: 0
    };
    if (Array.isArray(shellState.conversations)) {
      shellState.conversations.unshift(provisional);
    } else {
      shellState.conversations = [provisional];
    }
    selected = shellState.getSelectedConversation() || provisional;
    try {
      renderConversationList();
    } catch { }
    loadInbox().catch(() => { });
  }

  // Capture unread state before opening session begins
  const rawUnreadCount = shellState.getRoomUnreadCount(roomId) || (selected?.unreadCount ?? selected?.unread_count ?? 0);
  const isMarkedUnread = Boolean(selected?.isMarkedUnread || selected?.is_marked_unread || shellState._markedUnreadRooms?.has(String(roomId)));
  const trackedUnreadSet = shellState._unreadMessageIds?.has(String(roomId))
    ? new Set(shellState._unreadMessageIds.get(String(roomId)))
    : new Set();
  const trackedEditsSet = shellState._unreadEditedMessages?.has(String(roomId))
    ? new Set(shellState._unreadEditedMessages.get(String(roomId)))
    : new Set();

  const shouldHaveDivider = Boolean(rawUnreadCount > 0 || isMarkedUnread || trackedUnreadSet?.size > 0 || targetMessageId);
  activeConversationOpeningState = {
    roomId,
    initialUnreadCount: rawUnreadCount,
    isMarkedUnread,
    trackedUnreadSet,
    trackedEditsSet,
    hasPositioned: false,
    targetMessageId: targetMessageId || null,
    isRestoringPosition: hasSavedPosition,
    isReadAcknowledged: false,
    hasUnreadDivider: shouldHaveDivider,
    unreadDividerMessageId: null
  };

  // Clear unread indicator when conversation is opened
  if (selected && ((selected.unreadCount || 0) > 0 || (selected.unread_count || 0) > 0 || isMarkedUnread)) {
    selected.unreadCount = 0;
    selected.unread_count = 0;
    selected.isMarkedUnread = false;
    selected.is_marked_unread = false;
    shellState.markConversationAsRead(roomId);
    updateChatFilterCounts();
    renderConversationList();
    persistConversationToDb(selected).catch(() => { });
  }

  // Restore draft for newly selected room
  if (composerInput) {
    composerInput.value = (roomId ? roomComposerDrafts.get(roomId) : '') || '';
    autoResizeComposer();
    updateSendButtonState();
  }
  if (activeVoiceAudio) {
    try {
      activeVoiceAudio.pause();
    } catch { }
    activeVoiceAudio = null;
  }
  if (voiceRecorder && voiceRecorder.isRecording()) {
    voiceRecorder.cancel();
    composerRecordingBar?.classList.add('hidden');
    composerBox?.classList.remove('hidden');
    resetRecordingVisualizer();
  }
  emojiPicker?.close();
  hideAttachmentMenu();
  hideUploadProgress();
  closeChatSearch();
  closeChatHeaderMenu();
  closeChangeChatListsModal();

  // Blocked contact & exited group composer/calling handling
  updateExitedGroupUI(selected);

  // Update visual selection in conversation list and remove badge from DOM
  if (conversationList) {
    const items = conversationList.querySelectorAll('.conversation-item');
    items.forEach((item) => {
      if (item.getAttribute('data-room-id') === roomId) {
        item.classList.add('selected');
        const badge = item.querySelector('.unread-badge');
        if (badge) badge.remove();
      } else {
        item.classList.remove('selected');
      }
    });
  }
  if (archivedConversationList) {
    const items = archivedConversationList.querySelectorAll('.conversation-item');
    items.forEach((item) => {
      if (item.getAttribute('data-room-id') === roomId) {
        item.classList.add('selected');
        const badge = item.querySelector('.unread-badge');
        if (badge) badge.remove();
      } else {
        item.classList.remove('selected');
      }
    });
  }

  if (selected) {
    hideFloatingDateIndicator(true);
    activeRoomMessagesState = getOrCreateRoomMessagesState(roomId);
    const authUserId = shellState.currentUser?.userId || shellState.userProfile?.userId;
    if (authUserId && activeRoomMessagesState.currentUserId !== authUserId) {
      activeRoomMessagesState.setCurrentUserId(authUserId);
    }

    const title = getConversationTitle(selected);
    const initials = getAvatarInitials(title);
    const color = getAvatarColor(title);

    // Switch main panel from empty welcome to selected chat
    chatEmptyPanel?.classList.add('hidden');
    chatSelectedPanel?.classList.remove('hidden');

    if (selectedChatName) selectedChatName.textContent = title;
    updateChatHeaderSubtitle();
    if (selectedChatAvatar) {
      renderAvatarElement(selectedChatAvatar, getConversationAvatarUrl(selected), initials, color, false);
    }
    if (selectedChatWelcomeName) selectedChatWelcomeName.textContent = title;

    if (selected.kind === 'group') {
      btnGroupInfo?.classList.remove('hidden');
      chatHeaderInfo?.classList.add('clickable-group');
      chatHeaderInfo?.setAttribute('title', 'Click for group info');
      ensureRoomParticipants(roomId).catch(() => { });
    } else {
      btnGroupInfo?.classList.add('hidden');
      chatHeaderInfo?.classList.remove('clickable-group');
      chatHeaderInfo?.setAttribute('title', 'Click for contact info');
    }

    // If Contact Info panel was open, refresh it with new conversation info to prevent stale data
    if (activeContactInfoRoomId || shellState.isContactInfoOpen()) {
      openContactInfo(roomId);
    }
    if (mediaBrowserPanel && !mediaBrowserPanel.classList.contains('hidden')) {
      activeMbRoomId = roomId;
      _populateMbTab(activeMbTab, roomId);
    }
    if (starredMessagesPanel && !starredMessagesPanel.classList.contains('hidden')) {
      activeStarredRoomId = roomId;
      _renderStarredMessages(roomId);
    }
    // Update pinned bar for newly selected conversation
    currentPinnedBarIndex = 0;
    renderPinnedBar(roomId);

    // Immediately render cached messages if we already have them for this room
    if (activeRoomMessagesState.messages.length > 0) {
      if (activeRoomMessagesState.peerLastReadSeq > 0) {
        activeRoomMessagesState.setPeerLastReadSeq(activeRoomMessagesState.peerLastReadSeq);
      }
      messagesEmpty?.classList.add('hidden');
      messagesLoading?.classList.add('hidden');
      messagesError?.classList.add('hidden');
      messagesScrollArea?.classList.remove('hidden');
      renderMessages();
      if (hasSavedPosition) {
        restoreRoomScrollPosition(roomId);
        activeConversationOpeningState.hasPositioned = true;
      } else {
        positionConversationAtLatestUnreadOrBottom(roomId);
      }
      advanceReadCursorForActiveRoom();
    } else {
      advanceReadCursorForActiveRoom();
    }

    // Load message history if not already active for this room or if reload is forced or history not yet loaded
    const isExitedRoom = Boolean(selected?.isExited || selected?.exited);
    if (!isSameRoom || forceReload || !activeRoomMessagesState.isHistoryLoaded) {
      if (!isExitedRoom && window.ollacoreDesktop?.chat?.connect) {
        if (shellState.wsState !== 'connected') {
          updateWsIndicator('connecting', null, roomId);
        }
        window.ollacoreDesktop.chat.connect(roomId).then((res) => {
          if (shellState.selectedRoomId !== roomId) return;
          if (res?.ok) {
            updateWsIndicator(res.state || 'connected', null, roomId);
          } else if (res?.error) {
            updateWsIndicator('error', { message: res.error }, roomId);
          }
        }).catch((err) => {
          if (shellState.selectedRoomId === roomId) {
            updateWsIndicator('error', { message: err?.message || 'Connection failed' }, roomId);
          }
        });
      }

      loadMessagesForRoom(roomId, { forceReload });
    }

    // Load and apply custom theme for this conversation (non-blocking, fails gracefully to default)
    try {
      loadAndApplyThemeForRoom(roomId).catch((err) => {
        console.error('[Theme] Failed to load and apply room theme:', err);
        resetThemeToDefault();
      });
    } catch (themeErr) {
      console.error('[Theme] Error invoking loadAndApplyThemeForRoom:', themeErr);
      resetThemeToDefault();
    }
  } else {
    // Show empty welcome panel if no selection
    // The persistent application-level Chat WebSocket remains alive in the background
    const authUserId = shellState.currentUser?.userId || shellState.userProfile?.userId || null;
    activeRoomMessagesState = new RoomMessagesState(authUserId, sharedRoomReceiptStore);
    if (messagesList) messagesList.innerHTML = '';
    if (composerInput) {
      composerInput.value = '';
      autoResizeComposer();
      updateSendButtonState();
    }
    resetThemeToDefault();
    chatEmptyPanel?.classList.remove('hidden');
    chatSelectedPanel?.classList.add('hidden');
    closeContactInfo();
  }
}

/**
 * Deduplication cache for dispatched read receipts to avoid request floods
 * when switching to or loading rooms with dozens of messages.
 */
export const readReceiptsDispatched = new Set();
const MAX_DISPATCHED_RECEIPTS = 2000;

export function trackAndDispatchReadReceipt(roomId, messageId) {
  if (!roomId || !messageId) return;
  if (readReceiptsDispatched.has(messageId)) return;
  if (readReceiptsDispatched.size >= MAX_DISPATCHED_RECEIPTS) {
    const iter = readReceiptsDispatched.values();
    for (let i = 0; i < 500; i++) {
      const next = iter.next();
      if (next.done) break;
      readReceiptsDispatched.delete(next.value);
    }
  }
  readReceiptsDispatched.add(messageId);
  window.ollacoreDesktop?.chat?.markRead(roomId, messageId).catch(() => {
    // Evict on failure so retry is allowed if conversation is viewed again
    readReceiptsDispatched.delete(messageId);
  });
}

let unreadDividerDismissTimer = null;

/**
 * Dismisses the visual unread divider from the DOM and active opening state once messages are seen.
 * @param {string|null} [roomId=null]
 */
export function dismissUnreadDivider(roomId = null) {
  if (unreadDividerDismissTimer) {
    clearTimeout(unreadDividerDismissTimer);
    unreadDividerDismissTimer = null;
  }
  const currentRoomId = shellState.selectedRoomId;
  const targetRoom = roomId || currentRoomId;
  if (roomId && currentRoomId && roomId !== currentRoomId) return;

  if (activeConversationOpeningState && (!targetRoom || activeConversationOpeningState.roomId === targetRoom)) {
    activeConversationOpeningState.hasUnreadDivider = false;
    activeConversationOpeningState.unreadDividerMessageId = null;
  }

  const dividerEl = messagesList?.querySelector('.unread-messages-divider');
  if (dividerEl) {
    dividerEl.classList.add('fading-out');
    setTimeout(() => {
      if (dividerEl.parentNode) {
        dividerEl.parentNode.removeChild(dividerEl);
      }
    }, 300);
  }
}

/**
 * Schedules dismissal of the unread divider after a brief viewing delay once messages are seen.
 * @param {string|null} [roomId=null]
 * @param {number} [delayMs=1500]
 */
export function scheduleDismissUnreadDivider(roomId = null, delayMs = 1500) {
  const currentRoomId = shellState.selectedRoomId;
  const targetRoom = roomId || currentRoomId;
  if (!targetRoom || targetRoom !== currentRoomId) return;

  const dividerEl = messagesList?.querySelector('.unread-messages-divider');
  if (!dividerEl) return;

  if (unreadDividerDismissTimer) {
    clearTimeout(unreadDividerDismissTimer);
  }

  unreadDividerDismissTimer = setTimeout(() => {
    unreadDividerDismissTimer = null;
    if (shellState.selectedRoomId === targetRoom) {
      dismissUnreadDivider(targetRoom);
    }
  }, delayMs);
}

/**
 * Sends read receipts for any unread incoming messages in the currently selected room.
 * Ensures receipts are only transmitted if the conversation is actively visible.
 */
export function advanceReadCursorForActiveRoom() {
  const roomId = shellState.selectedRoomId;
  if (!roomId) return;
  if (typeof document !== 'undefined' && document.hidden) return;
  if (isMainWindowMinimized || !isMainWindowVisible) return;
  const targetState = getOrCreateRoomMessagesState(roomId);
  const currentUserId = targetState?.currentUserId || shellState.currentUser?.userId || shellState.userProfile?.userId;
  if (targetState?.messages?.length) {
    const incoming = targetState.messages.filter((m) => !isOwnMessage(m, currentUserId));
    if (incoming.length > 0) {
      for (const inc of incoming) {
        if (inc.id && inc.status !== 'read' && inc.status !== 'READ') {
          inc.status = 'read';
          inc.deliveryStatus = 'read';
          inc.delivery_status = 'read';
          trackAndDispatchReadReceipt(roomId, inc.id);
          persistMessageStatusToDb(inc.id, 'read', null, inc.eventSeq ?? inc.event_seq, roomId).catch(() => { });
        }
      }
    }
  }

  // Ensure conversation unread state is cleared when actively viewed and read
  const unread = shellState.getRoomUnreadCount?.(roomId) ?? 0;
  const isMarked = shellState._markedUnreadRooms?.has(String(roomId));
  const currentConv = shellState.conversations?.find((c) => c.roomId === roomId);
  const convHasUnread = (currentConv?.unreadCount || 0) > 0 || (currentConv?.unread_count || 0) > 0 || currentConv?.isMarkedUnread || currentConv?.is_marked_unread;
  if (unread > 0 || isMarked || convHasUnread) {
    shellState.markConversationAsRead(roomId);
    if (currentConv) {
      currentConv.isMarkedUnread = false;
      currentConv.is_marked_unread = false;
      currentConv.unreadCount = 0;
      currentConv.unread_count = 0;
    }
    updateChatFilterCounts();
    renderConversationList();
    if (currentConv) persistConversationToDb(currentConv).catch(() => { });
  }

  // Acknowledge read state in active session:
  // Persisted unread state is cleared and read receipts are dispatched,
  // but the visual unread divider is preserved for the duration of this active viewing session.
  if (activeConversationOpeningState && activeConversationOpeningState.roomId === roomId) {
    activeConversationOpeningState.isReadAcknowledged = true;
  }
  const unreadDivider = messagesList?.querySelector('.unread-messages-divider');
  // Visual unread divider remains visible throughout active viewing session; do not remove it here.
  if (unreadDivider && messagesScrollArea) {
    const distFromBottom = messagesScrollArea.scrollHeight - messagesScrollArea.scrollTop - messagesScrollArea.clientHeight;
    const isViewingBottom = distFromBottom <= 140 || messagesScrollArea.scrollHeight <= (messagesScrollArea.clientHeight + 10);
    if (isViewingBottom) {
      scheduleDismissUnreadDivider(roomId, 2000);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════
// Phase 4C: Message History Loading & Rendering
// ═══════════════════════════════════════════════════════════════════

/**
 * Synchronizes server-side read cursor for a room via GET /rooms/{roomId}/unread.
 * Updates peer read sequence, durable SQLite app_metadata, and marks all matching
 * outgoing messages as 'read' (double blue ticks).
 * @param {string} roomId
 * @param {number|null} [token=null] Optional activeLoadToken to guard against race conditions
 * @returns {Promise<number>} The effective peer read sequence
 */
export async function syncServerReadCursorForRoom(roomId, token = null) {
  if (!roomId || !window?.ollacoreDesktop?.chatApi?.getUnread) return 0;
  try {
    const unreadData = await window.ollacoreDesktop.chatApi.getUnread(roomId);
    const serverLastReadSeq = Number(unreadData?.lastReadSeq ?? unreadData?.last_read_seq ?? 0);
    if (serverLastReadSeq > 0) {
      const targetState = getOrCreateRoomMessagesState(roomId);
      const currentSeq = targetState.peerLastReadSeq || 0;
      const effectiveSeq = Math.max(currentSeq, serverLastReadSeq);
      targetState.setPeerLastReadSeq(effectiveSeq);

      if (window?.ollacoreDesktop?.db?.setMetadata) {
        await window.ollacoreDesktop.db.setMetadata('peer_read_seq:' + roomId, String(effectiveSeq)).catch(() => { });
      }

      const isCurrentSelection = shellState.selectedRoomId === roomId && (token === null || activeLoadToken === token);
      if (isCurrentSelection && targetState.messages && targetState.messages.length > 0) {
        const effectiveUserId = targetState.currentUserId || shellState.currentUser?.userId || shellState.userProfile?.userId;
        for (const m of targetState.messages) {
          const mSeq = m.eventSeq ?? m.event_seq ?? 0;
          if (mSeq > 0 && mSeq <= effectiveSeq && isOwnMessage(m, effectiveUserId)) {
            m.status = 'read';
            m.deliveryStatus = 'read';
            m.delivery_status = 'read';
            if (m.id) updateMessageStatusInDom(m.id, 'read');
            const cid = m.clientMessageId || m.client_message_id;
            if (cid) updateMessageStatusInDom(cid, 'read');
          }
        }
      }
      return effectiveSeq;
    }
  } catch (err) {
    console.warn(`[syncServerReadCursorForRoom] Failed to sync server unread cursor for ${roomId}:`, err?.message || err);
  }
  return 0;
}

/**
 * Loads messages for the selected room.
 * Rejects stale responses when user switches conversations.
 * @param {string} roomId
 */
async function loadMessagesForRoom(roomId, { forceReload = false } = {}) {
  if (!roomId || !window.ollacoreDesktop?.chatApi?.getMessages) return;

  hideFloatingDateIndicator(true);
  activeLoadToken++;
  const token = activeLoadToken;

  const targetState = getOrCreateRoomMessagesState(roomId);
  activeRoomMessagesState = targetState;

  const authUserId = shellState.currentUser?.userId || shellState.currentUser?.user_id || shellState.userProfile?.userId || shellState.userProfile?.user_id || null;
  if (authUserId && targetState.currentUserId !== authUserId) {
    targetState.setCurrentUserId(authUserId);
  }

  // Restore durable peer read cursor from SQLite app_metadata if available
  if (window?.ollacoreDesktop?.db?.getMetadata) {
    try {
      const meta = await window.ollacoreDesktop.db.getMetadata('peer_read_seq:' + roomId);
      if (meta?.value) {
        const seq = parseInt(meta.value, 10);
        if (seq > 0) {
          targetState.setPeerLastReadSeq(seq);
          if (targetState.messages.length > 0 && activeLoadToken === token && shellState.selectedRoomId === roomId) {
            renderMessages();
          }
        }
      }
    } catch (_) { }
  }

  const currentConv = shellState.conversations?.find((c) => c.roomId === roomId);
  const isExitedRoom = Boolean(currentConv?.isExited || currentConv?.exited);

  if (!isExitedRoom) {
    // Reconcile peer read cursor with OllaCore server (GET /rooms/{roomId}/unread)
    syncServerReadCursorForRoom(roomId, token).catch(() => { });

    if (currentConv?.kind === 'group') {
      ensureRoomParticipants(roomId).catch(() => { });
    }
  }

  // 1. Local-first: Always hydrate local messages from SQLite if room has not yet loaded full history or forceReload
  if (!targetState.isHistoryLoaded || forceReload) {
    try {
      let dbMsgs = await loadMessagesFromDb(roomId, { limit: 100 });
      let allDbMsgs = Array.isArray(dbMsgs) ? [...dbMsgs] : [];

      const openingTargetId = (activeConversationOpeningState && activeConversationOpeningState.roomId === roomId)
        ? activeConversationOpeningState.targetMessageId
        : null;

      // If opening with a specific targetMessageId, ensure it and surrounding history are loaded from SQLite
      if (openingTargetId) {
        const hasTargetInDb = allDbMsgs.some(m => m.id === openingTargetId || m.clientMessageId === openingTargetId || m.client_message_id === openingTargetId);
        if (!hasTargetInDb && window?.ollacoreDesktop?.db?.getMessageById) {
          try {
            const targetRow = await window.ollacoreDesktop.db.getMessageById(openingTargetId);
            if (targetRow) {
              const targetMsg = sqliteRowToMessage(targetRow);
              if (targetMsg) {
                const targetSeq = targetMsg.eventSeq ?? targetMsg.event_seq;
                let surrounding = [];
                if (typeof targetSeq === 'number' && targetSeq > 0) {
                  surrounding = await loadMessagesFromDb(roomId, {
                    limit: 50,
                    beforeSeq: targetSeq + 25
                  });
                }
                if (surrounding.length === 0) {
                  surrounding = [targetMsg];
                }
                allDbMsgs = [...surrounding, ...allDbMsgs];
              }
            }
          } catch (tErr) {
            console.warn('[loadMessagesForRoom] Failed to load target message from SQLite:', tErr);
          }
        }
      }

      // Also ensure any tracked unread messages are loaded from SQLite immediately
      if (activeConversationOpeningState && activeConversationOpeningState.roomId === roomId && activeConversationOpeningState.trackedUnreadSet?.size > 0) {
        for (const unreadId of activeConversationOpeningState.trackedUnreadSet) {
          if (!allDbMsgs.some(m => m.id === unreadId || m.clientMessageId === unreadId)) {
            if (window?.ollacoreDesktop?.db?.getMessageById) {
              try {
                const found = await window.ollacoreDesktop.db.getMessageById(unreadId);
                if (found) {
                  const norm = sqliteRowToMessage(found);
                  if (norm) {
                    allDbMsgs.push(norm);
                  }
                }
              } catch { }
            }
          }
        }
      }

      let dbBeforeSeq = null;
      if (allDbMsgs.length > 0) {
        for (const m of allDbMsgs) {
          const s = Number(m.eventSeq ?? m.event_seq);
          if (Number.isFinite(s) && (dbBeforeSeq === null || s < dbBeforeSeq)) {
            dbBeforeSeq = s;
          }
        }
      }
      let dbPaging = 0;
      while (dbMsgs && dbMsgs.length >= 100 && dbBeforeSeq !== null && dbBeforeSeq > 1 && dbPaging < 50) {
        dbPaging++;
        dbMsgs = await loadMessagesFromDb(roomId, { limit: 100, beforeSeq: dbBeforeSeq });
        if (Array.isArray(dbMsgs) && dbMsgs.length > 0) {
          allDbMsgs.unshift(...dbMsgs);
          let nextMin = null;
          for (const m of dbMsgs) {
            const s = Number(m.eventSeq ?? m.event_seq);
            if (Number.isFinite(s) && (nextMin === null || s < nextMin)) {
              nextMin = s;
            }
          }
          if (nextMin !== null && nextMin < dbBeforeSeq) {
            dbBeforeSeq = nextMin;
          } else {
            break;
          }
        } else {
          break;
        }
      }

      if (activeLoadToken === token && shellState.selectedRoomId === roomId) {
        if (allDbMsgs.length > 0) {
          const prevCount = targetState.messages.length;
          targetState.mergeServerMessages(allDbMsgs);
          if (targetState.peerLastReadSeq > 0) {
            targetState.setPeerLastReadSeq(targetState.peerLastReadSeq);
          }
          if (prevCount === 0 || targetState.messages.length !== prevCount) {
            messagesEmpty?.classList.add('hidden');
            messagesLoading?.classList.add('hidden');
            messagesError?.classList.add('hidden');
            messagesScrollArea?.classList.remove('hidden');
            renderMessages();
            if (activeConversationOpeningState?.isRestoringPosition || (roomSavedScrollPositions.has(String(roomId)) && !activeConversationOpeningState?.targetMessageId)) {
              restoreRoomScrollPosition(roomId);
              if (activeConversationOpeningState) activeConversationOpeningState.hasPositioned = true;
            } else {
              positionConversationAtLatestUnreadOrBottom(roomId);
            }
            renderPinnedBar(roomId);
          }
        }
      }
    } catch (dbErr) {
      console.warn('[loadMessagesForRoom] Failed to load local messages from SQLite:', dbErr);
    }
  }

  const hasExistingMessages = targetState.messages.length > 0;

  // Only show full loading spinner and clear message list if we STILL have NO existing messages
  if (!hasExistingMessages) {
    if (messagesList) messagesList.innerHTML = '';
    messagesEmpty?.classList.add('hidden');
    messagesError?.classList.add('hidden');
    messagesScrollArea?.classList.add('hidden');
    olderMessagesLoader?.classList.add('hidden');
    scrollBottomBtn?.classList.add('hidden');
    messagesLoading?.classList.remove('hidden');
    targetState.isLoadingInitial = true;
  }

  if (isExitedRoom) {
    targetState.isLoadingInitial = false;
    targetState.isHistoryLoaded = true;
    targetState.hasMore = false;
    messagesLoading?.classList.add('hidden');
    messagesError?.classList.add('hidden');

    if (targetState.messages.length === 0) {
      messagesEmpty?.classList.remove('hidden');
      messagesScrollArea?.classList.add('hidden');
    } else {
      messagesEmpty?.classList.add('hidden');
      messagesScrollArea?.classList.remove('hidden');
      renderMessages();
      if (activeConversationOpeningState && activeConversationOpeningState.roomId === roomId && !activeConversationOpeningState.hasPositioned) {
        if (activeConversationOpeningState.isRestoringPosition || (roomSavedScrollPositions.has(String(roomId)) && !activeConversationOpeningState.targetMessageId)) {
          restoreRoomScrollPosition(roomId);
          activeConversationOpeningState.hasPositioned = true;
        } else {
          positionConversationAtLatestUnreadOrBottom(roomId);
        }
      }
      renderPinnedBar(roomId);
    }
    return;
  }

  try {
    // If room is already fully loaded from the beginning (and not forcing reload), catch up newer messages
    if (targetState.isHistoryLoaded && !forceReload && targetState.newestSeq) {
      const res = await window.ollacoreDesktop.chatApi.getMessages(roomId, {
        limit: 50,
        afterSeq: targetState.newestSeq
      });

      if (activeLoadToken !== token || shellState.selectedRoomId !== roomId) {
        return;
      }

      const newMsgs = Array.isArray(res?.messages) ? res.messages : (Array.isArray(res) ? res : []);
      if (newMsgs.length > 0) {
        targetState.mergeServerMessages(newMsgs);
        persistMessagesToDb(newMsgs, roomId).catch(() => { });
        const wasNearBottom = messagesScrollArea ? ((messagesScrollArea.scrollHeight - messagesScrollArea.scrollTop - messagesScrollArea.clientHeight) < 120) : false;
        renderMessages();
        if (activeConversationOpeningState?.isRestoringPosition || (roomSavedScrollPositions.has(String(roomId)) && !activeConversationOpeningState?.targetMessageId)) {
          restoreRoomScrollPosition(roomId);
        } else if (wasNearBottom) {
          scrollToBottom(false);
        } else {
          positionConversationAtLatestUnreadOrBottom(roomId);
        }
      }
    } else {
      // Room has not loaded full history or forced reload: Paginate complete available history from server!
      const conv = shellState.conversations.find((c) => c.roomId === roomId);
      const lastSeq = conv?.lastMessage?.eventSeq || conv?.lastMessage?.event_seq;
      let currentBeforeSeq = (typeof lastSeq === 'number' && lastSeq > 2147483647) ? (lastSeq + 1000) : 2147483647;

      let hasMorePages = true;
      let pageCount = 0;
      const MAX_PAGES = 50; // Safety cap (up to 2,500 messages)
      let loadFailed = false;

      while (hasMorePages && pageCount < MAX_PAGES) {
        pageCount++;
        let res;
        try {
          res = await window.ollacoreDesktop.chatApi.getMessages(roomId, {
            limit: 50,
            beforeSeq: currentBeforeSeq
          });
        } catch (pageErr) {
          loadFailed = true;
          throw pageErr;
        }

        // Stale response guard: ignore if token changed or user selected a different room
        if (activeLoadToken !== token || shellState.selectedRoomId !== roomId) {
          return;
        }

        const messages = Array.isArray(res?.messages) ? res.messages : (Array.isArray(res) ? res : []);
        const serverHasMore = (typeof (res?.hasMore ?? res?.has_more) === 'boolean')
          ? Boolean(res?.hasMore ?? res?.has_more)
          : (messages.length >= 50);

        if (messages.length > 0) {
          targetState.mergeServerMessages(messages, serverHasMore);
          const reconciledForDb = targetState.messages.filter((m) =>
            messages.some((sm) => (sm.id && sm.id === m.id) || (sm.client_message_id && sm.client_message_id === m.clientMessageId))
          );
          persistMessagesToDb(reconciledForDb.length > 0 ? reconciledForDb : messages, roomId).catch(() => { });

          // Render the first page if messages were not yet rendered, so the user sees content immediately.
          // For multi-page history loading, batch intermediate pages in memory to eliminate message flickering,
          // performing the coordinated final render when pagination completes.
          const isInitialFirstPage = !hasExistingMessages && pageCount === 1;
          if (isInitialFirstPage && activeLoadToken === token && shellState.selectedRoomId === roomId) {
            messagesLoading?.classList.add('hidden');
            messagesEmpty?.classList.add('hidden');
            messagesScrollArea?.classList.remove('hidden');

            renderMessages();

            if (activeConversationOpeningState?.isRestoringPosition || (roomSavedScrollPositions.has(String(roomId)) && !activeConversationOpeningState?.targetMessageId)) {
              restoreRoomScrollPosition(roomId);
              if (activeConversationOpeningState) activeConversationOpeningState.hasPositioned = true;
            } else {
              positionConversationAtLatestUnreadOrBottom(roomId);
            }
          }

          let minSeq = null;
          for (const m of messages) {
            const s = Number(m.eventSeq ?? m.event_seq);
            if (Number.isFinite(s) && (minSeq === null || s < minSeq)) {
              minSeq = s;
            }
          }

          if (serverHasMore && minSeq !== null && minSeq > 1) {
            if (minSeq < currentBeforeSeq) {
              currentBeforeSeq = minSeq;
            } else {
              hasMorePages = false;
            }
          } else {
            hasMorePages = false;
          }
        } else {
          hasMorePages = false;
        }

        if (!serverHasMore) {
          hasMorePages = false;
        }
      }

      if (!loadFailed) {
        targetState.isHistoryLoaded = true;
        targetState.hasMore = false;
      }
    }

    targetState.isLoadingInitial = false;
    messagesLoading?.classList.add('hidden');

    if (targetState.messages.length === 0) {
      messagesEmpty?.classList.remove('hidden');
      messagesScrollArea?.classList.add('hidden');
    } else {
      // Case 4: If an unread target message was tracked but is not yet loaded in messages,
      // load the specific message from SQLite without loading entire history
      if (activeConversationOpeningState && activeConversationOpeningState.roomId === roomId && activeConversationOpeningState.trackedUnreadSet?.size > 0) {
        for (const unreadId of activeConversationOpeningState.trackedUnreadSet) {
          if (!targetState.messages.some(m => m.id === unreadId || m.clientMessageId === unreadId)) {
            if (window?.ollacoreDesktop?.db?.getMessageById) {
              try {
                const found = await window.ollacoreDesktop.db.getMessageById(unreadId);
                if (found) {
                  const norm = sqliteRowToMessage(found);
                  if (norm) {
                    targetState.mergeServerMessages([norm]);
                  }
                }
              } catch { }
            }
          }
        }
      }

      messagesEmpty?.classList.add('hidden');
      messagesScrollArea?.classList.remove('hidden');
      if (activeConversationOpeningState && activeConversationOpeningState.roomId === roomId && !activeConversationOpeningState.hasPositioned) {
        renderMessages();
        if (activeConversationOpeningState.isRestoringPosition || (roomSavedScrollPositions.has(String(roomId)) && !activeConversationOpeningState.targetMessageId)) {
          restoreRoomScrollPosition(roomId);
          activeConversationOpeningState.hasPositioned = true;
        } else {
          positionConversationAtLatestUnreadOrBottom(roomId);
        }
      } else {
        const prevH = messagesScrollArea ? messagesScrollArea.scrollHeight : 0;
        const prevT = messagesScrollArea ? messagesScrollArea.scrollTop : 0;
        const distFromBottom = prevH - prevT - (messagesScrollArea?.clientHeight || 0);
        const wasAtBottom = distFromBottom <= 140 || prevH <= ((messagesScrollArea?.clientHeight || 0) + 5);

        renderMessages();
        const targetId = activeConversationOpeningState?.targetMessageId;
        const targetEl = targetId ? findMessageDomElement(targetId) : null;
        if (targetEl) {
          targetEl.scrollIntoView({ behavior: 'auto', block: 'center' });
        } else if (activeConversationOpeningState?.isRestoringPosition || (roomSavedScrollPositions.has(String(roomId)) && !targetId)) {
          restoreRoomScrollPosition(roomId);
        } else if (wasAtBottom) {
          scrollToBottom(false);
          requestAnimationFrame(() => {
            if (shellState.selectedRoomId === roomId && messagesScrollArea) {
              messagesScrollArea.scrollTop = messagesScrollArea.scrollHeight;
              scrollBottomBtn?.classList.add('hidden');
            }
          });
        } else if (messagesScrollArea && prevH > 0) {
          messagesScrollArea.scrollTop = messagesScrollArea.scrollHeight - prevH + prevT;
        } else {
          positionConversationAtLatestUnreadOrBottom(roomId);
        }
      }
      renderPinnedBar(roomId);

      // Send delivery and read receipts according to reference implementation
      const currentUserId = targetState.currentUserId || shellState.currentUser?.userId || shellState.userProfile?.userId;
      const incoming = targetState.messages.filter(
        (m) => !isOwnMessage(m, currentUserId)
      );
      if (incoming.length > 0) {
        for (const inc of incoming) {
          if (inc.id) {
            window.ollacoreDesktop?.chat?.markDelivered(roomId, inc.id).catch(() => { });
          }
        }
        const isVisibleToUser = typeof document === 'undefined' || (!document.hidden && !isMainWindowMinimized && isMainWindowVisible);
        if (isVisibleToUser) {
          for (const inc of incoming) {
            if (inc.id && inc.status !== 'read' && inc.status !== 'READ') {
              trackAndDispatchReadReceipt(roomId, inc.id);
            }
          }
          advanceReadCursorForActiveRoom();
        }
      }
    }
  } catch (err) {
    if (activeLoadToken !== token || shellState.selectedRoomId !== roomId) {
      return;
    }

    const isForbiddenActiveMember = err?.httpStatus === 403 || String(err?.message || '').toLowerCase().includes('not an active member');
    if (isForbiddenActiveMember && currentConv) {
      currentConv.isExited = true;
      currentConv.exited = true;
      persistConversationToDb(currentConv).catch(() => { });
      updateExitedGroupUI(currentConv);
      targetState.isLoadingInitial = false;
      targetState.isHistoryLoaded = true;
      targetState.hasMore = false;
      messagesLoading?.classList.add('hidden');
      messagesError?.classList.add('hidden');
      if (targetState.messages.length === 0) {
        messagesEmpty?.classList.remove('hidden');
        messagesScrollArea?.classList.add('hidden');
      } else {
        messagesEmpty?.classList.add('hidden');
        messagesScrollArea?.classList.remove('hidden');
        renderMessages();
        renderPinnedBar(roomId);
      }
      return;
    }

    targetState.isLoadingInitial = false;
    messagesLoading?.classList.add('hidden');
    if (targetState.messages.length === 0) {
      messagesScrollArea?.classList.add('hidden');
      messagesEmpty?.classList.add('hidden');
      if (messagesErrorText) {
        messagesErrorText.textContent = err.message || 'Failed to load messages';
      }
      messagesError?.classList.remove('hidden');
    } else {
      targetState.hasMore = true;
      targetState.isHistoryLoaded = false;
    }
  }
}

/**
 * Safely creates a message bubble DOM node using DOM methods (never raw innerHTML).
 * @param {object} message
 * @returns {HTMLElement}
 */

/**
 * Safely opens an external URL using the secure Electron bridge.
 * Validates protocol (only http: and https: are permitted).
 * @param {string} rawUrl
 */
export function openExternalUrlSafely(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return;
  let targetUrl = rawUrl.trim();
  if (/^www\./i.test(targetUrl)) {
    targetUrl = 'https://' + targetUrl;
  }
  if (!/^https?:\/\//i.test(targetUrl)) {
    console.warn('[openExternalUrlSafely] Blocked non-http(s) URL:', rawUrl);
    return;
  }
  try {
    const parsed = new URL(targetUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      console.warn('[openExternalUrlSafely] Blocked forbidden protocol:', parsed.protocol);
      return;
    }
  } catch (err) {
    console.warn('[openExternalUrlSafely] Malformed URL:', err);
    return;
  }

  if (window.ollacoreDesktop?.shell?.openExternal) {
    window.ollacoreDesktop.shell.openExternal(targetUrl).catch((err) => {
      console.warn('[openExternalUrlSafely] shell.openExternal failed:', err);
      try { window.open(targetUrl, '_blank', 'noopener,noreferrer'); } catch (_) { }
    });
  } else {
    try { window.open(targetUrl, '_blank', 'noopener,noreferrer'); } catch (_) { }
  }
}

/**
 * Safely renders message text with detected URLs converted to clickable anchors.
 * Uses createElement and createTextNode exclusively — zero raw innerHTML risk.
 * @param {HTMLElement} container
 * @param {string} text
 */
export function renderFormattedMessageText(container, text) {
  if (!container) return;
  container.innerHTML = '';
  const tokens = parseTextWithUrls(text);
  if (tokens.length === 0) {
    container.textContent = text || '';
    return;
  }
  for (const tok of tokens) {
    if (tok.type === 'link') {
      const a = document.createElement('a');
      a.className = 'chat-inline-link';
      a.href = tok.href;
      a.textContent = tok.text;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.title = tok.href;
      a.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        openExternalUrlSafely(tok.href);
      });
      container.appendChild(a);
    } else {
      container.appendChild(document.createTextNode(tok.text));
    }
  }
}

// ═══════════════════════════════════════════════════════════════════
// GROUP PARTICIPANT SENDER RESOLUTION & CACHING
// ═══════════════════════════════════════════════════════════════════

const inFlightParticipantsRequests = new Map(); // roomId -> Promise

/**
 * Resolves a human-readable display name for any message sender,
 * especially in group chats. Never displays internal UUIDs or principal IDs.
 * @param {object} message
 * @param {string|null} [roomId=null]
 * @returns {string}
 */
export function resolveSenderNameForMessage(message, roomId = null) {
  if (!message || typeof message !== 'object') return 'Contact';
  const effectiveRoomId = roomId || message.roomId || message.room_id || shellState?.selectedRoomId;
  const currentUserId = activeRoomMessagesState?.currentUserId || shellState?.currentUser?.userId || shellState?.userProfile?.userId;
  const roomParticipants = effectiveRoomId ? shellState?.getRoomParticipants(effectiveRoomId) : null;

  return resolveGroupSenderName(message, currentUserId, {
    roomId: effectiveRoomId,
    roomParticipants,
    getContactNicknameFn: (id) => shellState?.getContactNickname(id),
    conversations: shellState?.conversations,
    globalParticipantsCache: shellState?.participantProfiles
  });
}

/**
 * Ensures room participants are fetched from server/cache and updates rendered sender labels.
 * Deduplicates in-flight network requests.
 * @param {string} roomId
 * @returns {Promise<Array<object>>}
 */
export async function ensureRoomParticipants(roomId, { force = false } = {}) {
  if (!roomId || !window.ollacoreDesktop?.chatApi?.getParticipants) return [];
  const cleanRoomId = String(roomId).trim();

  if (force) {
    shellState?.roomParticipants?.delete(cleanRoomId);
    inFlightParticipantsRequests.delete(cleanRoomId);
  } else {
    // If already in memory with participants, return them
    const existing = shellState?.getRoomParticipants(cleanRoomId);
    if (existing && existing.size > 0) {
      return Array.from(existing.values());
    }

    if (inFlightParticipantsRequests.has(cleanRoomId)) {
      return inFlightParticipantsRequests.get(cleanRoomId);
    }
  }

  const fetchPromise = (async () => {
    try {
      const res = await window.ollacoreDesktop.chatApi.getParticipants(cleanRoomId);
      const list = Array.isArray(res?.participants)
        ? res.participants
        : (Array.isArray(res?.data?.participants) ? res.data.participants : []);

      if (shellState) {
        shellState.setRoomParticipants(cleanRoomId, list);
      }

      // If this room is currently selected in the UI, update any message-sender elements in the DOM
      if (shellState?.selectedRoomId === cleanRoomId) {
        updateRenderedGroupSenderNames(cleanRoomId);
      }

      return list;
    } catch (err) {
      console.warn('[ensureRoomParticipants] Failed to fetch participants for room:', cleanRoomId, err);
      return [];
    } finally {
      inFlightParticipantsRequests.delete(cleanRoomId);
    }
  })();

  inFlightParticipantsRequests.set(cleanRoomId, fetchPromise);
  return fetchPromise;
}

/**
 * Dynamically updates rendered sender labels and reply headers in the active chat view.
 * @param {string} roomId
 */
export function updateRenderedGroupSenderNames(roomId) {
  if (!messagesList) return;
  const targetRoomId = roomId || shellState?.selectedRoomId;
  if (!targetRoomId) return;

  const senderElements = messagesList.querySelectorAll('.message-sender[data-sender-id]');
  senderElements.forEach((el) => {
    const senderId = el.getAttribute('data-sender-id');
    if (!senderId) return;
    const resolvedName = resolveSenderNameForMessage({ senderId, sender_id: senderId, roomId: targetRoomId }, targetRoomId);
    if (resolvedName && resolvedName !== 'Contact' && el.textContent !== resolvedName) {
      el.textContent = resolvedName;
      el.style.color = getAvatarColor(resolvedName);
    }
  });

  const replySenders = messagesList.querySelectorAll('.message-reply-preview-name');
  replySenders.forEach((el) => {
    const parentPreview = el.closest('.message-reply-preview');
    const replyToId = parentPreview?.getAttribute('data-reply-to');
    if (!replyToId) return;
    const originalMsg = resolveOriginalMessage(replyToId, targetRoomId);
    if (originalMsg) {
      const currentUserId = activeRoomMessagesState?.currentUserId || shellState?.currentUser?.userId;
      const resolvedName = getReplySenderName(
        originalMsg,
        currentUserId,
        (uid, rId) => resolveSenderNameForMessage({ senderId: uid, roomId: rId || targetRoomId }),
        {
          roomId: targetRoomId,
          roomParticipants: shellState?.getRoomParticipants(targetRoomId),
          conversations: shellState?.conversations,
          globalParticipantsCache: shellState?.participantProfiles
        }
      );
      if (resolvedName && resolvedName !== 'Contact' && el.textContent !== resolvedName) {
        el.textContent = resolvedName;
      }
    }
  });
}

// ═══════════════════════════════════════════════════════════════════
// MESSAGE REPLY PREVIEW & NAVIGATION (WHATSAPP STYLE)
// ═══════════════════════════════════════════════════════════════════

const replyOriginalMessagesCache = new Map();

/**
 * Resolves original message object for a reply reference synchronously if present in memory.
 * Checks local cache, active room state, and all room messages states.
 * @param {string} replyToId
 * @param {string|null} [roomId=null]
 * @returns {object|null}
 */
function resolveOriginalMessage(replyToId, roomId = null) {
  if (!replyToId) return null;
  const replyKey = String(replyToId);
  if (replyOriginalMessagesCache.has(replyKey)) {
    return replyOriginalMessagesCache.get(replyKey);
  }
  const currentRState = activeRoomMessagesState || roomMessagesState;
  if (currentRState?.messages) {
    const found = currentRState.messages.find((m) =>
      (m.id && String(m.id) === replyKey) ||
      (m.clientMessageId && String(m.clientMessageId) === replyKey) ||
      (m.client_message_id && String(m.client_message_id) === replyKey)
    );
    if (found) {
      replyOriginalMessagesCache.set(replyKey, found);
      if (found.id) replyOriginalMessagesCache.set(String(found.id), found);
      const cid = found.clientMessageId || found.client_message_id;
      if (cid) replyOriginalMessagesCache.set(String(cid), found);
      return found;
    }
  }
  const targetRoomId = roomId || shellState.selectedRoomId;
  if (targetRoomId && roomMessagesMap.has(targetRoomId)) {
    const rState = roomMessagesMap.get(targetRoomId);
    if (rState?.messages) {
      const found = rState.messages.find((m) =>
        (m.id && String(m.id) === replyKey) ||
        (m.clientMessageId && String(m.clientMessageId) === replyKey) ||
        (m.client_message_id && String(m.client_message_id) === replyKey)
      );
      if (found) {
        replyOriginalMessagesCache.set(replyKey, found);
        if (found.id) replyOriginalMessagesCache.set(String(found.id), found);
        const cid = found.clientMessageId || found.client_message_id;
        if (cid) replyOriginalMessagesCache.set(String(cid), found);
        return found;
      }
    }
  }
  return null;
}

/**
 * Asynchronously populates reply preview text and sender for messages not immediately in memory.
 * Hierarchy:
 * 1. Currently loaded messages / cache
 * 2. ChatShellState / RoomMessagesState
 * 3. SQLite persisted messages (direct query by ID, then recent batch)
 * 4. OllaCore message history API if not in SQLite
 *
 * If found in SQLite/history: merges into state without duplicates, updates cache, and renders preview.
 * Distinguishes deleted-for-everyone ("This message was deleted") vs deleted-for-me ("Message unavailable")
 * vs genuinely not found ("Message unavailable").
 *
 * @param {string} replyToId
 * @param {string} roomId
 * @param {HTMLElement|null} nameSpan
 * @param {HTMLElement|null} textEl
 * @param {string|null} currentUserId
 */
async function fetchAndPopulateReplyPreview(replyToId, roomId, nameSpan, textEl, currentUserId) {
  if (!replyToId) return;
  const replyKey = String(replyToId);
  const targetRoomId = roomId || shellState.selectedRoomId;
  if (!targetRoomId) return;

  // 1. Check synchronous cache and in-memory room states
  let found = resolveOriginalMessage(replyKey, targetRoomId);

  // 2. Check SQLite persistent database directly by ID / client_message_id
  if (!found) {
    try {
      found = await loadMessageByIdFromDb(replyKey, targetRoomId);
    } catch (err) {
      console.warn('[fetchAndPopulateReplyPreview] SQLite getMessageById error:', err);
    }
  }

  // 2b. Check SQLite batch load as fallback if not matched by single ID
  if (!found) {
    try {
      const dbMsgs = await loadMessagesFromDb(targetRoomId, { limit: 100 });
      found = dbMsgs.find((m) =>
        (m.id && String(m.id) === replyKey) ||
        (m.clientMessageId && String(m.clientMessageId) === replyKey) ||
        (m.client_message_id && String(m.client_message_id) === replyKey)
      );
    } catch (err) {
      console.warn('[fetchAndPopulateReplyPreview] SQLite batch check error:', err);
    }
  }

  // 3. Fetch from OllaCore history API if not in SQLite
  if (!found && window.ollacoreDesktop?.chatApi?.getMessages) {
    try {
      const res = await window.ollacoreDesktop.chatApi.getMessages(targetRoomId, { limit: 50 });
      const apiMessages = Array.isArray(res?.messages) ? res.messages : (Array.isArray(res) ? res : []);
      if (apiMessages.length > 0) {
        // Persist fetched messages to SQLite in the background
        const currentRState = activeRoomMessagesState || roomMessagesState;
        const reconciledForDb = apiMessages.map((m) => {
          const id = m.id;
          const cid = m.clientMessageId || m.client_message_id;
          const knownStatus = (id && currentRState ? currentRState.getStatus(id) : null) || (cid && currentRState ? currentRState.getStatus(cid) : null);
          if (knownStatus) {
            const higher = getHighestStatus(knownStatus, m.deliveryStatus, m.delivery_status, m.status) || knownStatus;
            return { ...m, status: higher, deliveryStatus: higher, delivery_status: higher };
          }
          return m;
        });
        persistMessagesToDb(reconciledForDb, targetRoomId).catch(() => { });

        found = apiMessages.find((m) =>
          (m.id && String(m.id) === replyKey) ||
          (m.clientMessageId && String(m.clientMessageId) === replyKey) ||
          (m.client_message_id && String(m.client_message_id) === replyKey)
        );

        if (found && currentRState && currentRState.roomId === targetRoomId) {
          currentRState.mergeServerMessages([found]);
        }
      }
    } catch (err) {
      console.warn('[fetchAndPopulateReplyPreview] OllaCore chatApi lookup error:', err);
    }
  }

  // If found in any tier (memory, SQLite, OllaCore):
  if (found) {
    replyOriginalMessagesCache.set(replyKey, found);
    if (found.id) replyOriginalMessagesCache.set(String(found.id), found);
    const cid = found.clientMessageId || found.client_message_id;
    if (cid) replyOriginalMessagesCache.set(String(cid), found);

    // Merge into room state without duplicates to allow seamless jumping
    const currentRState = activeRoomMessagesState || roomMessagesState;
    if (currentRState && currentRState.roomId === targetRoomId) {
      const alreadyHas = currentRState.messages.some((m) =>
        (m.id && String(m.id) === replyKey) ||
        (m.clientMessageId && String(m.clientMessageId) === replyKey) ||
        (m.client_message_id && String(m.client_message_id) === replyKey)
      );
      if (!alreadyHas) {
        currentRState.mergeServerMessages([found]);
      }
    }

    if (nameSpan) {
      nameSpan.textContent = getReplySenderName(
        found,
        currentUserId,
        (uid, rId) => resolveSenderNameForMessage({ senderId: uid, roomId: rId || targetRoomId }),
        {
          roomId: targetRoomId,
          roomParticipants: shellState?.getRoomParticipants(targetRoomId),
          conversations: shellState?.conversations,
          globalParticipantsCache: shellState?.participantProfiles
        }
      );
    }

    if (textEl) {
      const isDeletedForEveryone = Boolean(
        found.isDeleted ||
        found.kind === 'deleted' ||
        resolveMessageContent(found).isDeleted
      );
      const isDeletedForMeOnly = Boolean(found.isDeletedForMe && !isDeletedForEveryone);

      if (isDeletedForEveryone) {
        textEl.textContent = 'This message was deleted';
        textEl.classList.add('is-deleted');
      } else if (isDeletedForMeOnly) {
        textEl.textContent = 'Message unavailable';
        textEl.classList.add('is-deleted');
      } else {
        textEl.textContent = formatReplyPreview(found);
        textEl.classList.remove('is-deleted');
      }
    }
    return;
  }

  // Only if original message genuinely cannot be found after all lookup tiers
  if (nameSpan) nameSpan.textContent = 'Reply';
  if (textEl) {
    textEl.textContent = 'Message unavailable';
    textEl.classList.add('is-deleted');
  }
}

/**
 * Navigates to and highlights the original quoted message when clicked.
 * Smoothly scrolls into view, centers it, and pulses a highlight.
 * Hierarchy:
 * 1. Check rendered DOM element
 * 2. Check in-memory RoomMessagesState
 * 3. Check SQLite local database
 * 4. Paginate / fetch from OllaCore history API
 *
 * Merges loaded message into state without duplicates, renders, scrolls, and highlights.
 * @param {string} replyToId
 * @param {string|null} [roomId=null]
 */
async function jumpToOriginalMessage(replyToId, roomId = null) {
  if (!replyToId) return;
  const replyKey = String(replyToId);
  const targetRoomId = roomId || shellState.selectedRoomId;
  if (!targetRoomId) return;

  if (shellState.selectedRoomId !== targetRoomId) {
    await selectConversation(targetRoomId);
  }

  const currentRState = activeRoomMessagesState || roomMessagesState;

  // 1. Check if original message row is already rendered in DOM
  let row = messagesList?.querySelector(`.message-row[data-message-id="${replyKey}"]`)
    || messagesList?.querySelector(`.message-row[data-client-message-id="${replyKey}"]`);

  // 2. Check in memory room messages
  if (!row && currentRState?.messages) {
    const inMemory = currentRState.messages.find((m) =>
      (m.id && String(m.id) === replyKey) ||
      (m.clientMessageId && String(m.clientMessageId) === replyKey) ||
      (m.client_message_id && String(m.client_message_id) === replyKey)
    );
    if (inMemory) {
      renderMessages();
      row = messagesList?.querySelector(`.message-row[data-message-id="${replyKey}"]`)
        || messagesList?.querySelector(`.message-row[data-client-message-id="${replyKey}"]`);
    }
  }

  // 3. Check SQLite local database directly by ID
  if (!row) {
    try {
      const foundInDb = await loadMessageByIdFromDb(replyKey, targetRoomId);
      if (foundInDb && currentRState) {
        currentRState.mergeServerMessages([foundInDb]);
        renderMessages();
        row = messagesList?.querySelector(`.message-row[data-message-id="${replyKey}"]`)
          || messagesList?.querySelector(`.message-row[data-client-message-id="${replyKey}"]`);
      }
    } catch (err) {
      console.warn('[jumpToOriginalMessage] SQLite lookup error:', err);
    }
  }

  // 3b. Check SQLite batch if not matched
  if (!row) {
    try {
      const dbMsgs = await loadMessagesFromDb(targetRoomId, { limit: 100 });
      const foundInDb = dbMsgs.find((m) =>
        (m.id && String(m.id) === replyKey) ||
        (m.clientMessageId && String(m.clientMessageId) === replyKey) ||
        (m.client_message_id && String(m.client_message_id) === replyKey)
      );
      if (foundInDb && currentRState) {
        currentRState.mergeServerMessages([foundInDb]);
        renderMessages();
        row = messagesList?.querySelector(`.message-row[data-message-id="${replyKey}"]`)
          || messagesList?.querySelector(`.message-row[data-client-message-id="${replyKey}"]`);
      }
    } catch (err) {
      console.warn('[jumpToOriginalMessage] SQLite batch lookup error:', err);
    }
  }

  // 4. If outside loaded window, paginate older messages using loadOlderMessages()
  let paginationAttempts = 0;
  while (!row && currentRState?.hasMore && paginationAttempts < 5) {
    paginationAttempts++;
    await loadOlderMessages();
    row = messagesList?.querySelector(`.message-row[data-message-id="${replyKey}"]`)
      || messagesList?.querySelector(`.message-row[data-client-message-id="${replyKey}"]`);
  }

  // 5. If still not in loaded list, fetch from OllaCore history API
  if (!row && window.ollacoreDesktop?.chatApi?.getMessages) {
    try {
      const res = await window.ollacoreDesktop.chatApi.getMessages(targetRoomId, { limit: 50 });
      const apiMessages = Array.isArray(res?.messages) ? res.messages : (Array.isArray(res) ? res : []);
      if (apiMessages.length > 0) {
        const reconciledForDb = apiMessages.map((m) => {
          const id = m.id;
          const cid = m.clientMessageId || m.client_message_id;
          const knownStatus = (id && currentRState ? currentRState.getStatus(id) : null) || (cid && currentRState ? currentRState.getStatus(cid) : null);
          if (knownStatus) {
            const higher = getHighestStatus(knownStatus, m.deliveryStatus, m.delivery_status, m.status) || knownStatus;
            return { ...m, status: higher, deliveryStatus: higher, delivery_status: higher };
          }
          return m;
        });
        persistMessagesToDb(reconciledForDb, targetRoomId).catch(() => { });
        currentRState?.mergeServerMessages(apiMessages);
        renderMessages();
        row = messagesList?.querySelector(`.message-row[data-message-id="${replyKey}"]`)
          || messagesList?.querySelector(`.message-row[data-client-message-id="${replyKey}"]`);
      }
    } catch (err) {
      console.warn('[jumpToOriginalMessage] OllaCore chatApi lookup error:', err);
    }
  }

  // 6. Scroll smoothly and highlight
  if (row) {
    messagesList?.querySelectorAll('.message-row.highlighted').forEach((r) => r.classList.remove('highlighted'));
    row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    row.classList.add('highlighted');
    setTimeout(() => {
      row.classList.remove('highlighted');
    }, 2000);
  }
}

let activeReactionPicker = null;

export function closeReactionPicker() {
  if (activeReactionPicker) {
    activeReactionPicker.remove();
    activeReactionPicker = null;
  }
}

export function openReactionPicker(e, message, anchorEl) {
  closeReactionPicker();
  closeContextMenu();

  if (!message) return;

  const picker = document.createElement('div');
  picker.className = 'message-reaction-picker';
  picker.setAttribute('role', 'toolbar');
  picker.setAttribute('aria-label', 'Reactions');

  const currentUserId = roomMessagesState.currentUserId || shellState.currentUser?.userId || shellState.userProfile?.userId;
  const userReactions = message.reactions || {};

  REACTION_EMOJIS.forEach((emoji) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'reaction-picker-btn';
    btn.textContent = emoji;
    const hasMyReaction = currentUserId && Array.isArray(userReactions[emoji]) && userReactions[emoji].includes(currentUserId);
    if (hasMyReaction) {
      btn.classList.add('active');
    }
    btn.setAttribute('aria-label', `React with ${emoji}`);
    btn.title = `React with ${emoji}`;
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      closeReactionPicker();
      handleToggleReaction(message, emoji);
    });
    picker.appendChild(btn);
  });

  document.body.appendChild(picker);
  activeReactionPicker = picker;

  // Position above the anchorEl or event coordinates
  const rect = anchorEl ? anchorEl.getBoundingClientRect() : { left: e.clientX, top: e.clientY, width: 0, height: 0, bottom: e.clientY };
  const pickerWidth = picker.offsetWidth || 230;
  const pickerHeight = picker.offsetHeight || 44;

  let left = rect.left + (rect.width / 2) - (pickerWidth / 2);
  let top = rect.top - pickerHeight - 8;

  // Keep within viewport bounds
  if (left < 10) left = 10;
  if (left + pickerWidth > window.innerWidth - 10) {
    left = window.innerWidth - pickerWidth - 10;
  }
  if (top < 10) {
    top = (rect.bottom || rect.top) + 8; // flip below if not enough room above
  }

  picker.style.left = `${left}px`;
  picker.style.top = `${top}px`;

  // Focus the first button for keyboard accessibility
  const firstBtn = picker.querySelector('button');
  firstBtn?.focus();

  // Keyboard navigation within picker
  picker.addEventListener('keydown', (ev) => {
    const buttons = Array.from(picker.querySelectorAll('button'));
    const idx = buttons.indexOf(document.activeElement);
    if (ev.key === 'ArrowRight') {
      ev.preventDefault();
      const nextIdx = (idx + 1) % buttons.length;
      buttons[nextIdx]?.focus();
    } else if (ev.key === 'ArrowLeft') {
      ev.preventDefault();
      const prevIdx = (idx - 1 + buttons.length) % buttons.length;
      buttons[prevIdx]?.focus();
    } else if (ev.key === 'Escape') {
      ev.preventDefault();
      closeReactionPicker();
    }
  });
}

export async function handleToggleReaction(message, emoji) {
  if (!message || !emoji) return;
  const currentUserId = roomMessagesState.currentUserId || shellState.currentUser?.userId || shellState.userProfile?.userId;
  if (!currentUserId) return;

  const roomId = message.roomId || message.room_id || shellState.selectedRoomId;
  const mid = message.id || message.clientMessageId || message.client_message_id;
  if (!mid) return;

  const existingUsers = (message.reactions && Array.isArray(message.reactions[emoji])) ? message.reactions[emoji] : [];
  const isAdd = !existingUsers.includes(currentUserId);

  // 1. Optimistic update in in-memory state
  roomMessagesState.updateReaction(mid, currentUserId, emoji, isAdd);
  renderMessages();

  // 2. Persist to local SQLite
  if (roomId) {
    persistReactionToDb(roomId, mid, currentUserId, emoji, isAdd).catch((err) => {
      console.warn('[reactions] DB persist error:', err);
    });
  }

  // 3. Dispatch to server via IPC bridge
  try {
    const chat = window.ollacoreDesktop?.chat;
    if (isAdd) {
      if (chat?.addReaction) {
        await chat.addReaction({ roomId, messageId: mid, emoji });
      }
    } else {
      if (chat?.removeReaction) {
        await chat.removeReaction({ roomId, messageId: mid, emoji });
      }
    }
  } catch (err) {
    console.error('[reactions] Failed to update reaction on server:', err);
    // Roll back optimistic state on error
    roomMessagesState.updateReaction(mid, currentUserId, emoji, !isAdd);
    renderMessages();
    if (roomId) {
      persistReactionToDb(roomId, mid, currentUserId, emoji, !isAdd).catch(() => { });
    }
    if (typeof showUserError === 'function') {
      showUserError('Failed to update reaction.');
    }
  }
}

function createMessageBubbleElement(message) {
  const isSystem = message?.kind === 'system' || message?.type === 'system';
  if (isSystem) {
    const row = document.createElement('div');
    row.className = 'message-row system-message-row';
    if (message.id) row.setAttribute('data-message-id', message.id);
    const cid = message.clientMessageId || message.client_message_id;
    if (cid) row.setAttribute('data-client-message-id', cid);
    const seq = message.eventSeq ?? message.event_seq;
    if (typeof seq === 'number' && Number.isFinite(seq) && seq > 0) row.setAttribute('data-seq', String(seq));

    const pill = document.createElement('div');
    pill.className = 'system-message-pill';
    const resolved = resolveMessageContent(message);
    const text = (resolved?.text) || (message.body && typeof message.body === 'object' && message.body.text)
      ? (resolved?.text || message.body.text)
      : (message.text || (typeof message.body === 'string' ? message.body : '') || message.content || '');
    pill.textContent = text;
    row.appendChild(pill);
    return row;
  }

  const currentUserId = roomMessagesState.currentUserId || shellState.currentUser?.userId || shellState.userProfile?.userId;
  const isOwn = isOwnMessage(message, currentUserId);
  const row = document.createElement('div');
  row.className = `message-row ${isOwn ? 'outgoing' : 'incoming'}`;
  if (message.id) row.setAttribute('data-message-id', message.id);
  const cid = message.clientMessageId || message.client_message_id;
  if (cid) row.setAttribute('data-client-message-id', cid);
  const seq = message.eventSeq ?? message.event_seq;
  if (typeof seq === 'number' && Number.isFinite(seq) && seq > 0) row.setAttribute('data-seq', String(seq));

  const bubble = document.createElement('div');
  bubble.className = 'message-bubble';

  const resolved = resolveMessageContent(message);
  const isCall = Boolean(resolved.isCallEntry || resolved.kind === 'call');

  // Message selection mode state and checkbox
  const msgKey = message.id || cid;
  if (shellState.isMessageSelectionMode) {
    row.classList.add('selection-mode');
    const isMsgSelected = shellState.isMessageSelected(message) || (msgKey && shellState.isMessageSelected(msgKey));
    if (isMsgSelected) {
      row.classList.add('is-selected');
    }
    if (!isCall) {
      const chkContainer = document.createElement('div');
      chkContainer.className = 'message-select-checkbox';
      const chk = document.createElement('input');
      chk.type = 'checkbox';
      chk.checked = Boolean(isMsgSelected);
      chk.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleMessageSelectionUI(message || msgKey);
      });
      chkContainer.appendChild(chk);
      row.prepend(chkContainer);

      row.addEventListener('click', (e) => {
        if (shellState.isMessageSelectionMode) {
          e.stopPropagation();
          toggleMessageSelectionUI(message || msgKey);
        }
      });
    }
  }

  // Context menu trigger button & right-click (skip action button for call cards)
  if (!isCall) {
    const reactBtn = document.createElement('button');
    reactBtn.type = 'button';
    reactBtn.className = 'message-react-btn';
    reactBtn.innerHTML = '<svg class="ui-icon ui-icon-xs" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/></svg>';
    reactBtn.title = 'Add reaction';
    reactBtn.setAttribute('aria-label', 'Add reaction');
    reactBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openReactionPicker(e, message, reactBtn);
    });
    bubble.appendChild(reactBtn);

    const actionBtn = document.createElement('button');
    actionBtn.type = 'button';
    actionBtn.className = 'message-action-btn';
    actionBtn.innerHTML = '&#709;';
    actionBtn.title = 'Message options';
    actionBtn.setAttribute('aria-label', 'Message options');
    actionBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openMessageContextMenu(e, message, actionBtn);
    });
    bubble.appendChild(actionBtn);
  }

  row.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    openMessageContextMenu(e, message);
  });

  // Group chat incoming sender label
  const selectedConv = shellState.getSelectedConversation();
  const isGroup = selectedConv?.kind === 'group';
  if (isGroup && !isOwn) {
    const senderUserId = message.senderId || message.sender_id;
    const senderName = resolveSenderNameForMessage(message, selectedConv?.roomId);
    const senderEl = document.createElement('span');
    senderEl.className = 'message-sender';
    if (senderUserId) {
      senderEl.setAttribute('data-sender-id', senderUserId);
    }
    senderEl.style.color = getAvatarColor(senderName);
    senderEl.textContent = senderName;
    bubble.appendChild(senderEl);

    // If senderName is the fallback 'Contact' and we haven't resolved participants yet,
    // trigger background resolution
    if (senderName === 'Contact' && senderUserId && selectedConv?.roomId) {
      ensureRoomParticipants(selectedConv.roomId);
    }
  }

  // Forwarded visual badge
  if (resolved.isForwarded) {
    const forwardEl = document.createElement('div');
    forwardEl.className = 'message-forwarded-badge';
    forwardEl.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 17 20 12 15 7"/><path d="M4 18v-2a4 4 0 0 1 4-4h12"/></svg><span>Forwarded</span>';
    bubble.appendChild(forwardEl);
  }

  // Reply preview bar if replyTo is present
  const replyToId = message.replyTo || message.reply_to || message.replyToId || message.reply_to_id;
  if (replyToId) {
    const replyContainer = document.createElement('div');
    replyContainer.className = 'message-reply-preview';
    replyContainer.setAttribute('role', 'button');
    replyContainer.setAttribute('tabindex', '0');
    replyContainer.setAttribute('title', 'Jump to original message');
    replyContainer.setAttribute('data-reply-to', replyToId);

    const barEl = document.createElement('div');
    barEl.className = 'message-reply-preview-bar';
    replyContainer.appendChild(barEl);

    const contentEl = document.createElement('div');
    contentEl.className = 'message-reply-preview-content';

    const senderHeader = document.createElement('div');
    senderHeader.className = 'message-reply-preview-sender';

    const iconSpan = document.createElement('span');
    iconSpan.className = 'message-reply-preview-icon';
    iconSpan.textContent = '↩';
    senderHeader.appendChild(iconSpan);

    const nameSpan = document.createElement('span');
    nameSpan.className = 'message-reply-preview-name';
    senderHeader.appendChild(nameSpan);
    contentEl.appendChild(senderHeader);

    const textEl = document.createElement('div');
    textEl.className = 'message-reply-preview-text';
    contentEl.appendChild(textEl);

    replyContainer.appendChild(contentEl);

    const resolvedOriginal = resolveOriginalMessage(replyToId, message.roomId || message.room_id);
    if (resolvedOriginal) {
      nameSpan.textContent = getReplySenderName(
        resolvedOriginal,
        currentUserId,
        (uid, rId) => resolveSenderNameForMessage({ senderId: uid, roomId: rId || selectedConv?.roomId }),
        {
          roomId: selectedConv?.roomId,
          roomParticipants: selectedConv?.roomId ? shellState?.getRoomParticipants(selectedConv.roomId) : null,
          conversations: shellState?.conversations,
          globalParticipantsCache: shellState?.participantProfiles
        }
      );
      textEl.textContent = formatReplyPreview(resolvedOriginal);
      if (resolvedOriginal.isDeleted || resolvedOriginal.kind === 'deleted' || resolvedOriginal.isDeletedForMe) {
        textEl.classList.add('is-deleted');
      }
    } else {
      nameSpan.textContent = 'Reply';
      textEl.textContent = 'Loading original message...';
      fetchAndPopulateReplyPreview(replyToId, message.roomId || message.room_id, nameSpan, textEl, currentUserId);
    }

    replyContainer.addEventListener('click', (e) => {
      e.stopPropagation();
      jumpToOriginalMessage(replyToId, message.roomId || message.room_id);
    });

    replyContainer.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        e.stopPropagation();
        jumpToOriginalMessage(replyToId, message.roomId || message.room_id);
      }
    });

    bubble.appendChild(replyContainer);
  }

  // Message body / media / fallback
  const msgRoomId = message.roomId || message.room_id || shellState.selectedRoomId;

  if (resolved.kind === 'call') {
    const card = document.createElement('div');
    card.className = 'message-call-card';
    card.setAttribute('role', 'button');
    card.setAttribute('tabindex', '0');

    const isVideo = Boolean(resolved.isVideo || resolved.callType === 'video');
    const isIncoming = resolved.direction === 'incoming';
    const isMissed = resolved.status === 'missed';
    const isDeclined = resolved.status === 'declined';
    const isCancelled = resolved.status === 'cancelled';
    const isCompleted = resolved.status === 'completed';

    const iconWrapper = document.createElement('div');
    iconWrapper.className = `call-card-icon-wrapper ${isMissed ? 'call-card-missed' : ''}`;

    let iconSvg = '';
    if (isVideo) {
      iconSvg = '<svg class="ui-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m22 8-6 4 6 4V8Z"/><rect width="14" height="12" x="2" y="6" rx="2" ry="2"/></svg>';
    } else if (isMissed) {
      iconSvg = '<svg class="ui-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/><line x1="23" y1="1" x2="1" y2="23"/></svg>';
    } else {
      iconSvg = '<svg class="ui-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>';
    }
    iconWrapper.innerHTML = iconSvg;
    card.appendChild(iconWrapper);

    const content = document.createElement('div');
    content.className = 'call-card-content';

    const titleEl = document.createElement('div');
    titleEl.className = 'call-card-title';
    titleEl.textContent = isVideo ? 'Video call' : 'Audio call';
    content.appendChild(titleEl);

    const detailsEl = document.createElement('div');
    detailsEl.className = `call-card-details ${isMissed ? 'call-missed' : ''}`;

    let directionSvg = '';
    if (isIncoming) {
      directionSvg = '<svg class="call-direction-icon call-direction-incoming" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="17" y1="7" x2="7" y2="17"/><polyline points="17 17 7 17 7 7"/></svg>';
    } else {
      directionSvg = '<svg class="call-direction-icon call-direction-outgoing" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="7" y1="17" x2="17" y2="7"/><polyline points="7 7 17 7 17 17"/></svg>';
    }

    let statusText = '';
    let statusClass = '';
    if (isMissed) {
      statusText = 'Missed';
      statusClass = 'call-status-missed';
    } else if (isDeclined) {
      statusText = 'Declined';
      statusClass = 'call-status-declined';
    } else if (isCancelled) {
      statusText = 'Cancelled';
      statusClass = 'call-status-cancelled';
    } else if (isCompleted) {
      statusText = formatCallTimelineDuration(resolved.duration);
      statusClass = 'call-status-completed';
    } else {
      statusText = formatCallTimelineDuration(resolved.duration) || 'Completed';
      statusClass = 'call-status-completed';
    }

    detailsEl.innerHTML = `${directionSvg}<span class="${statusClass}">${escapeHtml(statusText)}</span>`;
    content.appendChild(detailsEl);
    card.appendChild(content);

    card.title = `Call back (${isVideo ? 'Video' : 'Voice'})`;
    card.addEventListener('click', (e) => {
      e.stopPropagation();
      const targetRoom = msgRoomId || shellState.selectedRoomId;
      if (targetRoom) {
        const { displayName, phone } = resolveCallerIdentity(targetRoom, null);
        const peerName = displayName || (isVideo ? 'Video Call' : 'Voice Call');
        if (isVideo) {
          voiceCallManager.startVideoCall(targetRoom, peerName, { peerPhone: phone }).catch(() => { });
        } else {
          voiceCallManager.startCall(targetRoom, peerName, { peerPhone: phone }).catch(() => { });
        }
      }
    });

    bubble.appendChild(card);
  } else if (resolved.kind === 'image') {
    if (!resolved.caption) {
      bubble.classList.add('is-media-only');
    }
    const imgContainer = document.createElement('div');
    imgContainer.className = 'message-image-container';
    const resolvedUrl = resolved.url
      || (resolved.attachmentId ? attachmentUrls.get(resolved.attachmentId) : null)
      || (cid ? attachmentUrls.get(cid) : null);

    if (resolvedUrl) {
      const img = document.createElement('img');
      img.className = 'message-image-thumb';
      img.src = resolvedUrl;
      img.alt = resolved.filename || 'Photo';
      img.loading = 'lazy';
      img.addEventListener('click', (e) => {
        e.stopPropagation();
        openImagePreview(resolvedUrl, resolved.filename, resolved.caption);
      });
      img.addEventListener('error', () => {
        console.warn('Image failed to load, clearing cached URL:', resolved.attachmentId);
        if (resolved.attachmentId) {
          attachmentUrls.delete(resolved.attachmentId);
          if (msgRoomId) resolveAttachmentUrl(msgRoomId, resolved.attachmentId);
        }
      });
      imgContainer.appendChild(img);
    } else {
      const placeholder = document.createElement('div');
      placeholder.className = 'media-placeholder';
      if (resolved.attachmentId) {
        placeholder.setAttribute('data-attachment-id', resolved.attachmentId);
      }
      const spinner = document.createElement('span');
      spinner.className = 'spinner spinner-sm';
      const label = document.createElement('span');
      label.textContent = 'Loading photo...';
      placeholder.appendChild(spinner);
      placeholder.appendChild(label);
      imgContainer.appendChild(placeholder);

      if (resolved.attachmentId && msgRoomId) {
        resolveAttachmentUrl(msgRoomId, resolved.attachmentId);
      }
    }

    if (resolved.caption) {
      const captionEl = document.createElement('div');
      captionEl.className = 'message-image-caption';
      renderFormattedMessageText(captionEl, resolved.caption);
      imgContainer.appendChild(captionEl);
    }
    bubble.appendChild(imgContainer);
  } else if (resolved.kind === 'video') {
    if (!resolved.caption) {
      bubble.classList.add('is-media-only');
    }
    const videoContainer = document.createElement('div');
    videoContainer.className = 'message-video-container';
    const resolvedUrl = resolved.url
      || (resolved.attachmentId ? attachmentUrls.get(resolved.attachmentId) : null)
      || (cid ? attachmentUrls.get(cid) : null);

    if (resolvedUrl) {
      const video = document.createElement('video');
      video.className = 'message-video';
      video.controls = true;
      video.playsInline = true;
      video.preload = 'metadata';
      video.src = resolvedUrl;
      video.addEventListener('error', () => {
        console.warn('Video failed to load, clearing cached URL:', resolved.attachmentId);
        if (resolved.attachmentId) {
          attachmentUrls.delete(resolved.attachmentId);
          if (msgRoomId) resolveAttachmentUrl(msgRoomId, resolved.attachmentId);
        }
      });
      videoContainer.appendChild(video);
    } else {
      const placeholder = document.createElement('div');
      placeholder.className = 'media-placeholder';
      if (resolved.attachmentId) {
        placeholder.setAttribute('data-attachment-id', resolved.attachmentId);
      }
      const spinner = document.createElement('span');
      spinner.className = 'spinner spinner-sm';
      const label = document.createElement('span');
      label.textContent = 'Loading video...';
      placeholder.appendChild(spinner);
      placeholder.appendChild(label);
      videoContainer.appendChild(placeholder);

      if (resolved.attachmentId && msgRoomId) {
        resolveAttachmentUrl(msgRoomId, resolved.attachmentId);
      }
    }

    if (resolved.caption) {
      const captionEl = document.createElement('div');
      captionEl.className = 'message-image-caption';
      renderFormattedMessageText(captionEl, resolved.caption);
      videoContainer.appendChild(captionEl);
    }
    bubble.appendChild(videoContainer);
  } else if (resolved.kind === 'audio') {
    const audioContainer = document.createElement('div');
    audioContainer.className = resolved.isVoiceNote ? 'message-voice-note-container' : 'message-audio-container';
    const resolvedUrl = resolved.url
      || (resolved.attachmentId ? attachmentUrls.get(resolved.attachmentId) : null)
      || (cid ? attachmentUrls.get(cid) : null);

    if (resolved.isVoiceNote) {
      if (resolvedUrl) {
        const player = createVoiceNotePlayerElement(resolvedUrl, resolved.duration || 0, resolved.attachmentId, msgRoomId);
        audioContainer.appendChild(player);
      } else if (resolved.attachmentId && attachmentErrors.has(resolved.attachmentId)) {
        const errorText = attachmentErrors.get(resolved.attachmentId) || 'Unable to load voice message';
        const ph = document.createElement('div');
        ph.className = 'media-placeholder media-error-placeholder';
        ph.setAttribute('data-attachment-id', resolved.attachmentId);
        const label = document.createElement('span');
        label.className = 'media-error-label';
        label.textContent = errorText;
        const retryBtn = document.createElement('button');
        retryBtn.type = 'button';
        retryBtn.className = 'btn-retry-media-load';
        retryBtn.textContent = '↻ Retry';
        retryBtn.title = 'Retry loading voice message';
        retryBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          attachmentErrors.delete(resolved.attachmentId);
          attachmentUrls.delete(resolved.attachmentId);
          ph.innerHTML = '<span class="spinner spinner-sm"></span><span>Loading voice message...</span>';
          ph.classList.remove('media-error-placeholder');
          if (msgRoomId) resolveAttachmentUrl(msgRoomId, resolved.attachmentId);
        });
        ph.appendChild(label);
        ph.appendChild(retryBtn);
        audioContainer.appendChild(ph);
      } else {
        const placeholder = document.createElement('div');
        placeholder.className = 'media-placeholder';
        if (resolved.attachmentId) {
          placeholder.setAttribute('data-attachment-id', resolved.attachmentId);
        }
        const spinner = document.createElement('span');
        spinner.className = 'spinner spinner-sm';
        const label = document.createElement('span');
        label.textContent = 'Loading voice message...';
        placeholder.appendChild(spinner);
        placeholder.appendChild(label);
        audioContainer.appendChild(placeholder);

        if (resolved.attachmentId && msgRoomId) {
          resolveAttachmentUrl(msgRoomId, resolved.attachmentId);
        }
      }
    } else {
      if (resolvedUrl) {
        const audio = document.createElement('audio');
        audio.className = 'message-audio';
        audio.controls = true;
        audio.preload = 'metadata';
        audio.src = resolvedUrl;
        audio.addEventListener('error', () => {
          console.warn('Audio failed to load, clearing cached URL:', resolved.attachmentId);
          if (resolved.attachmentId) {
            attachmentUrls.delete(resolved.attachmentId);
            if (msgRoomId) resolveAttachmentUrl(msgRoomId, resolved.attachmentId);
          }
        });
        audioContainer.appendChild(audio);
      } else if (resolved.attachmentId && attachmentErrors.has(resolved.attachmentId)) {
        const errorText = attachmentErrors.get(resolved.attachmentId) || 'Unable to load audio';
        const ph = document.createElement('div');
        ph.className = 'media-placeholder media-error-placeholder';
        ph.setAttribute('data-attachment-id', resolved.attachmentId);
        const label = document.createElement('span');
        label.className = 'media-error-label';
        label.textContent = errorText;
        const retryBtn = document.createElement('button');
        retryBtn.type = 'button';
        retryBtn.className = 'btn-retry-media-load';
        retryBtn.textContent = '↻ Retry';
        retryBtn.title = 'Retry loading audio';
        retryBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          attachmentErrors.delete(resolved.attachmentId);
          attachmentUrls.delete(resolved.attachmentId);
          ph.innerHTML = '<span class="spinner spinner-sm"></span><span>Loading audio...</span>';
          ph.classList.remove('media-error-placeholder');
          if (msgRoomId) resolveAttachmentUrl(msgRoomId, resolved.attachmentId);
        });
        ph.appendChild(label);
        ph.appendChild(retryBtn);
        audioContainer.appendChild(ph);
      } else {
        const placeholder = document.createElement('div');
        placeholder.className = 'media-placeholder';
        if (resolved.attachmentId) {
          placeholder.setAttribute('data-attachment-id', resolved.attachmentId);
        }
        const spinner = document.createElement('span');
        spinner.className = 'spinner spinner-sm';
        const label = document.createElement('span');
        label.textContent = 'Loading audio...';
        placeholder.appendChild(spinner);
        placeholder.appendChild(label);
        audioContainer.appendChild(placeholder);

        if (resolved.attachmentId && msgRoomId) {
          resolveAttachmentUrl(msgRoomId, resolved.attachmentId);
        }
      }
    }

    if (resolved.caption) {
      const captionEl = document.createElement('div');
      captionEl.className = 'message-image-caption';
      renderFormattedMessageText(captionEl, resolved.caption);
      audioContainer.appendChild(captionEl);
    }
    bubble.appendChild(audioContainer);
  } else if (resolved.kind === 'file') {
    const card = document.createElement('div');
    card.className = 'message-file-card';
    if (resolved.attachmentId) {
      card.setAttribute('data-attachment-id', resolved.attachmentId);
    }
    const resolvedUrl = resolved.url
      || (resolved.attachmentId ? attachmentUrls.get(resolved.attachmentId) : null)
      || (cid ? attachmentUrls.get(cid) : null);
    if (resolvedUrl) {
      card.setAttribute('data-resolved-url', resolvedUrl);
    }

    const iconEl = document.createElement('div');
    iconEl.className = 'file-card-icon';
    const ext = (resolved.filename.split('.').pop() || '').toLowerCase();
    let icon = '📄';
    if (ext === 'pdf') icon = '📕';
    else if (['zip', 'rar', 'gz', 'tar'].includes(ext)) icon = '📦';
    else if (['doc', 'docx'].includes(ext)) icon = '📝';
    else if (['xls', 'xlsx', 'csv'].includes(ext)) icon = '📊';
    else if (['ppt', 'pptx'].includes(ext)) icon = '📑';
    iconEl.textContent = icon;

    const details = document.createElement('div');
    details.className = 'file-card-details';
    const nameEl = document.createElement('div');
    nameEl.className = 'file-card-name';
    nameEl.textContent = resolved.filename;
    nameEl.title = resolved.filename;
    const metaEl = document.createElement('div');
    metaEl.className = 'file-card-meta';
    const sizeStr = resolved.byteSize ? formatFileSize(resolved.byteSize) : (ext.toUpperCase() || 'FILE');
    metaEl.textContent = sizeStr;
    details.appendChild(nameEl);
    details.appendChild(metaEl);

    const actionEl = document.createElement('div');
    const onFileDownload = async (e) => {
      e.stopPropagation();
      const currentUrl = card.getAttribute('data-resolved-url')
        || (resolved.attachmentId ? attachmentUrls.get(resolved.attachmentId) : null)
        || resolvedUrl;
      await handleDownloadFile(resolved.attachmentId, resolved.filename, currentUrl, msgRoomId);
    };

    const onFileOpen = async (e) => {
      e.stopPropagation();
      const currentUrl = card.getAttribute('data-resolved-url')
        || (resolved.attachmentId ? attachmentUrls.get(resolved.attachmentId) : null)
        || resolvedUrl;
      await handleOpenFile(resolved.attachmentId, resolved.filename, currentUrl, msgRoomId, card, resolved.mime);
    };

    const downloadBtn = document.createElement('button');
    downloadBtn.type = 'button';
    downloadBtn.className = 'btn-file-download';
    downloadBtn.title = `Download ${resolved.filename}`;
    downloadBtn.setAttribute('aria-label', `Download ${resolved.filename}`);
    downloadBtn.textContent = '⬇';
    downloadBtn.addEventListener('click', onFileDownload);
    actionEl.appendChild(downloadBtn);

    card.appendChild(iconEl);
    card.appendChild(details);
    card.appendChild(actionEl);

    card.title = `Click to open ${resolved.filename}`;
    card.style.cursor = 'pointer';
    card.addEventListener('click', onFileOpen);

    if (resolved.attachmentId && !resolvedUrl && msgRoomId) {
      resolveAttachmentUrl(msgRoomId, resolved.attachmentId);
    }

    bubble.appendChild(card);
  } else if (resolved.isFallback) {
    const fallbackEl = document.createElement('div');
    fallbackEl.className = 'message-fallback';
    const fallbackSpan = document.createElement('span');
    fallbackSpan.textContent = resolved.fallbackText || '';
    fallbackEl.appendChild(fallbackSpan);
    bubble.appendChild(fallbackEl);
  } else {
    const textEl = document.createElement('div');
    const isEmoji = !resolved.isDeleted && isEmojiOnly(resolved.text);
    textEl.className = `message-text ${isEmoji ? 'emoji-only' : ''} ${resolved.isDeleted ? 'deleted-text' : ''}`.trim();
    if (resolved.isDeleted) {
      textEl.textContent = resolved.text || '';
    } else {
      renderFormattedMessageText(textEl, resolved.text || '');
    }
    bubble.appendChild(textEl);
  }

  // Metadata footer (edited indicator, timestamp, status checkmark)
  const metaEl = document.createElement('div');
  metaEl.className = 'message-meta';

  if (message.editedAt || message.edited_at) {
    const editedEl = document.createElement('span');
    editedEl.className = 'message-meta-edited';
    editedEl.textContent = '(edited)';
    metaEl.appendChild(editedEl);
  }

  const isStarred = (message.id && roomMessagesState.isStarred(message.id, msgRoomId))
    || (cid && roomMessagesState.isStarred(cid, msgRoomId));
  if (isStarred) {
    const starEl = document.createElement('span');
    starEl.className = 'message-meta-star';
    starEl.textContent = '★';
    starEl.title = 'Starred';
    metaEl.appendChild(starEl);
  }

  // Pin indicator
  const isPinnedMsg = (message.id && shellState.isMessagePinned(message.id, msgRoomId))
    || (cid && shellState.isMessagePinned(cid, msgRoomId));
  if (isPinnedMsg) {
    const pinEl = document.createElement('span');
    pinEl.className = 'message-meta-pin';
    pinEl.title = 'Pinned';
    pinEl.innerHTML = '<svg class="ui-icon" style="width:10px;height:10px;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="12" y1="17" x2="12" y2="22"/><path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a1 1 0 0 0 0-2H8a1 1 0 0 0 0 2h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z"/></svg>';
    metaEl.appendChild(pinEl);
  }

  const timeStr = formatMessageTime(message.createdAt || message.created_at || (message.startedAt ? new Date(message.startedAt).toISOString() : null));
  if (timeStr) {
    const timeEl = document.createElement('span');
    timeEl.className = 'message-meta-time';
    timeEl.textContent = timeStr;
    metaEl.appendChild(timeEl);
  }

  // Status checkmark (outgoing messages only, skip for call cards)
  if (isOwn && !isCall) {
    const status = (message.id ? roomMessagesState.getStatus(message.id) : null)
      || (cid ? roomMessagesState.getStatus(cid) : null)
      || message.deliveryStatus
      || message.delivery_status
      || message.status
      || 'sent';

    const tickDesc = getTickDescriptor(status, true);

    if (tickDesc.statusClass === 'status-failed') {
      row.classList.add('failed');
    }

    if (tickDesc.hasTick) {
      const statusIcon = document.createElement('span');
      statusIcon.className = `message-status-icon ${tickDesc.statusClass}`;
      statusIcon.textContent = tickDesc.symbol;
      statusIcon.title = tickDesc.title;
      metaEl.appendChild(statusIcon);
    }

    if (status === 'failed') {
      const retryBtn = document.createElement('button');
      retryBtn.type = 'button';
      retryBtn.className = 'btn-retry-send';
      retryBtn.textContent = '↻ Retry';
      retryBtn.title = 'Retry sending';
      retryBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        handleRetryMessage(cid || message.id);
      });
      metaEl.appendChild(retryBtn);
    }
  }

  bubble.appendChild(metaEl);
  row.appendChild(bubble);

  // Reactions
  if (message.reactions && typeof message.reactions === 'object') {
    const entries = Object.entries(message.reactions).filter(([_, users]) => Array.isArray(users) && users.length > 0);
    if (entries.length > 0) {
      const reactionsEl = document.createElement('div');
      reactionsEl.className = 'message-reactions';
      reactionsEl.setAttribute('role', 'group');
      reactionsEl.setAttribute('aria-label', 'Reactions');
      for (const [emoji, users] of entries) {
        const badge = document.createElement('button');
        badge.type = 'button';
        badge.className = 'reaction-badge';
        const hasMyReaction = currentUserId && users.includes(currentUserId);
        if (hasMyReaction) {
          badge.classList.add('active');
          badge.title = users.length === 1
            ? `You reacted with ${emoji}. Click to remove.`
            : `You and ${users.length - 1} other${users.length - 1 === 1 ? '' : 's'} reacted with ${emoji}. Click to remove.`;
        } else {
          badge.title = `${users.length} user${users.length === 1 ? '' : 's'} reacted with ${emoji}. Click to react.`;
        }
        badge.textContent = users.length > 1 ? `${emoji} ${users.length}` : emoji;
        badge.addEventListener('click', (e) => {
          e.stopPropagation();
          handleToggleReaction(message, emoji);
        });
        reactionsEl.appendChild(badge);
      }
      row.appendChild(reactionsEl);
    }
  }

  return row;
}

/**
 * Renders all messages grouped by calendar day.
 * Displays unread-messages divider before the first unread message when unread messages exist.
 */
function renderMessages() {
  if (!messagesList) return;
  const wasRebuilding = isRebuildingMessagesDom;
  isRebuildingMessagesDom = true;
  try {
    messagesList.innerHTML = '';

    const roomId = shellState.selectedRoomId;
    const openingState = (activeConversationOpeningState && activeConversationOpeningState.roomId === roomId)
      ? activeConversationOpeningState
      : null;
    const currentUserId = roomMessagesState.currentUserId || shellState.currentUser?.userId || shellState.userProfile?.userId;
    const isReadAcknowledged = Boolean(openingState?.isReadAcknowledged);
    let firstUnreadId = null;

    if (openingState && openingState.hasUnreadDivider) {
      if (!openingState.unreadDividerMessageId) {
        const firstUnread = findFirstUnreadMessage(roomMessagesState.messages, {
          currentUserId,
          unreadCount: openingState.initialUnreadCount,
          isMarkedUnread: openingState.isMarkedUnread,
          trackedUnreadSet: openingState.trackedUnreadSet,
          trackedEditsSet: openingState.trackedEditsSet,
          targetMessageId: openingState.targetMessageId
        });
        if (firstUnread) {
          openingState.unreadDividerMessageId = firstUnread.id || firstUnread.clientMessageId || firstUnread.client_message_id;
        } else {
          openingState.hasUnreadDivider = false;
        }
      }
      firstUnreadId = openingState.unreadDividerMessageId;
    } else if (!openingState && !isReadAcknowledged) {
      const unreadCount = shellState.getRoomUnreadCount(roomId);
      const isMarkedUnread = Boolean(shellState._markedUnreadRooms?.has(String(roomId)));
      const trackedUnreadSet = shellState._unreadMessageIds?.get(String(roomId));
      if (unreadCount > 0 || isMarkedUnread || trackedUnreadSet?.size > 0) {
        const firstUnread = findFirstUnreadMessage(roomMessagesState.messages, {
          currentUserId,
          unreadCount,
          isMarkedUnread,
          trackedUnreadSet
        });
        firstUnreadId = firstUnread ? (firstUnread.id || firstUnread.clientMessageId || firstUnread.client_message_id) : null;
      }
    }
    let unreadDividerInserted = false;

    const dayGroups = groupMessagesByDay(roomMessagesState.messages);
    for (const group of dayGroups) {
      const divider = document.createElement('div');
      divider.className = 'day-divider';
      divider.dataset.dateKey = group.dateKey;
      divider.dataset.dateLabel = group.label;
      const pill = document.createElement('span');
      pill.className = 'day-divider-pill';
      pill.textContent = group.label;
      divider.appendChild(pill);
      messagesList.appendChild(divider);

      for (const msg of group.messages) {
        const mId = msg.id || msg.clientMessageId || msg.client_message_id;
        if (firstUnreadId && !unreadDividerInserted && mId === firstUnreadId) {
          const unreadDivider = document.createElement('div');
          unreadDivider.className = 'unread-messages-divider';
          unreadDivider.id = 'unread-messages-divider';
          const unreadPill = document.createElement('span');
          unreadPill.className = 'unread-messages-divider-pill';
          unreadPill.textContent = 'Unread Messages';
          unreadDivider.appendChild(unreadPill);
          messagesList.appendChild(unreadDivider);
          unreadDividerInserted = true;
        }

        const el = createMessageBubbleElement(msg);
        el.dataset.dateKey = group.dateKey;
        el.dataset.dateLabel = group.label;
        messagesList.appendChild(el);
      }
    }
  } finally {
    isRebuildingMessagesDom = wasRebuilding;
  }
}

/**
 * Appends a new message directly to DOM without replacing all messages or resetting scroll position.
 * @param {object} msg
 * @returns {boolean}
 */
export function appendMessageToDom(msg) {
  if (!messagesList || !messagesScrollArea) return false;
  if (messagesScrollArea.classList.contains('hidden')) return false;

  const existing = findMessageDomElement(msg);
  if (existing) {
    updateMessageElementInDom(existing, msg);
    return true;
  }

  const msgDate = msg.createdAt || msg.created_at || new Date().toISOString();
  const dateKey = getCalendarDateKey(msgDate);
  const dateLabel = formatCalendarDayLabel(msgDate);

  const allDividers = messagesList.querySelectorAll('.day-divider');
  const lastDivider = allDividers.length > 0 ? allDividers[allDividers.length - 1] : null;
  const lastDateKey = lastDivider?.dataset?.dateKey;

  if (!lastDivider || lastDateKey !== dateKey) {
    const divider = document.createElement('div');
    divider.className = 'day-divider';
    divider.dataset.dateKey = dateKey;
    divider.dataset.dateLabel = dateLabel;
    const pill = document.createElement('span');
    pill.className = 'day-divider-pill';
    pill.textContent = dateLabel;
    divider.appendChild(pill);
    messagesList.appendChild(divider);
  }

  const el = createMessageBubbleElement(msg);
  el.dataset.dateKey = dateKey;
  el.dataset.dateLabel = dateLabel;
  messagesList.appendChild(el);
  return true;
}

/**
 * Updates a single message bubble element in DOM without rebuilding the list.
 * @param {HTMLElement} el
 * @param {object} msg
 */
export function updateMessageElementInDom(el, msg) {
  if (!el || !msg) return;
  const cid = msg.clientMessageId || msg.client_message_id;
  const id = msg.id;
  if (id) {
    el.setAttribute('data-message-id', id);
    el.id = `msg-${id}`;
  }
  if (cid) {
    el.setAttribute('data-client-message-id', cid);
  }

  const textEl = el.querySelector('.message-text');
  const resolved = resolveMessageContent(msg);
  if (textEl && resolved.text && !resolved.isFallback) {
    textEl.textContent = resolved.text;
  }

  const isEdited = Boolean(msg.editedAt || msg.edited_at);
  let editedLabel = el.querySelector('.message-edited-label');
  if (isEdited && !editedLabel) {
    const metaEl = el.querySelector('.message-meta');
    if (metaEl) {
      editedLabel = document.createElement('span');
      editedLabel.className = 'message-edited-label';
      editedLabel.textContent = 'edited';
      metaEl.insertBefore(editedLabel, metaEl.firstChild);
    }
  }

  const effectiveStatus = (id ? roomMessagesState.getStatus(id) : null) ||
    (cid ? roomMessagesState.getStatus(cid) : null) ||
    msg.deliveryStatus ||
    msg.delivery_status ||
    msg.status;
  if (effectiveStatus) {
    updateMessageStatusInDom(id || cid, effectiveStatus);
  }
}

/**
 * Removes a deleted message element from DOM in place.
 * @param {string} msgId
 * @returns {boolean}
 */
export function removeMessageElementFromDom(msgId) {
  const el = findMessageDomElement(msgId);
  if (el) {
    el.remove();
    return true;
  }
  return false;
}

let floatingDateHideTimer = null;
let lastFloatingDateLabel = '';

/**
 * Determines the date label of the message currently nearest the top of visible message area.
 * @returns {string}
 */
function getActiveTopDateLabel() {
  if (!messagesScrollArea || !messagesList) return '';
  const children = Array.from(messagesList.children);
  if (children.length === 0) return '';
  return calculateVisibleDateLabel(messagesScrollArea.scrollTop, children, 30);
}

/**
 * Updates the floating date indicator position and visibility during scroll.
 */
function updateFloatingDateOnScroll() {
  if (!floatingDateIndicator || !floatingDatePill || !messagesScrollArea || !messagesList) return;

  // If messages list is empty or scroll area is hidden, hide floating date immediately
  if (messagesScrollArea.classList.contains('hidden') || messagesList.children.length === 0) {
    hideFloatingDateIndicator(true);
    return;
  }

  // Only show floating indicator if the container actually has scrollable overflow
  if (messagesScrollArea.scrollHeight <= messagesScrollArea.clientHeight + 10) {
    hideFloatingDateIndicator(true);
    return;
  }

  const label = getActiveTopDateLabel();
  if (!label) {
    hideFloatingDateIndicator(true);
    return;
  }

  if (label !== lastFloatingDateLabel) {
    lastFloatingDateLabel = label;
    floatingDatePill.textContent = label;
  }

  // Show floating indicator overlay
  floatingDateIndicator.classList.remove('hidden');
  floatingDateIndicator.classList.add('visible');

  // Prevent overlap with permanent divider if one is passing directly under the floating pill
  const targetTop = messagesScrollArea.scrollTop;
  const prevNear = messagesList.querySelector('.day-divider.near-top');
  let currentNear = null;

  const dividers = messagesList.querySelectorAll('.day-divider');
  for (const div of dividers) {
    const relTop = div.offsetTop - targetTop;
    if (relTop >= -10 && relTop <= 35) {
      currentNear = div;
      break;
    }
  }

  if (prevNear && prevNear !== currentNear) {
    prevNear.classList.remove('near-top');
  }
  if (currentNear && currentNear !== prevNear) {
    currentNear.classList.add('near-top');
  }

  // Fade out 1200ms after scrolling stops
  if (floatingDateHideTimer) {
    clearTimeout(floatingDateHideTimer);
  }
  floatingDateHideTimer = setTimeout(() => {
    hideFloatingDateIndicator(false);
  }, 1200);
}

/**
 * Hides or fades out the floating date indicator.
 * @param {boolean} [immediate=false]
 */
function hideFloatingDateIndicator(immediate = false) {
  if (floatingDateHideTimer) {
    clearTimeout(floatingDateHideTimer);
    floatingDateHideTimer = null;
  }
  if (!floatingDateIndicator) return;

  const near = messagesList?.querySelector('.day-divider.near-top');
  if (near) near.classList.remove('near-top');

  if (immediate) {
    floatingDateIndicator.classList.remove('visible');
    floatingDateIndicator.classList.add('hidden');
  } else {
    floatingDateIndicator.classList.remove('visible');
    setTimeout(() => {
      if (!floatingDateIndicator.classList.contains('visible')) {
        floatingDateIndicator.classList.add('hidden');
      }
    }, 250);
  }
}

/**
 * Scrolls the message area to bottom.
 * @param {boolean} [smooth=false]
 */
function scrollToBottom(smooth = false) {
  hideFloatingDateIndicator(true);
  if (!messagesScrollArea) return;
  if (smooth) {
    messagesScrollArea.scrollTo({
      top: messagesScrollArea.scrollHeight,
      behavior: 'smooth'
    });
  } else {
    messagesScrollArea.scrollTop = messagesScrollArea.scrollHeight;
  }
  scrollBottomBtn?.classList.add('hidden');
}

/**
 * Locates the DOM element representing a message in the active messagesList.
 * @param {object|string} messageOrId
 * @returns {HTMLElement|null}
 */
export function findMessageDomElement(messageOrId) {
  if (!messagesList || !messageOrId) return null;
  const id = typeof messageOrId === 'object'
    ? (messageOrId.id || messageOrId.clientMessageId || messageOrId.client_message_id)
    : messageOrId;
  if (!id) return null;
  const escaped = CSS.escape(String(id));
  let el = messagesList.querySelector(`[data-message-id="${escaped}"]`);
  if (!el) {
    el = messagesList.querySelector(`[data-client-message-id="${escaped}"]`);
  }
  if (!el && typeof messageOrId === 'object') {
    const cid = messageOrId.clientMessageId || messageOrId.client_message_id;
    if (cid) {
      el = messagesList.querySelector(`[data-client-message-id="${CSS.escape(String(cid))}"]`);
    }
    const seq = messageOrId.eventSeq ?? messageOrId.event_seq;
    if (!el && typeof seq === 'number' && Number.isFinite(seq) && seq > 0) {
      const candidate = messagesList.querySelector(`[data-seq="${CSS.escape(String(seq))}"]`);
      if (candidate) {
        const candidateMsgId = candidate.getAttribute('data-message-id');
        const incomingId = messageOrId.id || messageOrId.messageId || messageOrId.message_id;
        if (!candidateMsgId || !incomingId || candidateMsgId === incomingId) {
          el = candidate;
        }
      }
    }
  }
  return el;
}

/**
 * Automatically scrolls to the latest unread message if unread messages exist,
 * or to the latest message at the bottom if there are no unread messages.
 * 
 * Case 1: If the conversation contains unread messages, positions at the latest
 * unread message immediately before newer messages (NOT at the oldest unread message).
 * Case 2: If the conversation has no unread messages, automatically scrolls to bottom.
 * Case 3: Handles notification-driven navigation identically.
 * Case 4: Handles large histories gracefully without full loads.
 *
 * @param {string} roomId
 * @param {object} [options]
 * @returns {boolean} Whether positioned at an unread message
 */
export function positionConversationAtLatestUnreadOrBottom(roomId, { force = false } = {}) {
  if (!roomId || !messagesScrollArea) return false;
  if (shellState.selectedRoomId !== roomId) return false;

  const targetState = getOrCreateRoomMessagesState(roomId);
  const currentUserId = targetState.currentUserId || shellState.currentUser?.userId || shellState.userProfile?.userId;
  const openingState = (activeConversationOpeningState && activeConversationOpeningState.roomId === roomId)
    ? activeConversationOpeningState
    : null;

  const unreadCount = openingState ? openingState.initialUnreadCount : shellState.getRoomUnreadCount(roomId);
  const isMarkedUnread = openingState ? openingState.isMarkedUnread : Boolean(shellState._markedUnreadRooms?.has(String(roomId)));
  const trackedUnreadSet = openingState ? openingState.trackedUnreadSet : shellState._unreadMessageIds?.get(String(roomId));
  const trackedEditsSet = openingState ? openingState.trackedEditsSet : shellState._unreadEditedMessages?.get(String(roomId));
  const targetMessageId = openingState ? openingState.targetMessageId : null;

  const latestUnread = findLatestUnreadMessage(targetState.messages, {
    currentUserId,
    unreadCount,
    isMarkedUnread,
    trackedUnreadSet,
    trackedEditsSet,
    targetMessageId
  });

  if (latestUnread) {
    const el = findMessageDomElement(latestUnread);
    if (el) {
      hideFloatingDateIndicator(true);
      el.scrollIntoView({ behavior: 'auto', block: 'center' });
      requestAnimationFrame(() => {
        if (shellState.selectedRoomId === roomId) {
          el.scrollIntoView({ behavior: 'auto', block: 'center' });
          const distFromBottom = messagesScrollArea.scrollHeight - messagesScrollArea.scrollTop - messagesScrollArea.clientHeight;
          if (distFromBottom > 150) {
            scrollBottomBtn?.classList.remove('hidden');
          } else {
            scrollBottomBtn?.classList.add('hidden');
          }
        }
      });

      if (openingState) {
        openingState.hasPositioned = true;
        openingState.targetMessageId = latestUnread.id || latestUnread.clientMessageId;
      }
      saveRoomScrollPosition(roomId);
      return true;
    }

    // If an unread or target message exists but is not yet rendered in the DOM,
    // do not prematurely scroll to the bottom. Wait for the element to be rendered.
    if (openingState && (targetMessageId || unreadCount > 0 || isMarkedUnread || trackedUnreadSet?.size > 0)) {
      return false;
    }
  }

  // Case 2: No unread messages or unread element not in DOM -> scroll to bottom
  scrollToBottom(false);
  if (openingState) {
    openingState.hasPositioned = true;
  }
  saveRoomScrollPosition(roomId);
  return false;
}


/**
 * Loads older historical messages using sequence cursor beforeSeq.
 * Preserves exact visual scroll position.
 */
async function loadOlderMessages() {
  const roomId = shellState.selectedRoomId;
  if (!roomId || isPaginatingOlder) {
    return;
  }
  const targetState = getOrCreateRoomMessagesState(roomId);
  if (!targetState || !targetState.hasMore || targetState.isLoadingOlder) {
    return;
  }

  isPaginatingOlder = true;
  targetState.isLoadingOlder = true;
  olderMessagesLoader?.classList.remove('hidden');

  const prevScrollHeight = messagesScrollArea ? messagesScrollArea.scrollHeight : 0;
  const prevScrollTop = messagesScrollArea ? messagesScrollArea.scrollTop : 0;
  const token = activeLoadToken;

  try {
    const oldestMsg = targetState.messages[0];
    const beforeTime = oldestMsg?.createdAt || oldestMsg?.created_at;
    const beforeSeq = targetState.oldestSeq ?? (oldestMsg?.eventSeq ?? oldestMsg?.event_seq ?? null);

    // 1. First, check SQLite local storage for older messages
    let localOlder = [];
    if (beforeTime || (typeof beforeSeq === 'number' && beforeSeq > 0)) {
      try {
        localOlder = await loadMessagesFromDb(roomId, {
          limit: 50,
          beforeTime: beforeTime || undefined,
          beforeSeq: (typeof beforeSeq === 'number' && beforeSeq > 0) ? beforeSeq : undefined
        });
      } catch (dbErr) {
        console.warn('[loadOlderMessages] SQLite lookup error:', dbErr);
      }
    }

    if (activeLoadToken !== token || shellState.selectedRoomId !== roomId) {
      return;
    }

    if (Array.isArray(localOlder) && localOlder.length > 0) {
      const hasMoreLocal = localOlder.length >= 50;
      targetState.prependOlderMessages(localOlder, hasMoreLocal || Boolean(targetState.hasMore));
      if (targetState.peerLastReadSeq > 0) {
        targetState.setPeerLastReadSeq(targetState.peerLastReadSeq);
      }
      renderMessages();
      if (mediaBrowserPanel && !mediaBrowserPanel.classList.contains('hidden') && activeMbRoomId === roomId) {
        _populateMbTab(activeMbTab, roomId);
      }
      if (starredMessagesPanel && !starredMessagesPanel.classList.contains('hidden') && activeStarredRoomId === roomId) {
        _renderStarredMessages(roomId);
      }
      if (messagesScrollArea) {
        const newScrollHeight = messagesScrollArea.scrollHeight;
        messagesScrollArea.scrollTop = newScrollHeight - prevScrollHeight + prevScrollTop;
      }
      return;
    }

    const currentOlderConv = shellState.conversations?.find((c) => (c.roomId || c.room_id || c.id) === roomId);
    if (currentOlderConv?.isExited || currentOlderConv?.exited) {
      targetState.hasMore = false;
      return;
    }

    // 2. If no older messages in SQLite, fetch from OllaCore history API
    const queryBeforeSeq = (typeof beforeSeq === 'number' && beforeSeq > 0) ? beforeSeq : undefined;
    if (window.ollacoreDesktop?.chatApi?.getMessages) {
      const res = await window.ollacoreDesktop.chatApi.getMessages(roomId, {
        limit: 50,
        beforeSeq: queryBeforeSeq
      });

      if (activeLoadToken !== token || shellState.selectedRoomId !== roomId) {
        return;
      }

      const messages = Array.isArray(res?.messages) ? res.messages : [];
      let hasMore = false;
      if (typeof (res?.hasMore ?? res?.has_more) === 'boolean') {
        hasMore = Boolean(res?.hasMore ?? res?.has_more);
      } else if (messages.length >= 50) {
        let minSeq = null;
        for (const m of messages) {
          const s = m.eventSeq ?? m.event_seq;
          if (typeof s === 'number' && (minSeq === null || s < minSeq)) minSeq = s;
        }
        hasMore = minSeq !== null && minSeq > 1;
      }

      targetState.prependOlderMessages(messages, hasMore);
      if (targetState.peerLastReadSeq > 0) {
        targetState.setPeerLastReadSeq(targetState.peerLastReadSeq);
      }
      if (messages.length > 0) {
        const reconciledForDb = messages.map((m) => {
          const id = m.id;
          const cid = m.clientMessageId || m.client_message_id;
          const knownStatus = (id ? targetState.getStatus(id) : null) || (cid ? targetState.getStatus(cid) : null);
          if (knownStatus) {
            const higher = getHighestStatus(knownStatus, m.deliveryStatus, m.delivery_status, m.status) || knownStatus;
            return { ...m, status: higher, deliveryStatus: higher, delivery_status: higher };
          }
          return m;
        });
        persistMessagesToDb(reconciledForDb, roomId).catch(() => { });
      }
      renderMessages();
      if (mediaBrowserPanel && !mediaBrowserPanel.classList.contains('hidden') && activeMbRoomId === roomId) {
        _populateMbTab(activeMbTab, roomId);
      }
      if (starredMessagesPanel && !starredMessagesPanel.classList.contains('hidden') && activeStarredRoomId === roomId) {
        _renderStarredMessages(roomId);
      }

      // Preserve exact scroll position
      if (messagesScrollArea) {
        const newScrollHeight = messagesScrollArea.scrollHeight;
        messagesScrollArea.scrollTop = newScrollHeight - prevScrollHeight + prevScrollTop;
      }
    } else {
      targetState.hasMore = false;
    }
  } catch (err) {
    console.error('Error loading older messages:', err);
  } finally {
    olderMessagesLoader?.classList.add('hidden');
    targetState.isLoadingOlder = false;
    isPaginatingOlder = false;
  }
}

/**
 * Updates delivery/read status tick icon on an active message row in DOM.
 * @param {string} messageId
 * @param {string} status
 */
function updateMessageStatusInDom(messageId, status) {
  if (!messagesList || !messageId) return;
  let row = messagesList.querySelector(`.message-row[data-message-id="${messageId}"]`);
  if (!row) {
    row = messagesList.querySelector(`.message-row[data-client-message-id="${messageId}"]`);
  }
  if (!row && roomMessagesState?.messages) {
    const msg = roomMessagesState.messages.find(
      (m) => m.id === messageId || m.clientMessageId === messageId || m.client_message_id === messageId
    );
    if (msg) {
      if (msg.id) row = messagesList.querySelector(`.message-row[data-message-id="${msg.id}"]`);
      if (!row && (msg.clientMessageId || msg.client_message_id)) {
        const cid = msg.clientMessageId || msg.client_message_id;
        row = messagesList.querySelector(`.message-row[data-client-message-id="${cid}"]`);
      }
    }
  }
  if (!row) return;

  // Reconcile attributes if message is linked in state
  if (roomMessagesState?.messages) {
    const matched = roomMessagesState.messages.find(
      (m) => m.id === messageId || m.clientMessageId === messageId || m.client_message_id === messageId
    );
    if (matched) {
      if (matched.id && !row.getAttribute('data-message-id')) {
        row.setAttribute('data-message-id', matched.id);
      }
      const cid = matched.clientMessageId || matched.client_message_id;
      if (cid && !row.getAttribute('data-client-message-id')) {
        row.setAttribute('data-client-message-id', cid);
      }
    }
  }

  // Strictly enforce monotonic progression in DOM (never downgrade from read/delivered to sent/sending)
  const stateStatus = roomMessagesState?.getStatus?.(messageId);
  const effectiveStatus = (stateStatus && (STATUS_RANKS[stateStatus] ?? -99) > (STATUS_RANKS[status] ?? -99))
    ? stateStatus
    : (status || stateStatus || 'sent');

  const isOutgoing = row.classList.contains('outgoing');
  const tickDesc = getTickDescriptor(effectiveStatus, isOutgoing);

  let statusIcon = row.querySelector('.message-status-icon');
  if (!tickDesc.hasTick) {
    if (statusIcon) statusIcon.remove();
    return;
  }

  const meta = row.querySelector('.message-meta');
  if (!statusIcon && meta) {
    statusIcon = document.createElement('span');
    meta.appendChild(statusIcon);
  }

  if (statusIcon) {
    statusIcon.className = `message-status-icon ${tickDesc.statusClass}`;
    statusIcon.textContent = tickDesc.symbol;
    statusIcon.title = tickDesc.title;
  }

  let retryBtn = row.querySelector('.btn-retry-send');
  if (effectiveStatus === 'failed') {
    row.classList.add('failed');
    if (!retryBtn && meta) {
      const cid = row.getAttribute('data-client-message-id') || messageId;
      retryBtn = document.createElement('button');
      retryBtn.type = 'button';
      retryBtn.className = 'btn-retry-send';
      retryBtn.textContent = '↻ Retry';
      retryBtn.title = 'Retry sending';
      retryBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        handleRetryMessage(cid);
      });
      meta.appendChild(retryBtn);
    }
  } else {
    row.classList.remove('failed');
    if (retryBtn) {
      retryBtn.remove();
    }
  }
}

// ═══════════════════════════════════════════════════════════════════
// Media Sharing & Attachment Helpers (Phase 4-10)
// ═══════════════════════════════════════════════════════════════════

/**
 * Resolves presigned download URL for an attachment and caches it.
 * @param {string} roomId
 * @param {string} attachmentId
 * @returns {Promise<string|null>}
 */
async function resolveAttachmentUrl(roomId, attachmentId) {
  if (!attachmentId || !roomId) return null;
  if (attachmentUrls.has(attachmentId)) {
    return attachmentUrls.get(attachmentId);
  }
  if (pendingUrlResolutions.has(attachmentId)) {
    return null;
  }
  pendingUrlResolutions.add(attachmentId);
  attachmentErrors.delete(attachmentId);

  try {
    const res = await window.ollacoreDesktop?.chatApi?.downloadAttachment(roomId, attachmentId);
    const url = res?.downloadUrl || res?.download_url;
    if (url) {
      attachmentUrls.set(attachmentId, url);
      attachmentErrors.delete(attachmentId);
      updateMediaPlaceholdersInDom(attachmentId, url, roomId);
      return url;
    } else {
      const errText = 'Voice message unavailable';
      attachmentErrors.set(attachmentId, errText);
      updateMediaPlaceholdersInDom(attachmentId, null, roomId, errText);
    }
  } catch (err) {
    console.warn('Failed to resolve attachment URL:', err?.message || err);
    const errText = 'Unable to load voice message';
    attachmentErrors.set(attachmentId, errText);
    updateMediaPlaceholdersInDom(attachmentId, null, roomId, errText);
  } finally {
    pendingUrlResolutions.delete(attachmentId);
  }
  return null;
}

/**
 * Creates a WhatsApp-style interactive voice note player element.
 */
function createVoiceNotePlayerElement(resolvedUrl, initialDurationSec = 0, attachmentId = null, msgRoomId = null) {
  const player = document.createElement('div');
  player.className = 'voice-note-player';

  const playBtn = document.createElement('button');
  playBtn.type = 'button';
  playBtn.className = 'voice-note-play-btn';
  playBtn.title = 'Play voice message';
  playBtn.textContent = '▶';

  const body = document.createElement('div');
  body.className = 'voice-note-body';

  const sliderContainer = document.createElement('div');
  sliderContainer.className = 'voice-note-slider-container';

  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = '0';
  slider.max = '1000';
  slider.value = '0';
  slider.className = 'voice-note-slider';
  slider.setAttribute('aria-label', 'Voice message progress');
  sliderContainer.appendChild(slider);

  const meta = document.createElement('div');
  meta.className = 'voice-note-meta';

  let effectiveDuration = (Number(initialDurationSec) > 0 && isFinite(initialDurationSec)) ? Number(initialDurationSec) : 0;

  const timeLabel = document.createElement('span');
  timeLabel.className = 'voice-note-time';
  timeLabel.textContent = `0:00 / ${VoiceRecorder.formatDuration(effectiveDuration)}`;

  const speedBtn = document.createElement('button');
  speedBtn.type = 'button';
  speedBtn.className = 'voice-note-speed-btn';
  speedBtn.title = 'Playback speed';
  speedBtn.textContent = '1x';

  meta.appendChild(timeLabel);
  meta.appendChild(speedBtn);

  body.appendChild(sliderContainer);
  body.appendChild(meta);

  const audio = document.createElement('audio');
  audio.preload = 'metadata';
  audio.src = resolvedUrl;

  slider.disabled = effectiveDuration <= 0 && (!audio.duration || isNaN(audio.duration) || audio.readyState < 1);

  const updateDurationState = () => {
    if (isFinite(audio.duration) && audio.duration > 0) {
      effectiveDuration = audio.duration;
      slider.disabled = false;
      if (audio.paused && (!audio.currentTime || audio.currentTime === 0)) {
        timeLabel.textContent = `0:00 / ${VoiceRecorder.formatDuration(effectiveDuration)}`;
      }
    }
  };

  audio.addEventListener('loadedmetadata', updateDurationState);
  audio.addEventListener('durationchange', updateDurationState);
  audio.addEventListener('canplay', updateDurationState);

  playBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (audio.paused) {
      if (activeVoiceAudio && activeVoiceAudio !== audio) {
        try {
          activeVoiceAudio.pause();
        } catch { }
      }
      activeVoiceAudio = audio;
      audio.play().catch((err) => console.warn('Voice playback failed:', err));
    } else {
      audio.pause();
    }
  });

  audio.addEventListener('play', () => {
    playBtn.textContent = '❚❚';
  });

  audio.addEventListener('pause', () => {
    playBtn.textContent = '▶';
  });

  audio.addEventListener('timeupdate', () => {
    if (effectiveDuration > 0 && isFinite(audio.currentTime)) {
      slider.value = (audio.currentTime / effectiveDuration) * 1000;
      timeLabel.textContent = `${VoiceRecorder.formatDuration(audio.currentTime)} / ${VoiceRecorder.formatDuration(effectiveDuration)}`;
    }
  });

  audio.addEventListener('ended', () => {
    playBtn.textContent = '▶';
    slider.value = 0;
    audio.currentTime = 0;
    timeLabel.textContent = `0:00 / ${VoiceRecorder.formatDuration(effectiveDuration)}`;
  });

  const handleSeek = (ratio) => {
    if (effectiveDuration > 0 && isFinite(ratio)) {
      const targetTime = Math.max(0, Math.min(effectiveDuration, ratio * effectiveDuration));
      audio.currentTime = targetTime;
      slider.value = ratio * 1000;
      timeLabel.textContent = `${VoiceRecorder.formatDuration(audio.currentTime)} / ${VoiceRecorder.formatDuration(effectiveDuration)}`;
    }
  };

  slider.addEventListener('input', (e) => {
    e.stopPropagation();
    handleSeek(Number(slider.value) / 1000);
  });

  slider.addEventListener('change', (e) => {
    e.stopPropagation();
  });

  slider.addEventListener('click', (e) => {
    e.stopPropagation();
  });

  slider.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
  });

  sliderContainer.addEventListener('click', (e) => {
    e.stopPropagation();
    if (e.target === slider) return;
    const rect = slider.getBoundingClientRect();
    if (rect.width > 0 && effectiveDuration > 0) {
      const clickX = e.clientX - rect.left;
      const ratio = Math.max(0, Math.min(1, clickX / rect.width));
      handleSeek(ratio);
    }
  });

  const speeds = [1, 1.5, 2];
  let speedIdx = 0;
  speedBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    speedIdx = (speedIdx + 1) % speeds.length;
    const s = speeds[speedIdx];
    audio.playbackRate = s;
    speedBtn.textContent = `${s}x`;
  });

  let audioRetryCount = 0;
  audio.addEventListener('error', async () => {
    console.warn('Voice audio load error:', attachmentId);
    if (attachmentId && audioRetryCount < 1) {
      audioRetryCount++;
      attachmentUrls.delete(attachmentId);
      const roomId = msgRoomId || shellState.selectedRoomId;
      if (roomId) {
        const freshUrl = await resolveAttachmentUrl(roomId, attachmentId);
        if (freshUrl) {
          audio.src = freshUrl;
          audio.load();
          return;
        }
      }
    }
    timeLabel.textContent = 'Error';
    playBtn.disabled = true;
    playBtn.title = 'Audio load failed';
  });

  player.appendChild(playBtn);
  player.appendChild(body);
  player.appendChild(audio);
  return player;
}

/**
 * Replaces loading placeholder elements in the DOM once a download URL is available.
 * @param {string} attachmentId
 * @param {string|null} url
 * @param {string|null} [roomId=null]
 * @param {string|null} [errorText=null]
 */
function updateMediaPlaceholdersInDom(attachmentId, url, roomId = null, errorText = null) {
  if (!attachmentId) return;
  const effectiveRoomId = roomId || shellState.selectedRoomId;
  const placeholders = document.querySelectorAll(`[data-attachment-id="${attachmentId}"]`);
  for (const ph of placeholders) {
    const parent = ph.parentElement;
    if (!parent) continue;

    if (url) {
      if (parent.classList.contains('message-image-container')) {
        const img = document.createElement('img');
        img.className = 'message-image-thumb';
        img.src = url;
        img.alt = 'Photo';
        img.loading = 'lazy';
        img.addEventListener('click', (e) => {
          e.stopPropagation();
          const caption = parent.querySelector('.message-image-caption')?.textContent || '';
          openImagePreview(url, 'Photo', caption);
        });
        img.addEventListener('error', () => {
          console.warn('Image failed to load, clearing cached URL:', attachmentId);
          attachmentUrls.delete(attachmentId);
        });
        ph.replaceWith(img);
      } else if (parent.classList.contains('message-video-container')) {
        const video = document.createElement('video');
        video.className = 'message-video';
        video.controls = true;
        video.playsInline = true;
        video.preload = 'metadata';
        video.src = url;
        video.addEventListener('error', () => {
          console.warn('Video failed to load, clearing cached URL:', attachmentId);
          attachmentUrls.delete(attachmentId);
        });
        ph.replaceWith(video);
      } else if (parent.classList.contains('message-voice-note-container')) {
        let duration = 0;
        const targetState = effectiveRoomId ? roomMessagesMap.get(effectiveRoomId) : activeRoomMessagesState;
        const msgs = targetState?.messages || activeRoomMessagesState?.messages || [];
        const msg = msgs.find(m => {
          const body = m.body && typeof m.body === 'object' ? m.body : {};
          const aid = m.attachmentId || m.attachment_id || body.attachmentId || body.attachment_id;
          const aids = m.attachment_ids || m.attachmentIds || body.attachment_ids || body.attachmentIds || [];
          return aid === attachmentId || (Array.isArray(aids) && aids.includes(attachmentId));
        });
        if (msg) {
          const body = msg.body && typeof msg.body === 'object' ? msg.body : {};
          duration = Number(body.duration ?? msg.duration ?? 0);
        }
        const player = createVoiceNotePlayerElement(url, duration, attachmentId, effectiveRoomId);
        ph.replaceWith(player);
      } else if (parent.classList.contains('message-audio-container')) {
        const audio = document.createElement('audio');
        audio.className = 'message-audio';
        audio.controls = true;
        audio.preload = 'metadata';
        audio.src = url;
        audio.addEventListener('error', () => {
          console.warn('Audio failed to load, clearing cached URL:', attachmentId);
          attachmentUrls.delete(attachmentId);
        });
        ph.replaceWith(audio);
      }
    } else if (errorText) {
      ph.innerHTML = '';
      ph.classList.add('media-error-placeholder');
      const label = document.createElement('span');
      label.className = 'media-error-label';
      label.textContent = errorText;
      const retryBtn = document.createElement('button');
      retryBtn.type = 'button';
      retryBtn.className = 'btn-retry-media-load';
      retryBtn.textContent = '↻ Retry';
      retryBtn.title = 'Retry loading media';
      retryBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        attachmentErrors.delete(attachmentId);
        attachmentUrls.delete(attachmentId);
        pendingUrlResolutions.delete(attachmentId);
        const isVoice = parent.classList.contains('message-voice-note-container');
        ph.innerHTML = `<span class="spinner spinner-sm"></span><span>Loading ${isVoice ? 'voice message' : 'media'}...</span>`;
        ph.classList.remove('media-error-placeholder');
        if (effectiveRoomId) resolveAttachmentUrl(effectiveRoomId, attachmentId);
      });
      ph.appendChild(label);
      ph.appendChild(retryBtn);
    }
  }

  // Update file cards with resolved download URL
  if (url) {
    const fileCards = messagesList.querySelectorAll(`.message-file-card[data-attachment-id="${attachmentId}"]`);
    for (const card of fileCards) {
      card.setAttribute('data-resolved-url', url);
    }
  }
}

/**
 * Opens image preview lightbox modal.
 * @param {string} url
 * @param {string} [filename='Image']
 * @param {string} [caption='']
 */
function openImagePreview(url, filename = 'Image', caption = '') {
  if (!imagePreviewModal || !previewImgElement) return;
  previewImgElement.src = url;
  if (previewFilename) previewFilename.textContent = filename || 'Image';
  if (previewCaption) {
    if (caption) {
      previewCaption.textContent = caption;
      previewCaption.classList.remove('hidden');
    } else {
      previewCaption.textContent = '';
      previewCaption.classList.add('hidden');
    }
  }
  imagePreviewModal.classList.remove('hidden');
}

/**
 * Closes image preview lightbox modal.
 */
function closeImagePreview() {
  if (!imagePreviewModal) return;
  imagePreviewModal.classList.add('hidden');
  if (previewImgElement) previewImgElement.src = '';
}

/**
 * Opens a file attachment (such as PDF) using the Windows default registered application.
 * Checks local cache first; if not present, downloads to the cache directory and opens.
 * Does NOT prompt with a Save As dialog.
 * @param {string|null} attachmentId
 * @param {string} filename
 * @param {string|null} knownUrl
 * @param {string|null} [targetRoomId]
 * @param {HTMLElement|null} [cardElement]
 * @param {string} [mime='']
 */
async function handleOpenFile(attachmentId, filename, knownUrl, targetRoomId = null, cardElement = null, mime = '') {
  const roomId = targetRoomId || shellState.selectedRoomId;
  let downloadUrl = knownUrl || (attachmentId ? attachmentUrls.get(attachmentId) : null);

  if (!downloadUrl && attachmentId && roomId) {
    if (cardElement) cardElement.classList.add('opening-file');
    try {
      downloadUrl = await resolveAttachmentUrl(roomId, attachmentId);
    } catch {
      // Ignored; main process can also attempt resolution
    } finally {
      if (cardElement) cardElement.classList.remove('opening-file');
    }
  }

  // 1. Primary: Use main-process managed cache and shell.openPath via media.openAttachment
  if (window.ollacoreDesktop?.media?.openAttachment || window.ollacoreDesktop?.dialog?.openAttachment) {
    const openFn = window.ollacoreDesktop.media?.openAttachment || window.ollacoreDesktop.dialog?.openAttachment;
    if (cardElement) cardElement.classList.add('opening-file');
    try {
      const res = await openFn({
        attachmentId,
        filename,
        downloadUrl,
        roomId,
        mime
      });
      if (res?.ok) {
        return;
      }
      const errorMsg = res?.error || 'Failed to open file with default application';
      alert(`Unable to open "${filename}": ${errorMsg}`);
      return;
    } catch (err) {
      console.warn('Native openAttachment error:', err);
      alert(`Unable to open "${filename}": ${err?.message || 'Unexpected error'}`);
      return;
    } finally {
      if (cardElement) cardElement.classList.remove('opening-file');
    }
  }

  // 2. Fallback: Electron shell openPath if local path or openExternal
  if (window.ollacoreDesktop?.shell?.openExternal && downloadUrl) {
    try {
      await window.ollacoreDesktop.shell.openExternal(downloadUrl);
      return;
    } catch (err) {
      console.warn('Shell openExternal fallback failed:', err);
    }
  }

  // 3. Browser fallback
  if (downloadUrl) {
    window.open(downloadUrl, '_blank');
  } else {
    alert(`Attachment "${filename}" is currently unavailable.`);
  }
}

/**
 * Safely downloads an attachment to disk.
 * @param {string|null} attachmentId
 * @param {string} filename
 * @param {string|null} knownUrl
 * @param {string|null} [targetRoomId]
 */
async function handleDownloadFile(attachmentId, filename, knownUrl, targetRoomId = null) {
  let downloadUrl = knownUrl || (attachmentId ? attachmentUrls.get(attachmentId) : null);
  const roomId = targetRoomId || shellState.selectedRoomId;
  if (!downloadUrl && attachmentId && roomId) {
    downloadUrl = await resolveAttachmentUrl(roomId, attachmentId);
  }
  if (!downloadUrl) {
    alert('Unable to resolve download URL for this attachment.');
    return;
  }

  // 1. Native Electron safe save dialog
  if (window.ollacoreDesktop?.dialog?.saveMediaFile) {
    try {
      const res = await window.ollacoreDesktop.dialog.saveMediaFile({
        defaultFilename: filename || 'download',
        downloadUrl
      });
      if (res?.ok && res.savedPath) {
        console.log('File successfully saved:', res.savedPath);
        if (window.ollacoreDesktop?.shell?.showItemInFolder) {
          window.ollacoreDesktop.shell.showItemInFolder(res.savedPath);
        }
      }
      return;
    } catch (err) {
      console.warn('Native save dialog failed, using fallback:', err);
    }
  }

  // 2. Electron shell open in external browser
  if (window.ollacoreDesktop?.shell?.openExternal) {
    try {
      await window.ollacoreDesktop.shell.openExternal(downloadUrl);
      return;
    } catch (err) {
      console.warn('Shell openExternal fallback failed:', err);
    }
  }

  // 3. Browser/sandbox download fallback
  const a = document.createElement('a');
  a.href = downloadUrl;
  a.download = filename || 'download';
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

/**
 * Toggles attachment options popover menu.
 */
function toggleAttachmentMenu() {
  if (!attachmentMenuPopover) return;
  const selectedConv = shellState.getSelectedConversation();
  if (selectedConv?.isExited || selectedConv?.exited) return;
  const isHidden = attachmentMenuPopover.classList.contains('hidden');
  if (isHidden) {
    emojiPicker?.close();
    attachmentMenuPopover.classList.remove('hidden');
    btnAttachmentPicker?.setAttribute('aria-expanded', 'true');
  } else {
    hideAttachmentMenu();
  }
}

/**
 * Closes attachment options popover menu.
 */
function hideAttachmentMenu() {
  if (!attachmentMenuPopover) return;
  attachmentMenuPopover.classList.add('hidden');
  btnAttachmentPicker?.setAttribute('aria-expanded', 'false');
}

/**
 * Shows upload progress bar above composer.
 * @param {string} filename
 * @param {number} [percent=0]
 */
function showUploadProgress(filename, percent = 0) {
  if (!composerUploadBar) return;
  composerUploadBar.classList.remove('hidden');
  if (uploadFilename) uploadFilename.textContent = filename || 'Uploading...';
  if (uploadPercent) uploadPercent.textContent = `${Math.round(percent)}%`;
  if (uploadProgressFill) uploadProgressFill.style.width = `${Math.round(percent)}%`;
}

/**
 * Updates upload progress bar.
 * @param {number} percent
 */
function updateUploadProgress(percent) {
  const p = Math.max(0, Math.min(100, Math.round(percent)));
  if (uploadPercent) uploadPercent.textContent = `${p}%`;
  if (uploadProgressFill) uploadProgressFill.style.width = `${p}%`;
}

/**
 * Hides upload progress bar.
 */
function hideUploadProgress() {
  if (!composerUploadBar) return;
  composerUploadBar.classList.add('hidden');
  if (uploadProgressFill) uploadProgressFill.style.width = '0%';
  if (uploadPercent) uploadPercent.textContent = '0%';
}

/**
 * Handles picking an attachment by category.
 * @param {'photos_videos' | 'documents' | 'audio'} category
 */
async function handlePickAttachment(category) {
  hideAttachmentMenu();

  // Try Electron native file picker dialog first
  if (window.ollacoreDesktop?.dialog?.openMediaFile) {
    try {
      const res = await window.ollacoreDesktop.dialog.openMediaFile({ category });
      if (res?.canceled) return;
      if (res && res.ok === false) {
        alert(`Cannot attach file: ${res.error || 'Validation failed'}`);
        return;
      }
      if (res?.fileId || res?.filePath) {
        await processAndUploadFile({
          fileId: res.fileId,
          filePath: res.filePath,
          filename: res.filename,
          byteSize: res.byteSize,
          declaredMime: res.mime,
          previewUrl: res.previewUrl,
          kind: res.kind
        });
        return;
      }
    } catch (err) {
      console.warn('Native file picker failed, falling back to input:', err);
    }
  }

  // Fallback: trigger hidden input[type=file]
  if (composerFileInput) {
    if (category === 'photos_videos') {
      composerFileInput.accept = 'image/*,video/*';
    } else if (category === 'audio') {
      composerFileInput.accept = 'audio/*';
    } else if (category === 'documents') {
      composerFileInput.accept = '.pdf,.zip,.rar,.gz,.tar,.txt,.csv,.json,.xml,.doc,.docx,.xls,.xlsx,.ppt,.pptx';
    } else {
      composerFileInput.accept = '*/*';
    }
    composerFileInput.click();
  }
}

/**
 * Validates, uploads, and sends a media attachment message.
 * @param {object} params
 * @param {string} [params.fileId]
 * @param {string} [params.filePath]
 * @param {File} [params.file]
 * @param {string} [params.filename]
 * @param {number} [params.byteSize]
 * @param {string} [params.declaredMime]
 * @param {string|null} [params.previewUrl]
 * @param {string|null} [params.kind]
 */
async function processAndUploadFile({ fileId, filePath, file, filename, byteSize, declaredMime = '', previewUrl = null, kind: declaredKind = null }) {
  const targetRoomId = shellState.selectedRoomId;
  if (!targetRoomId) {
    alert('Please select a conversation before attaching media.');
    return;
  }

  const name = filename || file?.name || (filePath ? filePath.split(/[/\\]/).pop() : 'file');
  const size = byteSize ?? file?.size ?? 0;
  const mime = declaredMime || file?.type || '';

  // 1. Client-side security and format validation
  const validation = validateMediaFile({
    filename: name,
    byteSize: size,
    declaredMime: mime
  });

  if (!validation.isValid) {
    alert(`Cannot send file: ${validation.error}`);
    return;
  }

  const kind = declaredKind || validation.kind;
  const effectiveMime = validation.effectiveMime || mime;
  const currentUserId = roomMessagesState.currentUserId || shellState.currentUser?.userId || shellState.userProfile?.userId || '';
  const clientMessageId = `local-${generateUuid()}`;

  // Establish local preview URL before creating message/rendering
  let localUrl = previewUrl || null;
  if (!localUrl && file && (kind === 'image' || kind === 'video' || kind === 'audio')) {
    try {
      localUrl = URL.createObjectURL(file);
    } catch {
      // Ignore URL.createObjectURL errors in non-browser env
    }
  }
  if (localUrl) {
    attachmentUrls.set(clientMessageId, localUrl);
  }

  // 2. Create optimistic message & add to chat immediately
  const optimisticMsg = createOptimisticMediaMessage(targetRoomId, currentUserId, {
    kind,
    filename: name,
    caption: '',
    mime: effectiveMime,
    byteSize: size,
    clientMessageId
  });

  roomMessagesState.addOptimisticMessage(optimisticMsg);
  persistMessageToDb(optimisticMsg, targetRoomId).catch(() => { });
  messagesEmpty?.classList.add('hidden');
  messagesScrollArea?.classList.remove('hidden');
  renderMessages();
  scrollToBottom(true);
  dismissUnreadDivider(targetRoomId);
  if (mediaBrowserPanel && !mediaBrowserPanel.classList.contains('hidden') && activeMbRoomId === targetRoomId) {
    _populateMbTab(activeMbTab, targetRoomId);
  }

  if (localUrl) {
    updateMediaPlaceholdersInDom(clientMessageId, localUrl);
  }

  // 3. Show upload progress in composer
  showUploadProgress(name, 0);

  const wireKind = (kind === 'audio') ? 'file' : kind;

  // Store for retry & ACK tracking
  pendingPayloads.set(clientMessageId, {
    roomId: targetRoomId,
    kind: wireKind,
    body: {
      text: name,
      caption: '',
      filename: name,
      mime: effectiveMime,
      byte_size: size
    },
    attachmentIds: [],
    clientMessageId
  });

  try {
    let uploadRes;

    if ((fileId || filePath) && window.ollacoreDesktop?.chatApi?.uploadMedia) {
      uploadRes = await window.ollacoreDesktop.chatApi.uploadMedia({
        roomId: targetRoomId,
        fileId,
        filePath,
        filename: name,
        declaredMime: effectiveMime,
        byteSize: size
      });
    } else if (file) {
      if (window.ollacoreDesktop?.chatApi?.uploadMedia && typeof file.arrayBuffer === 'function') {
        const arrayBuf = await file.arrayBuffer();
        const uint8 = new Uint8Array(arrayBuf);
        uploadRes = await window.ollacoreDesktop.chatApi.uploadMedia({
          roomId: targetRoomId,
          fileBuffer: uint8,
          filename: name,
          declaredMime: effectiveMime,
          byteSize: size
        });
      } else if (window.ollacoreDesktop?.chatApi?.initAttachment) {
        // Direct init -> PUT -> complete fallback
        const init = await window.ollacoreDesktop.chatApi.initAttachment(targetRoomId, {
          filename: name,
          mime: effectiveMime,
          byteSize: size
        });
        const uploadUrl = init?.uploadUrl || init?.upload_url;
        const attachmentId = init?.attachmentId || init?.attachment_id;
        await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': effectiveMime }, body: file });
        await window.ollacoreDesktop.chatApi.completeAttachment(targetRoomId, attachmentId);
        // Verify attachment readiness via downloadAttachment polling
        if (window.ollacoreDesktop?.chatApi?.downloadAttachment) {
          for (let attempt = 0; attempt < 8; attempt++) {
            try {
              const dl = await window.ollacoreDesktop.chatApi.downloadAttachment(targetRoomId, attachmentId);
              if (dl?.downloadUrl || dl?.download_url) {
                attachmentUrls.set(attachmentId, dl.downloadUrl || dl.download_url);
                break;
              }
            } catch { }
            await new Promise(r => setTimeout(r, 250));
          }
        }
        uploadRes = { ok: true, data: { attachmentId, filename: name, mime: effectiveMime, byteSize: size, kind } };
      } else {
        throw new Error('Upload API not available in current environment');
      }
    } else {
      throw new Error('No valid file source to upload');
    }

    const data = uploadRes?.data || uploadRes;
    const attachmentId = data?.attachmentId || data?.attachment_id;
    if (!attachmentId) {
      throw new Error(uploadRes?.error?.message || 'Upload did not return an attachment ID');
    }

    hideUploadProgress();

    // Map attachment ID to resolved download URL or cached local preview URL
    const downloadUrl = data?.downloadUrl || data?.download_url;
    if (downloadUrl) {
      attachmentUrls.set(attachmentId, downloadUrl);
      updateMediaPlaceholdersInDom(attachmentId, downloadUrl, targetRoomId);
    } else if (attachmentUrls.has(clientMessageId)) {
      attachmentUrls.set(attachmentId, attachmentUrls.get(clientMessageId));
    }

    // 4. Send message through WebSocket using verified payload contract
    const messageBody = {
      text: name,
      mime: effectiveMime,
      filename: name,
      byte_size: size
    };

    const wireKind = (kind === 'audio') ? 'file' : kind;
    const payload = {
      client_message_id: clientMessageId,
      kind: wireKind,
      body: messageBody,
      reply_to: null,
      attachment_ids: [attachmentId]
    };

    // Update pending payload with the real attachmentId
    const pending = pendingPayloads.get(clientMessageId);
    if (pending) {
      pending.attachmentIds = [attachmentId];
      pending.body = messageBody;
    }

    // Update message in state with attachment ID
    const msgInState = roomMessagesState.messages.find(m => m.clientMessageId === clientMessageId);
    if (msgInState) {
      msgInState.attachmentIds = [attachmentId];
      msgInState.attachment_ids = [attachmentId];
      msgInState.attachments = [{
        attachmentId,
        attachment_id: attachmentId,
        filename: name,
        mime: effectiveMime,
        byteSize: size,
        byte_size: size
      }];
    }

    // Persist pending outbox record to SQLite BEFORE attempting network delivery
    await outboxManager.enqueue({
      clientMessageId,
      roomId: targetRoomId,
      wirePayload: payload,
      optimisticMsg: msgInState || optimisticMsg
    });

    const wsState = await window.ollacoreDesktop?.chat?.getState();
    if (wsState !== 'connected' || (typeof navigator !== 'undefined' && !navigator.onLine)) {
      roomMessagesState.updateReceipt(clientMessageId, 'pending');
      persistMessageStatusToDb(clientMessageId, 'pending').catch(() => { });
      if (shellState.selectedRoomId === targetRoomId) {
        updateMessageStatusInDom(clientMessageId, 'pending');
      }
      return;
    }

    const sendRes = await window.ollacoreDesktop?.chat?.send('message.send', payload, targetRoomId);
    if (sendRes?.ok && sendRes?.requestId) {
      requestToClient.set(sendRes.requestId, clientMessageId);
    } else {
      roomMessagesState.updateReceipt(clientMessageId, 'pending');
      persistMessageStatusToDb(clientMessageId, 'pending').catch(() => { });
      if (shellState.selectedRoomId === targetRoomId) {
        updateMessageStatusInDom(clientMessageId, 'pending');
      }
    }
  } catch (err) {
    console.error('Error during media upload/send:', err);
    hideUploadProgress();
    roomMessagesState.updateReceipt(clientMessageId, 'pending');
    persistMessageStatusToDb(clientMessageId, 'pending').catch(() => { });
    if (shellState.selectedRoomId === targetRoomId) {
      updateMessageStatusInDom(clientMessageId, 'pending');
    }
  }
}

/**
 * Processes, uploads, and sends a recorded voice message.
 */
async function processAndUploadVoiceNote({ blob, duration, mimeType }) {
  const targetRoomId = shellState.selectedRoomId;
  if (!targetRoomId) {
    alert('Please select a conversation before sending a voice message.');
    return;
  }

  const effectiveMime = mimeType || 'audio/webm;codecs=opus';
  const filename = `voice_message_${Date.now()}.webm`;
  const size = blob.size;
  const roundedDuration = Math.max(1, Math.round(duration));
  const currentUserId = roomMessagesState.currentUserId || shellState.currentUser?.userId || shellState.userProfile?.userId || '';
  const clientMessageId = `local-${generateUuid()}`;

  // 1. Create optimistic voice message & add to chat immediately
  const optimisticMsg = createOptimisticVoiceMessage(targetRoomId, currentUserId, {
    filename,
    mime: effectiveMime,
    byteSize: size,
    duration: roundedDuration,
    clientMessageId
  });

  roomMessagesState.addOptimisticMessage(optimisticMsg);
  persistMessageToDb(optimisticMsg, targetRoomId).catch(() => { });
  messagesEmpty?.classList.add('hidden');
  messagesScrollArea?.classList.remove('hidden');
  renderMessages();
  scrollToBottom(true);
  dismissUnreadDivider(targetRoomId);

  // 2. Local instant blob preview URL for immediate playback in the optimistic bubble
  try {
    const localUrl = URL.createObjectURL(blob);
    attachmentUrls.set(clientMessageId, localUrl);
    updateMediaPlaceholdersInDom(clientMessageId, localUrl);
  } catch { }

  // 3. Update sidebar conversation preview
  const conv = shellState.conversations.find((c) => c.roomId === targetRoomId);
  if (conv) {
    conv.lastMessage = {
      preview: '🎤 Voice message',
      senderId: currentUserId,
      createdAt: optimisticMsg.createdAt,
      kind: 'audio'
    };
    renderConversationList();
    persistConversationToDb(conv).catch(() => { });
  }

  // Store for retry & ACK tracking
  pendingPayloads.set(clientMessageId, {
    roomId: targetRoomId,
    kind: 'file',
    body: {
      text: 'Voice message',
      filename,
      mime: effectiveMime,
      byte_size: size,
      duration: roundedDuration,
      is_voice_note: true
    },
    attachmentIds: [],
    clientMessageId
  });

  try {
    let uploadRes;
    if (window.ollacoreDesktop?.chatApi?.uploadMedia && typeof blob.arrayBuffer === 'function') {
      const arrayBuf = await blob.arrayBuffer();
      const uint8 = new Uint8Array(arrayBuf);
      uploadRes = await window.ollacoreDesktop.chatApi.uploadMedia({
        roomId: targetRoomId,
        fileBuffer: uint8,
        filename,
        declaredMime: effectiveMime,
        byteSize: size
      });
    } else if (window.ollacoreDesktop?.chatApi?.initAttachment) {
      const initMime = effectiveMime.includes('webm') ? 'video/webm' : effectiveMime;
      const init = await window.ollacoreDesktop.chatApi.initAttachment(targetRoomId, {
        filename,
        mime: initMime,
        byteSize: size
      });
      const uploadUrl = init?.uploadUrl || init?.upload_url;
      const attachmentId = init?.attachmentId || init?.attachment_id;
      await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': initMime }, body: blob });
      await window.ollacoreDesktop.chatApi.completeAttachment(targetRoomId, attachmentId);
      // Verify attachment readiness via downloadAttachment polling
      if (window.ollacoreDesktop?.chatApi?.downloadAttachment) {
        for (let attempt = 0; attempt < 8; attempt++) {
          try {
            const dl = await window.ollacoreDesktop.chatApi.downloadAttachment(targetRoomId, attachmentId);
            if (dl?.downloadUrl || dl?.download_url) {
              attachmentUrls.set(attachmentId, dl.downloadUrl || dl.download_url);
              break;
            }
          } catch { }
          await new Promise(r => setTimeout(r, 250));
        }
      }
      uploadRes = { ok: true, data: { attachmentId, filename, mime: effectiveMime, byteSize: size, kind: 'audio' } };
    } else {
      throw new Error('Upload API not available in current environment');
    }

    const data = uploadRes?.data || uploadRes;
    const attachmentId = data?.attachmentId || data?.attachment_id;
    if (!attachmentId) {
      throw new Error(uploadRes?.error?.message || 'Upload did not return an attachment ID');
    }

    // Map attachment ID to resolved download URL or cached local preview URL
    const downloadUrl = data?.downloadUrl || data?.download_url;
    if (downloadUrl) {
      attachmentUrls.set(attachmentId, downloadUrl);
      updateMediaPlaceholdersInDom(attachmentId, downloadUrl, targetRoomId);
    } else if (attachmentUrls.has(clientMessageId)) {
      attachmentUrls.set(attachmentId, attachmentUrls.get(clientMessageId));
    }

    // 4. Send message through WebSocket using verified backend contract:
    // wire kind: "file", body contains is_voice_note: true and duration
    const messageBody = {
      text: 'Voice message',
      filename,
      mime: effectiveMime,
      byte_size: size,
      duration: roundedDuration,
      is_voice_note: true
    };

    const payload = {
      client_message_id: clientMessageId,
      kind: 'file',
      body: messageBody,
      reply_to: null,
      attachment_ids: [attachmentId]
    };

    const pending = pendingPayloads.get(clientMessageId);
    if (pending) {
      pending.attachmentIds = [attachmentId];
      pending.body = messageBody;
    }

    const msgInState = roomMessagesState.messages.find(m => m.clientMessageId === clientMessageId);
    if (msgInState) {
      msgInState.attachmentIds = [attachmentId];
      msgInState.attachment_ids = [attachmentId];
      msgInState.attachments = [{
        attachmentId,
        attachment_id: attachmentId,
        filename,
        mime: effectiveMime,
        byteSize: size,
        byte_size: size
      }];
    }

    // Persist pending outbox record to SQLite BEFORE attempting network delivery
    await outboxManager.enqueue({
      clientMessageId,
      roomId: targetRoomId,
      wirePayload: payload,
      optimisticMsg: msgInState || optimisticMsg
    });

    const wsState = await window.ollacoreDesktop?.chat?.getState();
    if (wsState !== 'connected' || (typeof navigator !== 'undefined' && !navigator.onLine)) {
      roomMessagesState.updateReceipt(clientMessageId, 'pending');
      persistMessageStatusToDb(clientMessageId, 'pending').catch(() => { });
      if (shellState.selectedRoomId === targetRoomId) {
        updateMessageStatusInDom(clientMessageId, 'pending');
      }
      return;
    }

    const sendRes = await window.ollacoreDesktop?.chat?.send('message.send', payload, targetRoomId);
    if (sendRes?.ok && sendRes?.requestId) {
      requestToClient.set(sendRes.requestId, clientMessageId);
    } else {
      roomMessagesState.updateReceipt(clientMessageId, 'pending');
      persistMessageStatusToDb(clientMessageId, 'pending').catch(() => { });
      if (shellState.selectedRoomId === targetRoomId) {
        updateMessageStatusInDom(clientMessageId, 'pending');
      }
    }
  } catch (err) {
    console.error('Error uploading/sending voice note:', err);
    roomMessagesState.updateReceipt(clientMessageId, 'pending');
    persistMessageStatusToDb(clientMessageId, 'pending').catch(() => { });
    if (shellState.selectedRoomId === targetRoomId) {
      updateMessageStatusInDom(clientMessageId, 'pending');
    }
  }
}

// ═══════════════════════════════════════════════════════════════════
// Phase 4D: Message Composer & Outgoing Send Dispatch
// ═══════════════════════════════════════════════════════════════════

/**
 * Auto-resizes composer textarea up to 140px.
 */
function autoResizeComposer() {
  if (!composerInput) return;
  composerInput.style.height = 'auto';
  const newHeight = Math.min(composerInput.scrollHeight, 140);
  composerInput.style.height = `${Math.max(newHeight, 24)}px`;
}

/**
 * Updates the disabled and visibility state of composer send/mic buttons.
 */
function updateSendButtonState() {
  const hasText = composerInput && composerInput.value.trim().length > 0;
  const hasRoom = Boolean(shellState.selectedRoomId);

  if (editingMessage || hasText) {
    if (btnSendMessage) {
      btnSendMessage.classList.remove('hidden');
      btnSendMessage.disabled = !hasRoom;
      btnSendMessage.title = editingMessage ? 'Save' : 'Send message';
      btnSendMessage.innerHTML = editingMessage ? UI_ICONS.check : UI_ICONS.send;
    }
    if (btnVoiceRecord) {
      btnVoiceRecord.classList.add('hidden');
      btnVoiceRecord.disabled = true;
    }
  } else {
    if (btnSendMessage) {
      btnSendMessage.classList.add('hidden');
      btnSendMessage.disabled = true;
      btnSendMessage.title = 'Send message';
      btnSendMessage.innerHTML = UI_ICONS.send;
    }
    if (btnVoiceRecord) {
      btnVoiceRecord.classList.remove('hidden');
      btnVoiceRecord.disabled = !hasRoom;
    }
  }
}

/**
 * Sends a message from the composer to the active conversation.
 */
async function handleSendMessage() {
  console.log('[CHECKPOINT 2] handleSendMessage invoked', { selectedRoomId: shellState.selectedRoomId, hasComposer: Boolean(composerInput) });
  const targetRoomId = shellState.selectedRoomId;
  if (!targetRoomId) {
    console.warn('[CHECKPOINT 3 FAIL] targetRoomId is missing/null');
    return;
  }
  console.log('[CHECKPOINT 3] targetRoomId is valid:', targetRoomId);

  const selectedConv = shellState.getSelectedConversation();
  if (selectedConv?.isExited || selectedConv?.exited) {
    console.warn('[handleSendMessage] Cannot send message to an exited group');
    return;
  }

  if (shellState.isRoomBlocked(targetRoomId)) {
    // Note: shellState.isRoomBlocked(targetRoomId) is tracked.
    // Server authoritatively handles delivery suppression for blocked contacts.
    // Cannot send messages to a blocked contact if server policy rejects.
    console.log('[handleSendMessage] Sending message to room with block relationship:', targetRoomId);
  }

  if (editingMessage) {
    const activeUserId = roomMessagesState.currentUserId || shellState.currentUser?.userId || shellState.userProfile?.userId;
    if (!canEditMessage(editingMessage, activeUserId)) {
      showUserError('The 15-minute edit window for this message has expired.');
      exitEditMode();
      return;
    }

    const rawText = composerInput ? composerInput.value : '';
    const validation = validateComposerText(rawText);
    if (!validation.valid) return;

    const msgToEdit = editingMessage;
    const newText = validation.text;
    const currentResolved = resolveMessageContent(msgToEdit);
    const currentText = currentResolved.text || '';
    if (newText === currentText) {
      exitEditMode();
      if (composerInput) {
        composerInput.value = '';
        autoResizeComposer();
        updateSendButtonState();
      }
      return;
    }

    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      showUserError('Cannot edit messages while offline.');
      return;
    }

    const rId = msgToEdit.roomId || msgToEdit.room_id || targetRoomId;

    const targetState = getOrCreateRoomMessagesState(rId);
    const canonicalServerMessageId = await resolveCanonicalMessageId(rId, msgToEdit, {
      targetState,
      chatApi: window.ollacoreDesktop?.chatApi
    });

    if (!canonicalServerMessageId) {
      const errorMsg = 'Unable to edit message: could not resolve server message ID.';
      console.error('[handleSendMessage:edit]', errorMsg, { msgToEdit, rId });
      showUserError(errorMsg);
      return;
    }

    // Save snapshot of previous content for optimistic rollback
    const prevBody = msgToEdit.body ? { ...msgToEdit.body } : { text: currentText };
    const prevEditedAt = msgToEdit.editedAt || msgToEdit.edited_at || null;

    let updatedResult = null;
    try {
      if (!window.ollacoreDesktop?.chatApi?.editMessage) {
        throw new Error('Chat API service unavailable');
      }
      updatedResult = await window.ollacoreDesktop.chatApi.editMessage(
        rId,
        canonicalServerMessageId,
        { text: newText }
      );
    } catch (err) {
      console.error('[handleSendMessage:edit] Failed to edit message:', err);
      // Rollback memory/UI to previous authoritative content
      const rollbackPayload = {
        body: prevBody,
        editedAt: prevEditedAt,
        edited_at: prevEditedAt
      };
      targetState.updateMessage(canonicalServerMessageId, rollbackPayload);
      if (shellState.selectedRoomId === rId) {
        renderMessages();
      }
      showUserError(err?.message || 'Failed to edit message.');
      return;
    }

    // Only after REST PATCH succeeds:
    exitEditMode();

    if (composerInput) {
      composerInput.value = '';
      autoResizeComposer();
      updateSendButtonState();
    }
    stopLocalTyping(rId);
    emojiPicker?.close();
    roomComposerDrafts.delete(targetRoomId);

    const nowIso = updatedResult?.editedAt || updatedResult?.edited_at || new Date().toISOString();
    const clientMsgId = msgToEdit.clientMessageId || msgToEdit.client_message_id;

    const updatePayload = {
      body: { text: newText },
      editedAt: nowIso,
      edited_at: nowIso
    };
    if (updatedResult?.reactions) {
      updatePayload.reactions = updatedResult.reactions;
    }

    targetState.updateMessage(canonicalServerMessageId, updatePayload);
    if (clientMsgId && clientMsgId !== canonicalServerMessageId) {
      targetState.updateMessage(clientMsgId, updatePayload);
    }
    if (msgToEdit.id && msgToEdit.id !== canonicalServerMessageId) {
      targetState.updateMessage(msgToEdit.id, updatePayload);
    }
    persistMessageEditToDb(canonicalServerMessageId, { text: newText }, nowIso).catch(() => { });

    msgToEdit.id = canonicalServerMessageId;
    msgToEdit.body = { ...(msgToEdit.body || {}), text: newText };
    msgToEdit.editedAt = nowIso;
    msgToEdit.edited_at = nowIso;

    // Update reply cache if this message is referenced in replies
    if (canonicalServerMessageId && replyOriginalMessagesCache.has(String(canonicalServerMessageId))) {
      const cached = replyOriginalMessagesCache.get(String(canonicalServerMessageId));
      if (cached) {
        cached.body = { ...(cached.body || {}), text: newText };
        cached.editedAt = nowIso;
        cached.edited_at = nowIso;
      }
    }
    if (clientMsgId && replyOriginalMessagesCache.has(String(clientMsgId))) {
      const cached = replyOriginalMessagesCache.get(String(clientMsgId));
      if (cached) {
        cached.body = { ...(cached.body || {}), text: newText };
        cached.editedAt = nowIso;
        cached.edited_at = nowIso;
      }
    }

    if (shellState.selectedRoomId === rId) {
      renderMessages();
    }

    const conv = shellState.conversations.find((c) => c.roomId === rId);
    if (conv && conv.lastMessage) {
      conv.lastMessage.preview = newText;
      renderConversationList();
      persistConversationToDb(conv).catch(() => { });
    }
    return;
  }

  const rawText = composerInput ? composerInput.value : '';
  const validation = validateComposerText(rawText);
  if (!validation.valid) {
    console.warn('[CHECKPOINT 4 FAIL] Composer validation rejected input:', validation.error);
    return;
  }
  console.log('[CHECKPOINT 4] Composer validation passed, text length:', validation.text.length);

  let effectiveReplyTo = null;
  if (replyingToMessage) {
    effectiveReplyTo = replyingToMessage.id || replyingToMessage.clientMessageId || replyingToMessage.client_message_id;
    if (effectiveReplyTo) {
      replyOriginalMessagesCache.set(effectiveReplyTo, replyingToMessage);
    }
    exitReplyMode();
  }

  const currentUserId = roomMessagesState.currentUserId || shellState.currentUser?.userId || shellState.userProfile?.userId || '';
  const clientMessageId = `local-${generateUuid()}`;
  console.log('[CHECKPOINT 5] Generated clientMessageId:', clientMessageId);

  const optimisticMsg = createOptimisticMessage(
    targetRoomId,
    currentUserId,
    validation.text,
    clientMessageId
  );
  if (effectiveReplyTo) {
    optimisticMsg.replyTo = effectiveReplyTo;
    optimisticMsg.reply_to = effectiveReplyTo;
    optimisticMsg.replyToId = effectiveReplyTo;
    optimisticMsg.reply_to_id = effectiveReplyTo;
  }

  const isOffline = (typeof navigator !== 'undefined' && !navigator.onLine);
  if (isOffline) {
    optimisticMsg.status = 'pending';
    optimisticMsg.deliveryStatus = 'pending';
  }
  console.log('[CHECKPOINT 6] Created optimisticMsg:', { id: optimisticMsg.id, status: optimisticMsg.status });

  // Add optimistic message to room state & render immediately
  roomMessagesState.addOptimisticMessage(optimisticMsg);
  console.log('[CHECKPOINT 7] Added optimisticMsg to roomMessagesState, count:', roomMessagesState.messages.length);

  if (isOffline) {
    roomMessagesState.updateReceipt(clientMessageId, 'pending');
  }
  persistMessageToDb(optimisticMsg, targetRoomId).catch(() => { });
  messagesEmpty?.classList.add('hidden');
  messagesScrollArea?.classList.remove('hidden');
  appendMessageToDom(optimisticMsg);
  if (!findMessageDomElement(optimisticMsg)) {
    renderMessages();
  }
  const domRendered = Boolean(findMessageDomElement(optimisticMsg));
  console.log('[CHECKPOINT 8] Rendered in conversation DOM, found in DOM:', domRendered);

  scrollToBottom(false);
  dismissUnreadDivider(targetRoomId);

  // Clear composer & remove draft for this room
  if (composerInput) {
    composerInput.value = '';
    autoResizeComposer();
    updateSendButtonState();
  }
  stopLocalTyping(targetRoomId);
  emojiPicker?.close();
  roomComposerDrafts.delete(targetRoomId);
  console.log('[CHECKPOINT 14] Composer cleared, draft deleted, send button updated');

  // Update sidebar conversation preview with optimistic message
  const conv = shellState.conversations.find((c) => c.roomId === targetRoomId);
  if (conv) {
    conv.lastMessage = {
      preview: validation.text,
      senderId: currentUserId,
      createdAt: optimisticMsg.createdAt,
      kind: 'text'
    };
    renderConversationList();
    persistConversationToDb(conv).catch(() => { });
  }

  // Store for retry & ACK tracking
  pendingPayloads.set(clientMessageId, {
    roomId: targetRoomId,
    kind: 'text',
    text: validation.text,
    clientMessageId
  });

  const payload = {
    client_message_id: clientMessageId,
    kind: 'text',
    body: { text: validation.text },
    reply_to: effectiveReplyTo || null,
    attachment_ids: []
  };

  // Persist pending outbox record to SQLite BEFORE attempting network delivery
  console.log('[CHECKPOINT 9] Persisting to outboxManager...');
  const enqueueResult = await outboxManager.enqueue({
    clientMessageId,
    roomId: targetRoomId,
    wirePayload: payload,
    optimisticMsg
  });
  console.log('[CHECKPOINT 9] Outbox enqueue result:', enqueueResult);

  const sendRequestId = generateUuid();
  requestToClient.set(sendRequestId, clientMessageId);

  try {
    const wsState = await window.ollacoreDesktop?.chat?.getState();
    console.log('[CHECKPOINT 10] Invoking send, wsState:', wsState, 'sendRequestId:', sendRequestId);
    if (wsState !== 'connected' || (typeof navigator !== 'undefined' && !navigator.onLine)) {
      console.warn('[CHECKPOINT 10 WARNING] wsState is not connected:', wsState);
      requestToClient.delete(sendRequestId);
      // Disconnected: keep message pending locally, durable in SQLite outbox with clock icon
      roomMessagesState.updateReceipt(clientMessageId, 'pending');
      persistMessageStatusToDb(clientMessageId, 'pending').catch(() => { });
      if (shellState.selectedRoomId === targetRoomId) {
        updateMessageStatusInDom(clientMessageId, 'pending');
      }
      return;
    }

    const res = await window.ollacoreDesktop?.chat?.send('message.send', payload, targetRoomId, sendRequestId);
    console.log('[CHECKPOINT 10] chat.send response:', res);
    if (res?.ok && res?.requestId && res.requestId !== sendRequestId) {
      requestToClient.set(res.requestId, clientMessageId);
    } else if (!res?.ok) {
      console.warn('[CHECKPOINT 10 FAIL] chat.send returned not ok:', res?.error);
      const errStr = String(res?.error?.code || res?.error?.message || res?.error || res?.code || '').toLowerCase();
      const isBlockErr = errStr.includes('block');
      if (isBlockErr) {
        requestToClient.delete(sendRequestId);
        pendingPayloads.delete(clientMessageId);
        outboxManager.clear({ clientMessageId }).catch(() => { });
        roomMessagesState.updateReceipt(clientMessageId, 'sent', targetRoomId);
        persistMessageStatusToDb(clientMessageId, 'sent').catch(() => { });
        if (shellState.selectedRoomId === targetRoomId) {
          updateMessageStatusInDom(clientMessageId, 'sent');
        }
      } else {
        requestToClient.delete(sendRequestId);
        roomMessagesState.updateReceipt(clientMessageId, 'pending');
        persistMessageStatusToDb(clientMessageId, 'pending').catch(() => { });
        if (shellState.selectedRoomId === targetRoomId) {
          updateMessageStatusInDom(clientMessageId, 'pending');
        }
      }
    }

    if (recentUnmatchedAcks.has(sendRequestId) || recentUnmatchedAcks.has(clientMessageId)) {
      recentUnmatchedAcks.delete(sendRequestId);
      recentUnmatchedAcks.delete(clientMessageId);
      requestToClient.delete(sendRequestId);
      pendingPayloads.delete(clientMessageId);
      outboxManager.clear({ clientMessageId }).catch(() => { });
      roomMessagesState.updateReceipt(clientMessageId, 'sent', targetRoomId);
      persistMessageStatusToDb(clientMessageId, 'sent').catch(() => { });
      if (shellState.selectedRoomId === targetRoomId) {
        updateMessageStatusInDom(clientMessageId, 'sent');
      }
    }
  } catch (err) {
    requestToClient.delete(sendRequestId);
    console.error('[CHECKPOINT 10 ERROR] Error sending message via WebSocket:', err);
    roomMessagesState.updateReceipt(clientMessageId, 'pending');
    persistMessageStatusToDb(clientMessageId, 'pending').catch(() => { });
    if (shellState.selectedRoomId === targetRoomId) {
      updateMessageStatusInDom(clientMessageId, 'pending');
    }
  }
}

/**
 * Retries sending a previously failed message.
 * @param {string} clientMessageId
 */
async function handleRetryMessage(clientMessageId) {
  if (!clientMessageId) return;

  const pending = pendingPayloads.get(clientMessageId);
  const targetRoomId = pending?.roomId || shellState.selectedRoomId;
  if (!targetRoomId) return;

  const msgInState = roomMessagesState.messages.find(
    (m) => m.clientMessageId === clientMessageId || m.id === clientMessageId
  );

  const kind = pending?.kind || msgInState?.kind || 'text';
  const body = pending?.body || msgInState?.body || (pending?.text ? { text: pending.text } : null);
  const attachmentIds = pending?.attachmentIds || msgInState?.attachmentIds || msgInState?.attachment_ids || [];

  if (!body) return;

  // Change status back to sending (allowed recovery: failed -> sending)
  roomMessagesState.updateReceipt(clientMessageId, 'sending');
  if (shellState.selectedRoomId === targetRoomId) {
    updateMessageStatusInDom(clientMessageId, 'sending');
  }

  const wireKind = (kind === 'audio' || kind === 'image' || kind === 'video') ? 'file' : kind;

  const payload = {
    client_message_id: clientMessageId,
    kind: wireKind,
    body,
    reply_to: null,
    attachment_ids: Array.isArray(attachmentIds) ? attachmentIds : []
  };

  // Ensure outbox item is persisted before retry attempt
  await outboxManager.enqueue({
    clientMessageId,
    roomId: targetRoomId,
    wirePayload: payload,
    optimisticMsg: msgInState
  });

  const retryRequestId = generateUuid();
  requestToClient.set(retryRequestId, clientMessageId);

  try {
    const wsState = await window.ollacoreDesktop?.chat?.getState();
    if (wsState !== 'connected') {
      requestToClient.delete(retryRequestId);
      roomMessagesState.updateReceipt(clientMessageId, 'failed');
      if (shellState.selectedRoomId === targetRoomId) {
        updateMessageStatusInDom(clientMessageId, 'failed');
      }
      return;
    }

    const res = await window.ollacoreDesktop?.chat?.send('message.send', payload, targetRoomId, retryRequestId);
    if (res?.ok && res?.requestId && res.requestId !== retryRequestId) {
      requestToClient.set(res.requestId, clientMessageId);
    } else if (!res?.ok) {
      const errStr = String(res?.error?.code || res?.error?.message || res?.error || res?.code || '').toLowerCase();
      const isBlockErr = errStr.includes('block');
      if (isBlockErr) {
        requestToClient.delete(retryRequestId);
        pendingPayloads.delete(clientMessageId);
        outboxManager.clear({ clientMessageId }).catch(() => { });
        roomMessagesState.updateReceipt(clientMessageId, 'sent', targetRoomId);
        persistMessageStatusToDb(clientMessageId, 'sent').catch(() => { });
        if (shellState.selectedRoomId === targetRoomId) {
          updateMessageStatusInDom(clientMessageId, 'sent');
        }
      } else {
        requestToClient.delete(retryRequestId);
        roomMessagesState.updateReceipt(clientMessageId, 'failed');
        if (shellState.selectedRoomId === targetRoomId) {
          updateMessageStatusInDom(clientMessageId, 'failed');
        }
      }
    }

    if (recentUnmatchedAcks.has(retryRequestId) || recentUnmatchedAcks.has(clientMessageId)) {
      recentUnmatchedAcks.delete(retryRequestId);
      recentUnmatchedAcks.delete(clientMessageId);
      requestToClient.delete(retryRequestId);
      pendingPayloads.delete(clientMessageId);
      outboxManager.clear({ clientMessageId }).catch(() => { });
      roomMessagesState.updateReceipt(clientMessageId, 'sent', targetRoomId);
      persistMessageStatusToDb(clientMessageId, 'sent').catch(() => { });
      if (shellState.selectedRoomId === targetRoomId) {
        updateMessageStatusInDom(clientMessageId, 'sent');
      }
    }
  } catch (err) {
    requestToClient.delete(retryRequestId);
    console.error('Error retrying message:', err);
    roomMessagesState.updateReceipt(clientMessageId, 'failed');
    if (shellState.selectedRoomId === targetRoomId) {
      updateMessageStatusInDom(clientMessageId, 'failed');
    }
  }
}

let selectedParticipantsRefreshSeq = 0;

const recentSystemEventsMap = new Map();

/**
 * Resolves a friendly display name for a participant or user ID in a room.
 * @param {string} userId
 * @param {string|null} fallbackName
 * @param {string|null} roomId
 * @returns {string}
 */
export function resolveParticipantName(userId, fallbackName = null, roomId = null) {
  if (!userId) return fallbackName || 'someone';
  const currentUserId = shellState.currentUser?.userId || shellState.userProfile?.userId;
  if (currentUserId && String(userId).toLowerCase().trim() === String(currentUserId).toLowerCase().trim()) {
    return 'You';
  }
  if (fallbackName && !isInternalIdOrUuid(fallbackName)) {
    return String(fallbackName).trim();
  }
  try {
    const resolved = typeof resolveMemberInfo === 'function' ? resolveMemberInfo(userId) : null;
    if (resolved?.displayName && !isInternalIdOrUuid(resolved.displayName)) {
      return resolved.displayName.trim();
    }
    if (resolved?.phone) {
      return resolved.phone.trim();
    }
  } catch { }

  if (roomId) {
    const cachedParts = (shellState?.roomParticipants && shellState.roomParticipants.get(roomId)) ||
      (typeof activeGroupParticipants !== 'undefined' ? activeGroupParticipants : null);
    if (Array.isArray(cachedParts)) {
      const match = cachedParts.find((p) => {
        const pid = p.principalId || p.principal_id || p.userId || p.user_id;
        return pid && String(pid).toLowerCase().trim() === String(userId).toLowerCase().trim();
      });
      if (match) {
        if (match.displayName && !isInternalIdOrUuid(match.displayName)) {
          return match.displayName.trim();
        }
        if (match.phone) {
          return match.phone.trim();
        }
      }
    }
  }
  return fallbackName && !isInternalIdOrUuid(fallbackName) ? String(fallbackName).trim() : 'someone';
}

/**
 * Creates, deduplicates, persists, and renders a group membership system message.
 * @param {string} roomId
 * @param {object} eventData
 * @returns {object|null} The created system message, or null if deduplicated/ignored
 */
export function createAndRecordGroupSystemMessage(roomId, eventData = {}) {
  if (!roomId || !eventData || typeof eventData !== 'object') return null;
  const cleanRoomId = String(roomId).trim();
  const currentUserId = shellState.currentUser?.userId || shellState.userProfile?.userId;

  const action = eventData.action;
  const actorId = eventData.actorId || null;
  let actorName = eventData.actorName || null;
  const targetUserId = eventData.targetUserId || null;
  const targetUserIds = Array.isArray(eventData.targetUserIds) ? eventData.targetUserIds : null;
  let targetName = eventData.targetName || null;
  const role = eventData.role || null;
  const method = eventData.method || null;
  const eventId = eventData.eventId || null;
  const createdAt = eventData.createdAt || new Date().toISOString();
  const eventSeq = Number(eventData.eventSeq || 0);

  // Strict deduplication:
  // 1. If explicit eventId matches a recently seen event, ignore
  const now = Date.now();
  if (eventId) {
    const evKey = `ev:${eventId}`;
    if (recentSystemEventsMap.has(evKey)) {
      return null;
    }
    recentSystemEventsMap.set(evKey, now);
  }

  // 2. 10-second dedup window for identical cleanRoomId:action:targetUserId(:role)
  const dedupTarget = targetUserIds ? targetUserIds.slice().sort().join(',') : (targetUserId || '');
  const semanticKey = `sem:${cleanRoomId}:${action}:${dedupTarget}:${role || ''}`;
  const lastTime = recentSystemEventsMap.get(semanticKey);
  if (lastTime && (now - lastTime) < 10000) {
    return null;
  }
  recentSystemEventsMap.set(semanticKey, now);

  // Prune stale entries older than 60s if map grows
  if (recentSystemEventsMap.size > 200) {
    for (const [k, v] of recentSystemEventsMap.entries()) {
      if (now - v > 60000) {
        recentSystemEventsMap.delete(k);
      }
    }
  }

  // Resolve actor and target names if not provided or UUID-like
  const resolveUserNameFn = (uid) => resolveParticipantName(uid, null, cleanRoomId);
  if (!actorName && actorId) {
    actorName = resolveParticipantName(actorId, null, cleanRoomId);
  }
  if (!targetName && targetUserId) {
    targetName = resolveParticipantName(targetUserId, null, cleanRoomId);
  }

  const systemText = formatGroupMembershipSystemText({
    action,
    actorId,
    actorName,
    targetUserId,
    targetUserIds,
    targetName,
    role,
    method,
    currentUserId,
    resolveUserNameFn
  });

  if (!systemText) {
    return null;
  }

  const msgId = eventId || `sys_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  const systemMsg = {
    id: msgId,
    roomId: cleanRoomId,
    room_id: cleanRoomId,
    senderId: 'system',
    sender_id: 'system',
    kind: 'system',
    type: 'system',
    status: 'delivered',
    createdAt,
    created_at: createdAt,
    eventSeq,
    event_seq: eventSeq,
    body: {
      text: systemText,
      system_type: 'group_membership',
      action,
      actorId,
      targetUserId,
      targetUserIds,
      role
    },
    body_json: JSON.stringify({
      text: systemText,
      system_type: 'group_membership',
      action,
      actorId,
      targetUserId,
      targetUserIds,
      role
    })
  };

  // Add to RoomMessagesState
  const roomState = getOrCreateRoomMessagesState(cleanRoomId);
  if (roomState) {
    roomState.addSystemMessage(systemMsg);
  }

  // Persist to local SQLite
  persistMessageToDb(systemMsg, cleanRoomId).catch((err) => {
    console.warn('[app.js] Failed to persist system message to SQLite:', err?.message || err);
  });

  // Render to DOM if the affected room is currently active and selected
  if (shellState.selectedRoomId === cleanRoomId) {
    messagesEmpty?.classList.add('hidden');
    messagesLoading?.classList.add('hidden');
    messagesError?.classList.add('hidden');
    messagesScrollArea?.classList.remove('hidden');

    const domMessageRows = messagesList ? messagesList.querySelectorAll('.message-row') : [];
    if (domMessageRows.length === 0 && roomState?.messages?.length > 0) {
      renderMessages();
      scrollToBottom(true);
    } else {
      const appended = appendMessageToDom(systemMsg);
      if (!appended || !findMessageDomElement(systemMsg)) {
        renderMessages();
      }
      scrollToBottom(true);
    }
  }

  return systemMsg;
}

/**
 * Creates, deduplicates, persists, and renders a group description system message.
 * @param {string} roomId
 * @param {object} eventData
 * @returns {object|null} The created system message, or null if deduplicated/ignored
 */
export function createAndRecordGroupDescriptionSystemMessage(roomId, eventData = {}) {
  if (!roomId || !eventData || typeof eventData !== 'object') return null;
  const cleanRoomId = String(roomId).trim();
  const currentUserId = shellState.currentUser?.userId || shellState.userProfile?.userId;

  const action = eventData.action || null;
  const prevDescription = eventData.prevDescription !== undefined ? eventData.prevDescription : undefined;
  const newDescription = eventData.newDescription !== undefined ? eventData.newDescription : undefined;
  const actorId = eventData.actorId || null;
  let actorName = eventData.actorName || null;
  const eventId = eventData.eventId || null;
  const createdAt = eventData.createdAt || new Date().toISOString();
  const eventSeq = Number(eventData.eventSeq || 0);

  // Infer effective action
  let effectiveAction = action ? String(action).toLowerCase().trim() : null;
  if (!effectiveAction && (prevDescription !== undefined || newDescription !== undefined)) {
    const hasPrev = Boolean(prevDescription && typeof prevDescription === 'string' && prevDescription.trim().length > 0);
    const hasNew = Boolean(newDescription && typeof newDescription === 'string' && newDescription.trim().length > 0);
    if (!hasPrev && hasNew) {
      effectiveAction = 'add';
    } else if (hasPrev && !hasNew) {
      effectiveAction = 'remove';
    } else if (hasPrev && hasNew && prevDescription.trim() !== newDescription.trim()) {
      effectiveAction = 'change';
    } else {
      return null;
    }
  }

  if (['add', 'added', 'description_add', 'description_added'].includes(effectiveAction)) {
    effectiveAction = 'add';
  } else if (['change', 'changed', 'edit', 'edited', 'description_change', 'description_changed', 'description_edit'].includes(effectiveAction)) {
    effectiveAction = 'change';
  } else if (['remove', 'removed', 'delete', 'deleted', 'clear', 'cleared', 'description_remove', 'description_removed', 'description_clear'].includes(effectiveAction)) {
    effectiveAction = 'remove';
  } else {
    return null;
  }

  // Deduplication:
  // 1. If explicit eventId matches a recently seen event, ignore
  const now = Date.now();
  if (eventId) {
    const evKey = `ev:${eventId}`;
    if (recentSystemEventsMap.has(evKey)) {
      return null;
    }
    recentSystemEventsMap.set(evKey, now);
  }

  // 2. 10-second dedup window for identical cleanRoomId:desc:action:newDescription
  const descKeyPart = (newDescription !== undefined ? String(newDescription).trim() : '').slice(0, 64);
  const semanticKey = `desc:${cleanRoomId}:${effectiveAction}:${descKeyPart}`;
  const lastTime = recentSystemEventsMap.get(semanticKey);
  if (lastTime && (now - lastTime) < 10000) {
    return null;
  }
  recentSystemEventsMap.set(semanticKey, now);

  // Prune stale entries older than 60s
  if (recentSystemEventsMap.size > 200) {
    for (const [k, v] of recentSystemEventsMap.entries()) {
      if (now - v > 60000) {
        recentSystemEventsMap.delete(k);
      }
    }
  }

  // Resolve actor name
  const resolveUserNameFn = (uid) => resolveParticipantName(uid, null, cleanRoomId);
  if (!actorName && actorId) {
    actorName = resolveParticipantName(actorId, null, cleanRoomId);
  }

  const systemText = formatGroupDescriptionSystemText({
    action: effectiveAction,
    actorId,
    actorName,
    currentUserId,
    resolveUserNameFn
  });

  if (!systemText) {
    return null;
  }

  const msgId = eventId || `sys_desc_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  const systemMsg = {
    id: msgId,
    roomId: cleanRoomId,
    room_id: cleanRoomId,
    senderId: 'system',
    sender_id: 'system',
    kind: 'system',
    type: 'system',
    status: 'delivered',
    createdAt,
    created_at: createdAt,
    eventSeq,
    event_seq: eventSeq,
    body: {
      text: systemText,
      system_type: 'group_description',
      action: effectiveAction,
      actorId,
      actorName
    },
    body_json: JSON.stringify({
      text: systemText,
      system_type: 'group_description',
      action: effectiveAction,
      actorId,
      actorName
    })
  };

  // Add to RoomMessagesState
  const roomState = getOrCreateRoomMessagesState(cleanRoomId);
  if (roomState) {
    roomState.addSystemMessage(systemMsg);
  }

  // Persist to local SQLite
  persistMessageToDb(systemMsg, cleanRoomId).catch((err) => {
    console.warn('[app.js] Failed to persist group description system message to SQLite:', err?.message || err);
  });

  // Render to DOM if the affected room is currently active and selected
  if (shellState.selectedRoomId === cleanRoomId) {
    messagesEmpty?.classList.add('hidden');
    messagesLoading?.classList.add('hidden');
    messagesError?.classList.add('hidden');
    messagesScrollArea?.classList.remove('hidden');

    const domMessageRows = messagesList ? messagesList.querySelectorAll('.message-row') : [];
    if (domMessageRows.length === 0 && roomState?.messages?.length > 0) {
      renderMessages();
      scrollToBottom(true);
    } else {
      const appended = appendMessageToDom(systemMsg);
      if (!appended || !findMessageDomElement(systemMsg)) {
        renderMessages();
      }
      scrollToBottom(true);
    }
  }

  return systemMsg;
}

/**
 * Handles incoming real-time WebSocket frames.
 * Updates message state and DOM when active room matches.
 * Also updates conversation previews in the sidebar.
 * @param {object} frame
 */
export function handleRealtimeChatEvent(frame) {
  if (!frame || typeof frame !== 'object') return;
  const { type, room_id, payload } = frame;
  const eventRoomId = room_id || frame.roomId || frame.room_id || payload?.room_id || payload?.roomId;
  const logIncomingInviteDecision = ({ source, decision, reason, isSelfMatch = false, hasSenderIdentity = false, hasTargetIdentity = false, targetMatches = null, modality = null, epoch = null }) => {
    console.info('[VoiceCall] INCOMING_INVITE', {
      stage: 'renderer_incoming_invite',
      source,
      decision,
      reason,
      modality,
      epoch,
      hasSenderIdentity,
      isSelfMatch,
      hasTargetIdentity,
      targetMatches
    });
  };
  const reqId = frame.request_id || frame.requestId || payload?.request_id;
  const isSameRoom = (a, b) => Boolean(a && b && String(a).toLowerCase().trim() === String(b).toLowerCase().trim());
  const isActiveRoom = isSameRoom(eventRoomId, shellState?.selectedRoomId) || (eventRoomId === shellState?.selectedRoomId);
  const isCurrentlyViewed = eventRoomId === shellState.selectedRoomId && isAppActiveAndFocused();
  const isMsgCreated = (type === 'message.created' || type === 'message.new' || type === 'message.create');

  // Handle ACK frames
  const isAckType = (type === 'ack' || type === 'message.ack' || type === 'ack.message' || type === 'msg_ack' || type === 'ws_ack' || type === 'message.send.ack' || type === 'ack.send');
  if (isAckType) {
    const isError = Boolean(frame.error || payload?.error || payload?.status === 'error' || payload?.status === 'rejected');
    const clientMsgId = (reqId && requestToClient.get(reqId)) ||
      frame.client_message_id ||
      frame.clientMessageId ||
      payload?.client_message_id ||
      payload?.clientMessageId ||
      payload?.message?.client_message_id ||
      payload?.message?.clientMessageId;

    if (isError) {
      if (clientMsgId) {
        if (reqId) requestToClient.delete(reqId);
        pendingPayloads.delete(clientMsgId);
        outboxManager.clear({ clientMessageId: clientMsgId }).catch(() => { });
        const targetRoomId = eventRoomId || shellState.selectedRoomId;
        const targetState = getOrCreateRoomMessagesState(targetRoomId);

        const errorCode = String(frame.error?.code || frame.code || frame.error || payload?.code || payload?.error?.code || payload?.error || '').toLowerCase();
        const errorReason = String(frame.error?.reason || frame.reason || payload?.reason || payload?.error?.reason || '').toLowerCase();
        const errorMsg = String(frame.error?.message || frame.message || payload?.message || payload?.error?.message || '').toLowerCase();
        const isBlockError = Boolean(
          errorCode.includes('block') ||
          errorReason.includes('block') ||
          errorMsg.includes('block')
        );

        if (isBlockError) {
          // Block rejection under WhatsApp privacy model: server accepted/withheld delivery.
          // Display single tick 'sent', clear from outbox, do NOT show retry button or leak block error.
          targetState?.updateReceipt(clientMsgId, 'sent', targetRoomId);
          persistMessageStatusToDb(clientMsgId, 'sent').catch(() => { });
          if (targetRoomId === shellState.selectedRoomId) {
            updateMessageStatusInDom(clientMsgId, 'sent');
          }
        } else {
          targetState?.updateReceipt(clientMsgId, 'failed', targetRoomId);
          persistMessageStatusToDb(clientMsgId, 'failed').catch(() => { });
          if (targetRoomId === shellState.selectedRoomId) {
            updateMessageStatusInDom(clientMsgId, 'failed');
          }
        }
      }
      return;
    }

    if (!clientMsgId && reqId) {
      recordUnmatchedAck(reqId, frame);
      return;
    }

    if (clientMsgId) {
      if (reqId) requestToClient.delete(reqId);
      const pending = pendingPayloads.get(clientMsgId);
      pendingPayloads.delete(clientMsgId);
      outboxManager.clear({ clientMessageId: clientMsgId }).catch(() => { });

      const targetRoomId = pending?.roomId || eventRoomId || shellState.selectedRoomId;
      const targetState = getOrCreateRoomMessagesState(targetRoomId);

      const serverMsgId = payload?.id || payload?.message_id || payload?.message?.id || payload?.message?.message_id || frame?.id || frame?.message_id;
      const rawSeq = payload?.seq ?? payload?.event_seq ?? payload?.message?.seq ?? payload?.message?.event_seq ?? frame?.seq ?? frame?.event_seq;
      const serverSeq = Number.isInteger(Number(rawSeq)) && Number(rawSeq) > 0 ? Number(rawSeq) : 0;

      let existingMsg = null;
      if (targetState?.messages) {
        existingMsg = targetState.messages.find(
          (m) =>
            (m.clientMessageId && String(m.clientMessageId) === String(clientMsgId)) ||
            (m.client_message_id && String(m.client_message_id) === String(clientMsgId)) ||
            (m.id && String(m.id) === String(clientMsgId)) ||
            (serverMsgId && m.id && String(m.id) === String(serverMsgId))
        );
      }

      if (existingMsg) {
        if (serverMsgId) {
          existingMsg.id = serverMsgId;
        }
        if (serverSeq > 0) {
          existingMsg.eventSeq = serverSeq;
          existingMsg.event_seq = serverSeq;
        }
        if (!existingMsg.clientMessageId) {
          existingMsg.clientMessageId = clientMsgId;
        }
        if (!existingMsg.client_message_id) {
          existingMsg.client_message_id = clientMsgId;
        }
        if (payload?.message && typeof payload.message === 'object') {
          Object.assign(existingMsg, payload.message);
          if (serverMsgId) existingMsg.id = serverMsgId;
          if (clientMsgId) {
            existingMsg.clientMessageId = clientMsgId;
            existingMsg.client_message_id = clientMsgId;
          }
          if (serverSeq > 0) {
            existingMsg.eventSeq = serverSeq;
            existingMsg.event_seq = serverSeq;
          }
        }
      } else if (payload?.message && typeof payload.message === 'object') {
        existingMsg = payload.message;
        if (serverMsgId) existingMsg.id = serverMsgId;
        if (clientMsgId) {
          existingMsg.clientMessageId = clientMsgId;
          existingMsg.client_message_id = clientMsgId;
        }
        if (serverSeq > 0) {
          existingMsg.eventSeq = serverSeq;
          existingMsg.event_seq = serverSeq;
        }
        targetState?.appendIncomingMessage?.(existingMsg);
      }

      if (targetState) {
        const curStatus = (serverMsgId ? targetState.getStatus(serverMsgId) : null) || targetState.getStatus(clientMsgId);
        const curRank = curStatus ? (STATUS_RANKS[curStatus] ?? -99) : -99;
        if (curRank < 1) {
          targetState.updateReceipt(clientMsgId, 'sent', targetRoomId);
          if (serverMsgId) {
            targetState.updateReceipt(serverMsgId, 'sent', targetRoomId);
          }
        } else if (serverMsgId && curStatus) {
          targetState.updateReceipt(serverMsgId, curStatus, targetRoomId);
        }

        if (existingMsg) {
          existingMsg.status = (curRank >= 1 ? curStatus : 'sent');
          existingMsg.deliveryStatus = existingMsg.status;
          existingMsg.delivery_status = existingMsg.status;
        }

        if (typeof targetState._calculateSeqBounds === 'function') {
          targetState._calculateSeqBounds();
        }

        if (existingMsg) {
          const savePromise = persistMessageToDb(existingMsg, targetRoomId);
          savePromise.catch((err) => {
            console.warn('[app.js] Failed to persist ack message to SQLite:', err?.message || err);
          });

          savePromise.then(() => {
            const liveRank = (serverMsgId ? targetState.getStatus(serverMsgId) : null) || targetState.getStatus(clientMsgId);
            if (!liveRank || (STATUS_RANKS[liveRank] ?? -99) < 1) {
              if (serverMsgId) {
                persistMessageStatusToDb(serverMsgId, 'sent').catch(() => { });
              }
              persistMessageStatusToDb(clientMsgId, 'sent').catch(() => { });
            }
          }).catch(() => { });
        } else {
          persistMessageStatusToDb(clientMsgId, 'sent').catch(() => { });
          if (serverMsgId) {
            persistMessageStatusToDb(serverMsgId, 'sent').catch(() => { });
          }
        }
      }

      if (targetRoomId && targetRoomId === shellState.selectedRoomId) {
        const liveStatus = (serverMsgId ? targetState?.getStatus(serverMsgId) : null) || targetState?.getStatus(clientMsgId) || 'sent';
        const liveRank = STATUS_RANKS[liveStatus] ?? -99;
        if (liveRank <= 1) {
          updateMessageStatusInDom(clientMsgId, 'sent');
          if (serverMsgId) {
            updateMessageStatusInDom(serverMsgId, 'sent');
          }
        }
      }
    }
    return;
  }

  // Handle error frames correlated to outgoing requests
  if ((type === 'error' || type === 'serverError') && reqId) {
    const clientMsgId = requestToClient.get(reqId);
    if (clientMsgId) {
      requestToClient.delete(reqId);
      const pending = pendingPayloads.get(clientMsgId);
      pendingPayloads.delete(clientMsgId);
      const targetRoomId = pending?.roomId || eventRoomId || shellState.selectedRoomId;
      const targetState = getOrCreateRoomMessagesState(targetRoomId);

      const errorCode = String(frame.error?.code || frame.code || frame.error || payload?.code || payload?.error?.code || payload?.error || '').toLowerCase();
      const errorReason = String(frame.error?.reason || frame.reason || payload?.reason || payload?.error?.reason || '').toLowerCase();
      const errorMsg = String(frame.error?.message || frame.message || payload?.message || payload?.error?.message || '').toLowerCase();
      const isBlockError = Boolean(
        errorCode.includes('block') ||
        errorReason.includes('block') ||
        errorMsg.includes('block')
      );

      if (isBlockError) {
        // Block-related error frame: do not show retry button, clear from outbox, display single tick
        outboxManager.clear({ clientMessageId: clientMsgId }).catch(() => { });
        if (targetState) {
          targetState.updateReceipt(clientMsgId, 'sent', targetRoomId);
          persistMessageStatusToDb(clientMsgId, 'sent').catch(() => { });
        }
        if (targetRoomId && targetRoomId === shellState.selectedRoomId) {
          updateMessageStatusInDom(clientMsgId, 'sent');
        }
      } else {
        if (targetState) {
          targetState.updateReceipt(clientMsgId, 'failed', targetRoomId);
          persistMessageStatusToDb(clientMsgId, 'failed').catch(() => { });
        }
        if (targetRoomId && targetRoomId === shellState.selectedRoomId) {
          updateMessageStatusInDom(clientMsgId, 'failed');
        }
      }
    }
    return;
  }

  // Handle attachment.ready frames
  if (type === 'attachment.ready' && payload) {
    const attachmentId = payload.attachment_id || payload.attachmentId;
    const downloadUrl = payload.download_url || payload.downloadUrl;
    if (attachmentId && downloadUrl) {
      attachmentUrls.set(attachmentId, downloadUrl);
      updateMediaPlaceholdersInDom(attachmentId, downloadUrl);
    } else if (attachmentId && eventRoomId) {
      resolveAttachmentUrl(eventRoomId, attachmentId);
    }
    return;
  }

  // Handle presence.changed frames
  if (type === 'presence.changed') {
    const principalId = payload?.principal_id || payload?.principalId;
    const online = Boolean(payload?.online);
    if (eventRoomId && principalId) {
      if (shellState.isUserBlocked(principalId) || shellState.isRoomBlocked(eventRoomId)) {
        shellState.setPresence(eventRoomId, principalId, false);
        shellState.setTyping(eventRoomId, principalId, false);
        return;
      }
      shellState.setPresence(eventRoomId, principalId, online);
      if (!online) {
        const key = `${eventRoomId}:${principalId}`;
        if (remoteTypingTimeouts.has(key)) {
          clearTimeout(remoteTypingTimeouts.get(key));
          remoteTypingTimeouts.delete(key);
        }
        shellState.setTyping(eventRoomId, principalId, false);
      }
      if (shellState.selectedRoomId && String(eventRoomId) === String(shellState.selectedRoomId)) {
        updateChatHeaderSubtitle();
      }
    }
    return;
  }

  // Handle typing.started frames
  if (type === 'typing.started') {
    const principalId = payload?.principal_id || payload?.principalId;
    const currentUserId = shellState.currentUser?.userId || shellState.userProfile?.userId;
    if (eventRoomId && principalId && (!currentUserId || String(principalId).toLowerCase() !== String(currentUserId).toLowerCase())) {
      if (shellState.isUserBlocked(principalId) || shellState.isRoomBlocked(eventRoomId)) {
        return;
      }
      shellState.setTyping(eventRoomId, principalId, true);
      const key = `${eventRoomId}:${principalId}`;
      if (remoteTypingTimeouts.has(key)) {
        clearTimeout(remoteTypingTimeouts.get(key));
      }
      const timer = setTimeout(() => {
        remoteTypingTimeouts.delete(key);
        shellState.setTyping(eventRoomId, principalId, false);
        if (shellState.selectedRoomId && String(eventRoomId) === String(shellState.selectedRoomId)) {
          updateChatHeaderSubtitle();
        }
      }, 6000);
      remoteTypingTimeouts.set(key, timer);

      if (shellState.selectedRoomId && String(eventRoomId) === String(shellState.selectedRoomId)) {
        updateChatHeaderSubtitle();
      }
    }
    return;
  }

  // Handle typing.stopped frames
  if (type === 'typing.stopped') {
    const principalId = payload?.principal_id || payload?.principalId;
    if (eventRoomId && principalId) {
      const key = `${eventRoomId}:${principalId}`;
      if (remoteTypingTimeouts.has(key)) {
        clearTimeout(remoteTypingTimeouts.get(key));
        remoteTypingTimeouts.delete(key);
      }
      shellState.setTyping(eventRoomId, principalId, false);
      if (shellState.selectedRoomId && String(eventRoomId) === String(shellState.selectedRoomId)) {
        updateChatHeaderSubtitle();
      }
    }
    return;
  }

  // Intercept in-band call signaling messages (invite, decline, cancel)
  if (isMsgCreated) {
    const p = payload || {};
    const body = p.body;
    const cid = p.client_message_id || p.clientMessageId;
    if ((body && typeof body === 'object' && body.call_signal) || (typeof cid === 'string' && cid.startsWith('call_sig_'))) {
      const sig = body?.call_signal || (body?.call_type ? 'invite' : null);
      const isVideo = Boolean(body?.is_video === true || body?.call_type === 'video');
      const callType = isVideo ? 'video' : 'voice';
      const signalCallId = body?.call_id ?? body?.callId ?? p.call_id ?? p.callId ?? null;
      const signalCallEpoch = body?.call_epoch ?? body?.callEpoch ?? p.call_epoch ?? p.callEpoch ?? frame.call_epoch ?? frame.callEpoch;
      const signalTimestamp = body?.created_at ?? body?.createdAt ?? p.created_at ?? p.createdAt ?? frame.created_at ?? frame.createdAt ?? frame.timestamp;
      const msgId = p.id || p.message_id;
      const senderId = p.sender_id || p.senderId || p.from || frame.sender_id || frame.senderId || '';
      const targetUserId = body?.target_user_id || body?.targetUserId || p.target_user_id || p.targetUserId || null;

      // Ignore signals sent by self or if current client initiated the call
      const currentUserId = shellState.currentUser?.userId || shellState.currentUser?.user_id || shellState.userProfile?.userId || shellState.userProfile?.user_id || '';
      const activeUserId = activeRoomMessagesState.currentUserId || currentUserId;
      const isCallerInRoom = (voiceCallManager.roomId === eventRoomId && (voiceCallManager.isOutgoing || voiceCallManager.state === CALL_STATE.OUTGOING_RINGING || voiceCallManager.state === CALL_STATE.CONNECTING || voiceCallManager.state === CALL_STATE.CONNECTED));
      const isSelfSender = Boolean(
        (senderId && activeUserId && (String(senderId).toLowerCase().trim() === String(activeUserId).toLowerCase().trim() || isParticipantSelf({ principalId: senderId }, activeUserId))) ||
        (senderId && currentUserId && String(senderId).toLowerCase().trim() === String(currentUserId).toLowerCase().trim())
      );
      const isCallActive = (voiceCallManager.state !== CALL_STATE.IDLE && !voiceCallManager.isEnded);
      const isRecentlyInitiated = recentlyInitiatedCalls.has(eventRoomId) &&
        (Date.now() - recentlyInitiatedCalls.get(eventRoomId) < 60000) &&
        (isCallActive || isSelfSender || !senderId);

      if (isSelfSender) {
        logIncomingInviteDecision({ source: 'message.created', decision: 'suppressed', reason: 'self_sender', isSelfMatch: true, hasSenderIdentity: Boolean(senderId), hasTargetIdentity: Boolean(targetUserId), modality: callType, epoch: signalCallEpoch ?? null });
        return;
      }

      if (sig === 'invite') {
        if (isCallerInRoom || isRecentlyInitiated) {
          logIncomingInviteDecision({ source: 'message.created', decision: 'suppressed', reason: isCallerInRoom ? 'local_call_active' : 'recent_local_call', hasSenderIdentity: Boolean(senderId), hasTargetIdentity: Boolean(targetUserId), modality: callType, epoch: signalCallEpoch ?? null });
          return;
        }
        // If the invite is targeted to a specific user, ensure it is meant for current user
        if (targetUserId && currentUserId && String(targetUserId).toLowerCase().trim() !== String(currentUserId).toLowerCase().trim()) {
          // Targeted to another member; ignore
          logIncomingInviteDecision({ source: 'message.created', decision: 'suppressed', reason: 'target_mismatch', hasSenderIdentity: Boolean(senderId), hasTargetIdentity: true, targetMatches: false, modality: callType, epoch: signalCallEpoch ?? null });
          return;
        }

        if (voiceCallManager.roomId === eventRoomId && voiceCallManager.state === CALL_STATE.INCOMING_RINGING) {
          voiceCallManager.adoptSignalingEpoch?.(signalCallEpoch, { roomId: eventRoomId });
          if (signalCallId) {
            voiceCallManager.adoptAuthoritativeCallId(signalCallId, {
              roomId: eventRoomId,
              signalingEpoch: signalCallEpoch
            });
          }
          voiceCallManager.setModality(isVideo ? 'video' : 'voice');
          if (isVideo) {
            const { displayName } = resolveCallerIdentity(eventRoomId, senderId);
            window.ollacoreDesktop?.app?.showNotification?.({
              title: 'Incoming video call',
              body: `${displayName || 'Someone'} is calling you...`,
              roomId: eventRoomId
            });
          }
          updateVoiceCallUi(voiceCallManager.state, voiceCallManager.peerName, voiceCallManager.error);
          logIncomingInviteDecision({ source: 'message.created', decision: 'merged', reason: 'existing_incoming_ringing', hasSenderIdentity: Boolean(senderId), hasTargetIdentity: Boolean(targetUserId), targetMatches: targetUserId ? true : null, modality: callType, epoch: signalCallEpoch ?? null });
        } else if (voiceCallManager.state === CALL_STATE.IDLE || voiceCallManager.isEnded) {
          // Callee receives targeted invite to an ongoing call:
          // Trigger incoming call ringing experience
          const { displayName, phone } = resolveCallerIdentity(eventRoomId, senderId);
          window.ollacoreDesktop?.app?.focusWindow?.();
          window.ollacoreDesktop?.app?.showNotification?.({
            title: isVideo ? 'Incoming video call' : 'Incoming voice call',
            body: `${displayName || 'Someone'} is calling you...`,
            roomId: eventRoomId
          });
          window.ollacoreDesktop?.floatingCall?.show?.().catch(() => { });
          voiceCallManager.handleIncomingCall({
            roomId: eventRoomId,
            callId: signalCallId,
            callEpoch: signalCallEpoch,
            initiator: senderId || '',
            isVideo,
            callType,
            is_video: isVideo,
            call_type: callType,
            peerName: displayName,
            peerPhone: phone
          });
          syncFloatingCallState();
          logIncomingInviteDecision({ source: 'message.created', decision: 'presented', reason: 'genuine_remote_invite', hasSenderIdentity: Boolean(senderId), hasTargetIdentity: Boolean(targetUserId), targetMatches: targetUserId ? true : null, modality: callType, epoch: signalCallEpoch ?? null });
        } else {
          pendingRoomModalities.set(eventRoomId, { isVideo, callType, timestamp: Date.now() });
          logIncomingInviteDecision({ source: 'message.created', decision: 'suppressed', reason: 'other_call_active', hasSenderIdentity: Boolean(senderId), hasTargetIdentity: Boolean(targetUserId), modality: callType, epoch: signalCallEpoch ?? null });
        }
      } else if (sig === 'accept') {
        if (voiceCallManager.roomId === eventRoomId && (voiceCallManager.state === CALL_STATE.OUTGOING_RINGING || voiceCallManager.state === CALL_STATE.CONNECTING)) {
          voiceCallManager.handleCallAccepted?.({
            roomId: eventRoomId,
            callId: signalCallId,
            callEpoch: signalCallEpoch
          });
          updateVoiceCallUi(voiceCallManager.state, voiceCallManager.peerName, voiceCallManager.error);
          syncFloatingCallState();
          if (voiceCallManager.isVideo) {
            startFloatingVideoBridge();
          }
        }
      } else if (sig === 'decline') {
        if (voiceCallManager.roomId === eventRoomId) {
          // If we are already connected (e.g. Host is in call with others, or callee declined add-people invitation),
          // DO NOT terminate the ongoing call!
          if (voiceCallManager.state === CALL_STATE.CONNECTED) {
            console.log('[VoiceCallManager] Participant declined call invitation:', senderId);
            if (senderId && callStatusLabel) {
              const { displayName } = resolveCallerIdentity(eventRoomId, senderId);
              callStatusLabel.textContent = `${displayName || 'Participant'} declined`;
              scheduleCallPresentation(voiceCallManager, () => {
                if (voiceCallManager.state === CALL_STATE.CONNECTED && callStatusLabel) {
                  callStatusLabel.textContent = 'Connected';
                }
              }, 3000);
            }
          } else {
            voiceCallManager.handleRemoteCallEnded({
              roomId: eventRoomId,
              callId: signalCallId,
              callEpoch: signalCallEpoch,
              eventTimestamp: signalTimestamp
            });
          }
        }
      } else if (sig === 'cancel') {
        if (voiceCallManager.roomId === eventRoomId && voiceCallManager.state === CALL_STATE.INCOMING_RINGING) {
          voiceCallManager.handleRemoteCallEnded({
            roomId: eventRoomId,
            callId: signalCallId,
            callEpoch: signalCallEpoch,
            eventTimestamp: signalTimestamp
          });
        }
      } else if (sig === 'hangup' || sig === 'end') {
        if (voiceCallManager.roomId === eventRoomId) {
          voiceCallManager.handleRemoteCallEnded({
            roomId: eventRoomId,
            callId: signalCallId,
            callEpoch: signalCallEpoch,
            eventTimestamp: signalTimestamp
          });
        }
      }

      return; // Do NOT update sidebar lastMessage, do NOT render message in chat
    }
  }

  // 1. Sidebar conversation preview update
  if (eventRoomId && (type === 'message.created' || type === 'message.updated')) {
    let item = shellState.conversations.find((c) => c.roomId === eventRoomId);
    if (!item && payload) {
      item = {
        roomId: eventRoomId,
        room_id: eventRoomId,
        title: payload.sender_name || payload.senderName || 'New Chat',
        unreadCount: 0,
        unread_count: 0,
        kind: 'direct'
      };
      shellState.conversations.unshift(item);
    }

    if (item && payload) {
      const resolved = resolveMessageContent(payload);
      const previewText = resolved.isFallback ? (resolved.fallbackText || '') : (resolved.text || '');
      const msgId = payload.id || payload.message_id || frame?.message_id || frame?.id;

      if (isMsgCreated || !item.lastMessage || item.lastMessage.id === msgId) {
        item.lastMessage = {
          id: msgId || null,
          preview: previewText,
          senderId: payload.sender_id || payload.senderId || (item.lastMessage?.senderId ?? null),
          createdAt: payload.created_at || payload.createdAt || (item.lastMessage?.createdAt ?? new Date().toISOString()),
          kind: payload.kind || item.lastMessage?.kind || 'text'
        };
      }

      const activeUserId = activeRoomMessagesState.currentUserId || shellState.currentUser?.userId || shellState.userProfile?.userId;
      const targetState = getOrCreateRoomMessagesState(eventRoomId);
      const existingMsg = targetState?.messages?.find((m) => m.id === msgId || m.clientMessageId === msgId || m.client_message_id === msgId);
      const effectiveSenderId = payload.sender_id || payload.senderId || existingMsg?.senderId || existingMsg?.sender_id || (item.lastMessage?.id === msgId ? item.lastMessage?.senderId : null);
      const isOwn = isOwnMessage({ ...payload, sender_id: effectiveSenderId, senderId: effectiveSenderId }, activeUserId);

      if (isMsgCreated) {
        if (isOwn) {
          // Outgoing message sent by self: conversation is read
          shellState.markConversationAsRead(eventRoomId);
        } else if (isActiveRoom || isCurrentlyViewed) {
          // Incoming message for currently open conversation: keep read
          shellState.markConversationAsRead(eventRoomId);
          advanceReadCursorForActiveRoom();
        } else {
          // Incoming message while away or inactive: record unread with deduplication
          const prevUnread = item.unreadCount;
          const newUnread = shellState.recordIncomingUnreadMessage(eventRoomId, payload);
          const isDuplicate = newUnread === prevUnread;
          const isMuted = shellState.isConversationMuted(item);
          const isBlocked = shellState.isRoomBlocked(eventRoomId) || (effectiveSenderId && shellState.isUserBlocked(effectiveSenderId));
          if (!isMuted && !isBlocked && !isDuplicate) {
            if (notificationSettings.enabled) {
              const notifMsgId = payload.id || payload.message_id || payload.client_message_id || payload.clientMessageId || frame?.message_id || frame?.id;
              if (!notifMsgId || !isRendererDuplicateNotification(notifMsgId)) {
                const resolvedSenderName = resolveSenderNameForMessage(
                  { ...payload, sender_id: effectiveSenderId, senderId: effectiveSenderId },
                  eventRoomId
                );
                const notifContent = formatNotificationContent({
                  conversation: item,
                  message: payload,
                  showPreview: Boolean(notificationSettings.showPreview),
                  senderName: resolvedSenderName,
                  currentUserId: activeUserId
                });
                window.ollacoreDesktop?.app?.showNotification?.({
                  title: notifContent.title,
                  body: notifContent.body,
                  roomId: eventRoomId,
                  messageId: notifMsgId
                });
              }
            }
          }
        }

        // Bump conversation to top of list if unpinned
        const idx = shellState.conversations.findIndex((c) => c.roomId === eventRoomId);
        if (idx > 0) {
          const [conv] = shellState.conversations.splice(idx, 1);
          shellState.conversations.unshift(conv);
        }
      } else if (type === 'message.updated') {
        if (isOwn) {
          // Outgoing edit by self: conversation is read
          shellState.markConversationAsRead(eventRoomId);
        } else if (isActiveRoom || isCurrentlyViewed) {
          // Incoming edit actively viewed: keep read
          shellState.markConversationAsRead(eventRoomId);
        } else {
          // Incoming edit while away or inactive: record unread event
          shellState.recordIncomingEditedMessage(eventRoomId, payload);
          const isMuted = shellState.isConversationMuted(item);
          const isBlocked = shellState.isRoomBlocked(eventRoomId) || (effectiveSenderId && shellState.isUserBlocked(effectiveSenderId));
          if (!isMuted && !isBlocked) {
            if (notificationSettings.enabled) {
              const rawMsgId = payload.id || payload.message_id || frame?.message_id || frame?.id;
              const editNotifId = rawMsgId ? `${rawMsgId}_edited_${payload.updated_at || Date.now()}` : null;
              if (!editNotifId || !isRendererDuplicateNotification(editNotifId)) {
                const resolvedSenderName = resolveSenderNameForMessage(
                  { ...payload, sender_id: effectiveSenderId, senderId: effectiveSenderId },
                  eventRoomId
                );
                const notifContent = formatNotificationContent({
                  conversation: item,
                  message: payload,
                  showPreview: Boolean(notificationSettings.showPreview),
                  senderName: resolvedSenderName,
                  currentUserId: activeUserId
                });
                window.ollacoreDesktop?.app?.showNotification?.({
                  title: notifContent.title,
                  body: notificationSettings.showPreview ? `${notifContent.body} (edited)` : 'New message',
                  roomId: eventRoomId,
                  messageId: editNotifId
                });
              }
            }
          }
        }
      }

      renderConversationList();
      updateChatFilterCounts();
      if (currentNavigationDestination === 'archived') {
        renderArchivedList();
      }
      persistConversationToDb(item).catch(() => { });
    }
  }

  // Call events (Phase 6B/6C)
  if (type === 'call.started') {
    const p = payload || {};
    const callId = p.call_id || p.callId || frame.call_id || frame.callId || '';
    const callEpoch = p.call_epoch ?? p.callEpoch ?? frame.call_epoch ?? frame.callEpoch;
    const initiator = p.initiator || frame.initiator || '';
    const pendingModality = pendingRoomModalities.get(eventRoomId);
    if (pendingModality) {
      if (Date.now() - pendingModality.timestamp < 30000) {
        p.is_video = pendingModality.isVideo;
        p.call_type = pendingModality.callType;
      }
      pendingRoomModalities.delete(eventRoomId);
    }
    const isVideo = Boolean(
      p.call_type === 'video' ||
      p.callType === 'video' ||
      p.is_video === true ||
      p.isVideo === true ||
      p.kind === 'video' ||
      frame.call_type === 'video' ||
      frame.callType === 'video' ||
      frame.is_video === true ||
      frame.isVideo === true ||
      frame.kind === 'video'
    );
    const callType = isVideo ? 'video' : 'voice';
    const currentUserId = shellState.currentUser?.userId || shellState.userProfile?.userId;
    const activeUserId = activeRoomMessagesState.currentUserId || currentUserId;
    const isCallerInRoom = (voiceCallManager.roomId === eventRoomId && (voiceCallManager.isOutgoing || voiceCallManager.state === CALL_STATE.OUTGOING_RINGING || voiceCallManager.state === CALL_STATE.CONNECTING || voiceCallManager.state === CALL_STATE.CONNECTED));
    const isSelfInitiator = Boolean(
      (initiator && activeUserId && (String(initiator).toLowerCase().trim() === String(activeUserId).toLowerCase().trim() || isParticipantSelf({ principalId: initiator }, activeUserId))) ||
      (initiator && currentUserId && String(initiator).toLowerCase().trim() === String(currentUserId).toLowerCase().trim())
    );
    const isCallActive = (voiceCallManager.state !== CALL_STATE.IDLE && !voiceCallManager.isEnded);
    const isRecentlyInitiated = recentlyInitiatedCalls.has(eventRoomId) &&
      (Date.now() - recentlyInitiatedCalls.get(eventRoomId) < 60000) &&
      (isCallActive || isSelfInitiator || !initiator);

    const isLocalCaller = isSelfInitiator || isCallerInRoom || isRecentlyInitiated;

    if (callId && voiceCallManager.roomId === eventRoomId && voiceCallManager.state !== CALL_STATE.IDLE) {
      voiceCallManager.adoptAuthoritativeCallId(callId, {
        roomId: eventRoomId,
        signalingEpoch: callEpoch
      });
    }

    if (isLocalCaller) {
      // Local client initiated this call (outgoing). Suppress incoming notification and preserve outgoing state.
      logIncomingInviteDecision({ source: 'call.started', decision: 'suppressed', reason: isSelfInitiator ? 'self_initiator' : (isCallerInRoom ? 'local_call_active' : 'recent_local_call'), isSelfMatch: isSelfInitiator, hasSenderIdentity: Boolean(initiator), modality: callType, epoch: callEpoch ?? null });
      return;
    }

    const { displayName, phone } = resolveCallerIdentity(eventRoomId, initiator);
    // Bring app to front if in background / tray and show desktop notification for callee
    window.ollacoreDesktop?.app?.focusWindow?.();
    window.ollacoreDesktop?.app?.showNotification?.({
      title: isVideo ? 'Incoming video call' : 'Incoming voice call',
      body: `${displayName || 'Someone'} is calling you...`,
      roomId: eventRoomId
    });
    window.ollacoreDesktop?.floatingCall?.show?.().catch(() => { });
    voiceCallManager.handleIncomingCall({
      roomId: eventRoomId,
      callId,
      callEpoch,
      initiator,
      isVideo,
      callType,
      is_video: isVideo,
      call_type: callType,
      peerName: displayName,
      peerPhone: phone
    });
    syncFloatingCallState();
    logIncomingInviteDecision({ source: 'call.started', decision: 'presented', reason: 'genuine_remote_invite', hasSenderIdentity: Boolean(initiator), modality: callType, epoch: callEpoch ?? null });
    return;
  }

  if (type === 'call.ended' || type === 'call_ended' || type === 'call.cancelled' || type === 'call.rejected' || type === 'call.participant_left' || type === 'call.peer_left' || type === 'call.left') {
    const p = payload || {};
    const callId = p.call_id ?? p.callId ?? frame.call_id ?? frame.callId ?? null;
    const callEpoch = p.call_epoch ?? p.callEpoch ?? frame.call_epoch ?? frame.callEpoch;
    const eventTimestamp = p.created_at ?? p.createdAt ?? frame.created_at ?? frame.createdAt ?? frame.timestamp;
    voiceCallManager.handleRemoteCallEnded({
      roomId: eventRoomId,
      callId,
      callEpoch,
      eventTimestamp
    });
    return;
  }

  // Outgoing delivery and read acknowledgements for incoming messages
  if (isMsgCreated && payload) {
    const activeUserId = activeRoomMessagesState.currentUserId || shellState.currentUser?.userId || shellState.userProfile?.userId;
    const isOwn = isOwnMessage(payload, activeUserId);
    const msgId = payload.id || payload.message_id;
    if (!isOwn && eventRoomId && msgId) {
      // 1. Deliver acknowledgement: whenever incoming message is received by Windows client
      window.ollacoreDesktop?.chat?.markDelivered(eventRoomId, msgId).catch(() => { });

      // 2. Read acknowledgement: only when displayed/read in the currently active conversation and window is visible and focused
      if (eventRoomId === shellState.selectedRoomId && isAppActiveAndFocused()) {
        if (payload.status !== 'read' && payload.status !== 'READ') {
          trackAndDispatchReadReceipt(eventRoomId, msgId);
        }
      }
    }
  }

  // Handle incoming receipts with room-scoping and message-scoping
  if (type === 'receipt.delivered') {
    const msgId = payload?.message_id || payload?.messageId || payload?.id || frame.message_id || frame.messageId || frame.id;
    if (msgId) {
      const recipientId = payload?.principal_id || payload?.principalId || payload?.recipient_id || payload?.recipientId || frame?.principal_id || frame?.recipient_id || null;
      const targetRoom = eventRoomId || (activeRoomMessagesState.hasMessage(msgId) ? shellState.selectedRoomId : null);
      const targetState = targetRoom ? getOrCreateRoomMessagesState(targetRoom) : activeRoomMessagesState;

      if (targetState?.messages) {
        const existingMsg = targetState.messages.find(
          (m) => m.id === msgId || m.clientMessageId === msgId || m.client_message_id === msgId
        );
        const effectiveUserId = targetState.currentUserId || shellState.currentUser?.userId;
        if (existingMsg && effectiveUserId && !isOwnMessage(existingMsg, effectiveUserId)) {
          // Receipts for incoming messages must NOT update ticks or outgoing status
          return;
        }
      }
      if (targetState) {
        let effectiveSeq = payload?.seq ?? payload?.event_seq ?? payload?.eventSeq ?? frame?.seq ?? frame?.event_seq ?? frame?.eventSeq ?? null;
        if (!effectiveSeq && targetState?.messages) {
          const existingMsg = targetState.messages.find(
            (m) => m.id === msgId || m.clientMessageId === msgId || m.client_message_id === msgId
          );
          if (existingMsg) {
            effectiveSeq = existingMsg.eventSeq ?? existingMsg.event_seq ?? null;
          }
        }
        targetState.updateReceipt(msgId, 'delivered', targetRoom);
        if (targetRoom && targetRoom === shellState.selectedRoomId) {
          updateMessageStatusInDom(msgId, 'delivered');
        }
        persistMessageStatusToDb(msgId, 'delivered', recipientId, effectiveSeq, targetRoom).then(() => {
          checkAndRefreshOpenMessageInfo(msgId);
        }).catch((err) => {
          console.warn(`[receipt-persistence] Error persisting delivered receipt for message "${msgId}":`, err?.message || err);
        });
        checkAndRefreshOpenMessageInfo(msgId);
      }
    }
    return;
  }

  if (type === 'receipt.read') {
    const msgId = payload?.message_id || payload?.messageId || payload?.id || frame.message_id || frame.messageId || frame.id;
    if (msgId) {
      const targetRoom = eventRoomId || (activeRoomMessagesState.hasMessage(msgId) ? shellState.selectedRoomId : null);
      const conv = targetRoom ? shellState.conversations?.find((c) => c.roomId === targetRoom) : null;
      const recipientId = payload?.principal_id || payload?.principalId || payload?.recipient_id || payload?.recipientId || frame?.principal_id || frame?.recipient_id || conv?.peerUserId || conv?.peer_user_id || 'peer';
      const targetState = targetRoom ? getOrCreateRoomMessagesState(targetRoom) : activeRoomMessagesState;

      let effectiveSeq = payload?.seq ?? payload?.event_seq ?? payload?.eventSeq ?? frame?.seq ?? frame?.event_seq ?? frame?.eventSeq ?? null;
      if (targetState?.messages) {
        const existingMsg = targetState.messages.find(
          (m) => m.id === msgId || m.clientMessageId === msgId || m.client_message_id === msgId
        );
        const effectiveUserId = targetState.currentUserId || shellState.currentUser?.userId || shellState.userProfile?.userId;
        if (existingMsg && effectiveUserId && !isOwnMessage(existingMsg, effectiveUserId)) {
          // Receipts for incoming messages must NOT update ticks or outgoing status
          return;
        }
        if (!effectiveSeq && existingMsg) {
          effectiveSeq = existingMsg.eventSeq ?? existingMsg.event_seq ?? null;
        }
      }
      if (targetState) {
        targetState.updateReceipt(msgId, 'read', targetRoom);
        if (targetRoom) {
          savePersistentReceipt(targetRoom, msgId, 'read');
        }

        // Also advance any prior own messages in this room up to this read message
        if (targetState?.messages) {
          const effectiveUserId = targetState.currentUserId || shellState.currentUser?.userId || shellState.userProfile?.userId;
          const readIndex = targetState.messages.findIndex((m) => m.id === msgId || m.clientMessageId === msgId || m.client_message_id === msgId);
          if (readIndex !== -1) {
            for (let i = 0; i <= readIndex; i++) {
              const m = targetState.messages[i];
              if (isOwnMessage(m, effectiveUserId)) {
                if (m.id) {
                  targetState.updateReceipt(m.id, 'read', targetRoom);
                  if (targetRoom) savePersistentReceipt(targetRoom, m.id, 'read');
                }
                const cid = m.clientMessageId || m.client_message_id;
                if (cid) {
                  targetState.updateReceipt(cid, 'read', targetRoom);
                  if (targetRoom) savePersistentReceipt(targetRoom, cid, 'read');
                }
              }
            }
          }
        }

        if (effectiveSeq) {
          targetState.setPeerLastReadSeq(effectiveSeq);
          if (window?.ollacoreDesktop?.db?.setMetadata && targetRoom) {
            window.ollacoreDesktop.db.setMetadata('peer_read_seq:' + targetRoom, String(effectiveSeq)).catch(() => { });
          }
        }
        if (targetRoom && targetRoom === shellState.selectedRoomId) {
          updateMessageStatusInDom(msgId, 'read');
          if (effectiveSeq && targetState?.messages) {
            const effectiveUserId = targetState.currentUserId || shellState.currentUser?.userId || shellState.userProfile?.userId;
            for (const m of targetState.messages) {
              const mSeq = m.eventSeq ?? m.event_seq ?? 0;
              if (mSeq > 0 && mSeq <= effectiveSeq && isOwnMessage(m, effectiveUserId)) {
                if (m.id) updateMessageStatusInDom(m.id, 'read');
                const cid = m.clientMessageId || m.client_message_id;
                if (cid) updateMessageStatusInDom(cid, 'read');
              }
            }
          }
        }
        persistMessageStatusToDb(msgId, 'read', recipientId, effectiveSeq, targetRoom).then(() => {
          checkAndRefreshOpenMessageInfo(msgId);
        }).catch((err) => {
          console.warn(`[receipt-persistence] Error persisting READ receipt for message "${msgId}":`, err?.message || err);
        });
        checkAndRefreshOpenMessageInfo(msgId);
      }
    }
    return;
  }

  // 2. Active room message view update
  if (!eventRoomId) {
    return;
  }

  const targetState = getOrCreateRoomMessagesState(eventRoomId);
  if (isActiveRoom && activeRoomMessagesState !== targetState) {
    activeRoomMessagesState = targetState;
  }

  switch (type) {
    case 'message.new':
    case 'message.create':
    case 'message.created': {
      const msg = payload;
      const cid = msg.client_message_id || msg.clientMessageId;
      if (cid) {
        pendingPayloads.delete(cid);
        outboxManager.clear({ clientMessageId: cid });
      }

      const isOpeningUnread = Boolean(
        activeConversationOpeningState &&
        isSameRoom(activeConversationOpeningState.roomId, eventRoomId) &&
        !activeConversationOpeningState.isReadAcknowledged &&
        (activeConversationOpeningState.targetMessageId || activeConversationOpeningState.initialUnreadCount > 0)
      );

      const distFromBottom = messagesScrollArea
        ? (messagesScrollArea.scrollHeight - messagesScrollArea.scrollTop - messagesScrollArea.clientHeight)
        : 9999;
      const wasNearBottom = messagesScrollArea
        ? (distFromBottom <= 140 || messagesScrollArea.scrollHeight <= (messagesScrollArea.clientHeight + 5))
        : true;

      const appended = targetState.appendIncomingMessage(msg);
      const savePromise = persistMessageToDb(msg, eventRoomId);
      savePromise.catch((err) => {
        console.warn('[app.js] Failed to persist incoming message to SQLite:', err?.message || err);
      });
      const effectiveUserId = targetState.currentUserId || shellState.currentUser?.userId || shellState.userProfile?.userId;
      const isOwn = isOwnMessage(msg, effectiveUserId);

      // Only outgoing messages receive 'sent' receipt status, and only if not already delivered/read
      if (isOwn) {
        const curStatus = targetState.getStatus(msg.id) || (cid ? targetState.getStatus(cid) : null);
        const curRank = curStatus ? (STATUS_RANKS[curStatus] ?? -99) : -99;
        if (curRank < 1) {
          if (cid) {
            targetState.updateReceipt(cid, 'sent', eventRoomId);
            if (isActiveRoom) {
              updateMessageStatusInDom(cid, 'sent');
            }
          }
          if (msg.id) {
            targetState.updateReceipt(msg.id, 'sent', eventRoomId);
            if (isActiveRoom) {
              updateMessageStatusInDom(msg.id, 'sent');
            }
          }
          savePromise.then(() => {
            const liveRank = targetState.getStatus(msg.id) || (cid ? targetState.getStatus(cid) : null);
            if (!liveRank || (STATUS_RANKS[liveRank] ?? -99) < 1) {
              if (cid) {
                persistMessageStatusToDb(cid, 'sent').catch((err) => {
                  console.warn('[app.js] Failed to persist sent status for clientMessageId to SQLite:', err?.message || err);
                });
              }
              if (msg.id) {
                persistMessageStatusToDb(msg.id, 'sent').catch((err) => {
                  console.warn('[app.js] Failed to persist sent status for canonical msg.id to SQLite:', err?.message || err);
                });
              }
            }
          }).catch(() => { });
        }
      }

      if (isActiveRoom && appended) {
        const conv = shellState.conversations?.find((c) => c.roomId === eventRoomId);
        if (conv?.kind === 'group') {
          const senderUid = msg.senderId || msg.sender_id;
          const pMap = shellState.getRoomParticipants(eventRoomId);
          if (senderUid && !pMap.has(senderUid) && !pMap.has(senderUid.toLowerCase())) {
            ensureRoomParticipants(eventRoomId).catch(() => { });
          }
        }

        messagesEmpty?.classList.add('hidden');
        messagesLoading?.classList.add('hidden');
        messagesError?.classList.add('hidden');
        messagesScrollArea?.classList.remove('hidden');

        // Check if message tree needs full render (e.g. if messagesList was empty despite targetState having messages)
        const domMessageRows = messagesList ? messagesList.querySelectorAll('.message-row') : [];
        if (domMessageRows.length === 0 && targetState.messages.length > 0) {
          renderMessages();
          if (wasNearBottom || isOwn) {
            scrollToBottom(true);
            clearUnseenIncomingMessages(eventRoomId);
          }
        } else {
          // Targeted DOM append instead of destroying entire message tree
          let capturedAnchor = null;
          if (!wasNearBottom && !isOwn) {
            capturedAnchor = captureScrollAnchor();
          }
          const appendedToDom = appendMessageToDom(msg);
          const messageRowInDom = findMessageDomElement(msg);
          if (!appendedToDom || !messageRowInDom) {
            renderMessages();
          }
          if (mediaBrowserPanel && !mediaBrowserPanel.classList.contains('hidden') && activeMbRoomId === eventRoomId) {
            _populateMbTab(activeMbTab, eventRoomId);
          }

          if (wasNearBottom || isOwn) {
            scrollToBottom(true);
            clearUnseenIncomingMessages(eventRoomId);
          } else {
            if (capturedAnchor) {
              restoreScrollAnchor(capturedAnchor);
            }
            scrollBottomBtn?.classList.remove('hidden');
            if (!isOwn) {
              const msgKey = msg.id || msg.clientMessageId || cid;
              if (msgKey) {
                recordUnseenIncomingMessage(eventRoomId, msgKey);
              }
            }
          }
        }
      }
      break;
    }

    case 'message.updated': {
      const msgId = payload?.id || payload?.message_id || frame?.message_id || frame?.id;
      if (msgId) {
        const updated = targetState.updateMessage(msgId, payload);
        persistMessageEditToDb(msgId, payload.body || payload, payload.editedAt || payload.edited_at).catch(() => { });
        if (isActiveRoom && updated) {
          const el = findMessageDomElement(msgId);
          if (el) {
            updateMessageElementInDom(el, payload);
          } else {
            renderMessages();
          }
        }
        const conv = shellState.conversations.find((c) => c.roomId === eventRoomId);
        if (conv && conv.lastMessage && (conv.lastMessage.id === msgId || !conv.lastMessage.id)) {
          const resolved = resolveMessageContent(payload);
          conv.lastMessage.preview = resolved.text || resolved.fallbackText || conv.lastMessage.preview;
          renderConversationList();
          persistConversationToDb(conv).catch(() => { });
        }
      }
      break;
    }

    case 'message.deleted': {
      const msgId = payload?.id || payload?.message_id || frame?.message_id || frame?.id;
      if (msgId) {
        const deleted = targetState.deleteMessage(msgId);
        persistMessageDeletedToDb(msgId).catch(() => { });
        if (isActiveRoom && deleted) {
          removeMessageElementFromDom(msgId);
          if (mediaBrowserPanel && !mediaBrowserPanel.classList.contains('hidden') && activeMbRoomId === eventRoomId) {
            _populateMbTab(activeMbTab, eventRoomId);
          }
        }
        if (eventRoomId && msgId) {
          roomUnseenMessageIds.get(String(eventRoomId))?.delete(String(msgId));
          if (isActiveRoom) {
            updateScrollBottomBadge(eventRoomId);
          }
        }
        // Remove any local pin for this message
        shellState.unpinMessage(eventRoomId, msgId);
        if (isActiveRoom) renderPinnedBar(eventRoomId);
        shellState.removeUnreadMessage(eventRoomId, msgId);
        const conv = shellState.conversations.find((c) => c.roomId === eventRoomId);
        if (conv && conv.lastMessage) {
          conv.lastMessage.preview = 'This message was deleted';
          persistConversationToDb(conv).catch(() => { });
        }
        renderConversationList();
        updateChatFilterCounts();
        if (currentNavigationDestination === 'archived') {
          renderArchivedList();
        }
      }
      break;
    }

    case 'reaction.added': {
      const msgId = payload?.message_id || payload?.id;
      const emoji = payload?.emoji;
      const reactingUserId = payload?.user_id || payload?.userId || payload?.principal_id;
      if (msgId && emoji && reactingUserId) {
        targetState.updateReaction(msgId, reactingUserId, emoji, true);
        persistReactionToDb(eventRoomId, msgId, reactingUserId, emoji, true).catch(() => { });
        if (isActiveRoom) {
          const el = findMessageDomElement(msgId);
          const fullMsg = targetState.messages?.find((m) => m.id === msgId || m.clientMessageId === msgId);
          if (el && fullMsg) {
            updateMessageElementInDom(el, fullMsg);
          } else {
            renderMessages();
          }
        }
      }
      break;
    }

    case 'reaction.removed': {
      const msgId = payload?.message_id || payload?.id;
      const emoji = payload?.emoji;
      const reactingUserId = payload?.user_id || payload?.userId || payload?.principal_id;
      if (msgId && emoji && reactingUserId) {
        targetState.updateReaction(msgId, reactingUserId, emoji, false);
        persistReactionToDb(eventRoomId, msgId, reactingUserId, emoji, false).catch(() => { });
        if (isActiveRoom) {
          const el = findMessageDomElement(msgId);
          const fullMsg = targetState.messages?.find((m) => m.id === msgId || m.clientMessageId === msgId);
          if (el && fullMsg) {
            updateMessageElementInDom(el, fullMsg);
          } else {
            renderMessages();
          }
        }
      }
      break;
    }

    case 'resync': {
      if (isActiveRoom) {
        loadMessagesForRoom(eventRoomId);
      }
      break;
    }

    case 'member.added':
    case 'member.updated':
    case 'member.removed': {
      const cleanRoomId = String(eventRoomId || '').trim();
      if (!cleanRoomId) break;

      // Extract and record WhatsApp-style group system message for membership events
      const actorId = frame.actorId || payload?.actorId || payload?.actor_id || frame.actor_id || null;
      const targetUserId = frame.userId || payload?.userId || payload?.user_id || payload?.principalId || payload?.principal_id || frame.principalId || null;
      const targetName = payload?.displayName || payload?.display_name || payload?.name || payload?.member?.displayName || null;
      const actorName = payload?.actorName || payload?.actor_name || null;
      const method = frame.method || payload?.method || null;
      const actionPayload = frame.action || payload?.action || null;
      const role = frame.role || payload?.role || payload?.newRole || payload?.new_role || payload?.member?.role || null;
      const eventId = frame.eventId || payload?.eventId || frame.id || payload?.id || null;
      const createdAt = frame.createdAt || payload?.createdAt || payload?.created_at || frame.created_at || null;
      const eventSeq = frame.eventSeq || frame.event_seq || payload?.eventSeq || payload?.event_seq || 0;

      let eventAction = 'add';
      if (type === 'member.added') {
        const isLinkJoin = method === 'link' || method === 'group_link' || method === 'invite_link' || actionPayload === 'join_link';
        eventAction = isLinkJoin ? 'join_link' : 'add';
      } else if (type === 'member.removed') {
        const isVoluntaryLeave = actionPayload === 'leave' ||
          payload?.reason === 'left' ||
          (actorId && targetUserId && String(actorId).trim() === String(targetUserId).trim());
        eventAction = isVoluntaryLeave ? 'leave' : 'remove';
      } else if (type === 'member.updated') {
        eventAction = 'role_update';
      }

      createAndRecordGroupSystemMessage(cleanRoomId, {
        action: eventAction,
        actorId,
        actorName,
        targetUserId,
        targetName,
        role,
        method,
        eventId,
        createdAt,
        eventSeq
      });

      // Invalidate cached participants for the affected room
      if (shellState?.roomParticipants) {
        shellState.roomParticipants.delete(cleanRoomId);
      }
      inFlightParticipantsRequests.delete(cleanRoomId);

      // Refresh Contact Info side panel if open for this room
      if (activeContactInfoRoomId && activeContactInfoRoomId === cleanRoomId) {
        refreshContactInfoParticipants(activeContactInfoRoomId);
      }

      // Refresh Group Info modal if open for this room
      if (activeGroupInfoRoomId && activeGroupInfoRoomId === cleanRoomId) {
        refreshGroupParticipants(activeGroupInfoRoomId);
      }

      // If this room is currently open/selected, refresh participants and update capabilities in real-time
      if (shellState?.selectedRoomId === cleanRoomId) {
        const seq = ++selectedParticipantsRefreshSeq;
        ensureRoomParticipants(cleanRoomId, { force: true }).then((parts) => {
          if (shellState.selectedRoomId !== cleanRoomId || seq !== selectedParticipantsRefreshSeq) return;
          const conv = shellState.conversations?.find((c) => c.roomId === cleanRoomId);
          const currentUserId = shellState.currentUser?.userId || shellState.userProfile?.userId;
          const participantsList = Array.isArray(parts) ? parts : [];
          if (conv) {
            conv.participants = participantsList;
            conv.participantCount = participantsList.length;
            const selfPart = participantsList.find((p) => isParticipantSelf(p, currentUserId));
            if (selfPart?.role) {
              conv.my_role = selfPart.role;
              conv.myRole = selfPart.role;
            }
          }
          const caps = getGroupCapabilities(conv, participantsList, currentUserId);
          isCurrentUserAdmin = caps.isAdmin;
          updateRenderedGroupSenderNames(cleanRoomId);
        }).catch(() => { });
      }
      break;
    }

    case 'room.updated':
    case 'group.updated': {
      const conv = shellState.conversations?.find((c) => c.roomId === eventRoomId);
      const newName = payload?.name || frame?.name;
      const newDescription = payload?.description !== undefined ? payload.description : (frame?.description !== undefined ? frame.description : undefined);
      const newIconUrl = payload?.icon_url ?? payload?.iconUrl ?? frame?.icon_url ?? frame?.iconUrl;

      if (conv && newName) {
        conv.name = newName;
        if (eventRoomId === shellState.selectedRoomId && selectedChatName) {
          selectedChatName.textContent = newName;
          const initials = getAvatarInitials(newName);
          const color = getAvatarColor(newName);
          if (selectedChatAvatar) {
            selectedChatAvatar.textContent = initials;
            selectedChatAvatar.style.backgroundColor = color;
          }
        }
        if (activeGroupInfoRoomId === eventRoomId && groupInfoName) {
          groupInfoName.textContent = newName;
          const initials = getAvatarInitials(newName);
          const color = getAvatarColor(newName);
          if (groupInfoAvatar) {
            groupInfoAvatar.textContent = initials;
            groupInfoAvatar.style.backgroundColor = color;
          }
        }
        renderConversationList();
      }

      if (conv && newDescription !== undefined) {
        const prevDescription = payload?.previous_description ?? payload?.prev_description ?? frame?.previous_description ?? frame?.prev_description ?? conv.description ?? conv.about ?? '';
        if (String(newDescription || '').trim() !== String(prevDescription || '').trim()) {
          let actorId = payload?.actor_id || payload?.actorId || frame?.actor_id || frame?.actorId ||
            payload?.user_id || payload?.userId || frame?.user_id || frame?.userId ||
            payload?.principal_id || frame?.principal_id ||
            conv.ownerId || conv.owner_id || conv.creatorId || conv.creator_id || null;
          if (!actorId && Array.isArray(conv.participants)) {
            const ownerPart = conv.participants.find((p) => isParticipantOwner(p));
            if (ownerPart) {
              actorId = ownerPart.userId || ownerPart.user_id || ownerPart.principalId || ownerPart.principal_id;
            }
          }
          let actorName = payload?.actor_name || payload?.actorName || frame?.actor_name || frame?.actorName ||
            payload?.display_name || payload?.displayName || frame?.display_name || frame?.displayName || null;
          if (!actorName && actorId) {
            actorName = resolveParticipantName(actorId, null, eventRoomId);
          }

          createAndRecordGroupDescriptionSystemMessage(eventRoomId, {
            prevDescription,
            newDescription,
            actorId,
            actorName,
            eventId: frame?.id || payload?.id || null,
            createdAt: frame?.created_at || payload?.created_at || new Date().toISOString(),
            eventSeq: Number(frame?.seq ?? frame?.event_seq ?? payload?.seq ?? 0)
          });
        }

        conv.description = newDescription;
        conv.about = newDescription;
        if (activeContactInfoRoomId === eventRoomId) {
          const currentUserId = shellState.currentUser?.userId || shellState.userProfile?.userId;
          const caps = getGroupCapabilities(conv, activeGroupParticipants, currentUserId);
          if (contactInfoAboutText) {
            if (newDescription && typeof newDescription === 'string' && newDescription.trim() !== '') {
              contactInfoAboutText.textContent = newDescription.trim();
              contactInfoAboutText.classList.remove('contact-info-about-placeholder');
              contactInfoAboutSection?.classList.remove('hidden');
            } else if (caps.canEditDescription) {
              contactInfoAboutText.textContent = 'Add group description';
              contactInfoAboutText.classList.add('contact-info-about-placeholder');
              contactInfoAboutSection?.classList.remove('hidden');
            } else {
              contactInfoAboutSection?.classList.add('hidden');
            }
          }
        }
      }

      if (conv && newIconUrl !== undefined) {
        conv.avatarUrl = newIconUrl;
        conv.avatar_url = newIconUrl;
        renderConversationList();
      }
      break;
    }

    default:
      break;
  }
}


function escapeHtml(str) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// ═══════════════════════════════════════════════════════════════════
// Inbox Data Loading
// ═══════════════════════════════════════════════════════════════════

/**
 * Loads inbox data from ChatApi.
 */
async function loadInbox() {
  if (!window.ollacoreDesktop?.chatApi?.getInbox) return;

  shellState.setInboxLoading(true);
  inboxLoading?.classList.remove('hidden');
  inboxError?.classList.add('hidden');
  inboxEmpty?.classList.add('hidden');
  inboxNoSearch?.classList.add('hidden');

  // Local-first: load persisted conversations from SQLite first if available
  if (window.ollacoreDesktop?.db?.getConversations && (!shellState.conversations || shellState.conversations.length === 0)) {
    try {
      const localRows = await loadConversationsFromDb({ limit: 100 });
      if (localRows && localRows.length > 0) {
        shellState.setInbox(localRows);
        inboxLoading?.classList.add('hidden');
        renderConversationList();
      }
    } catch (dbErr) {
      console.warn('[DB] Failed to load cached conversations from SQLite:', dbErr);
    }
  }

  // Pre-load blocked users so inbox conversations can be sanitized against blocks immediately
  await loadBlockedUsers().catch((err) => {
    console.warn('[BlockedUsers] Failed to sync blocked users prior to inbox load:', err);
  });

  try {
    const res = await window.ollacoreDesktop.chatApi.getInbox(50);
    let conversations = Array.isArray(res?.conversations) ? res.conversations : [];
    if (window.ollacoreDesktop?.db?.getConversations) {
      try {
        const dbConvs = await loadConversationsFromDb({ limit: 100 });
        const currentUserId = shellState.currentUser?.userId || shellState.currentUser?.user_id || shellState.userProfile?.userId || shellState.userProfile?.user_id;
        for (const conv of conversations) {
          if (!conv) continue;
          const convId = conv.roomId || conv.room_id || conv.id;
          const localMatch = dbConvs.find((dbC) => (dbC.roomId || dbC.room_id || dbC.id) === convId);
          if (localMatch) {
            const isLastMsgOwn = isOwnMessage(conv.lastMessage, currentUserId);
            const localLastId = localMatch.lastMessage?.id || localMatch.lastMessageId || localMatch.last_message_id;
            const serverLastId = conv.lastMessage?.id || conv.last_message?.id || conv.lastMessage?.message_id || conv.last_message?.message_id;

            const localSeq = Number(localMatch.lastMessage?.eventSeq ?? localMatch.lastMessage?.event_seq ?? localMatch.lastEventSeq ?? localMatch.last_event_seq ?? 0);
            const serverSeq = Number(conv.lastMessage?.eventSeq ?? conv.lastMessage?.event_seq ?? conv.last_message?.event_seq ?? 0);

            const localTime = localMatch.lastMessage?.createdAt || localMatch.lastMessage?.created_at || localMatch.lastMessageTime || localMatch.last_message_time || localMatch.updatedAt || localMatch.updated_at;
            const serverTime = conv.lastMessage?.createdAt || conv.lastMessage?.created_at || conv.lastMessageTime || conv.last_message_time || conv.updatedAt || conv.updated_at;

            const localPreview = (localMatch.lastMessage?.preview || localMatch.preview || localMatch.last_message_preview || '').trim();
            const serverPreview = (conv.lastMessage?.preview || conv.preview || conv.last_message?.preview || '').trim();

            const localUnread = localMatch.unreadCount ?? localMatch.unread_count ?? 0;
            const localMarkedUnread = Boolean(localMatch.isMarkedUnread || localMatch.is_marked_unread);

            const hasNewIncomingMsg = (() => {
              if (isLastMsgOwn) return false;
              if (serverSeq > 0 && localSeq > 0) {
                return serverSeq > localSeq;
              }
              if (serverLastId && localLastId && serverLastId !== localLastId) {
                if (serverTime && localTime) {
                  return new Date(serverTime).getTime() > new Date(localTime).getTime() + 1000;
                }
                return true;
              }
              if (serverTime && localTime) {
                const sTime = new Date(serverTime).getTime();
                const lTime = new Date(localTime).getTime();
                if (sTime > lTime + 1000) return true;
                if (sTime <= lTime) return false;
              }
              if (localPreview && serverPreview && localPreview === serverPreview) {
                return false;
              }
              if (!conv.lastMessage) return false;
              return false;
            })();

            const noNewMessages = (localLastId && serverLastId && localLastId === serverLastId) ||
              (localSeq > 0 && serverSeq > 0 && localSeq >= serverSeq) ||
              (!hasNewIncomingMsg);

            if (!localMarkedUnread && !conv.isMarkedUnread) {
              if (isLastMsgOwn) {
                conv.unreadCount = 0;
                conv.unread_count = 0;
              } else if (localUnread === 0 && noNewMessages) {
                conv.unreadCount = 0;
                conv.unread_count = 0;
              }
            } else if (localMarkedUnread) {
              conv.isMarkedUnread = true;
              conv.is_marked_unread = true;
              conv.unreadCount = Math.max(1, conv.unreadCount || 1);
              conv.unread_count = conv.unreadCount;
            }
          }
        }
        const exitedDbConvs = dbConvs.filter((c) => c && (c.isExited || c.exited));
        for (const ec of exitedDbConvs) {
          const ecId = ec.roomId || ec.room_id || ec.id;
          if (!conversations.some((c) => (c.roomId || c.room_id || c.id) === ecId)) {
            conversations.push(ec);
          }
        }
      } catch (mergeErr) {
        console.warn('[DB] Failed to merge cached exited conversations:', mergeErr);
      }
    }
    shellState.setInbox(conversations);
    inboxLoading?.classList.add('hidden');
    renderConversationList();

    // Persist refreshed conversations to SQLite in background
    persistConversationsToDb(shellState.conversations).catch((err) => {
      console.warn('[DB] Failed to persist conversations to SQLite:', err);
    });

    // Synchronize blocked contacts list from server
    loadBlockedUsers().catch((err) => {
      console.warn('[BlockedUsers] Failed to sync blocked users:', err);
    });

    // If active selectedRoomId exists, re-sync selection
    if (shellState.selectedRoomId) {
      selectConversation(shellState.selectedRoomId);
    }
  } catch (err) {
    inboxLoading?.classList.add('hidden');
    // Handle unauthorized/session expired
    if (err.httpStatus === 401 || err.code === 'unauthorized') {
      await handleLogout();
      return;
    }
    // If local conversations were already loaded from SQLite, keep showing them
    if (shellState.conversations && shellState.conversations.length > 0) {
      renderConversationList();
      return;
    }
    shellState.setInboxError(err.message || 'Failed to load conversations');
    if (inboxErrorMessage) {
      inboxErrorMessage.textContent = err.message || 'Failed to load conversations';
    }
    inboxError?.classList.remove('hidden');
  }
}

/**
 * Dispatches an application launch intent (CLI or custom protocol ollachat://).
 * Handles room navigation or incoming voice/video call invocation.
 * @param {object} intent
 */
async function handleAppIntent(intent) {
  if (!intent || typeof intent !== 'object') return;
  console.log('[Intent] Handling application intent:', intent.action);

  if (intent.action === 'open_chat' && intent.roomId) {
    if (!shellState.selectedRoomId || shellState.selectedRoomId !== intent.roomId) {
      selectConversation(intent.roomId);
    }
    return;
  }

  if (intent.action === 'incoming_call' && intent.roomId) {
    const isVideo = Boolean(intent.isVideo || intent.callType === 'video');
    const callType = isVideo ? 'video' : 'voice';
    const peerName = intent.initiator || 'Caller';

    // Bring window to focus if minimized or in tray
    window.ollacoreDesktop?.app?.focusWindow?.();

    voiceCallManager.handleIncomingCall({
      roomId: intent.roomId,
      callId: intent.callId || null,
      initiator: intent.initiator || peerName,
      isVideo,
      callType,
      is_video: isVideo,
      call_type: callType,
      peerName,
      peerPhone: ''
    });
  }
}

/**
 * Invoked when authenticated desktop shell loads.
 */
async function onAuthenticatedScreenLoaded() {
  // Query actual WebSocket connection state rather than assuming disconnected
  if (window.ollacoreDesktop?.chat?.getState) {
    window.ollacoreDesktop.chat.getState().then((st) => {
      updateWsIndicator(st || 'connecting');
    }).catch(() => {
      updateWsIndicator('connecting');
    });
  } else {
    updateWsIndicator('connecting');
  }

  // Fetch conversations from Directory plane
  await loadInbox();

  // Check and dispatch any cold-start launch intent
  if (window.ollacoreDesktop?.app?.getPendingIntent) {
    try {
      const pending = await window.ollacoreDesktop.app.getPendingIntent();
      if (pending) {
        handleAppIntent(pending);
      }
    } catch (err) {
      console.warn('[Intent] Failed to retrieve pending launch intent:', err);
    }
  }

  // Check and dispatch any cold-start / queued notification navigation
  const getPendingNav = window.ollacoreDesktop?.chat?.getPendingNavigation || window.ollacoreDesktop?.app?.getPendingNavigation;
  if (getPendingNav) {
    try {
      const pendingNav = await getPendingNav();
      const pendingRoomId = (typeof pendingNav === 'object' && pendingNav !== null) ? pendingNav.roomId : pendingNav;
      const targetMessageId = (typeof pendingNav === 'object' && pendingNav !== null) ? pendingNav.messageId : null;
      if (pendingRoomId) {
        try { closeSettings(); } catch { }
        try { closeBackupModal(); } catch { }
        try { closeNewChatModal(); } catch { }
        if (targetMessageId) {
          selectConversation(pendingRoomId, { forceReload: true, targetMessageId });
        } else {
          selectConversation(pendingRoomId, { forceReload: true });
        }
      }
    } catch (err) {
      console.warn('[Notification] Failed to retrieve pending notification navigation:', err);
    }
  }
}

/**
 * Handles user logout and cleans up desktop chat state.
 */
async function handleLogout() {
  setButtonLoading(btnLogout, true);
  if (settingsModal) settingsModal.classList.add('hidden');
  closeNewChatModal();

  try {
    // Disconnect WebSocket
    if (window.ollacoreDesktop?.chat?.disconnect) {
      await window.ollacoreDesktop.chat.disconnect().catch(() => { });
    }

    // Call server logout & clear local session
    if (window.ollacoreDesktop?.auth?.logout) {
      await window.ollacoreDesktop.auth.logout(false);
    }

    if (activeVoiceAudio) {
      try {
        activeVoiceAudio.pause();
      } catch { }
      activeVoiceAudio = null;
    }
    stopLocalTyping();
    remoteTypingTimeouts.forEach((timer) => clearTimeout(timer));
    remoteTypingTimeouts.clear();
    shellState.clear();
    roomMessagesMap.clear();
    sharedRoomReceiptStore.clear();
    activeRoomMessagesState.resetAll();
    roomComposerDrafts.clear();
    requestToClient.clear();
    pendingPayloads.clear();
    if (composerInput) {
      composerInput.value = '';
      autoResizeComposer();
      updateSendButtonState();
    }
    emojiPicker?.close();
    closeChatSearch();
    if (messagesList) messagesList.innerHTML = '';
    directDraft.reset();
    groupDraft.reset();
    if (phoneInput) phoneInput.value = '';
    if (otpInput) otpInput.value = '';
    if (conversationSearch) conversationSearch.value = '';
    btnClearSearch?.classList.add('hidden');

    // Reset chat main area to welcome
    chatSelectedPanel?.classList.add('hidden');
    chatEmptyPanel?.classList.remove('hidden');
    updateWsIndicator('disconnected');

    showScreen('phone');
  } catch (err) {
    console.error('Logout error:', err);
    showScreen('phone');
  } finally {
    setButtonLoading(btnLogout, false);
  }
}

// ═══════════════════════════════════════════════════════════════════
// Settings & Profile Modal Controls
// ═══════════════════════════════════════════════════════════════════

export function openSettings() {
  setProfileEditMode(false);
  const user = shellState?.currentUser || shellState?.userProfile;
  if (user) {
    updateProfileDisplay(user);
  }
  updateNotificationSettingsUI(notificationSettings);
  settingsModal?.classList.remove('hidden');
}

export function closeSettings() {
  setProfileEditMode(false);
  settingsModal?.classList.add('hidden');
}

// ═══════════════════════════════════════════════════════════════════
// Phase 3: Backup & Restore Modal Controls
// ═══════════════════════════════════════════════════════════════════

export async function openBackupModal() {
  if (backupModal) {
    switchBackupTab('backup');
    if (backupStatusBanner) {
      backupStatusBanner.classList.add('hidden');
      backupStatusBanner.textContent = '';
    }
    if (restoreStatusBanner) {
      restoreStatusBanner.classList.add('hidden');
      restoreStatusBanner.textContent = '';
    }
    if (restorePreflightView) {
      restorePreflightView.classList.add('hidden');
    }
    if (restoreSelectedFilename) {
      restoreSelectedFilename.textContent = 'No file selected';
    }
    selectedRestoreFilePath = null;

    // Load active account
    try {
      const res = await window.ollacoreDesktop?.backup?.getCurrentAccount?.();
      if (res?.ok && res.account && backupAccountId) {
        const namePart = res.account.displayName ? `${res.account.displayName} ` : '';
        const phonePart = res.account.phone ? `(${res.account.phone}) ` : '';
        backupAccountId.textContent = `${namePart}${phonePart}[${res.account.userId}]`;
      } else if (backupAccountId) {
        const u = shellState?.currentUser || shellState?.userProfile;
        backupAccountId.textContent = u ? `${u.displayName || u.phone || u.userId} [${u.userId}]` : 'Connected User';
      }
    } catch {
      if (backupAccountId) backupAccountId.textContent = 'Active Account';
    }

    backupModal.classList.remove('hidden');
  }
}

export function closeBackupModal() {
  if (backupModal) {
    backupModal.classList.add('hidden');
  }
}

export function switchBackupTab(tabName) {
  if (tabName === 'backup') {
    tabBackup?.classList.add('active');
    tabBackup?.setAttribute('aria-selected', 'true');
    tabRestore?.classList.remove('active');
    tabRestore?.setAttribute('aria-selected', 'false');
    panelBackup?.classList.add('active');
    panelRestore?.classList.remove('active');
  } else {
    tabRestore?.classList.add('active');
    tabRestore?.setAttribute('aria-selected', 'true');
    tabBackup?.classList.remove('active');
    tabBackup?.setAttribute('aria-selected', 'false');
    panelRestore?.classList.add('active');
    panelBackup?.classList.remove('active');
  }
}

export async function handleCreateBackup() {
  if (!btnCreateBackup) return;
  setButtonLoading(btnCreateBackup, true);
  if (backupStatusBanner) {
    backupStatusBanner.className = 'status-banner status-banner-info';
    backupStatusBanner.textContent = 'Creating consistent database snapshot and packaging backup...';
    backupStatusBanner.classList.remove('hidden');
  }

  try {
    const includeAttachments = Boolean(backupIncludeAttachments?.checked);
    const res = await window.ollacoreDesktop?.backup?.create?.({ includeAttachments });
    if (res?.canceled) {
      if (backupStatusBanner) backupStatusBanner.classList.add('hidden');
      return;
    }
    if (res?.ok) {
      if (backupStatusBanner) {
        backupStatusBanner.className = 'status-banner status-banner-success';
        const attText = res.stats?.attachmentsCount ? ` with ${res.stats.attachmentsCount} attachments` : '';
        backupStatusBanner.innerHTML = `Backup successfully created${attText}!<br><span class="monospace" style="font-size:0.8rem;word-break:break-all;">${res.filePath}</span>`;
        backupStatusBanner.classList.remove('hidden');
      }
    } else {
      throw new Error(res?.error || 'Failed to create backup.');
    }
  } catch (err) {
    if (backupStatusBanner) {
      backupStatusBanner.className = 'status-banner status-banner-error';
      backupStatusBanner.textContent = `Backup failed: ${err.message}`;
      backupStatusBanner.classList.remove('hidden');
    }
  } finally {
    setButtonLoading(btnCreateBackup, false);
  }
}

export async function handleSelectRestoreFile() {
  try {
    const res = await window.ollacoreDesktop?.backup?.selectFile?.();
    if (res?.canceled || !res?.filePath) return;

    selectedRestoreFilePath = res.filePath;
    if (restoreSelectedFilename) {
      restoreSelectedFilename.textContent = res.filePath.split(/[\\/]/).pop() || res.filePath;
    }

    if (restoreStatusBanner) {
      restoreStatusBanner.className = 'status-banner status-banner-info';
      restoreStatusBanner.textContent = 'Performing preflight validation on backup archive...';
      restoreStatusBanner.classList.remove('hidden');
    }
    if (restorePreflightView) restorePreflightView.classList.add('hidden');

    const valResult = await window.ollacoreDesktop?.backup?.validate?.(res.filePath);
    if (!valResult?.ok) {
      throw new Error(valResult?.error || 'Preflight validation failed.');
    }

    // Populate preflight card
    const stats = valResult.stats || {};
    if (preflightCreatedAt) {
      preflightCreatedAt.textContent = stats.createdAt ? new Date(stats.createdAt).toLocaleString() : 'Unknown';
    }
    if (preflightAccount) {
      const acc = stats.account || {};
      preflightAccount.textContent = `${acc.displayName || acc.phone || acc.userId} (${acc.userId})`;
    }
    if (preflightConversations) {
      preflightConversations.textContent = String(stats.conversationsCount ?? 0);
    }
    if (preflightMessages) {
      preflightMessages.textContent = String(stats.messagesCount ?? 0);
    }
    if (preflightAttachments) {
      preflightAttachments.textContent = stats.includeAttachments
        ? `${stats.attachmentsCount ?? 0} files included`
        : 'Excluded (database only)';
    }
    if (preflightIntegrity) {
      preflightIntegrity.textContent = 'Integrity verified OK';
      preflightIntegrity.className = 'preflight-item-val text-success';
    }

    if (restoreStatusBanner) {
      restoreStatusBanner.className = 'status-banner status-banner-success';
      restoreStatusBanner.textContent = 'Backup file validated successfully. Review details below before restoring.';
      restoreStatusBanner.classList.remove('hidden');
    }
    if (restorePreflightView) restorePreflightView.classList.remove('hidden');
  } catch (err) {
    selectedRestoreFilePath = null;
    if (restorePreflightView) restorePreflightView.classList.add('hidden');
    if (restoreStatusBanner) {
      restoreStatusBanner.className = 'status-banner status-banner-error';
      restoreStatusBanner.textContent = `Validation failed: ${err.message}`;
      restoreStatusBanner.classList.remove('hidden');
    }
  }
}

export async function handleConfirmRestore() {
  if (!selectedRestoreFilePath) return;
  if (!btnConfirmRestore) return;

  setButtonLoading(btnConfirmRestore, true);
  if (btnCancelRestore) btnCancelRestore.disabled = true;

  if (restoreStatusBanner) {
    restoreStatusBanner.className = 'status-banner status-banner-info';
    restoreStatusBanner.textContent = 'Creating safety snapshot and restoring database...';
    restoreStatusBanner.classList.remove('hidden');
  }

  try {
    const res = await window.ollacoreDesktop?.backup?.restore?.(selectedRestoreFilePath, true);
    if (!res?.ok) {
      throw new Error(res?.error || 'Failed to restore backup.');
    }

    if (restorePreflightView) restorePreflightView.classList.add('hidden');
    if (restoreStatusBanner) {
      restoreStatusBanner.className = 'status-banner status-banner-success';
      restoreStatusBanner.textContent = 'Restore completed successfully! Your chats and media have been updated.';
      restoreStatusBanner.classList.remove('hidden');
    }

    // Refresh conversation list and UI
    if (typeof loadInbox === 'function') {
      loadInbox().catch(() => { });
    }
  } catch (err) {
    if (restoreStatusBanner) {
      restoreStatusBanner.className = 'status-banner status-banner-error';
      restoreStatusBanner.textContent = `Restore failed: ${err.message}`;
      restoreStatusBanner.classList.remove('hidden');
    }
  } finally {
    setButtonLoading(btnConfirmRestore, false);
    if (btnCancelRestore) btnCancelRestore.disabled = false;
  }
}

// ═══════════════════════════════════════════════════════════════════
// Phase 4B: New Chat & Create Group Modal Flow
// ═══════════════════════════════════════════════════════════════════

export function openNewChatModal(initialTab = null) {
  if (!newChatModal) return;
  directDraft.reset();
  groupDraft.reset();
  showError(directError, null);
  showError(groupError, null);

  if (directPhoneInput) directPhoneInput.value = '';
  if (groupNameInput) groupNameInput.value = '';
  if (groupMemberPhone) groupMemberPhone.value = '';
  directMatchedContact?.classList.add('hidden');
  if (btnStartDirectChat) btnStartDirectChat.disabled = true;
  if (btnCreateGroup) btnCreateGroup.disabled = true;

  renderGroupMembersChips();
  renderGroupContactsList();

  const targetTab = (typeof initialTab === 'string')
    ? initialTab
    : (shellState?.activeFilter === 'groups' ? 'group' : 'direct');

  switchNewChatTab(targetTab);
  newChatModal.classList.remove('hidden');
  if (targetTab === 'group') {
    setTimeout(() => groupNameInput?.focus(), 50);
  } else {
    setTimeout(() => directPhoneInput?.focus(), 50);
  }
}

export function closeNewChatModal() {
  if (!newChatModal) return;
  newChatModal.classList.add('hidden');
  directDraft.reset();
  groupDraft.reset();
  showError(directError, null);
  showError(groupError, null);
  if (groupAddPeopleContacts) groupAddPeopleContacts.innerHTML = '';
}

export function switchNewChatTab(tabName) {
  if (tabName === 'direct') {
    tabDirect?.classList.add('active');
    tabDirect?.setAttribute('aria-selected', 'true');
    tabGroup?.classList.remove('active');
    tabGroup?.setAttribute('aria-selected', 'false');
    panelDirect?.classList.add('active');
    panelDirect?.classList.remove('hidden');
    panelGroup?.classList.remove('active');
    panelGroup?.classList.add('hidden');
    directPhoneInput?.focus();
  } else if (tabName === 'group') {
    tabGroup?.classList.add('active');
    tabGroup?.setAttribute('aria-selected', 'true');
    tabDirect?.classList.remove('active');
    tabDirect?.setAttribute('aria-selected', 'false');
    panelGroup?.classList.add('active');
    panelGroup?.classList.remove('hidden');
    panelDirect?.classList.remove('active');
    panelDirect?.classList.add('hidden');
    renderGroupContactsList();
    groupNameInput?.focus();
  }
}

/**
 * Handles contact lookup for direct chat.
 */
async function handleDirectLookup() {
  showError(directError, null);
  directMatchedContact?.classList.add('hidden');
  if (btnStartDirectChat) btnStartDirectChat.disabled = true;

  const rawPhone = directPhoneInput?.value?.trim() || '';
  const validation = validatePhone(rawPhone);
  if (!validation.valid) {
    showError(directError, validation.error);
    directPhoneInput?.focus();
    return;
  }

  setButtonLoading(btnLookupDirect, true);
  directDraft.isLookingUp = true;

  try {
    const res = await window.ollacoreDesktop.chatApi.lookupContacts([validation.cleaned]);
    const contacts = Array.isArray(res?.contacts) ? res.contacts : [];
    const matched = contacts.find((c) => c && c.userId);

    if (matched) {
      directDraft.setMatchedContact(matched);
      const nickname = matched.userId ? shellState.getContactNickname(matched.userId) : null;
      const name = nickname || matched.displayName || matched.phone || 'OllaChat User';
      const initials = getAvatarInitials(name);
      const color = getAvatarColor(name);

      if (directContactName) directContactName.textContent = name;
      if (directContactPhone) directContactPhone.textContent = matched.phone;
      if (directContactAvatar) {
        directContactAvatar.textContent = initials;
        directContactAvatar.style.backgroundColor = color;
      }
      directMatchedContact?.classList.remove('hidden');
      if (btnStartDirectChat) btnStartDirectChat.disabled = false;
      btnStartDirectChat?.focus();
    } else {
      directDraft.clearMatchedContact();
      showError(directError, 'No OllaChat user found with this phone number.');
    }
  } catch (err) {
    if (err.httpStatus === 401 || err.code === 'unauthorized') {
      await handleLogout();
      return;
    }
    showError(directError, err.message || 'Failed to lookup contact');
  } finally {
    setButtonLoading(btnLookupDirect, false);
    directDraft.isLookingUp = false;
  }
}

/**
 * Handles starting a direct conversation with the matched contact.
 */
async function handleStartDirectChat() {
  if (!directDraft.canStart()) return;
  showError(directError, null);
  setButtonLoading(btnStartDirectChat, true);
  directDraft.isSubmitting = true;

  try {
    const res = await window.ollacoreDesktop.chatApi.openDirect(directDraft.matchedContact.userId);
    const targetRoomId = res?.roomId || res?.room_id;

    closeNewChatModal();
    await loadInbox();

    if (targetRoomId) {
      selectConversation(targetRoomId);
    }
  } catch (err) {
    if (err.httpStatus === 401 || err.code === 'unauthorized') {
      await handleLogout();
      return;
    }
    showError(directError, err.message || 'Failed to open conversation');
  } finally {
    setButtonLoading(btnStartDirectChat, false);
    directDraft.isSubmitting = false;
  }
}

/**
 * Handles looking up and adding a member to the group draft.
 */
async function handleAddGroupMember() {
  showError(groupError, null);
  const rawPhone = groupMemberPhone?.value?.trim() || '';
  const validation = validatePhone(rawPhone);
  if (!validation.valid) {
    showError(groupError, validation.error);
    groupMemberPhone?.focus();
    return;
  }

  setButtonLoading(btnAddGroupMember, true);

  try {
    const res = await window.ollacoreDesktop.chatApi.lookupContacts([validation.cleaned]);
    const contacts = Array.isArray(res?.contacts) ? res.contacts : [];
    const matched = contacts.find((c) => c && c.userId);

    if (matched) {
      const addRes = groupDraft.addMember(matched, shellState.currentUser?.userId);
      if (!addRes.added) {
        showError(groupError, addRes.error);
      } else {
        if (groupMemberPhone) groupMemberPhone.value = '';
        renderGroupMembersChips();
        updateCreateGroupButtonState();
        const contactItem = groupAddPeopleContacts?.querySelector(`[data-user-id="${matched.userId}"]`);
        if (contactItem) {
          contactItem.classList.add('selected');
          const cb = contactItem.querySelector('.group-add-contact-checkbox');
          if (cb) cb.checked = true;
        }
        groupMemberPhone?.focus();
      }
    } else {
      showError(groupError, 'No OllaChat user found with this phone number.');
    }
  } catch (err) {
    if (err.httpStatus === 401 || err.code === 'unauthorized') {
      await handleLogout();
      return;
    }
    showError(groupError, err.message || 'Failed to lookup member');
  } finally {
    setButtonLoading(btnAddGroupMember, false);
  }
}

/**
 * Renders selectable contact cards for group creation from known conversations.
 */
export function renderGroupContactsList() {
  if (!groupAddPeopleContacts) return;
  groupAddPeopleContacts.innerHTML = '';

  const currentUserId = shellState.currentUser?.userId || shellState.userProfile?.userId;
  const directConvs = (shellState.conversations || []).filter(
    (c) => c.kind === 'direct' && c.peer?.userId && (!currentUserId || c.peer.userId !== currentUserId)
  );

  const seenUsers = new Map();
  for (const c of directConvs) {
    if (!seenUsers.has(c.peer.userId)) {
      seenUsers.set(c.peer.userId, c);
    }
  }
  const uniqueConvs = Array.from(seenUsers.values());

  if (uniqueConvs.length === 0) {
    const emptyHint = document.createElement('div');
    emptyHint.className = 'field-hint';
    emptyHint.textContent = 'No direct chat contacts available. You can add members by phone number below.';
    groupAddPeopleContacts.appendChild(emptyHint);
    return;
  }

  for (const d of uniqueConvs) {
    const item = document.createElement('div');
    item.className = 'group-add-contact-item';
    item.setAttribute('data-user-id', d.peer.userId);

    const isSelected = groupDraft.members.some((m) => m.userId === d.peer.userId);
    if (isSelected) {
      item.classList.add('selected');
    }

    const title = getConversationTitle(d);
    const initials = getAvatarInitials(title);
    const color = getAvatarColor(title);

    const left = document.createElement('div');
    left.className = 'contact-info-participant-left';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'group-add-contact-checkbox';
    checkbox.checked = isSelected;
    checkbox.tabIndex = -1;
    left.appendChild(checkbox);

    const av = document.createElement('div');
    av.className = 'avatar avatar-sm';
    av.textContent = initials;
    av.style.backgroundColor = color;
    left.appendChild(av);

    const meta = document.createElement('div');
    meta.className = 'contact-info-participant-meta';

    const nameSpan = document.createElement('span');
    nameSpan.className = 'contact-info-participant-name';
    nameSpan.textContent = title;
    meta.appendChild(nameSpan);

    if (d.peer?.phone) {
      const phoneSpan = document.createElement('span');
      phoneSpan.className = 'contact-info-participant-sub';
      phoneSpan.textContent = d.peer.phone;
      meta.appendChild(phoneSpan);
    }
    left.appendChild(meta);
    item.appendChild(left);

    item.addEventListener('click', (e) => {
      if (e.target !== checkbox) {
        checkbox.checked = !checkbox.checked;
      }
      showError(groupError, null);
      if (checkbox.checked) {
        const contactObj = {
          userId: d.peer.userId,
          displayName: title,
          phone: d.peer.phone || ''
        };
        const addRes = groupDraft.addMember(contactObj, currentUserId);
        if (!addRes.added) {
          checkbox.checked = false;
          showError(groupError, addRes.error);
        } else {
          item.classList.add('selected');
        }
      } else {
        groupDraft.removeMember(d.peer.userId);
        item.classList.remove('selected');
      }
      renderGroupMembersChips();
      updateCreateGroupButtonState();
    });

    groupAddPeopleContacts.appendChild(item);
  }
}

/**
 * Renders the removable chips for selected group members.
 */
function renderGroupMembersChips() {
  if (!groupMembersChips) return;
  groupMembersChips.innerHTML = '';

  const members = groupDraft.members;
  if (groupMembersCount) {
    groupMembersCount.textContent = `${members.length} added`;
  }

  if (members.length === 0) {
    const hint = document.createElement('span');
    hint.className = 'no-members-hint';
    hint.textContent = 'No members added yet. Add at least 1 contact.';
    groupMembersChips.appendChild(hint);
    return;
  }

  for (const member of members) {
    const title = member.displayName || member.phone || 'Contact';
    const initials = getAvatarInitials(title);
    const color = getAvatarColor(title);

    const chip = document.createElement('div');
    chip.className = 'member-chip';

    chip.innerHTML = `
      <div class="avatar-chip" style="background-color: ${color};">${initials}</div>
      <span class="member-chip-name" title="${escapeHtml(title)} (${escapeHtml(member.phone)})">${escapeHtml(title)}</span>
      <button type="button" class="btn-remove-chip" title="Remove member" aria-label="Remove ${escapeHtml(title)}">✕</button>
    `;

    chip.querySelector('.btn-remove-chip')?.addEventListener('click', () => {
      groupDraft.removeMember(member.userId);
      renderGroupMembersChips();
      updateCreateGroupButtonState();
      const contactItem = groupAddPeopleContacts?.querySelector(`[data-user-id="${member.userId}"]`);
      if (contactItem) {
        contactItem.classList.remove('selected');
        const cb = contactItem.querySelector('.group-add-contact-checkbox');
        if (cb) cb.checked = false;
      }
    });

    groupMembersChips.appendChild(chip);
  }
}

function updateCreateGroupButtonState() {
  if (btnCreateGroup) {
    btnCreateGroup.disabled = !groupDraft.canSubmit();
  }
}

/**
 * Handles group creation form submission.
 */
async function handleCreateGroup() {
  showError(groupError, null);
  const nameVal = validateGroupName(groupNameInput?.value || '');
  if (!nameVal.valid) {
    showError(groupError, nameVal.error);
    groupNameInput?.focus();
    return;
  }

  groupDraft.setName(nameVal.name);
  if (!groupDraft.canSubmit()) {
    showError(groupError, 'Add at least 1 member to create a group');
    return;
  }

  setButtonLoading(btnCreateGroup, true);
  groupDraft.isSubmitting = true;

  try {
    const memberUserIds = groupDraft.getMemberUserIds();
    const res = await window.ollacoreDesktop.chatApi.createGroup(groupDraft.name, memberUserIds);
    const targetRoomId = res?.roomId || res?.room_id;

    closeNewChatModal();
    await loadInbox();

    if (targetRoomId) {
      selectConversation(targetRoomId);
    }
  } catch (err) {
    if (err.httpStatus === 401 || err.code === 'unauthorized') {
      await handleLogout();
      return;
    }
    showError(groupError, err.message || 'Failed to create group');
  } finally {
    setButtonLoading(btnCreateGroup, false);
    groupDraft.isSubmitting = false;
    updateCreateGroupButtonState();
  }
}

// ═══════════════════════════════════════════════════════════════════
// GROUP MANAGEMENT CONTROLLER (Group Info, Settings & Member Admin)
// ═══════════════════════════════════════════════════════════════════

let activeGroupInfoRoomId = null;
let activeGroupParticipants = [];
let isCurrentUserAdmin = false;
let pendingConfirmAction = null;


function resolveMemberInfo(mId) {
  if (!mId) return { displayName: null, phone: null, hasNickname: false };
  const currentUserId = shellState.currentUser?.userId || shellState.userProfile?.userId;
  if (currentUserId && String(mId).toLowerCase().trim() === String(currentUserId).toLowerCase().trim()) {
    const selfName = shellState.currentUser?.displayName || shellState.userProfile?.displayName;
    const selfPhone = shellState.currentUser?.phone || shellState.userProfile?.phone;
    return {
      displayName: selfName && !isInternalIdOrUuid(selfName) ? selfName.trim() : null,
      phone: selfPhone ? selfPhone.trim() : null,
      hasNickname: false
    };
  }

  const personalNickname = shellState.getContactNickname?.(mId);

  const peerConv = shellState.conversations?.find((c) => {
    const cPeerId = c.peer?.userId || c.peerUserId || c.peer_user_id || c.peerId;
    return cPeerId && String(cPeerId).toLowerCase().trim() === String(mId).toLowerCase().trim();
  });

  if (personalNickname) {
    const peerPhone = peerConv?.peer?.phone || peerConv?.phone;
    const peerName = peerConv?.peer?.displayName || peerConv?.name;
    return {
      displayName: personalNickname,
      phone: peerPhone ? peerPhone.trim() : null,
      serverDisplayName: peerName && !isInternalIdOrUuid(peerName) ? peerName.trim() : null,
      hasNickname: true,
      nickname: personalNickname
    };
  }

  if (peerConv) {
    const peerName = peerConv.peer?.displayName || peerConv.name;
    const peerPhone = peerConv.peer?.phone || peerConv.phone;
    return {
      displayName: peerName && !isInternalIdOrUuid(peerName) ? peerName.trim() : null,
      phone: peerPhone ? peerPhone.trim() : null,
      hasNickname: false
    };
  }

  return { displayName: null, phone: null, hasNickname: false };
}


function showGroupError(msg) {
  if (!groupInfoError) return;
  if (!msg) {
    groupInfoError.textContent = '';
    groupInfoError.classList.add('hidden');
  } else {
    groupInfoError.textContent = msg;
    groupInfoError.classList.remove('hidden');
    if (groupInfoSuccess) groupInfoSuccess.classList.add('hidden');
  }
}

function showGroupSuccess(msg) {
  if (!groupInfoSuccess) return;
  if (!msg) {
    groupInfoSuccess.textContent = '';
    groupInfoSuccess.classList.add('hidden');
  } else {
    groupInfoSuccess.textContent = msg;
    groupInfoSuccess.classList.remove('hidden');
    if (groupInfoError) groupInfoError.classList.add('hidden');
  }
}

function openConfirmModal(title, message, onProceed, proceedText = 'Confirm') {
  if (!groupConfirmModal) return;
  if (confirmModalTitle) confirmModalTitle.textContent = title;
  if (confirmModalMessage) confirmModalMessage.textContent = message;
  if (btnConfirmProceed) btnConfirmProceed.textContent = proceedText;
  pendingConfirmAction = onProceed;
  groupConfirmModal.classList.remove('hidden');
}

function closeConfirmModal() {
  if (!groupConfirmModal) return;
  groupConfirmModal.classList.add('hidden');
  if (btnConfirmProceed) btnConfirmProceed.textContent = 'Confirm';
  pendingConfirmAction = null;
}

export async function openGroupInfo(roomId) {
  if (!roomId) return;
  const conv = shellState.conversations?.find((c) => c.roomId === roomId);
  if (!conv || conv.kind !== 'group') return;

  activeGroupInfoRoomId = roomId;
  showGroupError(null);
  showGroupSuccess(null);

  groupInfoRenameForm?.classList.add('hidden');
  groupInfoName?.classList.remove('hidden');

  const title = getConversationTitle(conv);
  const initials = getAvatarInitials(title);
  const color = getAvatarColor(title);

  if (groupInfoName) groupInfoName.textContent = title;
  if (groupInfoAvatar) {
    const groupAvatar = getConversationAvatarUrl(conv);
    renderAvatarElement(groupInfoAvatar, groupAvatar, initials, color, false);
  }
  if (groupRenameInput) groupRenameInput.value = title;

  groupInfoModal?.classList.remove('hidden');
  await refreshGroupParticipants(roomId);
}

export function closeGroupInfo() {
  activeGroupInfoRoomId = null;
  activeGroupParticipants = [];
  isCurrentUserAdmin = false;
  groupInfoModal?.classList.add('hidden');
  closeConfirmModal();
}

let activeCallEligibleParticipants = [];
export const inFlightCallInvitations = new Set();

export { filterEligibleCallParticipants };

export function showCallAddParticipantError(msg) {
  if (callAddParticipantError) {
    callAddParticipantError.textContent = msg;
    callAddParticipantError.classList.remove('hidden');
  }
}

export function renderCallParticipantsList(participantsToRender) {
  if (!callParticipantsList) return;
  callParticipantsList.innerHTML = '';

  if (!participantsToRender || participantsToRender.length === 0) {
    callParticipantsEmpty?.classList.remove('hidden');
    return;
  }
  callParticipantsEmpty?.classList.add('hidden');

  for (const participant of participantsToRender) {
    const pId = participant.principalId || participant.principal_id;
    const resolved = resolveMemberInfo(pId);

    let nameText = '';
    if (resolved.hasNickname) {
      nameText = resolved.displayName;
    } else if (participant.displayName && !isInternalIdOrUuid(participant.displayName)) {
      nameText = participant.displayName.trim();
    } else if (resolved.displayName) {
      nameText = resolved.displayName;
    } else if (participant.phone) {
      nameText = participant.phone.trim();
    } else if (resolved.phone) {
      nameText = resolved.phone;
    } else {
      nameText = 'Member';
    }

    let phoneText = '';
    if (participant.phone) {
      phoneText = participant.phone.trim();
    } else if (resolved.phone) {
      phoneText = resolved.phone;
    }

    const item = document.createElement('div');
    item.className = 'call-participant-item';
    item.setAttribute('data-user-id', pId);

    const infoDiv = document.createElement('div');
    infoDiv.className = 'call-participant-info';

    const avatar = document.createElement('div');
    avatar.className = 'avatar avatar-sm';
    const memberAvatar = participant.avatarUrl || participant.avatar_url || (pId && (participant.avatarVersion || participant.avatar_version) ? `https://api.ollacore.com/v1/directory/users/${encodeURIComponent(pId)}/avatar?v=${encodeURIComponent(participant.avatarVersion || participant.avatar_version)}` : null);
    renderAvatarElement(avatar, memberAvatar, getAvatarInitials(nameText), getAvatarColor(nameText), false);

    const meta = document.createElement('div');
    meta.className = 'call-participant-meta';

    const nameEl = document.createElement('span');
    nameEl.className = 'call-participant-name';
    nameEl.textContent = nameText;

    meta.appendChild(nameEl);
    if (phoneText && phoneText !== nameText) {
      const phoneEl = document.createElement('span');
      phoneEl.className = 'call-participant-phone';
      phoneEl.textContent = phoneText;
      meta.appendChild(phoneEl);
    }

    infoDiv.appendChild(avatar);
    infoDiv.appendChild(meta);

    const inviteBtn = document.createElement('button');
    inviteBtn.type = 'button';
    inviteBtn.className = 'btn-invite-participant';
    inviteBtn.setAttribute('data-user-id', pId);

    const isAlreadyInvited = inFlightCallInvitations.has(pId);
    if (isAlreadyInvited) {
      inviteBtn.textContent = 'Invited';
      inviteBtn.disabled = true;
      inviteBtn.classList.add('invited');
    } else {
      inviteBtn.textContent = 'Invite';
      inviteBtn.addEventListener('click', () => {
        inviteParticipantToCall(participant, inviteBtn);
      });
    }

    item.appendChild(infoDiv);
    item.appendChild(inviteBtn);
    callParticipantsList.appendChild(item);
  }
}

export function inviteParticipantToCall(participant, buttonEl) {
  const pId = participant?.principalId || participant?.principal_id;
  if (!pId || inFlightCallInvitations.has(pId)) return Promise.resolve(false);

  inFlightCallInvitations.add(pId);
  if (buttonEl) {
    buttonEl.textContent = 'Inviting...';
    buttonEl.disabled = true;
  }

  const roomId = voiceCallManager.roomId;
  const isVideo = voiceCallManager.isVideo;
  const callType = voiceCallManager.mode || (isVideo ? 'video' : 'voice');
  return sendCallSignal('invite', roomId, {
    callType,
    isVideo,
    callId: voiceCallManager.callId,
    callEpoch: voiceCallManager.callEpoch,
    targetUserId: pId
  }).then(() => {
    if (buttonEl) {
      buttonEl.textContent = 'Invited';
      buttonEl.classList.add('invited');
    }
    return true;
  }).catch(() => {
    inFlightCallInvitations.delete(pId);
    if (buttonEl) {
      buttonEl.textContent = 'Invite';
      buttonEl.disabled = false;
      buttonEl.classList.remove('invited');
    }
    showCallAddParticipantError('Could not send the invitation. Please try again.');
    return false;
  });
}

export async function openCallAddParticipantModal() {
  if (!callAddParticipantModal) return;
  callAddParticipantModal.classList.remove('hidden');

  if (callAddParticipantError) {
    callAddParticipantError.textContent = '';
    callAddParticipantError.classList.add('hidden');
  }
  if (callParticipantSearch) {
    callParticipantSearch.value = '';
  }

  const roomId = voiceCallManager.roomId;
  if (!roomId || !window.ollacoreDesktop?.chatApi?.getParticipants) {
    showCallAddParticipantError('Cannot load participants: active call room unavailable');
    return;
  }

  callParticipantsLoading?.classList.remove('hidden');
  callParticipantsEmpty?.classList.add('hidden');
  if (callParticipantsList) callParticipantsList.innerHTML = '';

  try {
    const res = await window.ollacoreDesktop.chatApi.getParticipants(roomId);
    const participants = Array.isArray(res?.participants) ? res.participants : [];
    const currentUserId = shellState.currentUser?.userId || shellState.userProfile?.userId;

    activeCallEligibleParticipants = filterEligibleCallParticipants(
      participants,
      currentUserId,
      voiceCallManager.participants
    );

    renderCallParticipantsList(activeCallEligibleParticipants);
  } catch (err) {
    showCallAddParticipantError(err?.message || 'Failed to load room participants');
  } finally {
    callParticipantsLoading?.classList.add('hidden');
  }
}

export function closeCallAddParticipantModal() {
  if (!callAddParticipantModal) return;
  callAddParticipantModal.classList.add('hidden');
  if (callAddParticipantError) {
    callAddParticipantError.textContent = '';
    callAddParticipantError.classList.add('hidden');
  }
}

let groupParticipantsRefreshSeq = 0;

export async function refreshGroupParticipants(roomId) {
  if (!roomId || !window.ollacoreDesktop?.chatApi?.getParticipants) return;
  const seq = ++groupParticipantsRefreshSeq;

  groupMembersLoading?.classList.remove('hidden');
  if (groupMembersList) groupMembersList.innerHTML = '';

  try {
    const res = await window.ollacoreDesktop.chatApi.getParticipants(roomId);
    if (activeGroupInfoRoomId !== roomId || seq !== groupParticipantsRefreshSeq) return;

    activeGroupParticipants = Array.isArray(res?.participants) ? res.participants : [];
    shellState?.setRoomParticipants(roomId, activeGroupParticipants);
    updateRenderedGroupSenderNames(roomId);
    const currentUserId = shellState.currentUser?.userId || shellState.userProfile?.userId;

    const selfParticipant = activeGroupParticipants.find((p) => isParticipantSelf(p, currentUserId));
    isCurrentUserAdmin = Boolean(selfParticipant && isParticipantAdmin(selfParticipant));

    // Update role badge for current user
    if (groupInfoUserRoleBadge) {
      if (isCurrentUserAdmin) {
        groupInfoUserRoleBadge.textContent = 'Group Admin';
        groupInfoUserRoleBadge.className = 'badge-role admin';
      } else {
        groupInfoUserRoleBadge.textContent = 'Member';
        groupInfoUserRoleBadge.className = 'badge-role';
      }
    }

    // Group Rename is not supported in official OllaCore Customer Server API; keep disabled/hidden
    if (btnStartEditGroupName) {
      btnStartEditGroupName.classList.add('hidden');
    }

    // Add Member is not supported on client-safe OllaCore API; keep hidden
    if (groupAddMemberSection) {
      groupAddMemberSection.classList.add('hidden');
    }

    const memberCount = activeGroupParticipants.length;
    const countStr = `${memberCount} member${memberCount === 1 ? '' : 's'}`;
    if (groupInfoMemberCount) groupInfoMemberCount.textContent = countStr;
    if (groupMembersListCount) groupMembersListCount.textContent = String(memberCount);

    renderGroupMembersList(currentUserId);
  } catch (err) {
    if (activeGroupInfoRoomId !== roomId) return;
    showGroupError(err.message || 'Failed to load group members');
  } finally {
    groupMembersLoading?.classList.add('hidden');
  }
}

function renderGroupMembersList(currentUserId) {
  if (!groupMembersList) return;
  groupMembersList.innerHTML = '';

  const sorted = [...activeGroupParticipants].sort((a, b) => {
    const aIsSelf = isParticipantSelf(a, currentUserId);
    const bIsSelf = isParticipantSelf(b, currentUserId);
    if (aIsSelf) return -1;
    if (bIsSelf) return 1;
    const aAdmin = isParticipantAdmin(a);
    const bAdmin = isParticipantAdmin(b);
    if (aAdmin && !bAdmin) return -1;
    if (bAdmin && !aAdmin) return 1;
    const aName = a.displayName || a.phone || '';
    const bName = b.displayName || b.phone || '';
    return aName.localeCompare(bName);
  });

  for (const member of sorted) {
    const mId = member.principalId || member.principal_id;
    const isSelf = isParticipantSelf(member, currentUserId);
    const isAdmin = isParticipantAdmin(member);
    const isOwner = member.role && String(member.role).toLowerCase().trim() === 'owner';

    const item = document.createElement('div');
    item.className = 'group-member-item';

    const resolved = resolveMemberInfo(mId);
    let nameText = '';
    if (resolved.hasNickname) {
      nameText = resolved.displayName;
    } else if (member.displayName && !isInternalIdOrUuid(member.displayName)) {
      nameText = member.displayName.trim();
    } else if (resolved.displayName) {
      nameText = resolved.displayName;
    } else if (member.phone) {
      nameText = member.phone.trim();
    } else if (resolved.phone) {
      nameText = resolved.phone;
    } else {
      nameText = isSelf ? 'You' : 'Member';
    }

    let subText = '';
    if (resolved.hasNickname && resolved.serverDisplayName) {
      subText = `~${resolved.serverDisplayName}`;
    } else if (member.phone) {
      subText = member.phone.trim();
    } else if (resolved.phone) {
      subText = resolved.phone;
    }
    if (nameText === subText) {
      subText = '';
    }

    const initials = getAvatarInitials(nameText);
    const color = getAvatarColor(nameText);

    const leftDiv = document.createElement('div');
    leftDiv.className = 'group-member-left';

    const avatar = document.createElement('div');
    avatar.className = 'avatar avatar-sm';
    avatar.textContent = initials;
    avatar.style.backgroundColor = color;
    leftDiv.appendChild(avatar);

    const meta = document.createElement('div');
    meta.className = 'group-member-meta';

    const nameSpan = document.createElement('span');
    nameSpan.className = 'group-member-name';
    if (isSelf) {
      nameSpan.textContent = (nameText === 'You') ? 'You' : `${nameText} (You)`;
    } else {
      nameSpan.textContent = nameText;
    }
    meta.appendChild(nameSpan);

    if (subText) {
      const subSpan = document.createElement('span');
      subSpan.className = 'group-member-sub';
      subSpan.textContent = subText;
      meta.appendChild(subSpan);
    }
    leftDiv.appendChild(meta);
    item.appendChild(leftDiv);

    const rightDiv = document.createElement('div');
    rightDiv.className = 'group-member-right';

    if (isAdmin) {
      const adminBadge = document.createElement('span');
      adminBadge.className = 'badge-role admin';
      adminBadge.textContent = 'Group Admin';
      rightDiv.appendChild(adminBadge);
    }

    // Admin controls for other non-owner members
    // Note: Member removal / promotion is not supported on client-safe OllaCore API; omit action buttons

    item.appendChild(rightDiv);
    groupMembersList.appendChild(item);
  }
}

export async function handleRenameGroup() {
  if (!activeGroupInfoRoomId) return;
  showGroupError(null);
  showGroupSuccess(null);

  const rawName = groupRenameInput?.value || '';
  const val = validateGroupName(rawName);
  if (!val.valid) {
    showGroupError(val.error);
    groupRenameInput?.focus();
    return;
  }

  setButtonLoading(btnSaveGroupName, true);
  try {
    await window.ollacoreDesktop.chatApi.updateGroup(activeGroupInfoRoomId, { name: val.name });

    const conv = shellState.conversations?.find((c) => c.roomId === activeGroupInfoRoomId);
    if (conv) {
      conv.name = val.name;
    }

    if (groupInfoName) groupInfoName.textContent = val.name;
    if (activeGroupInfoRoomId === shellState.selectedRoomId && selectedChatName) {
      selectedChatName.textContent = val.name;
    }

    const initials = getAvatarInitials(val.name);
    const color = getAvatarColor(val.name);
    if (groupInfoAvatar) {
      groupInfoAvatar.textContent = initials;
      groupInfoAvatar.style.backgroundColor = color;
    }
    if (activeGroupInfoRoomId === shellState.selectedRoomId && selectedChatAvatar) {
      selectedChatAvatar.textContent = initials;
      selectedChatAvatar.style.backgroundColor = color;
    }

    renderConversationList();
    groupInfoRenameForm?.classList.add('hidden');
    groupInfoName?.classList.remove('hidden');
    showGroupSuccess('Group name updated successfully');
  } catch (err) {
    showGroupError(formatBackendGroupError('Rename group', err));
  } finally {
    setButtonLoading(btnSaveGroupName, false);
  }
}

export async function handleAddGroupMemberToExisting() {
  if (!activeGroupInfoRoomId) return;
  showGroupError(null);
  showGroupSuccess(null);

  const phone = groupAddMemberPhone?.value.trim() || '';
  if (!phone) {
    showGroupError('Please enter a phone number');
    groupAddMemberPhone?.focus();
    return;
  }

  setButtonLoading(btnSubmitAddMember, true);
  try {
    const lookupRes = await window.ollacoreDesktop.chatApi.lookupContacts([phone]);
    const contacts = Array.isArray(lookupRes?.contacts) ? lookupRes.contacts : [];
    const matchedContact = contacts.find((c) => c.isRegistered && c.userId);

    if (!matchedContact) {
      showGroupError('No registered OllaChat user found with this phone number');
      return;
    }

    const targetUserId = matchedContact.userId;
    const currentUserId = shellState.currentUser?.userId || shellState.userProfile?.userId;

    if (isParticipantSelf({ principalId: targetUserId }, currentUserId)) {
      showGroupError('You are already a member of this group');
      return;
    }

    const alreadyPresent = activeGroupParticipants.some((p) => isParticipantSelf(p, targetUserId));
    if (alreadyPresent) {
      showGroupError('This user is already a member of the group');
      return;
    }

    await window.ollacoreDesktop.chatApi.addMember(activeGroupInfoRoomId, targetUserId);
    createAndRecordGroupSystemMessage(activeGroupInfoRoomId, {
      action: 'add',
      actorId: currentUserId,
      targetUserId,
      targetName: matchedContact.displayName || matchedContact.phone || null
    });
    if (groupAddMemberPhone) groupAddMemberPhone.value = '';
    await refreshGroupParticipants(activeGroupInfoRoomId);
    showGroupSuccess('Member added to group');
  } catch (err) {
    showGroupError(formatBackendGroupError('Add member', err));
  } finally {
    setButtonLoading(btnSubmitAddMember, false);
  }
}

export async function handleRemoveMember(principalId) {
  if (!activeGroupInfoRoomId || !principalId) return;
  closeConfirmModal();
  showGroupError(null);
  showGroupSuccess(null);

  try {
    await window.ollacoreDesktop.chatApi.removeMember(activeGroupInfoRoomId, principalId);
    const curUid = shellState.currentUser?.userId || shellState.userProfile?.userId;
    createAndRecordGroupSystemMessage(activeGroupInfoRoomId, {
      action: 'remove',
      actorId: curUid,
      targetUserId: principalId
    });
    await refreshGroupParticipants(activeGroupInfoRoomId);
    showGroupSuccess('Member removed from group');
  } catch (err) {
    showGroupError(formatBackendGroupError('Remove member', err));
  }
}

export async function handleSetMemberRole(principalId, role) {
  if (!activeGroupInfoRoomId || !principalId) return;
  closeConfirmModal();
  showGroupError(null);
  showGroupSuccess(null);

  try {
    await window.ollacoreDesktop.chatApi.setMemberRole(activeGroupInfoRoomId, principalId, role);
    const curUid = shellState.currentUser?.userId || shellState.userProfile?.userId;
    createAndRecordGroupSystemMessage(activeGroupInfoRoomId, {
      action: 'role_update',
      actorId: curUid,
      targetUserId: principalId,
      role
    });
    await refreshGroupParticipants(activeGroupInfoRoomId);
    showGroupSuccess(role === 'admin' ? 'Member promoted to admin' : 'Admin role removed');
  } catch (err) {
    showGroupError(formatBackendGroupError('Update role', err));
  }
}

// ═══════════════════════════════════════════════════════════════════
// WHATSAPP-STYLE CONTACT INFO PANEL CONTROLLER
// ═══════════════════════════════════════════════════════════════════

let activeContactInfoRoomId = null;

export function getActiveContactInfoRoomId() {
  return activeContactInfoRoomId;
}

export function isContactInfoPanelOpen() {
  return Boolean(activeContactInfoRoomId && contactInfoPanel && !contactInfoPanel.classList.contains('hidden'));
}

export async function openContactInfo(roomId) {
  if (!roomId) return;
  closeChatHeaderMenu();
  closeParticipantActionMenu();
  const conv = shellState.conversations?.find((c) => c.roomId === roomId);
  if (!conv) return;

  const isSwitchingRoom = activeContactInfoRoomId !== roomId;
  activeContactInfoRoomId = roomId;
  shellState.openContactInfo(roomId);

  if (isSwitchingRoom) {
    activeGroupParticipants = [];
  }

  const currentUserId = shellState.currentUser?.userId || shellState.userProfile?.userId;
  const initialParticipants = Array.isArray(conv.participants)
    ? conv.participants
    : (activeGroupParticipants.length > 0 ? activeGroupParticipants : []);
  const caps = getGroupCapabilities(conv, initialParticipants, currentUserId);
  const isGroup = caps.isGroup;
  const isExited = caps.isExited;
  const title = getConversationTitle(conv);
  const initials = getAvatarInitials(title);
  const color = getAvatarColor(title);

  // Set Header Title
  if (contactInfoHeaderTitle) {
    contactInfoHeaderTitle.textContent = isGroup ? 'Group info' : 'Contact info';
  }

  // Set Avatar
  if (contactInfoAvatar) {
    const avatarUrl = getConversationAvatarUrl(conv);
    if (avatarUrl) {
      renderAvatarElement(contactInfoAvatar, avatarUrl, initials, color, false);
    } else {
      contactInfoAvatar.textContent = initials;
      contactInfoAvatar.style.backgroundColor = color;
    }
  }

  // Set Name
  if (contactInfoName) {
    contactInfoName.textContent = title;
    contactInfoName.classList.remove('hidden');
  }

  contactInfoRenameForm?.classList.add('hidden');
  btnContactInfoEditName?.classList.toggle('hidden', !caps.canRenameGroup);

  // Update favourite status on contact info nav row
  const isFav = shellState.isFavourite(roomId);
  if (contactInfoFavLabel) {
    contactInfoFavLabel.textContent = isFav ? 'Remove from favourites' : 'Add to favourites';
  }

  if (isGroup) {
    // Group mode
    contactInfoIdentifier?.classList.add('hidden');
    if (contactInfoGroupMeta) {
      contactInfoGroupMeta.textContent = 'Group conversation';
      contactInfoGroupMeta.classList.remove('hidden');
    }

    // Group description
    contactInfoDescForm?.classList.add('hidden');
    contactInfoAboutText?.classList.remove('hidden');
    const desc = conv.description || conv.about;
    if (contactInfoAboutTitle) contactInfoAboutTitle.textContent = 'Description';
    if (caps.canEditDescription) {
      btnContactInfoEditDesc?.classList.remove('hidden');
      if (desc && typeof desc === 'string' && desc.trim() !== '') {
        if (contactInfoAboutText) {
          contactInfoAboutText.textContent = desc.trim();
          contactInfoAboutText.classList.remove('contact-info-about-placeholder');
        }
      } else {
        if (contactInfoAboutText) {
          contactInfoAboutText.textContent = 'Add group description';
          contactInfoAboutText.classList.add('contact-info-about-placeholder');
        }
      }
      contactInfoAboutSection?.classList.remove('hidden');
    } else {
      btnContactInfoEditDesc?.classList.add('hidden');
      if (desc && typeof desc === 'string' && desc.trim() !== '') {
        if (contactInfoAboutText) {
          contactInfoAboutText.textContent = desc.trim();
          contactInfoAboutText.classList.remove('contact-info-about-placeholder');
        }
        contactInfoAboutSection?.classList.remove('hidden');
      } else {
        contactInfoAboutSection?.classList.add('hidden');
      }
    }

    // Details section hidden for groups
    contactInfoDetailsSection?.classList.add('hidden');
    btnContactInfoNicknameAction?.classList.add('hidden');
    contactInfoNicknameForm?.classList.add('hidden');
    contactInfoServerNameRow?.classList.add('hidden');

    // Danger zone for groups
    contactInfoExitGroupRow?.classList.toggle('hidden', !caps.canExitGroup);
    contactInfoDeleteChatRow?.classList.toggle('hidden', !caps.canDeleteChat);

    // Show participants section & load real participants
    contactInfoParticipantsSection?.classList.remove('hidden');
    await refreshContactInfoParticipants(roomId);
  } else {
    // Direct chat mode
    contactInfoGroupMeta?.classList.add('hidden');
    contactInfoParticipantsSection?.classList.add('hidden');
    btnGroupAddPeople?.classList.add('hidden');
    btnContactInfoEditName?.classList.add('hidden');
    contactInfoRenameForm?.classList.add('hidden');
    btnContactInfoEditDesc?.classList.add('hidden');
    contactInfoDescForm?.classList.add('hidden');
    contactInfoAboutText?.classList.remove('contact-info-about-placeholder');
    contactInfoAboutText?.classList.remove('hidden');
    contactInfoExitGroupRow?.classList.add('hidden');
    contactInfoDeleteChatRow?.classList.remove('hidden');

    const contactUserId = conv.peer?.userId || conv.peerUserId || conv.peer_user_id || conv.peerId;
    const currentNickname = contactUserId ? shellState.getContactNickname(contactUserId) : null;
    const serverDisplayName = conv.peer?.displayName || conv.displayName || null;

    if (contactUserId && btnContactInfoNicknameAction) {
      btnContactInfoNicknameAction.classList.remove('hidden');
      if (contactInfoNicknameActionLabel) {
        contactInfoNicknameActionLabel.textContent = currentNickname ? 'Edit nickname' : 'Add nickname';
      }
    } else {
      btnContactInfoNicknameAction?.classList.add('hidden');
    }
    contactInfoNicknameForm?.classList.add('hidden');

    const phone = conv.peer?.phone || conv.phone;
    const username = conv.peer?.username || conv.username;
    const identifier = phone || username || (conv.peer?.userId ? conv.peer.userId : '');

    if (identifier && contactInfoIdentifier) {
      contactInfoIdentifier.textContent = identifier;
      contactInfoIdentifier.classList.remove('hidden');
    } else {
      contactInfoIdentifier?.classList.add('hidden');
    }

    // About / Bio
    const bio = conv.peer?.about || conv.peer?.bio || conv.about || conv.bio;
    if (bio && typeof bio === 'string' && bio.trim() !== '') {
      if (contactInfoAboutTitle) contactInfoAboutTitle.textContent = 'About';
      if (contactInfoAboutText) contactInfoAboutText.textContent = bio.trim();
      contactInfoAboutSection?.classList.remove('hidden');
    } else {
      contactInfoAboutSection?.classList.add('hidden');
    }

    // Details: Profile name, Phone & Username
    let hasDetails = false;

    // Distinguish personal nickname from server profile name in Details section
    if (currentNickname && serverDisplayName && contactInfoServerNameRow && contactInfoServerNameValue) {
      contactInfoServerNameValue.textContent = serverDisplayName;
      contactInfoServerNameRow.classList.remove('hidden');
      hasDetails = true;
    } else {
      contactInfoServerNameRow?.classList.add('hidden');
    }

    if (phone && contactInfoPhoneValue) {
      contactInfoPhoneValue.textContent = phone;
      contactInfoPhoneRow?.classList.remove('hidden');
      hasDetails = true;
    } else {
      contactInfoPhoneRow?.classList.add('hidden');
    }

    if (username && contactInfoUsernameValue) {
      contactInfoUsernameValue.textContent = `@${username.replace(/^@/, '')}`;
      contactInfoUsernameRow?.classList.remove('hidden');
      hasDetails = true;
    } else {
      contactInfoUsernameRow?.classList.add('hidden');
    }

    if (hasDetails) {
      contactInfoDetailsSection?.classList.remove('hidden');
    } else {
      contactInfoDetailsSection?.classList.add('hidden');
    }
  }

  // Update Mute row status
  const isMuted = shellState.isConversationMuted(conv);
  if (contactInfoMuteValue) {
    contactInfoMuteValue.textContent = isMuted ? 'Muted' : 'Off';
  }

  // Update Block row status (direct chats only)
  if (isGroup) {
    contactInfoBlockRow?.classList.add('hidden');
  } else {
    contactInfoBlockRow?.classList.remove('hidden');
    const peerUserId = getDirectPeerUserId(conv, shellState.currentUser?.userId);
    const isBlocked = peerUserId ? shellState.isUserBlocked(peerUserId) : false;
    if (contactInfoBlockLabel) {
      contactInfoBlockLabel.textContent = isBlocked ? 'Unblock' : 'Block';
    }
  }

  contactInfoStarredRow?.classList.remove('hidden');
  updateContactInfoStarredCount(roomId);

  contactInfoPanel?.classList.remove('hidden');
}

export function closeContactInfo() {
  activeContactInfoRoomId = null;
  activeGroupParticipants = [];
  isCurrentUserAdmin = false;
  shellState.closeContactInfo();
  contactInfoPanel?.classList.add('hidden');
  closeParticipantActionMenu();
  closeGroupAddPeopleModal();
  contactInfoRenameForm?.classList.add('hidden');
  contactInfoNicknameForm?.classList.add('hidden');
  btnContactInfoNicknameAction?.classList.add('hidden');
  contactInfoName?.classList.remove('hidden');
  // Also close sub-panels that slide over contact info
  document.getElementById('media-browser-panel')?.classList.add('hidden');
  document.getElementById('starred-messages-panel')?.classList.add('hidden');
  document.getElementById('pinned-messages-panel')?.classList.add('hidden');
  // Reset module-level state if already initialised (safe — won't throw if undefined)
  if (typeof activeMbRoomId !== 'undefined') activeMbRoomId = null;
  if (typeof activeStarredRoomId !== 'undefined') activeStarredRoomId = null;
  if (typeof activePinnedRoomId !== 'undefined') activePinnedRoomId = null;
}

let contactInfoRefreshSeq = 0;

export async function refreshContactInfoParticipants(roomId) {
  if (!roomId || !window.ollacoreDesktop?.chatApi?.getParticipants) return;
  const seq = ++contactInfoRefreshSeq;

  contactInfoParticipantsLoading?.classList.remove('hidden');
  if (contactInfoParticipantsList) contactInfoParticipantsList.innerHTML = '';

  try {
    const res = await window.ollacoreDesktop.chatApi.getParticipants(roomId);
    if (activeContactInfoRoomId !== roomId || seq !== contactInfoRefreshSeq) return;

    const participants = Array.isArray(res?.participants)
      ? res.participants
      : (Array.isArray(res?.members) ? res.members : (Array.isArray(res) ? res : []));
    activeGroupParticipants = participants;
    shellState?.setRoomParticipants(roomId, participants);
    updateRenderedGroupSenderNames(roomId);
    const currentUserId = shellState.currentUser?.userId || shellState.userProfile?.userId;

    const conv = shellState.conversations?.find((c) => c.roomId === roomId);
    if (conv) {
      conv.participants = participants;
      conv.participantCount = participants.length;
      renderConversationList();
    }
    const caps = getGroupCapabilities(conv, participants, currentUserId);
    isCurrentUserAdmin = caps.isAdmin;

    // Admin rename control
    if (caps.canRenameGroup) {
      btnContactInfoEditName?.classList.remove('hidden');
    } else {
      btnContactInfoEditName?.classList.add('hidden');
      contactInfoRenameForm?.classList.add('hidden');
      contactInfoName?.classList.remove('hidden');
    }

    // Admin description control
    if (caps.canEditDescription) {
      btnContactInfoEditDesc?.classList.remove('hidden');
      contactInfoAboutSection?.classList.remove('hidden');
      const desc = conv?.description || conv?.about;
      if (!desc || typeof desc !== 'string' || desc.trim() === '') {
        if (contactInfoAboutText) {
          contactInfoAboutText.textContent = 'Add group description';
          contactInfoAboutText.classList.add('contact-info-about-placeholder');
        }
      } else {
        if (contactInfoAboutText) {
          contactInfoAboutText.textContent = desc.trim();
          contactInfoAboutText.classList.remove('contact-info-about-placeholder');
        }
      }
    } else {
      btnContactInfoEditDesc?.classList.add('hidden');
      contactInfoDescForm?.classList.add('hidden');
      contactInfoAboutText?.classList.remove('hidden');
      const desc = conv?.description || conv?.about;
      if (desc && typeof desc === 'string' && desc.trim() !== '') {
        if (contactInfoAboutText) {
          contactInfoAboutText.textContent = desc.trim();
          contactInfoAboutText.classList.remove('contact-info-about-placeholder');
        }
        contactInfoAboutSection?.classList.remove('hidden');
      } else {
        contactInfoAboutSection?.classList.add('hidden');
      }
    }

    // Add people button in participants section
    if (caps.canAddPeople) {
      btnGroupAddPeople?.classList.remove('hidden');
    } else {
      btnGroupAddPeople?.classList.add('hidden');
    }

    // Danger row
    if (caps.isExited) {
      contactInfoExitGroupRow?.classList.add('hidden');
      contactInfoDeleteChatRow?.classList.remove('hidden');
    } else if (caps.canExitGroup) {
      contactInfoExitGroupRow?.classList.remove('hidden');
      contactInfoDeleteChatRow?.classList.add('hidden');
    } else {
      contactInfoExitGroupRow?.classList.add('hidden');
      contactInfoDeleteChatRow?.classList.remove('hidden');
    }

    const count = participants.length;
    const countStr = `Participants · ${count}`;
    if (contactInfoParticipantsCount) contactInfoParticipantsCount.textContent = countStr;
    if (contactInfoGroupMeta) contactInfoGroupMeta.textContent = `Group · ${count} participant${count === 1 ? '' : 's'}`;

    renderContactInfoParticipantsList(participants, currentUserId);
  } catch (err) {
    if (activeContactInfoRoomId !== roomId) return;
    console.warn('[ContactInfo] Failed to fetch participants:', err?.message || err);
  } finally {
    contactInfoParticipantsLoading?.classList.add('hidden');
  }
}

function renderContactInfoParticipantsList(participants, currentUserId) {
  if (!contactInfoParticipantsList) return;
  contactInfoParticipantsList.innerHTML = '';

  const sorted = [...participants].sort((a, b) => {
    const aIsSelf = isParticipantSelf(a, currentUserId);
    const bIsSelf = isParticipantSelf(b, currentUserId);
    if (aIsSelf) return -1;
    if (bIsSelf) return 1;
    const aAdmin = isParticipantAdmin(a);
    const bAdmin = isParticipantAdmin(b);
    if (aAdmin && !bAdmin) return -1;
    if (bAdmin && !aAdmin) return 1;
    const aName = a.displayName || a.phone || '';
    const bName = b.displayName || b.phone || '';
    return aName.localeCompare(bName);
  });

  for (const member of sorted) {
    const mId = member.principalId || member.principal_id;
    const isSelf = isParticipantSelf(member, currentUserId);
    const isAdmin = isParticipantAdmin(member);

    const resolved = resolveMemberInfo(mId);
    let nameText = '';
    if (resolved.hasNickname) {
      nameText = resolved.displayName;
    } else if (member.displayName && !isInternalIdOrUuid(member.displayName)) {
      nameText = member.displayName.trim();
    } else if (resolved.displayName) {
      nameText = resolved.displayName;
    } else if (member.phone) {
      nameText = member.phone.trim();
    } else if (resolved.phone) {
      nameText = resolved.phone;
    } else {
      nameText = isSelf ? 'You' : 'Member';
    }

    let subText = '';
    if (resolved.hasNickname && resolved.serverDisplayName) {
      subText = `~${resolved.serverDisplayName}`;
    } else if (member.phone) {
      subText = member.phone.trim();
    } else if (resolved.phone) {
      subText = resolved.phone;
    }
    if (nameText === subText) subText = '';

    const initials = getAvatarInitials(nameText);
    const color = getAvatarColor(nameText);

    const row = document.createElement('div');
    row.className = 'contact-info-participant-row';

    const left = document.createElement('div');
    left.className = 'contact-info-participant-left';

    const avatar = document.createElement('div');
    avatar.className = 'avatar avatar-sm';
    avatar.textContent = initials;
    avatar.style.backgroundColor = color;
    left.appendChild(avatar);

    const meta = document.createElement('div');
    meta.className = 'contact-info-participant-meta';

    const nameSpan = document.createElement('span');
    nameSpan.className = 'contact-info-participant-name';
    nameSpan.textContent = isSelf && nameText !== 'You' ? `${nameText} (You)` : nameText;
    meta.appendChild(nameSpan);

    if (subText) {
      const subSpan = document.createElement('span');
      subSpan.className = 'contact-info-participant-sub';
      subSpan.textContent = subText;
      meta.appendChild(subSpan);
    }
    left.appendChild(meta);
    row.appendChild(left);

    const right = document.createElement('div');
    right.className = 'contact-info-participant-right';

    const mRole = String(member.role || '').toLowerCase().trim();
    if (mRole === 'owner' || mRole === 'creator') {
      const ownerBadge = document.createElement('span');
      ownerBadge.className = 'badge-role owner';
      ownerBadge.textContent = 'Group Owner';
      right.appendChild(ownerBadge);
    } else if (isAdmin) {
      const adminBadge = document.createElement('span');
      adminBadge.className = 'badge-role admin';
      adminBadge.textContent = 'Group Admin';
      right.appendChild(adminBadge);
    }

    // For authorized admins (or when options are available), show action button
    if (isCurrentUserAdmin && !isSelf) {
      const actionBtn = document.createElement('button');
      actionBtn.type = 'button';
      actionBtn.className = 'btn-icon btn-xs participant-action-btn';
      actionBtn.title = 'Participant options';
      actionBtn.setAttribute('aria-label', `Options for ${nameText}`);
      actionBtn.innerHTML = '<svg class="ui-icon ui-icon-xs" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="1"/><circle cx="12" cy="5" r="1"/><circle cx="12" cy="19" r="1"/></svg>';

      actionBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openParticipantActionMenu(e, member, activeContactInfoRoomId);
      });

      row.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        openParticipantActionMenu(e, member, activeContactInfoRoomId);
      });

      right.appendChild(actionBtn);
    }

    row.appendChild(right);
    contactInfoParticipantsList.appendChild(row);
  }
}

// ═══════════════════════════════════════════════════════════════════
// PARTICIPANT ACTION MENU & MODAL CONTROLLERS
// ═══════════════════════════════════════════════════════════════════

let activeMenuParticipant = null;
let activeMenuRoomId = null;

function openParticipantActionMenu(e, participant, roomId) {
  if (!participantActionMenu || !participant || !roomId) return;
  activeMenuParticipant = participant;
  activeMenuRoomId = roomId;

  const currentUserId = shellState.currentUser?.userId || shellState.userProfile?.userId;
  const caps = getParticipantCapabilities(participant, isCurrentUserAdmin, currentUserId, activeGroupParticipants);

  if (partMenuViewContact) {
    partMenuViewContact.classList.toggle('hidden', !caps.canViewContact);
  }
  if (partMenuMakeAdmin) {
    partMenuMakeAdmin.classList.toggle('hidden', !caps.canPromote);
    if (partMenuMakeAdminText) {
      partMenuMakeAdminText.textContent = 'Promote to Owner';
    }
  }
  if (partMenuDismissAdmin) {
    partMenuDismissAdmin.classList.toggle('hidden', !caps.canDemote);
    if (partMenuDismissAdminText) {
      partMenuDismissAdminText.textContent = caps.targetIsOwner ? 'Demote to Member' : 'Dismiss as admin';
    }
  }
  if (partMenuSeparator) {
    partMenuSeparator.classList.toggle('hidden', !caps.canRemove);
  }
  if (partMenuRemove) {
    partMenuRemove.classList.toggle('hidden', !caps.canRemove);
    const resolved = resolveMemberInfo(participant.principalId || participant.principal_id);
    const pName = participant.displayName || resolved.displayName || 'member';
    if (partMenuRemoveText) {
      partMenuRemoveText.textContent = `Remove ${pName}`;
    }
  }

  participantActionMenu.classList.remove('hidden');
  const menuWidth = 200;
  const menuHeight = 150;
  let left = e.clientX || 0;
  let top = e.clientY || 0;
  if (left + menuWidth > window.innerWidth - 10) left = window.innerWidth - menuWidth - 10;
  if (top + menuHeight > window.innerHeight - 10) top = top - menuHeight;
  if (left < 10) left = 10;
  if (top < 10) top = 10;
  participantActionMenu.style.left = `${left}px`;
  participantActionMenu.style.top = `${top}px`;
}

function closeParticipantActionMenu() {
  if (!participantActionMenu) return;
  participantActionMenu.classList.add('hidden');
  activeMenuParticipant = null;
  activeMenuRoomId = null;
}

export function showToast(message) {
  if (typeof document === 'undefined') return;
  let toast = document.getElementById('app-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'app-toast';
    toast.className = 'app-toast';
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.classList.remove('hidden');
  toast.classList.add('visible');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => {
    toast.classList.remove('visible');
    toast.classList.add('hidden');
  }, 2500);
}

let pendingClearChatRoomId = null;

export function openClearChatModal(roomId) {
  if (!roomId) return;
  pendingClearChatRoomId = roomId;

  // Always reset default selection to "Delete chats only"
  if (clearChatOptionMessagesOnly) {
    clearChatOptionMessagesOnly.checked = true;
  }
  if (clearChatOptionMessagesAndMedia) {
    clearChatOptionMessagesAndMedia.checked = false;
  }

  clearChatModal?.classList.remove('hidden');
}

export function requestClearChat(roomId) {
  openClearChatModal(roomId);
}

export function closeClearChatModal() {
  clearChatModal?.classList.add('hidden');
  pendingClearChatRoomId = null;
}

export async function handleClearChatProceed() {
  const roomId = pendingClearChatRoomId;
  if (!roomId) {
    closeClearChatModal();
    return;
  }

  const deleteMedia = Boolean(clearChatOptionMessagesAndMedia?.checked);
  const rState = getOrCreateRoomMessagesState(roomId);

  if (deleteMedia) {
    // 1. Collect every attachment ID referenced by messages in the target room
    const targetMessages = Array.isArray(rState.messages) ? rState.messages : [];
    // 2 & 3. Inspect other loaded room message states; exclude any attachment referenced by other rooms
    const eligibleAttachmentIds = getEligibleAttachmentIdsForDeletion(roomId, roomMessagesMap, targetMessages);

    // 4 & 5. Send eligible attachment IDs to main process through secure IPC bridge
    if (eligibleAttachmentIds.length > 0) {
      try {
        if (window.ollacoreDesktop?.media?.deleteCachedAttachments) {
          await window.ollacoreDesktop.media.deleteCachedAttachments(eligibleAttachmentIds);
        }
      } catch (err) {
        console.warn('[handleClearChatProceed] Failed to delete cached attachments:', err);
      }

      // 6. Purge matching entries from renderer's in-memory attachmentUrls cache
      for (const id of eligibleAttachmentIds) {
        attachmentUrls.delete(id);
      }
    }

    rState.clearMessages(roomId, { chatsOnly: false });
  } else {
    // Delete chats only: selectively remove text messages and recorded voice notes, preserving other media attachments
    rState.clearMessages(roomId, { chatsOnly: true });
  }

  // Clear or update conversation's sidebar last-message preview and reset unread state
  const conv = shellState.conversations?.find((c) => String(c.roomId) === String(roomId));
  if (conv) {
    if (Array.isArray(rState.messages) && rState.messages.length > 0) {
      const lastMsg = rState.messages[rState.messages.length - 1];
      const resolvedLast = resolveMessageContent(lastMsg);
      conv.lastMessage = {
        preview: resolvedLast.fallbackText || resolvedLast.text || 'Attachment',
        senderId: lastMsg.senderId || lastMsg.sender_id,
        createdAt: lastMsg.createdAt || lastMsg.created_at,
        kind: resolvedLast.kind
      };
      conv.last_message = conv.lastMessage;
    } else {
      conv.lastMessage = null;
      conv.last_message = null;
    }
    conv.unreadCount = 0;
    conv.unread_count = 0;
  }
  shellState.markConversationAsRead(roomId);

  // Refresh:
  // - message list
  if (roomId === shellState.selectedRoomId) {
    if (rState.messages.length === 0) {
      messagesEmpty?.classList.remove('hidden');
      messagesScrollArea?.classList.add('hidden');
    } else {
      messagesEmpty?.classList.add('hidden');
      messagesScrollArea?.classList.remove('hidden');
    }
    renderMessages();
    scrollToBottom(false);
  }

  // - conversation list
  renderConversationList();
  updateChatFilterCounts();

  // - Media/Links/Docs panel if open
  if (mediaBrowserPanel && !mediaBrowserPanel.classList.contains('hidden') && activeMbRoomId === roomId) {
    _populateMbTab(activeMbTab, roomId);
  }

  // Clear pinned messages for this room and hide the pinned bar
  shellState.clearPinnedMessages(roomId);
  if (roomId === shellState.selectedRoomId) {
    renderPinnedBar(roomId);
  }

  closeClearChatModal();
  showToast('Chat cleared');
}

export function requestExitGroup(roomId) {
  if (!roomId) return;
  const conv = shellState.conversations?.find((c) => c.roomId === roomId);
  const title = conv ? getConversationTitle(conv) : 'this group';

  // Open WhatsApp-style confirmation modal if available; fallback to confirmation modal
  if (leaveGroupConfirmModal) {
    openLeaveGroupConfirmModal(roomId);
    return;
  }

  openConfirmModal(
    'Exit group',
    `Exit "${title}" group? You will no longer be a participant and won't be able to send or receive messages in this group.`,
    async () => {
      closeConfirmModal();
      try {
        if (voiceCallManager && voiceCallManager.currentRoomId === roomId && voiceCallManager.state !== 'IDLE' && voiceCallManager.state !== 'ENDED') {
          voiceCallManager.endCall(true);
        }
        await window.ollacoreDesktop.chatApi.leaveGroup(roomId);
        if (conv) {
          conv.isExited = true;
          conv.exited = true;
          persistConversationToDb(conv).catch(() => { });
        }
        if (shellState.selectedRoomId === roomId) {
          updateExitedGroupUI(conv);
        }
        closeContactInfo();
        renderConversationList();
        updateChatFilterCounts();
      } catch (err) {
        alert(formatBackendGroupError('Exit group', err));
      }
    }
  );
}

export function requestDeleteChat(roomId) {
  if (!roomId) return;
  openConfirmModal(
    'Delete chat?',
    'Are you sure you want to delete this chat?',
    async () => {
      closeConfirmModal();
      shellState.removeConversation(roomId);
      const rState = getOrCreateRoomMessagesState(roomId);
      rState.clearMessages(roomId);
      deleteConversationFromDb(roomId).catch(() => { });
      if (shellState.selectedRoomId === roomId) {
        shellState.selectedRoomId = null;
        chatSelectedPanel?.classList.add('hidden');
        chatEmptyPanel?.classList.remove('hidden');
        closeContactInfo();
        closeChatSearch();
        closeChatHeaderMenu();
      } else if (activeContactInfoRoomId === roomId) {
        closeContactInfo();
      }
      renderConversationList();
      updateChatFilterCounts();
    },
    'Delete chat'
  );
}

let selectedAddContactUserId = null;
const selectedAddContactUserIds = new Set();

function updateAddPeopleConfirmButton() {
  const count = selectedAddContactUserIds.size;
  if (btnConfirmGroupAddPeople) {
    btnConfirmGroupAddPeople.disabled = (count === 0);
    const btnText = btnConfirmGroupAddPeople.querySelector('.btn-text');
    if (btnText) {
      btnText.textContent = count > 1 ? `Add (${count}) to group` : 'Add to group';
    }
  }
}

export function openGroupAddPeopleModal(roomId) {
  if (!groupAddPeopleModal || !roomId) return;
  selectedAddContactUserId = null;
  selectedAddContactUserIds.clear();
  if (groupAddPeopleInput) groupAddPeopleInput.value = '';
  groupAddPeopleError?.classList.add('hidden');
  if (groupAddPeopleError) groupAddPeopleError.textContent = '';
  groupAddPeopleMatched?.classList.add('hidden');
  groupAddPeopleMatched?.classList.remove('selected');
  if (btnSelectMatchedContact) btnSelectMatchedContact.textContent = 'Select';
  updateAddPeopleConfirmButton();

  if (groupAddPeopleContactsList) {
    groupAddPeopleContactsList.querySelectorAll('.group-add-contact-item').forEach((el) => el.classList.remove('selected'));
    groupAddPeopleContactsList.innerHTML = '';
    const directConvs = (shellState.conversations || []).filter(
      (c) => c.kind === 'direct' && c.peer?.userId && !activeGroupParticipants.some((p) => isParticipantSelf(p, c.peer.userId))
    );

    if (directConvs.length === 0) {
      const emptyHint = document.createElement('div');
      emptyHint.className = 'field-hint';
      emptyHint.textContent = 'No other direct contacts available to add';
      groupAddPeopleContactsList.appendChild(emptyHint);
    } else {
      for (const d of directConvs) {
        const item = document.createElement('div');
        item.className = 'group-add-contact-item';
        item.setAttribute('data-user-id', d.peer.userId);

        const title = getConversationTitle(d);
        const initials = getAvatarInitials(title);
        const color = getAvatarColor(title);

        const left = document.createElement('div');
        left.className = 'contact-info-participant-left';

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.className = 'group-add-contact-checkbox';
        checkbox.tabIndex = -1;
        left.appendChild(checkbox);

        const av = document.createElement('div');
        av.className = 'avatar avatar-sm';
        av.textContent = initials;
        av.style.backgroundColor = color;
        left.appendChild(av);

        const meta = document.createElement('div');
        meta.className = 'contact-info-participant-meta';

        const nameSpan = document.createElement('span');
        nameSpan.className = 'contact-info-participant-name';
        nameSpan.textContent = title;
        meta.appendChild(nameSpan);

        if (d.peer?.phone) {
          const phoneSpan = document.createElement('span');
          phoneSpan.className = 'contact-info-participant-sub';
          phoneSpan.textContent = d.peer.phone;
          meta.appendChild(phoneSpan);
        }
        left.appendChild(meta);
        item.appendChild(left);

        item.addEventListener('click', (e) => {
          if (e.target !== checkbox) {
            checkbox.checked = !checkbox.checked;
          }
          if (checkbox.checked) {
            selectedAddContactUserIds.add(d.peer.userId);
            item.classList.add('selected');
          } else {
            selectedAddContactUserIds.delete(d.peer.userId);
            item.classList.remove('selected');
          }
          selectedAddContactUserId = selectedAddContactUserIds.values().next().value || null;
          updateAddPeopleConfirmButton();
        });

        checkbox.addEventListener('change', () => {
          if (checkbox.checked) {
            selectedAddContactUserIds.add(d.peer.userId);
            item.classList.add('selected');
          } else {
            selectedAddContactUserIds.delete(d.peer.userId);
            item.classList.remove('selected');
          }
          selectedAddContactUserId = selectedAddContactUserIds.values().next().value || null;
          updateAddPeopleConfirmButton();
        });

        groupAddPeopleContactsList.appendChild(item);
      }
    }
  }

  groupAddPeopleModal.classList.remove('hidden');
  groupAddPeopleInput?.focus();
}

export function closeGroupAddPeopleModal() {
  if (!groupAddPeopleModal) return;
  groupAddPeopleModal.classList.add('hidden');
  selectedAddContactUserId = null;
  selectedAddContactUserIds.clear();
}

let isProcessingLeaveGroup = false;

export function openLeaveGroupConfirmModal(roomId) {
  if (!roomId || !leaveGroupConfirmModal) return;
  pendingLeaveGroupRoomId = roomId;

  if (leaveGroupModalTitle) {
    leaveGroupModalTitle.textContent = 'Exit group?';
  }
  if (leaveGroupModalMessage) {
    leaveGroupModalMessage.textContent = 'Are you sure you want to exit this group?';
  }
  leaveGroupConfirmModal.classList.remove('hidden');
}

export function closeLeaveGroupConfirmModal() {
  if (leaveGroupConfirmModal) {
    leaveGroupConfirmModal.classList.add('hidden');
  }
  pendingLeaveGroupRoomId = null;
}

export async function handleConfirmLeaveGroup(roomId, { deleteChat = false } = {}) {
  const targetRoomId = roomId || pendingLeaveGroupRoomId;
  if (!targetRoomId || isProcessingLeaveGroup) return;

  const conv = shellState.conversations?.find((c) => c.roomId === targetRoomId);

  isProcessingLeaveGroup = true;
  closeLeaveGroupConfirmModal();

  try {
    if (voiceCallManager && voiceCallManager.currentRoomId === targetRoomId && voiceCallManager.state !== 'IDLE' && voiceCallManager.state !== 'ENDED') {
      voiceCallManager.endCall(true);
    }
    await window.ollacoreDesktop.chatApi.leaveGroup(targetRoomId);

    if (deleteChat) {
      // Exit and delete: execute local deletion only after leaveGroup succeeds
      shellState.removeConversation(targetRoomId);
      const rState = getOrCreateRoomMessagesState(targetRoomId);
      rState.clearMessages(targetRoomId);
      deleteConversationFromDb(targetRoomId).catch(() => { });
      shellState.selectedRoomId = null;
      chatSelectedPanel?.classList.add('hidden');
    } else {
      if (conv) {
        conv.isExited = true;
        conv.exited = true;
        persistConversationToDb(conv).catch(() => { });
        if (shellState.selectedRoomId === targetRoomId) {
          updateExitedGroupUI(conv);
        }
      }
    }
    closeContactInfo();
    renderConversationList();
    updateChatFilterCounts();
  } catch (err) {
    alert(formatBackendGroupError('Exit group', err));
  } finally {
    isProcessingLeaveGroup = false;
  }
}

export async function handleConfirmDeleteGroupChat(roomId) {
  return handleConfirmLeaveGroup(roomId, { deleteChat: true });
}

// ═══════════════════════════════════════════════════════════════════
// IN-CHAT MESSAGE SEARCH CONTROLLER
// ═══════════════════════════════════════════════════════════════════

export const chatSearchState = {
  isOpen: false,
  query: '',
  results: [],
  currentIndex: -1,
  isLoading: false,
  error: null,
  activeSearchId: 0
};

let searchDebounceTimer = null;

/**
 * Opens in-conversation search bar for currently selected room.
 */
function openChatSearch() {
  if (!shellState.selectedRoomId) return;
  chatSearchState.isOpen = true;
  chatSearchBar?.classList.remove('hidden');
  chatSearchInput?.focus();
  chatSearchInput?.select();
  if (chatSearchState.results.length > 0) {
    chatSearchResultsPanel?.classList.remove('hidden');
  }
}

/**
 * Closes in-conversation search bar and clears search highlights.
 */
function closeChatSearch() {
  chatSearchState.isOpen = false;
  chatSearchBar?.classList.add('hidden');
  chatSearchResultsPanel?.classList.add('hidden');
  if (chatSearchInput) chatSearchInput.value = '';
  btnClearChatSearch?.classList.add('hidden');
  if (chatSearchCount) chatSearchCount.textContent = '';
  if (btnPrevSearchResult) btnPrevSearchResult.disabled = true;
  if (btnNextSearchResult) btnNextSearchResult.disabled = true;
  clearTimeout(searchDebounceTimer);
  chatSearchState.results = [];
  chatSearchState.currentIndex = -1;
  chatSearchState.query = '';
  chatSearchState.error = null;
  chatSearchState.isLoading = false;
  if (chatSearchResultsList) chatSearchResultsList.innerHTML = '';
  if (messagesList) {
    messagesList.querySelectorAll('.message-row.highlighted').forEach((r) => r.classList.remove('highlighted'));
  }
}

/**
 * Safely renders snippet text with matched query terms wrapped in <mark> tags.
 * Avoids any innerHTML XSS injection.
 * @param {HTMLElement} container
 * @param {string} text
 * @param {string} query
 */
function renderHighlightedSnippet(container, text, query) {
  container.innerHTML = '';
  if (!query || typeof text !== 'string') {
    container.textContent = text || '';
    return;
  }
  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  let startIndex = 0;
  let matchIndex = lowerText.indexOf(lowerQuery, startIndex);

  if (matchIndex === -1) {
    container.textContent = text;
    return;
  }

  while (matchIndex !== -1) {
    if (matchIndex > startIndex) {
      container.appendChild(document.createTextNode(text.substring(startIndex, matchIndex)));
    }
    const mark = document.createElement('mark');
    mark.textContent = text.substring(matchIndex, matchIndex + query.length);
    container.appendChild(mark);
    startIndex = matchIndex + query.length;
    matchIndex = lowerText.indexOf(lowerQuery, startIndex);
  }

  if (startIndex < text.length) {
    container.appendChild(document.createTextNode(text.substring(startIndex)));
  }
}

/**
 * Executes server-side message search for the current conversation.
 * @param {string} query
 */
async function executeChatSearch(query) {
  const roomId = shellState.selectedRoomId;
  const cleanQuery = typeof query === 'string' ? query.trim() : '';

  if (!roomId || !cleanQuery) {
    chatSearchResultsPanel?.classList.add('hidden');
    if (chatSearchCount) chatSearchCount.textContent = '';
    if (btnPrevSearchResult) btnPrevSearchResult.disabled = true;
    if (btnNextSearchResult) btnNextSearchResult.disabled = true;
    return;
  }

  const searchId = ++chatSearchState.activeSearchId;
  chatSearchState.query = cleanQuery;
  chatSearchState.isLoading = true;
  chatSearchState.error = null;

  chatSearchResultsPanel?.classList.remove('hidden');
  if (chatSearchStatus) {
    chatSearchStatus.classList.remove('hidden', 'error-status');
    chatSearchStatus.innerHTML = '<span class="spinner spinner-sm"></span><span>Searching messages...</span>';
  }
  if (chatSearchResultsList) chatSearchResultsList.innerHTML = '';
  if (chatSearchCount) chatSearchCount.textContent = '...';
  if (btnPrevSearchResult) btnPrevSearchResult.disabled = true;
  if (btnNextSearchResult) btnNextSearchResult.disabled = true;

  try {
    const res = await window.ollacoreDesktop?.chatApi?.searchMessages(roomId, cleanQuery, { limit: 50 });

    // Discard outdated or superseded responses
    if (searchId !== chatSearchState.activeSearchId || roomId !== shellState.selectedRoomId) {
      return;
    }

    // Support both direct unpacked data ({ messages, hasMore }) and raw IPC response ({ ok: true, data: { messages, hasMore } })
    if (res && res.ok === false) {
      const errorMsg = res?.error?.message || 'Failed to search messages';
      chatSearchState.isLoading = false;
      chatSearchState.error = errorMsg;
      if (chatSearchStatus) {
        chatSearchStatus.classList.remove('hidden');
        chatSearchStatus.classList.add('error-status');
        chatSearchStatus.textContent = errorMsg;
      }
      if (chatSearchCount) chatSearchCount.textContent = '';
      return;
    }

    const rawList = res?.messages || res?.data?.messages || (Array.isArray(res) ? res : []);
    const messages = (Array.isArray(rawList) ? rawList : []).filter((msg) => {
      const mid = msg.id || msg.clientMessageId || msg.client_message_id;
      if (mid && roomMessagesState.isMessageDeletedForMe(mid, roomId)) return false;
      return true;
    });
    chatSearchState.isLoading = false;
    chatSearchState.results = messages;

    if (messages.length === 0) {
      if (chatSearchStatus) {
        chatSearchStatus.classList.remove('hidden', 'error-status');
        chatSearchStatus.textContent = 'No results';
      }
      if (chatSearchCount) chatSearchCount.textContent = '0 results';
      if (chatSearchResultsList) chatSearchResultsList.innerHTML = '';
      return;
    }

    // Results found: hide status, render results list
    chatSearchStatus?.classList.add('hidden');
    if (chatSearchResultsList) {
      chatSearchResultsList.innerHTML = '';
      const currentUserId = roomMessagesState.currentUserId || shellState.currentUser?.userId || shellState.userProfile?.userId;
      const selectedConv = shellState.getSelectedConversation();

      messages.forEach((msg, idx) => {
        const item = document.createElement('div');
        item.className = 'search-result-item';
        item.setAttribute('data-index', String(idx));
        if (msg.id) item.setAttribute('data-message-id', msg.id);

        const header = document.createElement('div');
        header.className = 'search-result-header';

        const senderSpan = document.createElement('span');
        senderSpan.className = 'search-result-sender';
        const isOwn = isOwnMessage(msg, currentUserId);
        if (isOwn) {
          senderSpan.textContent = 'You';
        } else if (selectedConv?.kind === 'group') {
          senderSpan.textContent = resolveSenderNameForMessage(msg, selectedConv.roomId);
        } else {
          senderSpan.textContent = getConversationTitle(selectedConv) || 'Contact';
        }

        const timeSpan = document.createElement('span');
        timeSpan.className = 'search-result-time';
        const timeStr = formatMessageTime(msg.createdAt || msg.created_at);
        const dayStr = formatDayDivider(msg.createdAt || msg.created_at);
        timeSpan.textContent = dayStr ? (timeStr ? `${dayStr}, ${timeStr}` : dayStr) : timeStr;

        header.appendChild(senderSpan);
        header.appendChild(timeSpan);

        const snippetDiv = document.createElement('div');
        snippetDiv.className = 'search-result-snippet';
        const resolved = resolveMessageContent(msg);
        const snippetText = resolved.text || resolved.caption || resolved.fallbackText || '';
        renderHighlightedSnippet(snippetDiv, snippetText, cleanQuery);

        item.appendChild(header);
        item.appendChild(snippetDiv);

        item.addEventListener('click', () => {
          navigateToSearchResult(idx);
        });

        chatSearchResultsList.appendChild(item);
      });
    }

    if (btnPrevSearchResult) btnPrevSearchResult.disabled = false;
    if (btnNextSearchResult) btnNextSearchResult.disabled = false;
    navigateToSearchResult(0);
  } catch (err) {
    if (searchId !== chatSearchState.activeSearchId || roomId !== shellState.selectedRoomId) return;
    chatSearchState.isLoading = false;
    const errorMsg = err?.message || 'Failed to search messages';
    chatSearchState.error = errorMsg;
    if (chatSearchStatus) {
      chatSearchStatus.classList.remove('hidden');
      chatSearchStatus.classList.add('error-status');
      chatSearchStatus.textContent = errorMsg;
    }
    if (chatSearchCount) chatSearchCount.textContent = '';
  }
}

/**
 * Navigates to a search result by index, scrolls to and highlights the target message in DOM.
 * @param {number} index
 */
function navigateToSearchResult(index) {
  if (index < 0 || index >= chatSearchState.results.length) return;
  chatSearchState.currentIndex = index;

  if (chatSearchCount) {
    chatSearchCount.textContent = `${index + 1} of ${chatSearchState.results.length}`;
  }

  // Update active item highlight in search panel
  if (chatSearchResultsList) {
    const items = chatSearchResultsList.querySelectorAll('.search-result-item');
    items.forEach((item, i) => {
      if (i === index) {
        item.classList.add('active');
        item.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      } else {
        item.classList.remove('active');
      }
    });
  }

  const targetMsg = chatSearchState.results[index];
  if (!targetMsg) return;

  // Check if message row is currently rendered in DOM
  let row = messagesList ? messagesList.querySelector(`.message-row[data-message-id="${targetMsg.id}"]`) : null;
  if (!row && targetMsg.id && messagesList) {
    // Message is historical; integrate into roomMessagesState and re-render
    roomMessagesState.mergeServerMessages([targetMsg]);
    renderMessages();
    row = messagesList.querySelector(`.message-row[data-message-id="${targetMsg.id}"]`);
  }

  if (row) {
    messagesList.querySelectorAll('.message-row.highlighted').forEach((r) => r.classList.remove('highlighted'));
    row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    row.classList.add('highlighted');
    setTimeout(() => {
      row.classList.remove('highlighted');
    }, 2000);
  }
}
// ═══════════════════════════════════════════════════════════════════
// MEDIA BROWSER PANEL (Media / Links / Docs — current conversation)
// ═══════════════════════════════════════════════════════════════════

const mediaBrowserPanel = document.getElementById('media-browser-panel');
const btnCloseMediaBrowser = document.getElementById('btn-close-media-browser');
const mediaBrowserTabs = document.getElementById('media-browser-tabs');
const mbTabMedia = document.getElementById('mb-tab-media');
const mbTabLinks = document.getElementById('mb-tab-links');
const mbTabDocs = document.getElementById('mb-tab-docs');
const mbMediaGrid = document.getElementById('mb-media-grid');
const mbMediaLoading = document.getElementById('mb-media-loading');
const mbMediaEmpty = document.getElementById('mb-media-empty');
const mbLinksList = document.getElementById('mb-links-list');
const mbLinksLoading = document.getElementById('mb-links-loading');
const mbLinksEmpty = document.getElementById('mb-links-empty');
const mbDocsList = document.getElementById('mb-docs-list');
const mbDocsLoading = document.getElementById('mb-docs-loading');
const mbDocsEmpty = document.getElementById('mb-docs-empty');
const contactInfoMediaRow = document.getElementById('contact-info-media-row');

let activeMbRoomId = null;
let activeMbTab = 'media'; // 'media' | 'links' | 'docs'

// URL regex — detects http/https URLs in message text
const URL_REGEX = /https?:\/\/[^\s<>"'`]+/gi;

function openMediaBrowser(roomId) {
  if (!roomId || !mediaBrowserPanel) return;
  activeMbRoomId = roomId;
  activeMbTab = 'media';
  // Reset tabs
  if (mediaBrowserTabs) {
    mediaBrowserTabs.querySelectorAll('.media-browser-tab').forEach((t) => {
      const isActive = t.getAttribute('data-tab') === 'media';
      t.classList.toggle('active', isActive);
      t.setAttribute('aria-selected', String(isActive));
    });
  }
  _switchMbTab('media');
  mediaBrowserPanel.classList.remove('hidden');
  _populateMbTab('media', roomId);
}

function closeMediaBrowser() {
  mediaBrowserPanel?.classList.add('hidden');
  activeMbRoomId = null;
}

function _switchMbTab(tab) {
  activeMbTab = tab;
  [mbTabMedia, mbTabLinks, mbTabDocs].forEach((pane, i) => {
    if (!pane) return;
    const tabs = ['media', 'links', 'docs'];
    pane.classList.toggle('hidden', tabs[i] !== tab);
  });
  if (mediaBrowserTabs) {
    mediaBrowserTabs.querySelectorAll('.media-browser-tab').forEach((btn) => {
      const isActive = btn.getAttribute('data-tab') === tab;
      btn.classList.toggle('active', isActive);
      btn.setAttribute('aria-selected', String(isActive));
    });
  }
  if (activeMbRoomId) {
    _populateMbTab(tab, activeMbRoomId);
  }
}

function _getMessagesForRoom(roomId) {
  const rId = roomId || activeContactInfoRoomId || shellState.selectedRoomId;
  if (!rId) return [];
  const targetState = roomMessagesMap.get(rId)
    || (activeRoomMessagesState?.roomId === rId ? activeRoomMessagesState : null);
  if (targetState && targetState.roomId === rId) {
    return Array.isArray(targetState.messages) ? targetState.messages : [];
  }
  if (!targetState && activeRoomMessagesState && (!activeRoomMessagesState.roomId || activeRoomMessagesState.roomId === rId)) {
    return Array.isArray(activeRoomMessagesState.messages) ? activeRoomMessagesState.messages : [];
  }
  return [];
}

function _populateMbTab(tab, roomId) {
  const messages = _getMessagesForRoom(roomId);
  const seen = new Set(); // deduplication by attachmentId or msgId

  if (tab === 'media') {
    if (!mbMediaGrid) return;
    mbMediaGrid.innerHTML = '';
    mbMediaLoading?.classList.add('hidden');

    const mediaMessages = messages.filter((msg) => {
      if (msg.isDeleted || msg.kind === 'deleted') return false;
      const kind = (msg.kind || '').toLowerCase();
      return kind === 'image' || kind === 'video';
    });

    if (mediaMessages.length === 0) {
      mbMediaEmpty?.classList.remove('hidden');
      return;
    }
    mbMediaEmpty?.classList.add('hidden');

    // Reverse so newest appears first
    const reversed = [...mediaMessages].reverse();
    for (const msg of reversed) {
      const resolved = resolveMessageContent(msg);
      const aid = resolved.attachmentId || msg.id || msg.clientMessageId || msg.client_message_id;
      if (!aid || seen.has(aid)) continue;
      seen.add(aid);

      const thumb = document.createElement('div');
      thumb.className = 'mb-media-thumb';
      thumb.title = resolved.filename || (resolved.kind === 'video' ? 'Video' : 'Photo');

      const cachedUrl = resolved.url || (resolved.attachmentId ? attachmentUrls.get(resolved.attachmentId) : null);

      if (resolved.kind === 'image') {
        if (cachedUrl) {
          const img = document.createElement('img');
          img.src = cachedUrl;
          img.alt = resolved.filename || 'Photo';
          img.loading = 'lazy';
          img.addEventListener('click', () => {
            openImagePreview(cachedUrl, resolved.filename, resolved.caption);
          });
          thumb.appendChild(img);
        } else {
          // Placeholder while URL resolves
          const ph = document.createElement('div');
          ph.className = 'mb-media-thumb-placeholder';
          ph.textContent = '📷';
          if (resolved.attachmentId) {
            ph.setAttribute('data-mb-attachment-id', resolved.attachmentId);
          }
          thumb.appendChild(ph);
          if (resolved.attachmentId && roomId) {
            resolveAttachmentUrl(roomId, resolved.attachmentId).then((url) => {
              if (url && thumb.isConnected) {
                const img = document.createElement('img');
                img.src = url;
                img.alt = resolved.filename || 'Photo';
                img.loading = 'lazy';
                img.addEventListener('click', () => openImagePreview(url, resolved.filename, resolved.caption));
                ph.replaceWith(img);
              }
            }).catch(() => { });
          }
        }
      } else if (resolved.kind === 'video') {
        if (cachedUrl) {
          const vid = document.createElement('video');
          vid.src = cachedUrl;
          vid.preload = 'metadata';
          vid.muted = true;
          vid.className = 'mb-video-element';
          vid.addEventListener('click', () => {
            // Open the video in the existing preview/native handler
            handleOpenFile(resolved.attachmentId, resolved.filename || 'video.mp4', cachedUrl, roomId, null, resolved.mime);
          });
          thumb.appendChild(vid);
          // Video badge
          const badge = document.createElement('span');
          badge.className = 'mb-video-badge';
          badge.textContent = '▶';
          thumb.appendChild(badge);
        } else {
          const ph = document.createElement('div');
          ph.className = 'mb-media-thumb-placeholder';
          ph.textContent = '🎥';
          thumb.appendChild(ph);
          if (resolved.attachmentId && roomId) {
            resolveAttachmentUrl(roomId, resolved.attachmentId).then((url) => {
              if (url && thumb.isConnected) {
                const vid = document.createElement('video');
                vid.src = url;
                vid.preload = 'metadata';
                vid.muted = true;
                vid.addEventListener('click', () => handleOpenFile(resolved.attachmentId, resolved.filename || 'video.mp4', url, roomId, null, resolved.mime));
                const badge = document.createElement('span');
                badge.className = 'mb-video-badge';
                badge.textContent = '▶';
                ph.replaceWith(vid);
                thumb.appendChild(badge);
              }
            }).catch(() => { });
          }
        }
      }

      mbMediaGrid.appendChild(thumb);
    }
  } else if (tab === 'links') {
    if (!mbLinksList) return;
    mbLinksList.innerHTML = '';
    mbLinksLoading?.classList.add('hidden');

    const linkItems = [];
    for (const msg of [...messages].reverse()) {
      if (msg.isDeleted || msg.kind === 'deleted') continue;
      const resolved = resolveMessageContent(msg);
      const text = resolved.text || resolved.caption || msg.body?.text || msg.body?.caption || (typeof msg.body === 'string' ? msg.body : '') || msg.text || '';
      if (!text) continue;
      const urls = extractUrls(text);
      if (!urls || urls.length === 0) continue;
      for (const url of urls) {
        if (seen.has(url)) continue;
        seen.add(url);
        linkItems.push({ url, msg });
      }
    }

    if (linkItems.length === 0) {
      mbLinksEmpty?.classList.remove('hidden');
      return;
    }
    mbLinksEmpty?.classList.add('hidden');

    for (const { url, msg } of linkItems) {
      let domain = url;
      const href = /^www\./i.test(url) ? 'https://' + url : url;
      try { domain = new URL(href).hostname.replace(/^www\./, ''); } catch (_) { }

      const card = document.createElement('div');
      card.className = 'mb-link-card';
      card.title = 'Click to open link';

      const iconEl = document.createElement('div');
      iconEl.className = 'mb-link-icon';
      iconEl.innerHTML = '<svg class="ui-icon ui-icon-xs" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>';

      const content = document.createElement('div');
      content.className = 'mb-link-content';

      const domainEl = document.createElement('div');
      domainEl.className = 'mb-link-domain';
      domainEl.textContent = domain;

      const urlEl = document.createElement('div');
      urlEl.className = 'mb-link-url';
      urlEl.textContent = url.length > 55 ? url.slice(0, 52) + '…' : url;

      content.appendChild(domainEl);
      content.appendChild(urlEl);

      const timeEl = document.createElement('div');
      timeEl.className = 'mb-link-time';
      const ts = msg.createdAt || msg.created_at;
      timeEl.textContent = ts ? formatMessageTime(ts) : '';

      // Jump to original message button
      const jumpBtn = document.createElement('button');
      jumpBtn.type = 'button';
      jumpBtn.className = 'mb-link-jump-btn';
      jumpBtn.title = 'Jump to message in chat';
      jumpBtn.setAttribute('aria-label', 'Jump to message in chat');
      jumpBtn.innerHTML = '<svg class="ui-icon ui-icon-xs" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
      jumpBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        closeMediaBrowser();
        closeContactInfo();
        const targetMsgId = msg.id || msg.clientMessageId || msg.client_message_id;
        _scrollToAndHighlightMessage(targetMsgId);
      });

      card.appendChild(iconEl);
      card.appendChild(content);
      card.appendChild(timeEl);
      card.appendChild(jumpBtn);

      card.addEventListener('click', () => {
        openExternalUrlSafely(href);
      });

      mbLinksList.appendChild(card);
    }
  } else if (tab === 'docs') {
    if (!mbDocsList) return;
    mbDocsList.innerHTML = '';
    mbDocsLoading?.classList.add('hidden');

    const docMessages = messages.filter((msg) => {
      if (msg.isDeleted || msg.kind === 'deleted') return false;
      const resolved = resolveMessageContent(msg);
      if (resolved.kind === 'file' || resolved.kind === 'document') {
        if (resolved.isVoiceNote) return false;
        return true;
      }
      const rawKind = (msg.kind || '').toLowerCase();
      if (rawKind === 'file' || rawKind === 'document') {
        return resolved.kind !== 'audio';
      }
      return false;
    });

    if (docMessages.length === 0) {
      mbDocsEmpty?.classList.remove('hidden');
      return;
    }
    mbDocsEmpty?.classList.add('hidden');

    for (const msg of [...docMessages].reverse()) {
      const resolved = resolveMessageContent(msg);
      const aid = resolved.attachmentId || msg.id || msg.clientMessageId || msg.client_message_id;
      if (!aid || seen.has(aid)) continue;
      seen.add(aid);

      const filename = resolved.filename || msg.body?.filename || msg.attachments?.[0]?.filename || msg.attachments?.[0]?.original_name || 'document';
      const ext = ((filename.split('.').pop() || '').toLowerCase());
      let icon = '📄';
      if (ext === 'pdf') icon = '📕';
      else if (['zip', 'rar', 'gz', 'tar'].includes(ext)) icon = '📦';
      else if (['doc', 'docx'].includes(ext)) icon = '📝';
      else if (['xls', 'xlsx', 'csv'].includes(ext)) icon = '📊';
      else if (['ppt', 'pptx'].includes(ext)) icon = '📑';

      const card = document.createElement('div');
      card.className = 'mb-doc-card';
      card.title = `Click to open ${filename}`;

      const iconEl = document.createElement('div');
      iconEl.className = 'mb-doc-icon';
      iconEl.textContent = icon;

      const details = document.createElement('div');
      details.className = 'mb-doc-details';

      const nameEl = document.createElement('div');
      nameEl.className = 'mb-doc-name';
      nameEl.textContent = filename;

      const metaEl = document.createElement('div');
      metaEl.className = 'mb-doc-meta';
      const sizeStr = resolved.byteSize ? formatFileSize(resolved.byteSize) : (ext ? ext.toUpperCase() : 'DOC');
      const ts = msg.createdAt || msg.created_at;
      metaEl.textContent = ts ? `${sizeStr} · ${formatMessageTime(ts)}` : sizeStr;

      details.appendChild(nameEl);
      details.appendChild(metaEl);

      const actionEl = document.createElement('div');
      actionEl.className = 'mb-doc-action';

      const dlBtn = document.createElement('button');
      dlBtn.type = 'button';
      dlBtn.className = 'mb-doc-download-btn';
      dlBtn.title = `Download ${filename}`;
      dlBtn.textContent = '⬇';
      dlBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const url = resolved.url || (resolved.attachmentId ? attachmentUrls.get(resolved.attachmentId) : null);
        await handleDownloadFile(resolved.attachmentId, filename, url, roomId);
      });
      actionEl.appendChild(dlBtn);

      // Jump to original message button for docs
      const jumpBtn = document.createElement('button');
      jumpBtn.type = 'button';
      jumpBtn.className = 'mb-link-jump-btn';
      jumpBtn.title = 'Jump to message in chat';
      jumpBtn.setAttribute('aria-label', 'Jump to message in chat');
      jumpBtn.innerHTML = '<svg class="ui-icon ui-icon-xs" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
      jumpBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        closeMediaBrowser();
        closeContactInfo();
        const targetMsgId = msg.id || msg.clientMessageId || msg.client_message_id;
        _scrollToAndHighlightMessage(targetMsgId);
      });
      actionEl.appendChild(jumpBtn);

      card.appendChild(iconEl);
      card.appendChild(details);
      card.appendChild(actionEl);

      card.addEventListener('click', async () => {
        const url = resolved.url || (resolved.attachmentId ? attachmentUrls.get(resolved.attachmentId) : null);
        await handleOpenFile(resolved.attachmentId, filename, url, roomId, card, resolved.mime);
      });

      mbDocsList.appendChild(card);
    }
  }
}

// Wire up media browser tab clicks
if (mediaBrowserTabs) {
  mediaBrowserTabs.addEventListener('click', (e) => {
    const btn = e.target.closest('.media-browser-tab');
    if (!btn) return;
    const tab = btn.getAttribute('data-tab');
    if (tab && tab !== activeMbTab) {
      _switchMbTab(tab);
    }
  });
}

// Wire up close button
if (btnCloseMediaBrowser) {
  btnCloseMediaBrowser.addEventListener('click', () => {
    closeMediaBrowser();
    if (activeContactInfoRoomId) {
      contactInfoPanel?.classList.remove('hidden');
    }
  });
}

// Wire up contact info media row
if (contactInfoMediaRow) {
  contactInfoMediaRow.addEventListener('click', () => {
    if (activeContactInfoRoomId) {
      contactInfoPanel?.classList.add('hidden');
      openMediaBrowser(activeContactInfoRoomId);
    }
  });
  contactInfoMediaRow.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      contactInfoMediaRow.click();
    }
  });
}

// ═══════════════════════════════════════════════════════════════════
// STARRED MESSAGES PANEL (local-only, current conversation scope)
// ═══════════════════════════════════════════════════════════════════

const starredMessagesPanel = document.getElementById('starred-messages-panel');
const btnCloseStarredMessages = document.getElementById('btn-close-starred-messages');
const starredList = document.getElementById('starred-list');
const starredLoading = document.getElementById('starred-loading');
const starredEmpty = document.getElementById('starred-empty');
const contactInfoStarredRow = document.getElementById('contact-info-starred-row');
const contactInfoStarredCount = document.getElementById('contact-info-starred-count');

let activeStarredRoomId = null;

export async function updateContactInfoStarredCount(roomId) {
  if (!contactInfoStarredCount || !roomId) return;
  try {
    const dbStarred = await loadStarredMessagesFromDb(roomId);
    let count = Array.isArray(dbStarred) ? dbStarred.length : 0;
    const rState = roomMessagesMap.get(roomId) || activeRoomMessagesState;
    if (rState?.getStarredMessageIds) {
      const memIds = rState.getStarredMessageIds(roomId);
      if (memIds && memIds.length > count) {
        count = memIds.length;
      }
    }
    contactInfoStarredCount.textContent = count > 0 ? String(count) : '';
  } catch (err) {
    const rState = roomMessagesMap.get(roomId) || activeRoomMessagesState;
    const count = rState?.getStarredMessageIds ? rState.getStarredMessageIds(roomId).length : 0;
    contactInfoStarredCount.textContent = count > 0 ? String(count) : '';
  }
}

function openStarredMessages(roomId) {
  if (!roomId || !starredMessagesPanel) return;
  activeStarredRoomId = roomId;
  starredMessagesPanel.classList.remove('hidden');
  _renderStarredMessages(roomId);
}

function closeStarredMessages() {
  starredMessagesPanel?.classList.add('hidden');
  activeStarredRoomId = null;
}

async function _renderStarredMessages(roomId) {
  if (!starredList) return;
  starredList.innerHTML = '';
  starredLoading?.classList.remove('hidden');
  starredEmpty?.classList.add('hidden');

  const targetState = roomMessagesMap.get(roomId) || activeRoomMessagesState;

  // 1. Load starred messages from SQLite (authoritative local database)
  let dbStarred = [];
  try {
    dbStarred = await loadStarredMessagesFromDb(roomId);
  } catch (err) {
    console.warn('[_renderStarredMessages] SQLite load failed:', err);
  }

  starredLoading?.classList.add('hidden');

  // Check if active starred room has changed while waiting for async SQLite call
  if (activeStarredRoomId && activeStarredRoomId !== roomId) {
    return;
  }

  // Combine with in-memory targetState starred IDs if any optimistic stars exist
  const inMemoryStarredIds = targetState?.getStarredMessageIds(roomId) || [];
  const inMemoryMessages = Array.isArray(targetState?.messages) ? targetState.messages : [];

  const starredMessages = [];
  const seen = new Set();

  // First, add all valid messages retrieved from SQLite (excluding deleted)
  for (const msg of dbStarred) {
    if (!msg || msg.isDeleted || msg.is_deleted || msg.kind === 'deleted' || msg.isDeletedForMe || msg.is_deleted_for_me) continue;
    const key = msg.id || msg.clientMessageId || msg.client_message_id;
    if (key && !seen.has(key)) {
      seen.add(key);
      starredMessages.push({ msg, mid: key });
      // Keep in-memory state synchronized
      if (targetState && !targetState.isStarred(key, roomId)) {
        targetState.starMessage(key, roomId);
      }
    }
  }

  // Then, check any in-memory starred messages not yet reflected in SQLite query
  for (const mid of inMemoryStarredIds) {
    if (seen.has(mid)) continue;
    const found = inMemoryMessages.find((m) =>
      m.id === mid || m.clientMessageId === mid || m.client_message_id === mid
    );
    if (found && !found.isDeleted && !found.is_deleted && found.kind !== 'deleted' && !found.isDeletedForMe && !found.is_deleted_for_me) {
      const key = found.id || found.clientMessageId || found.client_message_id || mid;
      if (!seen.has(key)) {
        seen.add(key);
        starredMessages.push({ msg: found, mid: key });
      }
    }
  }

  if (starredMessages.length === 0) {
    starredEmpty?.classList.remove('hidden');
    return;
  }

  const conv = shellState.conversations?.find((c) => c.roomId === roomId);
  const convName = conv ? getConversationTitle(conv) : 'Conversation';
  const currentUserId = targetState?.currentUserId || shellState.currentUser?.userId || shellState.userProfile?.userId;

  for (const { msg, mid } of starredMessages) {
    const item = document.createElement('div');
    item.className = 'starred-msg-item';
    item.setAttribute('data-message-id', mid);

    // Resolve sender
    const isOwn = isOwnMessage(msg, currentUserId);
    const resolvedSender = resolveSenderNameForMessage(msg, msg.roomId || msg.room_id);
    let senderName = isOwn ? 'You' : (resolvedSender && resolvedSender !== 'Contact' ? resolvedSender : (convName || 'Contact'));

    const initials = getAvatarInitials(senderName);
    const color = getAvatarColor(senderName);

    const avatarEl = document.createElement('div');
    avatarEl.className = 'avatar avatar-sm starred-msg-avatar';
    avatarEl.textContent = initials;
    avatarEl.style.backgroundColor = color;

    const content = document.createElement('div');
    content.className = 'starred-msg-content';

    const senderEl = document.createElement('div');
    senderEl.className = 'starred-msg-sender';
    senderEl.textContent = senderName;

    const resolved = resolveMessageContent(msg);
    const previewEl = document.createElement('div');
    previewEl.className = 'starred-msg-preview';
    if (resolved.kind === 'image') previewEl.textContent = '📷 ' + (resolved.caption || 'Photo');
    else if (resolved.kind === 'video') previewEl.textContent = '🎥 ' + (resolved.caption || 'Video');
    else if (resolved.kind === 'audio') previewEl.textContent = resolved.isVoiceNote ? '🎤 Voice message' : '🎵 Audio';
    else if (resolved.kind === 'file') previewEl.textContent = '📎 ' + resolved.filename;
    else previewEl.textContent = resolved.text || '';

    const ts = msg.createdAt || msg.created_at;
    const timeEl = document.createElement('div');
    timeEl.className = 'starred-msg-time';
    timeEl.textContent = ts ? formatMessageTime(ts) : '';

    content.appendChild(senderEl);
    content.appendChild(previewEl);

    const unstarBtn = document.createElement('button');
    unstarBtn.type = 'button';
    unstarBtn.className = 'starred-msg-unstar-btn';
    unstarBtn.title = 'Remove star';
    unstarBtn.textContent = '★';
    unstarBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const msgId = msg.id || msg.clientMessageId || msg.client_message_id || mid;
      if (targetState) targetState.unstarMessage(msgId, roomId);
      persistMessageStarredToDb(msgId, false, roomId).catch(() => { });
      item.remove();
      renderMessages(); // refresh star indicator in chat
      if (!starredList.querySelector('.starred-msg-item')) {
        starredEmpty?.classList.remove('hidden');
      }
      updateContactInfoStarredCount(roomId);
    });

    item.appendChild(avatarEl);
    item.appendChild(content);
    item.appendChild(timeEl);
    item.appendChild(unstarBtn);

    // Click to jump to message: reuse jumpToOriginalMessage
    item.addEventListener('click', async (e) => {
      if (e.target.closest('.starred-msg-unstar-btn')) return;
      closeStarredMessages();
      closeContactInfo();
      const msgId = msg.id || msg.clientMessageId || msg.client_message_id || mid;
      if (msgId) {
        await jumpToOriginalMessage(msgId, roomId);
      }
    });

    starredList.appendChild(item);
  }
}

function _isUUID(str) {
  if (!str || typeof str !== 'string') return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str) ||
    /^local-/.test(str) || str.length > 30;
}

function _scrollToAndHighlightMessage(messageId) {
  if (!messageId) return false;
  let msgEl = document.querySelector(`[data-message-id="${CSS.escape(String(messageId))}"]`);
  if (!msgEl) {
    msgEl = document.querySelector(`[data-client-message-id="${CSS.escape(String(messageId))}"]`);
  }
  if (!msgEl && roomMessagesState?.messages) {
    const msg = roomMessagesState.messages.find(
      (m) => m.id === messageId || m.clientMessageId === messageId || m.client_message_id === messageId
    );
    if (msg) {
      if (msg.id) msgEl = document.querySelector(`[data-message-id="${CSS.escape(String(msg.id))}"]`);
      if (!msgEl && (msg.clientMessageId || msg.client_message_id)) {
        const cid = msg.clientMessageId || msg.client_message_id;
        msgEl = document.querySelector(`[data-client-message-id="${CSS.escape(String(cid))}"]`);
      }
    }
  }
  if (msgEl) {
    msgEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    msgEl.classList.add('message-highlight');
    setTimeout(() => msgEl.classList.remove('message-highlight'), 2000);
    return true;
  }
  return false;
}

// Wire up starred messages close button
if (btnCloseStarredMessages) {
  btnCloseStarredMessages.addEventListener('click', () => {
    closeStarredMessages();
    const returnRoomId = activeContactInfoRoomId || shellState.selectedRoomId;
    if (returnRoomId) {
      contactInfoPanel?.classList.remove('hidden');
      updateContactInfoStarredCount(returnRoomId);
    }
  });
}

// Wire up contact info starred row
if (contactInfoStarredRow) {
  contactInfoStarredRow.addEventListener('click', () => {
    const targetRoomId = activeContactInfoRoomId || shellState.selectedRoomId;
    if (targetRoomId) {
      contactInfoPanel?.classList.add('hidden');
      openStarredMessages(targetRoomId);
    }
  });
  contactInfoStarredRow.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      contactInfoStarredRow.click();
    }
  });
}

// ═══════════════════════════════════════════════════════════════════
// LOCAL PINNED MESSAGES — Bar, Duration Modal, Panel
// ═══════════════════════════════════════════════════════════════════

let activePinnedRoomId = null;

/**
 * Renders (or hides) the pinned message banner below the chat header.
 * @param {string} roomId
 */
function renderPinnedBar(roomId) {
  if (!roomId || !chatPinnedBar) return;
  shellState.pruneExpiredPins(roomId);
  const pins = shellState.getPinnedMessages(roomId);
  if (!pins || pins.length === 0) {
    chatPinnedBar.classList.add('hidden');
    currentPinnedBarIndex = 0;
    return;
  }
  // Clamp index
  currentPinnedBarIndex = Math.max(0, Math.min(currentPinnedBarIndex, pins.length - 1));
  const pin = pins[currentPinnedBarIndex];

  if (chatPinnedBarSnippet) {
    chatPinnedBarSnippet.textContent = pin.preview || 'Pinned message';
  }
  if (chatPinnedBarExpiry) {
    chatPinnedBarExpiry.textContent = pin.expiresAt ? formatPinRemainingTime(pin.expiresAt) : '';
  }
  if (chatPinnedBarCounter) {
    if (pins.length > 1) {
      chatPinnedBarCounter.textContent = `${currentPinnedBarIndex + 1} of ${pins.length}`;
      chatPinnedBarCounter.classList.remove('hidden');
    } else {
      chatPinnedBarCounter.classList.add('hidden');
    }
  }

  // Nav buttons
  if (btnPinnedPrev) btnPinnedPrev.classList.toggle('hidden', pins.length <= 1);
  if (btnPinnedNext) btnPinnedNext.classList.toggle('hidden', pins.length <= 1);

  chatPinnedBar.classList.remove('hidden');
}

/**
 * Opens the pin duration picker modal for a specific message.
 */
function openPinDurationModal(roomId, messageId, preview) {
  if (!pinDurationModal) return;
  pendingPinMessageId = { roomId, messageId, preview };
  // Reset selection to 24h
  const radios = pinDurationModal.querySelectorAll('input[name="pin-duration-choice"]');
  radios.forEach((r) => { r.checked = r.value === '24h'; });
  updatePinDurationExpiryPreview('24h');
  // Listen for radio changes
  radios.forEach((r) => {
    r.onchange = () => updatePinDurationExpiryPreview(r.value);
  });
  pinDurationModal.classList.remove('hidden');
}

function closePinDurationModal() {
  pinDurationModal?.classList.add('hidden');
  pendingPinMessageId = null;
}

function updatePinDurationExpiryPreview(durationKey) {
  if (!pinDurationExpiry) return;
  const msMap = { '24h': 86400000, '7d': 604800000, '30d': 2592000000, '90d': 7776000000 };
  const ms = msMap[durationKey] || msMap['24h'];
  const expiresAt = Date.now() + ms;
  pinDurationExpiry.textContent = 'Expires: ' + formatPinExpiration(expiresAt);
}

function openPinLimitModal() {
  pinLimitModal?.classList.remove('hidden');
}

function closePinLimitModal() {
  pinLimitModal?.classList.add('hidden');
}

/**
 * Executes the pin action after the user confirms in the duration modal.
 */
function confirmPinMessage() {
  if (!pendingPinMessageId) return;
  const { roomId, messageId, preview } = pendingPinMessageId;
  const radios = pinDurationModal?.querySelectorAll('input[name="pin-duration-choice"]');
  let durationKey = '24h';
  if (radios) {
    radios.forEach((r) => { if (r.checked) durationKey = r.value; });
  }
  // Try to resolve the message object for preview
  let resolvedPreview = preview;
  if (!resolvedPreview) {
    const targetState = roomMessagesMap.get(roomId) || activeRoomMessagesState;
    const msg = targetState?.messages?.find((m) => m.id === messageId || m.clientMessageId === messageId || m.client_message_id === messageId);
    if (msg) resolvedPreview = getMessagePinPreview(msg);
  }
  const result = shellState.pinMessage(roomId, messageId, durationKey, { preview: resolvedPreview || 'Message' });
  closePinDurationModal();
  if (!result.ok && result.error === 'limit_reached') {
    openPinLimitModal();
    return;
  }
  renderMessages();
  renderPinnedBar(roomId);
}

/**
 * Opens the pinned messages slide-over panel.
 */
function openPinnedMessagesPanel(roomId) {
  if (!roomId || !pinnedMessagesPanel) return;
  activePinnedRoomId = roomId;
  pinnedMessagesPanel.classList.remove('hidden');
  _renderPinnedMessagesPanel(roomId);
}

function closePinnedMessagesPanel() {
  pinnedMessagesPanel?.classList.add('hidden');
  activePinnedRoomId = null;
}

function _renderPinnedMessagesPanel(roomId) {
  if (!pinnedList) return;
  pinnedList.innerHTML = '';
  pinnedEmpty?.classList.add('hidden');

  shellState.pruneExpiredPins(roomId);
  const pins = shellState.getPinnedMessages(roomId);

  if (!pins || pins.length === 0) {
    pinnedEmpty?.classList.remove('hidden');
    return;
  }

  const targetState = roomMessagesMap.get(roomId) || activeRoomMessagesState;
  const conv = shellState.conversations?.find((c) => c.roomId === roomId);
  const convName = conv ? getConversationTitle(conv) : 'Conversation';

  for (const pin of [...pins].reverse()) {
    const item = document.createElement('div');
    item.className = 'pinned-msg-item';
    item.setAttribute('data-message-id', pin.messageId);

    const preview = document.createElement('div');
    preview.className = 'pinned-msg-preview';
    preview.textContent = pin.preview || 'Pinned message';

    const expiry = document.createElement('div');
    expiry.className = 'pinned-msg-expiry';
    expiry.textContent = pin.expiresAt ? formatPinRemainingTime(pin.expiresAt) : '';

    const unpinBtn = document.createElement('button');
    unpinBtn.type = 'button';
    unpinBtn.className = 'starred-msg-unstar-btn';
    unpinBtn.title = 'Unpin';
    unpinBtn.innerHTML = '<svg class="ui-icon ui-icon-xs" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
    unpinBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      shellState.unpinMessage(roomId, pin.messageId);
      item.remove();
      renderMessages();
      renderPinnedBar(roomId);
      if (!pinnedList.querySelector('.pinned-msg-item')) {
        pinnedEmpty?.classList.remove('hidden');
      }
    });

    item.appendChild(preview);
    item.appendChild(expiry);
    item.appendChild(unpinBtn);

    // Click to jump to message in chat
    item.addEventListener('click', (e) => {
      if (e.target.closest('.starred-msg-unstar-btn')) return;
      closePinnedMessagesPanel();
      closeContactInfo();
      if (shellState.selectedRoomId !== roomId) {
        selectConversation(roomId);
      }
      if (pin.messageId) {
        // Attempt scroll; if message isn't loaded, remove stale pin gracefully
        const found = _scrollToAndHighlightMessage(pin.messageId);
        if (!found) {
          // Message not in DOM (not loaded) — do not crash
        }
      }
    });

    pinnedList.appendChild(item);
  }
}

// ═══════════════════════════════════════════════════════════════════
// WhatsApp Message Actions: Context Menu, Info, Star, Edit, Delete
// ═══════════════════════════════════════════════════════════════════

function closeContextMenu() {
  if (messageContextMenu) {
    messageContextMenu.classList.add('hidden');
  }
  contextMenuTargetMessage = null;
}

function openMessageContextMenu(e, message, anchorEl = null) {
  if (!messageContextMenu || !message) return;
  contextMenuTargetMessage = message;

  const currentUserId = roomMessagesState.currentUserId || shellState.currentUser?.userId || shellState.userProfile?.userId;
  const isOwn = isOwnMessage(message, currentUserId);
  const isDeleted = Boolean(message.isDeleted || message.kind === 'deleted');
  const targetRoom = message.roomId || message.room_id || shellState.selectedRoomId;
  const mid = message.id || message.clientMessageId || message.client_message_id;
  const isStarred = Boolean(mid && roomMessagesState.isStarred(mid, targetRoom));
  const isPinnedCtx = Boolean(mid && shellState.isMessagePinned(mid, targetRoom));

  if (ctxStarText) {
    ctxStarText.textContent = isStarred ? 'Unstar' : 'Star';
  }
  if (ctxPinText) {
    ctxPinText.textContent = isPinnedCtx ? 'Unpin' : 'Pin';
  }

  // Configure menu buttons based on ownership, time limits, and message state
  const isCall = Boolean(message.isCallEntry || message.kind === 'call');
  const items = messageContextMenu.querySelectorAll('.context-menu-item');
  items.forEach((item) => {
    const action = item.getAttribute('data-action');
    if (isCall) {
      if (action === 'delete-for-me') {
        item.classList.remove('hidden');
      } else {
        item.classList.add('hidden');
      }
    } else {
      if (action === 'edit') {
        item.classList.toggle('hidden', !canEditMessage(message, currentUserId));
      } else if (action === 'delete-for-everyone') {
        item.classList.toggle('hidden', !canDeleteMessageForEveryone(message, currentUserId));
      } else if (action === 'delete-for-me') {
        item.classList.remove('hidden');
      } else if (action === 'reply' || action === 'copy' || action === 'info' || action === 'star' || action === 'pin' || action === 'forward' || action === 'select') {
        item.classList.toggle('hidden', isDeleted);
      }
    }
  });

  const ctxReactions = messageContextMenu.querySelector('.context-menu-reactions');
  if (ctxReactions) {
    if (isCall || isDeleted) {
      ctxReactions.classList.add('hidden');
    } else {
      ctxReactions.classList.remove('hidden');
      const userReactions = message.reactions || {};
      ctxReactions.querySelectorAll('.ctx-reaction-btn').forEach((btn) => {
        const emoji = btn.getAttribute('data-emoji');
        const hasReacted = currentUserId && Array.isArray(userReactions[emoji]) && userReactions[emoji].includes(currentUserId);
        btn.classList.toggle('active', Boolean(hasReacted));
      });
    }
  }

  // Position menu
  messageContextMenu.classList.remove('hidden');
  const menuWidth = 190;
  const menuHeight = messageContextMenu.offsetHeight || 220;

  let left = 0;
  let top = 0;

  if (anchorEl) {
    const rect = anchorEl.getBoundingClientRect();
    left = rect.right - menuWidth;
    top = rect.bottom + 4;
  } else if (e) {
    left = e.clientX;
    top = e.clientY;
  }

  if (left + menuWidth > window.innerWidth - 10) {
    left = window.innerWidth - menuWidth - 10;
  }
  if (top + menuHeight > window.innerHeight - 10) {
    top = window.innerHeight - menuHeight - 10;
  }
  if (left < 10) left = 10;
  if (top < 10) top = 10;

  messageContextMenu.style.left = `${left}px`;
  messageContextMenu.style.top = `${top}px`;
}

function enterEditMode(message) {
  if (!message) return;
  const currentUserId = roomMessagesState.currentUserId || shellState.currentUser?.userId || shellState.userProfile?.userId;
  if (!canEditMessage(message, currentUserId)) {
    showUserError('Messages can only be edited within 15 minutes of sending.');
    return;
  }
  exitReplyMode();
  editingMessage = message;

  const resolved = resolveMessageContent(message);
  const text = resolved.text || '';

  if (composerEditPreview) {
    composerEditPreview.textContent = text;
  }
  composerEditBanner?.classList.remove('hidden');

  if (composerInput) {
    composerInput.value = text;
    autoResizeComposer();
    composerInput.focus();
  }
  updateSendButtonState();
}

function exitEditMode() {
  editingMessage = null;
  composerEditBanner?.classList.add('hidden');
  updateSendButtonState();
}

function enterReplyMode(message) {
  if (!message) return;
  exitEditMode();
  replyingToMessage = message;

  const mid = message.id || message.clientMessageId || message.client_message_id;
  if (mid) {
    replyOriginalMessagesCache.set(mid, message);
  }

  const currentUserId = roomMessagesState?.currentUserId || shellState.currentUser?.userId;
  const senderName = getReplySenderName(
    message,
    currentUserId,
    (uid, rId) => resolveSenderNameForMessage({ senderId: uid, roomId: rId || shellState.selectedRoomId }),
    {
      roomId: shellState.selectedRoomId,
      roomParticipants: shellState?.getRoomParticipants(shellState.selectedRoomId),
      conversations: shellState?.conversations,
      globalParticipantsCache: shellState?.participantProfiles
    }
  );

  if (composerReplySender) {
    composerReplySender.textContent = `Reply to ${senderName}`;
  }
  if (composerReplyPreview) {
    composerReplyPreview.textContent = formatReplyPreview(message);
  }
  composerReplyBanner?.classList.remove('hidden');

  if (composerInput) {
    composerInput.focus();
  }
}

function exitReplyMode() {
  replyingToMessage = null;
  composerReplyBanner?.classList.add('hidden');
}

export function renderMemberList(container, list, category) {
  if (!container) return;
  container.innerHTML = '';
  if (!list || list.length === 0) {
    const emptyHint = document.createElement('div');
    emptyHint.className = 'info-group-empty-hint';
    emptyHint.textContent = category === 'read' ? 'No one yet' : 'None';
    container.appendChild(emptyHint);
    return;
  }

  for (const item of list) {
    const name = item.displayName || resolveMemberDisplayName(item.id, item.pObj, {
      getContactNicknameFn: (i) => shellState?.getContactNickname(i),
      conversations: shellState?.conversations
    });
    const initials = getMemberInitials(name);
    const timeStr = item.time ? formatFullDateTime(item.time) : '';

    const row = document.createElement('div');
    row.className = 'info-member-row';

    const left = document.createElement('div');
    left.className = 'info-member-left';

    const avatar = document.createElement('div');
    avatar.className = 'info-member-avatar';
    avatar.setAttribute('aria-hidden', 'true');
    avatar.textContent = initials;

    const info = document.createElement('div');
    info.className = 'info-member-info';

    const nameSpan = document.createElement('span');
    nameSpan.className = 'info-member-name';
    nameSpan.textContent = name;

    info.appendChild(nameSpan);
    left.appendChild(avatar);
    left.appendChild(info);

    const right = document.createElement('div');
    right.className = 'info-member-right';

    if (timeStr) {
      const timeSpan = document.createElement('span');
      timeSpan.className = 'info-member-time';
      timeSpan.textContent = timeStr;
      right.appendChild(timeSpan);
    }

    const iconSpan = document.createElement('span');
    iconSpan.className = 'info-status-icon';
    if (category === 'read') {
      iconSpan.classList.add('read-tick');
      iconSpan.textContent = '✓✓';
    } else if (category === 'delivered') {
      iconSpan.classList.add('delivered-tick');
      iconSpan.textContent = '✓✓';
    } else {
      iconSpan.classList.add('pending-tick');
      iconSpan.textContent = '○';
    }
    right.appendChild(iconSpan);

    row.appendChild(left);
    row.appendChild(right);
    container.appendChild(row);
  }
}

export async function renderGroupMessageInfo(message, targetRoom) {
  if (!message) return;
  const mid = message.id || message.clientMessageId || message.client_message_id;
  const currentUserId = roomMessagesState?.currentUserId || shellState?.currentUser?.userId || shellState?.userProfile?.userId;

  // 1. Fetch DB receipts
  let dbReceipts = [];
  try {
    if (window.ollacoreDesktop?.db?.getMessageReceipts && mid) {
      const res = await window.ollacoreDesktop.db.getMessageReceipts({ messageId: mid, roomId: targetRoom });
      dbReceipts = Array.isArray(res?.receipts) ? res.receipts : [];
    }
  } catch (err) {
    console.warn('[message-info] Error loading receipts:', err);
  }

  // Double check modal is still open and showing this message
  if (!activeMessageInfoState || activeMessageInfoState.isGroup !== true) return;
  const activeMid = activeMessageInfoState.message?.id || activeMessageInfoState.message?.clientMessageId || activeMessageInfoState.message?.client_message_id;
  if (activeMid !== mid && activeMessageInfoState.message?.id !== message.id && activeMessageInfoState.message?.clientMessageId !== message.clientMessageId) {
    return;
  }

  // 2. Fetch or retrieve room participants
  let participantsMap = targetRoom && shellState?.getRoomParticipants ? shellState.getRoomParticipants(targetRoom) : null;
  if ((!participantsMap || participantsMap.size === 0) && targetRoom && typeof ensureRoomParticipants === 'function') {
    ensureRoomParticipants(targetRoom).then(() => {
      if (activeMessageInfoState && (activeMessageInfoState.message?.id === message.id || activeMessageInfoState.message?.clientMessageId === message.clientMessageId)) {
        renderGroupMessageInfo(message, targetRoom);
      }
    }).catch(() => { });
  }

  // 3. Partition members into Read, Delivered, Pending using pure partitioning helper
  const { readList, deliveredList, pendingList } = partitionGroupReceiptMembers({
    message,
    currentUserId,
    participantsMap,
    dbReceipts,
    getDisplayNameFn: (id, pObj) => resolveMemberDisplayName(id, pObj, {
      getContactNicknameFn: (i) => shellState?.getContactNickname(i),
      conversations: shellState?.conversations
    })
  });

  // Update Header Titles
  if (infoGroupReadTitle) infoGroupReadTitle.textContent = `Read by (${readList.length})`;
  if (infoGroupDeliveredTitle) infoGroupDeliveredTitle.textContent = `Delivered to (${deliveredList.length})`;
  if (infoGroupPendingTitle) infoGroupPendingTitle.textContent = `Pending (${pendingList.length})`;

  // Render lists
  renderMemberList(infoGroupReadList, readList, 'read');
  renderMemberList(infoGroupDeliveredList, deliveredList, 'delivered');
  renderMemberList(infoGroupPendingList, pendingList, 'pending');
}

export function checkAndRefreshOpenMessageInfo(msgId) {
  if (!messageInfoModal || messageInfoModal.classList.contains('hidden')) {
    return;
  }
  if (!activeMessageInfoState) return;

  const openMsg = activeMessageInfoState.message;
  if (!openMsg) return;
  const openMid = openMsg.id || openMsg.clientMessageId || openMsg.client_message_id;

  if (openMid === msgId || openMsg.id === msgId || openMsg.clientMessageId === msgId) {
    if (activeMessageInfoState.isGroup) {
      renderGroupMessageInfo(openMsg, activeMessageInfoState.targetRoom);
    } else {
      openMessageInfoModal(openMsg);
    }
  }
}

export function openMessageInfoModal(message) {
  if (!messageInfoModal || !message) return;

  const currentUserId = roomMessagesState.currentUserId || shellState.currentUser?.userId;
  const isOwn = isOwnMessage(message, currentUserId);
  const targetRoom = message.roomId || message.room_id || shellState.selectedRoomId;
  const mid = message.id || message.clientMessageId || message.client_message_id;

  // Render preview
  if (infoMessagePreviewContainer) {
    const resolved = resolveMessageContent(message);
    infoMessagePreviewContainer.textContent = resolved.text || resolved.filename || (resolved.isVoiceNote ? 'Voice message' : 'Media message');
  }

  const conv = targetRoom ? shellState?.conversations?.find((c) => c.roomId === targetRoom) : null;
  const isGroup = conv?.kind === 'group' || message.chatType === 'group' || message.kind === 'group' || (conv && conv.isGroup);

  if (isGroup) {
    activeMessageInfoState = { message, targetRoom, isGroup: true };
    info1to1Sections?.classList.add('hidden');
    infoGroupSections?.classList.remove('hidden');

    const sentDate = message.createdAt || message.created_at;
    if (infoGroupSentTime) {
      infoGroupSentTime.textContent = sentDate ? formatFullDateTime(sentDate) : 'Recently';
    }

    renderGroupMessageInfo(message, targetRoom);
  } else {
    activeMessageInfoState = { message, targetRoom, isGroup: false };
    infoGroupSections?.classList.add('hidden');
    info1to1Sections?.classList.remove('hidden');

    // Sent timestamp
    const sentDate = message.createdAt || message.created_at;
    if (infoSentTime) {
      infoSentTime.textContent = sentDate ? formatFullDateTime(sentDate) : 'Recently';
    }

    // Canonical status (directly from RoomMessagesState - no second status system!)
    const status = (message.id ? roomMessagesState.getStatus(message.id) : null)
      || (message.clientMessageId ? roomMessagesState.getStatus(message.clientMessageId) : null)
      || (message.client_message_id ? roomMessagesState.getStatus(message.client_message_id) : null)
      || message.deliveryStatus
      || message.delivery_status
      || message.status
      || (isOwn ? 'sent' : null);

    if (isOwn) {
      // Monotonic progression: Sent -> Delivered -> Read
      // ONLY show states we actually know.
      if (status === 'read') {
        infoReadRow?.classList.remove('hidden');
        infoDeliveredRow?.classList.remove('hidden');
      } else if (status === 'delivered') {
        infoReadRow?.classList.add('hidden');
        infoDeliveredRow?.classList.remove('hidden');
      } else {
        infoReadRow?.classList.add('hidden');
        infoDeliveredRow?.classList.add('hidden');
      }

      // We don't have timestamps for delivered/read in OllaCore, so hide the time field completely
      if (infoReadTime) infoReadTime.textContent = '';
      if (infoDeliveredTime) infoDeliveredTime.textContent = '';
    } else {
      // For incoming messages to this user
      infoReadRow?.classList.add('hidden');
      infoDeliveredRow?.classList.add('hidden');
    }

    // Adjust "Sent" label for incoming/outgoing messages
    const sentLabel = document.querySelector('.sent-icon + .info-status-details .info-status-label');
    if (sentLabel) {
      sentLabel.textContent = isOwn ? 'Sent' : 'Received';
    }

    // Edited timestamp
    const editedDate = message.editedAt || message.edited_at;
    if (editedDate && infoEditedRow && infoEditedTime) {
      infoEditedRow.classList.remove('hidden');
      infoEditedTime.textContent = formatFullDateTime(editedDate);
    } else if (infoEditedRow) {
      infoEditedRow.classList.add('hidden');
    }
  }

  messageInfoModal.classList.remove('hidden');
}

export function closeMessageInfoModal() {
  activeMessageInfoState = null;
  messageInfoModal?.classList.add('hidden');
}

async function handleDeleteForEveryone(message) {
  if (!message) return;
  const currentUserId = roomMessagesState.currentUserId || shellState.currentUser?.userId;
  if (!canDeleteMessageForEveryone(message, currentUserId)) {
    showUserError('Messages can only be deleted for everyone within 48 hours of sending.');
    return;
  }

  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    showUserError('Cannot delete messages for everyone while offline.');
    return;
  }

  const targetRoom = message.roomId || message.room_id || shellState.selectedRoomId;
  if (!targetRoom) return;

  const targetState = getOrCreateRoomMessagesState(targetRoom);
  const canonicalServerMessageId = await resolveCanonicalMessageId(targetRoom, message, {
    targetState,
    chatApi: window.ollacoreDesktop?.chatApi
  });

  if (!canonicalServerMessageId) {
    const errorMsg = 'Unable to delete message: could not resolve server message ID.';
    console.error('[handleDeleteForEveryone]', errorMsg, { message, targetRoom });
    showUserError(errorMsg);
    return;
  }

  try {
    if (!window.ollacoreDesktop?.chatApi?.deleteMessage) {
      throw new Error('Chat API service unavailable');
    }
    await window.ollacoreDesktop.chatApi.deleteMessage(
      targetRoom,
      canonicalServerMessageId
    );
  } catch (err) {
    console.error('[handleDeleteForEveryone] Failed to delete message:', err);
    showUserError(err?.message || 'Failed to delete message for everyone.');
    return;
  }

  // Only after REST DELETE succeeds:
  const clientMsgId = message.clientMessageId || message.client_message_id;
  targetState.deleteMessage(canonicalServerMessageId);
  persistMessageDeletedToDb(canonicalServerMessageId).catch(() => { });
  if (clientMsgId && clientMsgId !== canonicalServerMessageId) {
    targetState.deleteMessage(clientMsgId);
    persistMessageDeletedToDb(clientMsgId).catch(() => { });
  }
  if (message.id && message.id !== canonicalServerMessageId) {
    targetState.deleteMessage(message.id);
  }
  message.isDeleted = true;
  message.kind = 'deleted';
  message.body = { text: 'This message was deleted' };
  message.attachments = [];

  // Update reply cache if this message was cached
  if (canonicalServerMessageId && replyOriginalMessagesCache.has(String(canonicalServerMessageId))) {
    const cached = replyOriginalMessagesCache.get(String(canonicalServerMessageId));
    if (cached) {
      cached.isDeleted = true;
      cached.kind = 'deleted';
      cached.body = { text: 'This message was deleted' };
      cached.attachments = [];
    }
  }
  if (clientMsgId && replyOriginalMessagesCache.has(String(clientMsgId))) {
    const cached = replyOriginalMessagesCache.get(String(clientMsgId));
    if (cached) {
      cached.isDeleted = true;
      cached.kind = 'deleted';
      cached.body = { text: 'This message was deleted' };
      cached.attachments = [];
    }
  }

  // Remove local pin
  if (canonicalServerMessageId && targetRoom) shellState.unpinMessage(targetRoom, canonicalServerMessageId);
  if (clientMsgId && targetRoom) shellState.unpinMessage(targetRoom, clientMsgId);

  if (shellState.selectedRoomId === targetRoom) {
    renderMessages();
    renderPinnedBar(targetRoom);
  }

  const conv = shellState.conversations.find((c) => c.roomId === targetRoom);
  if (conv && conv.lastMessage) {
    conv.lastMessage.preview = 'This message was deleted';
    renderConversationList();
    persistConversationToDb(conv).catch(() => { });
  }
}

function handleDeleteForMe(message) {
  if (!message) return;
  const targetRoom = message.roomId || message.room_id || shellState.selectedRoomId;
  const mid = message.id || message.clientMessageId || message.client_message_id;

  roomMessagesState.deleteMessageForMe(mid, targetRoom);
  persistMessageDeletedForMeToDb(mid).catch(() => { });
  if (message.id && message.id !== mid) {
    roomMessagesState.deleteMessageForMe(message.id, targetRoom);
    persistMessageDeletedForMeToDb(message.id).catch(() => { });
  }

  // Update reply cache if this message was cached
  if (mid && replyOriginalMessagesCache.has(String(mid))) {
    const cached = replyOriginalMessagesCache.get(String(mid));
    if (cached) cached.isDeletedForMe = true;
  }
  if (message.id && replyOriginalMessagesCache.has(String(message.id))) {
    const cached = replyOriginalMessagesCache.get(String(message.id));
    if (cached) cached.isDeletedForMe = true;
  }

  // Remove any local pin for this deleted message
  if (mid && targetRoom) shellState.unpinMessage(targetRoom, mid);
  renderMessages();
  if (targetRoom) renderPinnedBar(targetRoom);
}

async function handleDeleteSelectedMessages({ forEveryone = false } = {}) {
  const selectedIds = shellState.getSelectedMessageIds();
  if (!selectedIds || selectedIds.length === 0) return;

  const currentRoomId = shellState.selectedRoomId;
  if (!currentRoomId) return;

  const currentUserId = roomMessagesState.currentUserId || shellState.currentUser?.userId;

  if (forEveryone) {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      showUserError('Cannot delete messages for everyone while offline.');
      return;
    }

    // Filter out messages user is not allowed to delete for everyone
    const messagesToDelete = roomMessagesState.messages.filter((m) => {
      const isSelected = (m.id && selectedIds.includes(String(m.id))) ||
        (m.clientMessageId && selectedIds.includes(String(m.clientMessageId))) ||
        (m.client_message_id && selectedIds.includes(String(m.client_message_id)));
      return isSelected && canDeleteMessageForEveryone(m, currentUserId);
    });

    if (messagesToDelete.length === 0) {
      showUserError('None of the selected messages can be deleted for everyone (must be sent by you within 48 hours).');
      return;
    }

    for (const msg of messagesToDelete) {
      await handleDeleteForEveryone(msg);
    }
  } else {
    // Delete for me
    for (const id of selectedIds) {
      const msg = roomMessagesState.messages.find((m) =>
        (m.id && String(m.id) === String(id)) ||
        (m.clientMessageId && String(m.clientMessageId) === String(id)) ||
        (m.client_message_id && String(m.client_message_id) === String(id))
      );
      if (msg) {
        handleDeleteForMe(msg);
      } else {
        roomMessagesState.deleteMessageForMe(id, currentRoomId);
        persistMessageDeletedForMeToDb(id).catch(() => { });
      }
    }
  }

  exitMessageSelectionMode();
}

// ═══════════════════════════════════════════════════════════════════
// Message Selection & WhatsApp-Style Forwarding Implementation
// ═══════════════════════════════════════════════════════════════════

let messagesPendingForward = [];
let selectedForwardRooms = new Set();
let isForwardingInProgress = false;

function updateSelectionToolbar() {
  const count = shellState.getSelectedMessageIds().length;
  const badge = document.getElementById('selection-count-label') || document.getElementById('selection-count-badge') || selectionCountBadge;
  if (badge) {
    badge.textContent = `${count} selected`;
  }
  if (btnDeleteSelected) {
    btnDeleteSelected.disabled = (count === 0);
  }
  if (btnForwardSelected) {
    btnForwardSelected.disabled = (count === 0 || isForwardingInProgress);
  }
}

function toggleMessageSelectionUI(messageOrId) {
  if (!messageOrId) return;
  shellState.toggleMessageSelection(messageOrId);
  const selectedCount = shellState.getSelectedMessageIds().length;
  if (selectedCount === 0) {
    exitMessageSelectionMode();
    return;
  }
  updateSelectionToolbar();

  const id = typeof messageOrId === 'object' ? messageOrId.id : messageOrId;
  const cid = typeof messageOrId === 'object' ? (messageOrId.clientMessageId || messageOrId.client_message_id) : null;
  const row = (id ? messagesList?.querySelector(`.message-row[data-message-id="${id}"]`) : null)
    || (cid ? messagesList?.querySelector(`.message-row[data-client-message-id="${cid}"]`) : null)
    || messagesList?.querySelector(`.message-row[data-message-id="${messageOrId}"]`)
    || messagesList?.querySelector(`.message-row[data-client-message-id="${messageOrId}"]`);
  if (row) {
    const isSelected = shellState.isMessageSelected(messageOrId);
    row.classList.toggle('is-selected', isSelected);
    const chk = row.querySelector('.message-select-checkbox input[type="checkbox"]');
    if (chk) chk.checked = isSelected;
  }
}

function enterMessageSelectionMode(initialMessageOrId = null) {
  shellState.isMessageSelectionMode = true;
  shellState.clearMessageSelection();
  if (initialMessageOrId) {
    shellState.toggleMessageSelection(initialMessageOrId);
  }
  if (messageSelectionBar) {
    messageSelectionBar.classList.remove('hidden');
  }
  updateSelectionToolbar();
  renderMessages();
}

function exitMessageSelectionMode() {
  shellState.isMessageSelectionMode = false;
  shellState.clearMessageSelection();
  if (messageSelectionBar) {
    messageSelectionBar.classList.add('hidden');
  }
  updateSelectionToolbar();
  renderMessages();
}

function handleSelectAction(message) {
  if (!message) return;
  enterMessageSelectionMode(message);
}

function handleForwardAction(message) {
  if (!message) return;
  if (shellState.isMessageSelectionMode && shellState.getSelectedMessageIds().length > 0) {
    const selectedIds = shellState.getSelectedMessageIds();
    const msgs = roomMessagesState.messages.filter((m) => {
      return (m.id && selectedIds.includes(String(m.id))) ||
        (m.clientMessageId && selectedIds.includes(String(m.clientMessageId))) ||
        (m.client_message_id && selectedIds.includes(String(m.client_message_id)));
    });
    openForwardModal(msgs.length > 0 ? msgs : [message]);
  } else {
    openForwardModal([message]);
  }
}

function openForwardModal(messagesToForward) {
  if (!messagesToForward || messagesToForward.length === 0) return;

  const validMessages = messagesToForward.filter((m) => {
    const res = resolveMessageContent(m);
    return !m.isCallEntry && m.kind !== 'call' && res.kind !== 'call' && !m.isDeleted && m.kind !== 'deleted';
  });

  if (validMessages.length === 0) {
    showUserError('Call history and deleted messages cannot be forwarded.');
    return;
  }

  messagesPendingForward = validMessages;
  selectedForwardRooms.clear();

  if (forwardModalTitle) {
    forwardModalTitle.textContent = validMessages.length > 1
      ? `Forward ${validMessages.length} messages to`
      : 'Forward message to';
  }
  if (forwardChatSearch) {
    forwardChatSearch.value = '';
  }
  updateForwardModalSelectionState();
  renderForwardChatList('');

  if (forwardModal) {
    forwardModal.classList.remove('hidden');
  }
  forwardChatSearch?.focus();
}

function closeForwardModal() {
  if (isForwardingInProgress) return;
  if (forwardModal) {
    forwardModal.classList.add('hidden');
  }
  selectedForwardRooms.clear();
  messagesPendingForward = [];
  if (btnConfirmForward) {
    btnConfirmForward.disabled = true;
    const btnText = btnConfirmForward.querySelector('.btn-text');
    if (btnText) btnText.textContent = 'Forward';
    if (forwardSpinner) forwardSpinner.classList.add('hidden');
  }
  if (btnCancelForward) btnCancelForward.disabled = false;
  if (btnCloseForwardModal) btnCloseForwardModal.disabled = false;
}

function updateForwardModalSelectionState() {
  const count = selectedForwardRooms.size;
  if (forwardSelectionCount) {
    forwardSelectionCount.textContent = `${count} ${count === 1 ? 'chat' : 'chats'} selected`;
  }
  if (btnConfirmForward) {
    btnConfirmForward.disabled = (count === 0);
  }
}

function renderForwardChatList(filterQuery = '') {
  if (!forwardChatList) return;
  forwardChatList.innerHTML = '';
  const q = filterQuery.trim().toLowerCase();

  const matchingConvs = shellState.conversations.filter((c) => {
    if (!c.roomId) return false;
    const title = (getConversationTitle(c) || '').toLowerCase();
    return !q || title.includes(q);
  });

  if (matchingConvs.length === 0) {
    const emptyEl = document.createElement('div');
    emptyEl.className = 'no-results-hint';
    emptyEl.textContent = q ? 'No chats found' : 'No chats available';
    emptyEl.style.padding = '16px';
    emptyEl.style.textAlign = 'center';
    emptyEl.style.color = 'var(--text-muted)';
    forwardChatList.appendChild(emptyEl);
    return;
  }

  for (const conv of matchingConvs) {
    const item = document.createElement('div');
    const isChecked = selectedForwardRooms.has(conv.roomId);
    item.className = `forward-chat-item ${isChecked ? 'is-selected' : ''}`;
    item.setAttribute('role', 'option');
    item.setAttribute('aria-selected', String(isChecked));

    const avatarEl = document.createElement('div');
    avatarEl.className = 'forward-chat-avatar';
    const title = getConversationTitle(conv);
    if (conv.avatarUrl) {
      avatarEl.innerHTML = `<img src="${conv.avatarUrl}" alt="${title}" />`;
    } else {
      avatarEl.style.backgroundColor = getAvatarColor(title);
      avatarEl.textContent = getAvatarInitials(title);
    }

    const detailsEl = document.createElement('div');
    detailsEl.className = 'forward-chat-details';
    const nameEl = document.createElement('span');
    nameEl.className = 'forward-chat-name';
    nameEl.textContent = title;
    const subEl = document.createElement('span');
    subEl.className = 'forward-chat-subtitle';
    subEl.textContent = conv.kind === 'group' ? 'Group' : (getConversationSubtitle(conv) || '');
    detailsEl.appendChild(nameEl);
    detailsEl.appendChild(subEl);

    const chk = document.createElement('input');
    chk.type = 'checkbox';
    chk.className = 'forward-chat-checkbox';
    chk.checked = isChecked;

    item.appendChild(avatarEl);
    item.appendChild(detailsEl);
    item.appendChild(chk);

    item.addEventListener('click', () => {
      if (selectedForwardRooms.has(conv.roomId)) {
        selectedForwardRooms.delete(conv.roomId);
      } else {
        selectedForwardRooms.add(conv.roomId);
      }
      updateForwardModalSelectionState();
      renderForwardChatList(forwardChatSearch ? forwardChatSearch.value : '');
    });

    forwardChatList.appendChild(item);
  }
}

async function forwardSingleMessage(msg, targetRoomId, currentUserId) {
  const resolved = resolveMessageContent(msg);
  const kind = msg.kind || resolved.kind || 'text';
  const isCall = Boolean(msg.isCallEntry || msg.kind === 'call' || resolved.kind === 'call');
  if (isCall) {
    console.warn('[Forwarding] Skipping call entry');
    return;
  }

  // Generate UNIQUE client message ID per destination room
  const clientMessageId = `local-${generateUuid()}`;
  const targetState = getOrCreateRoomMessagesState(targetRoomId);

  const hasAttachments = Boolean(
    (msg.attachmentIds && msg.attachmentIds.length > 0) ||
    (msg.attachment_ids && msg.attachment_ids.length > 0) ||
    (msg.body && (msg.body.attachment_id || msg.body.attachmentIds)) ||
    resolved.attachmentId
  );

  if (kind === 'text' && !hasAttachments) {
    // Text Forwarding
    const cleanText = getCleanForwardedText(resolved.text || msg.body?.text || '');
    const forwardBodyText = cleanText ? `[Forwarded] ${cleanText}` : '[Forwarded]';

    const optimisticMsg = createOptimisticMessage(
      targetRoomId,
      currentUserId,
      forwardBodyText,
      clientMessageId
    );
    optimisticMsg.body.is_forwarded = true;
    optimisticMsg.is_forwarded = true;
    optimisticMsg.isForwarded = true;

    targetState.addOptimisticMessage(optimisticMsg);
    persistMessageToDb(optimisticMsg, targetRoomId).catch(() => { });

    if (shellState.selectedRoomId === targetRoomId) {
      messagesEmpty?.classList.add('hidden');
      messagesScrollArea?.classList.remove('hidden');
      renderMessages();
      scrollToBottom(true);
    }

    const conv = shellState.conversations.find((c) => c.roomId === targetRoomId);
    if (conv) {
      conv.lastMessage = {
        preview: forwardBodyText,
        senderId: currentUserId,
        createdAt: optimisticMsg.createdAt,
        kind: 'text'
      };
      renderConversationList();
      persistConversationToDb(conv).catch(() => { });
    }

    pendingPayloads.set(clientMessageId, {
      roomId: targetRoomId,
      kind: 'text',
      text: forwardBodyText,
      clientMessageId
    });

    const payload = {
      client_message_id: clientMessageId,
      kind: 'text',
      body: {
        text: forwardBodyText,
        is_forwarded: true
      },
      reply_to: null,
      attachment_ids: []
    };

    // Outbox enqueue (Phase 4C durable SQLite outbox)
    await outboxManager.enqueue({
      clientMessageId,
      roomId: targetRoomId,
      wirePayload: payload,
      optimisticMsg
    });

    try {
      const wsState = await window.ollacoreDesktop?.chat?.getState();
      if (wsState !== 'connected' || (typeof navigator !== 'undefined' && !navigator.onLine)) {
        targetState.updateReceipt(clientMessageId, 'pending');
        persistMessageStatusToDb(clientMessageId, 'pending').catch(() => { });
        if (shellState.selectedRoomId === targetRoomId) {
          updateMessageStatusInDom(clientMessageId, 'pending');
        }
        return;
      }

      const res = await window.ollacoreDesktop?.chat?.send('message.send', payload, targetRoomId);
      if (res?.ok && res?.requestId) {
        requestToClient.set(res.requestId, clientMessageId);
      } else {
        targetState.updateReceipt(clientMessageId, 'pending');
        persistMessageStatusToDb(clientMessageId, 'pending').catch(() => { });
        if (shellState.selectedRoomId === targetRoomId) {
          updateMessageStatusInDom(clientMessageId, 'pending');
        }
      }
    } catch (err) {
      console.error('[Forwarding:text] Error sending WebSocket frame:', err);
      targetState.updateReceipt(clientMessageId, 'pending');
      persistMessageStatusToDb(clientMessageId, 'pending').catch(() => { });
      if (shellState.selectedRoomId === targetRoomId) {
        updateMessageStatusInDom(clientMessageId, 'pending');
      }
    }
  } else {
    // Media Forwarding (Image, Video, Document, Audio, Voice Note)
    const rawWsState = await window.ollacoreDesktop?.chat?.getState();
    const wsState = typeof rawWsState === 'object' && rawWsState !== null ? (rawWsState.data || rawWsState.state || 'connected') : rawWsState;
    if (wsState !== 'connected') {
      showUserError("Media can't be forwarded while offline.");
      const offlineErr = new Error("Media can't be forwarded while offline.");
      offlineErr.code = 'NETWORK_FAILURE';
      throw offlineErr;
    }

    let sourceAttachmentId = null;
    if (Array.isArray(msg.attachmentIds) && msg.attachmentIds.length > 0) {
      const item = msg.attachmentIds[0];
      sourceAttachmentId = (typeof item === 'object' && item !== null) ? (item.id || item.attachment_id || item.attachmentId) : item;
    }
    if (!sourceAttachmentId && Array.isArray(msg.attachment_ids) && msg.attachment_ids.length > 0) {
      const item = msg.attachment_ids[0];
      sourceAttachmentId = (typeof item === 'object' && item !== null) ? (item.id || item.attachment_id || item.attachmentId) : item;
    }
    if (!sourceAttachmentId && Array.isArray(msg.attachments) && msg.attachments.length > 0) {
      const item = msg.attachments[0];
      sourceAttachmentId = (typeof item === 'object' && item !== null) ? (item.id || item.attachment_id || item.attachmentId) : item;
    }
    if (!sourceAttachmentId && msg.body) {
      if (Array.isArray(msg.body.attachment_ids) && msg.body.attachment_ids.length > 0) {
        const item = msg.body.attachment_ids[0];
        sourceAttachmentId = (typeof item === 'object' && item !== null) ? (item.id || item.attachment_id || item.attachmentId) : item;
      } else if (Array.isArray(msg.body.attachmentIds) && msg.body.attachmentIds.length > 0) {
        const item = msg.body.attachmentIds[0];
        sourceAttachmentId = (typeof item === 'object' && item !== null) ? (item.id || item.attachment_id || item.attachmentId) : item;
      } else if (Array.isArray(msg.body.attachments) && msg.body.attachments.length > 0) {
        const item = msg.body.attachments[0];
        sourceAttachmentId = (typeof item === 'object' && item !== null) ? (item.id || item.attachment_id || item.attachmentId) : item;
      } else if (msg.body.attachment_id || msg.body.attachmentId) {
        const item = msg.body.attachment_id || msg.body.attachmentId;
        sourceAttachmentId = (typeof item === 'object' && item !== null) ? (item.id || item.attachment_id || item.attachmentId) : item;
      }
    }
    if (!sourceAttachmentId) {
      sourceAttachmentId = msg.attachmentId || msg.attachment_id || resolved.attachmentId || null;
    }
    if (typeof sourceAttachmentId === 'object' && sourceAttachmentId !== null) {
      sourceAttachmentId = sourceAttachmentId.id || sourceAttachmentId.attachment_id || sourceAttachmentId.attachmentId || null;
    }
    if (sourceAttachmentId) {
      sourceAttachmentId = String(sourceAttachmentId);
    }

    const sourceRoomId = msg.roomId || msg.room_id || shellState.selectedRoomId;

    if (!sourceAttachmentId && msg.id && window.ollacoreDesktop?.chatApi?.getMessages) {
      try {
        if (sourceRoomId) {
          const fetched = await window.ollacoreDesktop.chatApi.getMessages(sourceRoomId, { limit: 50 });
          const serverList = fetched?.messages || fetched?.data || (Array.isArray(fetched) ? fetched : []);
          const match = serverList.find(m => m.id === msg.id);
          if (match) {
            const rawMatchAid = (Array.isArray(match.attachment_ids) && match.attachment_ids[0])
              || (Array.isArray(match.attachmentIds) && match.attachmentIds[0])
              || (Array.isArray(match.attachments) && (match.attachments[0]?.id || match.attachments[0]?.attachment_id))
              || (match.body && (match.body.attachment_id || (match.body.attachment_ids && match.body.attachment_ids[0])))
              || null;
            if (rawMatchAid) {
              sourceAttachmentId = String(typeof rawMatchAid === 'object' ? (rawMatchAid.id || rawMatchAid.attachment_id) : rawMatchAid);
              msg.attachment_ids = [sourceAttachmentId];
              msg.attachmentIds = [sourceAttachmentId];
              persistMessageToDb(match, sourceRoomId).catch(() => { });
            }
          }
        }
      } catch (fetchErr) {
        console.warn('[Forwarding] Fallback message fetch failed:', fetchErr);
      }
    }

    if (!sourceAttachmentId) {
      const missingErr = new Error('Source attachment ID missing from message');
      missingErr.code = 'MISSING_ATTACHMENT_ID';
      throw missingErr;
    }

    const filename = resolved.filename || msg.body?.filename || `attachment_${Date.now()}`;
    const effectiveMime = resolved.mime || msg.body?.mime || 'application/octet-stream';
    const byteSize = resolved.byteSize || msg.body?.byte_size || 0;
    const isVoiceNote = Boolean(
      resolved.isVoiceNote ||
      msg.body?.is_voice_note ||
      (filename && filename.startsWith('voice_message_'))
    );
    const duration = resolved.duration || msg.body?.duration || null;
    const rawCaption = resolved.caption || (kind !== 'file' ? resolved.text : '') || '';
    const cleanCaption = getCleanForwardedText(rawCaption);

    // Re-upload attachment for target room using safe cache download/upload
    const uploadRes = await window.ollacoreDesktop.chatApi.uploadMedia({
      roomId: targetRoomId,
      sourceAttachmentId,
      sourceRoomId,
      filename,
      declaredMime: effectiveMime,
      byteSize
    });

    const uploadData = uploadRes?.data || uploadRes;
    const newAttachmentId = uploadData?.attachmentId || uploadData?.attachment_id;

    if (!newAttachmentId && uploadRes?.ok === false) {
      const errMsg = uploadRes?.error?.message || 'Media upload failed';
      const upErr = new Error(errMsg);
      if (errMsg.includes('download source attachment') || errMsg.includes('download URL') || errMsg.includes('Source attachment is not cached') || errMsg.includes('File does not exist')) {
        upErr.code = 'MEDIA_SOURCE_FAILURE';
      } else {
        upErr.code = 'UPLOAD_FAILURE';
      }
      throw upErr;
    }

    if (!newAttachmentId) {
      const noIdErr = new Error('Upload did not return a valid attachment ID');
      noIdErr.code = 'UPLOAD_FAILURE';
      throw noIdErr;
    }

    let wireKind = kind;
    if (kind === 'audio' || isVoiceNote) {
      wireKind = 'file';
    }

    let optimisticMsg;
    if (isVoiceNote) {
      optimisticMsg = createOptimisticVoiceMessage(targetRoomId, currentUserId, {
        filename,
        mime: effectiveMime,
        byteSize,
        duration: duration || 1,
        attachmentId: newAttachmentId,
        clientMessageId
      });
    } else {
      optimisticMsg = createOptimisticMediaMessage(targetRoomId, currentUserId, {
        kind: wireKind,
        filename,
        caption: cleanCaption ? `[Forwarded] ${cleanCaption}` : '',
        mime: effectiveMime,
        byteSize,
        attachmentId: newAttachmentId,
        clientMessageId
      });
    }

    optimisticMsg.attachmentIds = [newAttachmentId];
    optimisticMsg.attachment_ids = [newAttachmentId];
    optimisticMsg.body.is_forwarded = true;
    optimisticMsg.is_forwarded = true;
    optimisticMsg.isForwarded = true;

    let forwardDisplayText = filename;
    if (cleanCaption) {
      const fwdCap = `[Forwarded] ${cleanCaption}`;
      optimisticMsg.body.caption = fwdCap;
      optimisticMsg.body.text = fwdCap;
      forwardDisplayText = fwdCap;
    } else if (isVoiceNote) {
      forwardDisplayText = 'Voice message';
    }

    targetState.addOptimisticMessage(optimisticMsg);
    persistMessageToDb(optimisticMsg, targetRoomId).catch(() => { });

    if (shellState.selectedRoomId === targetRoomId) {
      messagesEmpty?.classList.add('hidden');
      messagesScrollArea?.classList.remove('hidden');
      renderMessages();
      scrollToBottom(true);
    }

    const dlUrl = uploadData?.downloadUrl || uploadData?.download_url;
    if (dlUrl) {
      attachmentUrls.set(newAttachmentId, dlUrl);
      if (shellState.selectedRoomId === targetRoomId) {
        updateMediaPlaceholdersInDom(newAttachmentId, dlUrl, targetRoomId);
      }
    }

    const conv = shellState.conversations.find((c) => c.roomId === targetRoomId);
    if (conv) {
      conv.lastMessage = {
        preview: forwardDisplayText,
        senderId: currentUserId,
        createdAt: optimisticMsg.createdAt,
        kind: wireKind
      };
      renderConversationList();
      persistConversationToDb(conv).catch(() => { });
    }

    const messageBody = {
      text: forwardDisplayText,
      filename,
      mime: effectiveMime,
      byte_size: byteSize,
      is_forwarded: true
    };
    if (cleanCaption) {
      messageBody.caption = `[Forwarded] ${cleanCaption}`;
    }
    if (isVoiceNote) {
      messageBody.is_voice_note = true;
      if (duration) messageBody.duration = duration;
    }

    const payload = {
      client_message_id: clientMessageId,
      kind: wireKind,
      body: messageBody,
      reply_to: null,
      attachment_ids: [newAttachmentId]
    };

    const res = await window.ollacoreDesktop?.chat?.send('message.send', payload, targetRoomId);
    if (res?.ok && res?.requestId) {
      requestToClient.set(res.requestId, clientMessageId);
    } else {
      targetState.updateReceipt(clientMessageId, 'failed');
      persistMessageStatusToDb(clientMessageId, 'failed').catch(() => { });
      if (shellState.selectedRoomId === targetRoomId) {
        updateMessageStatusInDom(clientMessageId, 'failed');
      }
    }
  }
}

async function executeForwarding() {
  if (isForwardingInProgress) return;
  if (selectedForwardRooms.size === 0 || messagesPendingForward.length === 0) {
    return;
  }

  isForwardingInProgress = true;

  const targetRooms = Array.from(selectedForwardRooms);
  // Preserve original chronological order (Phase 7)
  const messagesToForward = [...messagesPendingForward].sort((a, b) => {
    const tA = new Date(a.createdAt || a.created_at || 0).getTime();
    const tB = new Date(b.createdAt || b.created_at || 0).getTime();
    return tA - tB;
  });

  const totalOps = targetRooms.length * messagesToForward.length;
  let completedOps = 0;

  if (btnConfirmForward) {
    btnConfirmForward.disabled = true;
    const btnText = btnConfirmForward.querySelector('.btn-text');
    if (btnText) {
      btnText.textContent = totalOps > 1 ? `Forwarding (0/${totalOps})...` : 'Forwarding...';
    }
  }
  if (btnCancelForward) btnCancelForward.disabled = true;
  if (btnCloseForwardModal) btnCloseForwardModal.disabled = true;
  if (btnForwardSelected) btnForwardSelected.disabled = true;
  if (forwardSpinner) forwardSpinner.classList.remove('hidden');

  const forwardingErrors = [];
  const currentUserId = roomMessagesState.currentUserId || shellState.currentUser?.userId || shellState.userProfile?.userId || '';

  try {
    // Forward to each room independently (Phase 5 & Phase 8)
    for (const targetRoomId of targetRooms) {
      for (const msg of messagesToForward) {
        completedOps++;
        const resolved = resolveMessageContent(msg);
        const isMedia = Boolean(
          (msg.attachmentIds && msg.attachmentIds.length > 0) ||
          (msg.attachment_ids && msg.attachment_ids.length > 0) ||
          (msg.attachments && msg.attachments.length > 0) ||
          (msg.body && (msg.body.attachment_id || msg.body.attachmentIds || msg.body.attachment_ids || msg.body.attachments)) ||
          msg.attachmentId || msg.attachment_id || resolved.attachmentId ||
          ['image', 'video', 'audio', 'voice', 'document', 'file'].includes(msg.kind || resolved.kind)
        );

        const statusLabel = isMedia
          ? (totalOps > 1 ? `Uploading & forwarding (${completedOps}/${totalOps})...` : 'Uploading media...')
          : (totalOps > 1 ? `Forwarding (${completedOps}/${totalOps})...` : 'Forwarding message...');

        if (btnConfirmForward) {
          const btnText = btnConfirmForward.querySelector('.btn-text');
          if (btnText) btnText.textContent = statusLabel;
        }
        if (forwardSelectionCount) {
          forwardSelectionCount.textContent = statusLabel;
        }

        // Keep UI responsive and allow DOM paint
        await new Promise((r) => setTimeout(r, 16));

        try {
          await forwardSingleMessage(msg, targetRoomId, currentUserId);
        } catch (err) {
          console.error(`[Forwarding] Failed forwarding to ${targetRoomId}:`, err);
          forwardingErrors.push(err);
        }
      }
    }
  } finally {
    isForwardingInProgress = false;
  }

  closeForwardModal();
  if (shellState.isMessageSelectionMode) {
    exitMessageSelectionMode();
  }

  if (forwardingErrors.length > 0) {
    const isNetworkError = (err) => {
      const m = String(err?.message || '').toLowerCase();
      const c = String(err?.code || '').toLowerCase();
      return c === 'network_failure' ||
        m.includes('offline') ||
        m.includes('network') ||
        m.includes('connection') ||
        m.includes('fetch') ||
        c.includes('network') ||
        c.includes('enotfound') ||
        c.includes('econnrefused') ||
        c.includes('etimedout');
    };

    const isMissingId = (err) => {
      const m = String(err?.message || '');
      return err?.code === 'MISSING_ATTACHMENT_ID' ||
        m.includes('Source attachment ID missing') ||
        m.includes('attachment ID missing');
    };

    const isMediaSourceError = (err) => {
      const m = String(err?.message || '');
      return err?.code === 'MEDIA_SOURCE_FAILURE' ||
        m.includes('download source attachment') ||
        m.includes('download URL for source attachment') ||
        m.includes('Source attachment is not cached') ||
        m.includes('File does not exist') ||
        m.includes('original media') ||
        m.includes('access the original media');
    };

    const isUploadError = (err) => {
      const m = String(err?.message || '');
      return err?.code === 'UPLOAD_FAILURE' ||
        m.includes('Media upload failed') ||
        m.includes('Upload did not return') ||
        m.includes('Unable to upload') ||
        m.includes('initialize attachment upload') ||
        m.includes('Attachment upload failed');
    };

    if (forwardingErrors.some(isMissingId)) {
      showUserError('Unable to forward this media.');
    } else if (forwardingErrors.some(isMediaSourceError)) {
      showUserError('Unable to access the original media.');
    } else if (forwardingErrors.some(isUploadError)) {
      showUserError('Unable to upload the media.');
    } else if (forwardingErrors.some(isNetworkError)) {
      showUserError('Some forwarded messages could not be sent. Please check your connection.');
    } else {
      showUserError('Unable to forward this media.');
    }
  }
}

// ═══════════════════════════════════════════════════════════════════
// Application Initialization & Event Wiring
// ═══════════════════════════════════════════════════════════════════

let navigateRoomUnsubscribe = null;

async function init() {
  if (!window.ollacoreDesktop?.auth) {
    console.warn('Ollacore desktop bridge not available');
    return;
  }

  // 1. Country code selector
  countrySelect?.addEventListener('change', () => {
    if (countryPrefix) countryPrefix.textContent = countrySelect.value;
  });

  // 2. Request OTP submission
  btnRequestOtp?.addEventListener('click', async (e) => {
    e.preventDefault();
    showError(phoneError, null);

    const rawPhone = phoneInput?.value?.trim() || '';
    const countryCode = countrySelect?.value || '+91';

    let e164Phone;
    try {
      e164Phone = normalizeToE164(rawPhone, countryCode);
    } catch (err) {
      showError(phoneError, err.message || 'Enter a valid phone number');
      phoneInput?.focus();
      return;
    }

    setButtonLoading(btnRequestOtp, true);
    try {
      const res = await window.ollacoreDesktop.auth.requestOtp(e164Phone);
      if (res.ok) {
        if (displayOtpPhone) displayOtpPhone.textContent = res.state.phone;
        showScreen('otp');
        startCooldownTimer(res.state.cooldownRemaining || 60);
      } else {
        showError(phoneError, res.error || 'Failed to send OTP code');
      }
    } catch (err) {
      showError(phoneError, err.message || 'Unable to connect to Ollacore server');
    } finally {
      setButtonLoading(btnRequestOtp, false);
    }
  });

  phoneInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      btnRequestOtp?.click();
    }
  });

  // 3. Verify OTP submission
  async function submitOtp() {
    showError(otpError, null);
    const code = otpInput?.value?.trim() || '';

    if (code.length !== 6) {
      showError(otpError, 'Enter the complete 6-digit code');
      otpInput?.focus();
      return;
    }

    setButtonLoading(btnVerifyOtp, true);
    try {
      const res = await window.ollacoreDesktop.auth.verifyOtp(code);
      if (res.ok) {
        clearInterval(cooldownInterval);
        updateProfileDisplay(res.session);
        showScreen('authenticated');
      } else {
        showError(otpError, res.error || 'Invalid verification code');
        otpInput?.select();
      }
    } catch (err) {
      showError(otpError, err.message || 'Verification failed');
    } finally {
      setButtonLoading(btnVerifyOtp, false);
    }
  }

  btnVerifyOtp?.addEventListener('click', submitOtp);

  // Auto-submit OTP on 6 digits
  otpInput?.addEventListener('input', () => {
    if (!otpInput) return;
    otpInput.value = otpInput.value.replace(/\D/g, '').slice(0, 6);
    if (otpInput.value.length === 6) {
      submitOtp();
    }
  });

  // 4. Back to phone screen
  btnBackPhone?.addEventListener('click', async () => {
    clearInterval(cooldownInterval);
    await window.ollacoreDesktop.auth.backToPhone();
    showError(phoneError, null);
    showError(otpError, null);
    showScreen('phone');
  });

  // 5. Resend OTP
  btnResendOtp?.addEventListener('click', async () => {
    showError(otpError, null);
    if (btnResendOtp) btnResendOtp.disabled = true;
    try {
      const res = await window.ollacoreDesktop.auth.resendOtp();
      if (res.ok) {
        startCooldownTimer(res.state.cooldownRemaining || 60);
      } else {
        showError(otpError, res.error || 'Failed to resend code');
        if (btnResendOtp) btnResendOtp.disabled = false;
      }
    } catch (err) {
      showError(otpError, err.message || 'Unable to resend OTP');
      if (btnResendOtp) btnResendOtp.disabled = false;
    }
  });

  // 6. Logout triggers
  btnLogout?.addEventListener('click', handleLogout);
  btnModalLogout?.addEventListener('click', handleLogout);

  // 7. Search conversations input
  conversationSearch?.addEventListener('input', () => {
    const query = conversationSearch.value;
    shellState.setSearchQuery(query);
    if (btnClearSearch) {
      if (query.trim()) btnClearSearch.classList.remove('hidden');
      else btnClearSearch.classList.add('hidden');
    }
    renderConversationList();
  });

  btnClearSearch?.addEventListener('click', () => {
    if (conversationSearch) conversationSearch.value = '';
    shellState.setSearchQuery('');
    btnClearSearch.classList.add('hidden');
    conversationSearch?.focus();
    renderConversationList();
  });

  // 7b. Chat header search triggers
  btnChatSearch?.addEventListener('click', () => {
    if (chatSearchState.isOpen) {
      closeChatSearch();
    } else {
      openChatSearch();
    }
  });

  chatSearchInput?.addEventListener('input', () => {
    if (!chatSearchInput) return;
    const rawVal = chatSearchInput.value;
    if (rawVal.length > 0) {
      btnClearChatSearch?.classList.remove('hidden');
    } else {
      btnClearChatSearch?.classList.add('hidden');
    }

    clearTimeout(searchDebounceTimer);
    const query = rawVal.trim();
    if (!query) {
      chatSearchResultsPanel?.classList.add('hidden');
      if (chatSearchCount) chatSearchCount.textContent = '';
      if (btnPrevSearchResult) btnPrevSearchResult.disabled = true;
      if (btnNextSearchResult) btnNextSearchResult.disabled = true;
      chatSearchState.results = [];
      chatSearchState.currentIndex = -1;
      return;
    }

    searchDebounceTimer = setTimeout(() => {
      executeChatSearch(query);
    }, 250);
  });

  btnClearChatSearch?.addEventListener('click', () => {
    if (chatSearchInput) chatSearchInput.value = '';
    btnClearChatSearch?.classList.add('hidden');
    chatSearchResultsPanel?.classList.add('hidden');
    if (chatSearchCount) chatSearchCount.textContent = '';
    if (btnPrevSearchResult) btnPrevSearchResult.disabled = true;
    if (btnNextSearchResult) btnNextSearchResult.disabled = true;
    chatSearchState.results = [];
    chatSearchState.currentIndex = -1;
    chatSearchInput?.focus();
  });

  btnPrevSearchResult?.addEventListener('click', () => {
    if (chatSearchState.results.length === 0) return;
    const prev = chatSearchState.currentIndex - 1;
    navigateToSearchResult(prev >= 0 ? prev : chatSearchState.results.length - 1);
  });

  btnNextSearchResult?.addEventListener('click', () => {
    if (chatSearchState.results.length === 0) return;
    const next = chatSearchState.currentIndex + 1;
    navigateToSearchResult(next < chatSearchState.results.length ? next : 0);
  });

  btnCloseChatSearch?.addEventListener('click', closeChatSearch);

  chatSearchInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (e.shiftKey) {
        btnPrevSearchResult?.click();
      } else {
        btnNextSearchResult?.click();
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeChatSearch();
    }
  });

  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F')) {
      if (shellState.selectedRoomId) {
        e.preventDefault();
        openChatSearch();
      }
    } else if (e.key === 'Escape' && chatSearchState.isOpen) {
      closeChatSearch();
    }
  });

  // 8. Retry inbox loading
  btnRetryInbox?.addEventListener('click', loadInbox);

  // Navigation Rail Items
  navItemChats?.addEventListener('click', () => {
    switchNavigationRail('chats');
    const searchInput = document.getElementById('conversation-search');
    searchInput?.focus();
  });

  navItemCalls?.addEventListener('click', () => {
    switchNavigationRail('calls');
    callsSearch?.focus();
  });

  navItemArchived?.addEventListener('click', () => {
    switchNavigationRail('archived');
    archivedSearch?.focus();
  });

  // Archived Page Search
  archivedSearch?.addEventListener('input', () => {
    const val = archivedSearch.value.trim();
    if (btnClearArchivedSearch) {
      if (val) {
        btnClearArchivedSearch.classList.remove('hidden');
      } else {
        btnClearArchivedSearch.classList.add('hidden');
      }
    }
    renderArchivedList();
  });

  btnClearArchivedSearch?.addEventListener('click', () => {
    if (archivedSearch) {
      archivedSearch.value = '';
    }
    btnClearArchivedSearch?.classList.add('hidden');
    renderArchivedList();
    archivedSearch?.focus();
  });

  // Calls Page Search
  callsSearch?.addEventListener('input', () => {
    const val = callsSearch.value.trim();
    if (btnClearCallsSearch) {
      if (val) {
        btnClearCallsSearch.classList.remove('hidden');
      } else {
        btnClearCallsSearch.classList.add('hidden');
      }
    }
    renderCallsHistory();
  });

  btnClearCallsSearch?.addEventListener('click', () => {
    if (callsSearch) {
      callsSearch.value = '';
    }
    btnClearCallsSearch?.classList.add('hidden');
    renderCallsHistory();
    callsSearch?.focus();
  });

  btnSettings?.addEventListener('click', openSettings);
  userProfileTrigger?.addEventListener('click', openSettings);
  btnCloseSettings?.addEventListener('click', closeSettings);
  btnCloseSettingsFooter?.addEventListener('click', closeSettings);

  btnEditProfile?.addEventListener('click', () => setProfileEditMode(true));
  btnCancelEditProfile?.addEventListener('click', () => setProfileEditMode(false));
  btnSaveProfile?.addEventListener('click', handleSaveProfile);

  modalUserAvatarEdit?.addEventListener('click', handlePickProfilePhoto);
  modalUserAvatarEdit?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handlePickProfilePhoto();
    }
  });
  btnChangePhoto?.addEventListener('click', handlePickProfilePhoto);
  btnRemovePhoto?.addEventListener('click', handleRemoveProfilePhoto);

  profileEditForm?.addEventListener('submit', (e) => {
    e.preventDefault();
    handleSaveProfile();
  });

  editProfileName?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleSaveProfile();
    }
  });

  editProfileAbout?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleSaveProfile();
    }
  });

  settingsModal?.addEventListener('click', (e) => {
    if (e.target === settingsModal) {
      closeSettings();
    }
  });

  // Dynamically load client info metadata for display
  (async function loadClientInfo() {
    try {
      if (window.ollacoreDesktop?.getInfo) {
        const info = await window.ollacoreDesktop.getInfo();
        if (info) {
          const platformName = info.platform === 'win32' ? 'Windows' : (info.platform || 'Windows');
          const archName = info.arch || 'x64';
          const clientStr = `OllaChat Desktop (${platformName} ${archName})`;
          if (settingClient) settingClient.textContent = clientStr;
          if (settingClientEdit) settingClientEdit.textContent = clientStr;
        }
      }
    } catch {
      // Retain default static client text
    }
  })();

  // Notification settings initialization & listeners
  loadNotificationSettings();

  settingToggleNotifications?.addEventListener('change', () => {
    saveNotificationSettings({ enabled: Boolean(settingToggleNotifications.checked) });
  });

  settingToggleNotificationPreview?.addEventListener('change', () => {
    saveNotificationSettings({ showPreview: Boolean(settingToggleNotificationPreview.checked) });
  });

  // Backup & Restore event listeners
  settingItemBackupRestore?.addEventListener('click', openBackupModal);
  btnCloseBackupModal?.addEventListener('click', closeBackupModal);
  btnCloseBackupFooter?.addEventListener('click', closeBackupModal);
  tabBackup?.addEventListener('click', () => switchBackupTab('backup'));
  tabRestore?.addEventListener('click', () => switchBackupTab('restore'));
  btnCreateBackup?.addEventListener('click', handleCreateBackup);
  btnSelectRestoreFile?.addEventListener('click', handleSelectRestoreFile);
  btnConfirmRestore?.addEventListener('click', handleConfirmRestore);
  btnCancelRestore?.addEventListener('click', () => {
    selectedRestoreFilePath = null;
    restorePreflightView?.classList.add('hidden');
    if (restoreSelectedFilename) restoreSelectedFilename.textContent = 'No file selected';
    if (restoreStatusBanner) restoreStatusBanner.classList.add('hidden');
  });
  backupModal?.addEventListener('click', (e) => {
    if (e.target === backupModal) closeBackupModal();
  });
  window.ollacoreDesktop?.backup?.onRestoreCompleted?.(() => {
    if (typeof loadInbox === 'function') loadInbox().catch(() => { });
  });

  // 10. Phase 4B: New Chat modal triggers
  btnNewChat?.addEventListener('click', openNewChatModal);
  btnCloseNewChat?.addEventListener('click', closeNewChatModal);

  tabDirect?.addEventListener('click', () => switchNewChatTab('direct'));
  tabGroup?.addEventListener('click', () => switchNewChatTab('group'));

  newChatModal?.addEventListener('click', (e) => {
    if (e.target === newChatModal) {
      closeNewChatModal();
    }
  });

  // Direct chat actions
  btnLookupDirect?.addEventListener('click', handleDirectLookup);
  btnStartDirectChat?.addEventListener('click', handleStartDirectChat);
  directPhoneInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (directDraft.canStart()) {
        handleStartDirectChat();
      } else {
        handleDirectLookup();
      }
    }
  });

  // Group creation actions
  btnAddGroupMember?.addEventListener('click', handleAddGroupMember);
  btnCreateGroup?.addEventListener('click', handleCreateGroup);

  groupNameInput?.addEventListener('input', () => {
    groupDraft.setName(groupNameInput.value);
    updateCreateGroupButtonState();
  });

  groupNameInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      groupMemberPhone?.focus();
    }
  });

  groupMemberPhone?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleAddGroupMember();
    }
  });

  // Contact Info / Group Info right-side panel triggers & actions
  chatHeaderInfo?.addEventListener('click', () => {
    if (!shellState.selectedRoomId) return;
    if (activeContactInfoRoomId === shellState.selectedRoomId && isContactInfoPanelOpen()) {
      closeContactInfo();
    } else {
      openContactInfo(shellState.selectedRoomId);
    }
  });

  chatHeaderInfo?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (!shellState.selectedRoomId) return;
      if (activeContactInfoRoomId === shellState.selectedRoomId && isContactInfoPanelOpen()) {
        closeContactInfo();
      } else {
        openContactInfo(shellState.selectedRoomId);
      }
    }
  });

  btnCloseContactInfo?.addEventListener('click', closeContactInfo);

  btnContactActionVoice?.addEventListener('click', () => {
    if (!shellState.selectedRoomId) return;
    const { displayName, phone } = resolveCallerIdentity(shellState.selectedRoomId, null);
    const peerName = displayName || 'Voice Call';
    voiceCallManager.peerPhone = phone;
    voiceCallManager.startCall(shellState.selectedRoomId, peerName, { peerPhone: phone }).catch((err) => {
      console.error('Failed to start voice call from contact info:', err);
    });
  });

  btnContactActionVideo?.addEventListener('click', () => {
    if (!shellState.selectedRoomId) return;
    const { displayName, phone } = resolveCallerIdentity(shellState.selectedRoomId, null);
    const peerName = displayName || 'Video Call';
    voiceCallManager.peerPhone = phone;
    voiceCallManager.startVideoCall(shellState.selectedRoomId, peerName, { peerPhone: phone }).catch((err) => {
      console.error('Failed to start video call from contact info:', err);
    });
  });

  btnContactActionSearch?.addEventListener('click', () => {
    openChatSearch();
  });

  btnGroupInfo?.addEventListener('click', () => {
    if (shellState.selectedRoomId) {
      openContactInfo(shellState.selectedRoomId);
    }
  });

  // Contact Info Rename Form Listeners
  btnContactInfoEditName?.addEventListener('click', () => {
    if (!contactInfoRenameForm || !activeContactInfoRoomId) return;
    const conv = shellState.conversations?.find((c) => c.roomId === activeContactInfoRoomId);
    if (contactInfoRenameInput) {
      contactInfoRenameInput.value = conv ? getConversationTitle(conv) : '';
    }
    contactInfoRenameForm.classList.remove('hidden');
    contactInfoName?.classList.add('hidden');
    btnContactInfoEditName?.classList.add('hidden');
    contactInfoRenameInput?.focus();
    contactInfoRenameInput?.select();
  });

  btnContactInfoCancelName?.addEventListener('click', () => {
    contactInfoRenameForm?.classList.add('hidden');
    contactInfoName?.classList.remove('hidden');
    btnContactInfoEditName?.classList.remove('hidden');
  });

  async function handleContactInfoSaveName() {
    if (!activeContactInfoRoomId) return;
    const raw = contactInfoRenameInput?.value || '';
    const val = validateGroupName(raw);
    if (!val.valid) {
      alert(val.error);
      contactInfoRenameInput?.focus();
      return;
    }
    setButtonLoading(btnContactInfoSaveName, true);
    try {
      await window.ollacoreDesktop.chatApi.updateGroup(activeContactInfoRoomId, { name: val.name });
      const conv = shellState.conversations?.find((c) => c.roomId === activeContactInfoRoomId);
      if (conv) conv.name = val.name;
      if (contactInfoName) contactInfoName.textContent = val.name;
      if (activeContactInfoRoomId === shellState.selectedRoomId && selectedChatName) {
        selectedChatName.textContent = val.name;
      }
      contactInfoRenameForm?.classList.add('hidden');
      contactInfoName?.classList.remove('hidden');
      btnContactInfoEditName?.classList.remove('hidden');
      renderConversationList();
    } catch (err) {
      alert(formatBackendGroupError('Rename group', err));
    } finally {
      setButtonLoading(btnContactInfoSaveName, false);
    }
  }

  btnContactInfoSaveName?.addEventListener('click', handleContactInfoSaveName);
  contactInfoRenameInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleContactInfoSaveName();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      contactInfoRenameForm?.classList.add('hidden');
      contactInfoName?.classList.remove('hidden');
      btnContactInfoEditName?.classList.remove('hidden');
    }
  });

  // Contact Info Group Description Listeners
  btnContactInfoEditDesc?.addEventListener('click', () => {
    if (!contactInfoDescForm || !contactInfoDescInput) return;
    const conv = shellState.conversations?.find((c) => c.roomId === activeContactInfoRoomId);
    const desc = conv?.description || conv?.about || '';
    contactInfoDescInput.value = desc;
    if (contactInfoDescCounter) {
      contactInfoDescCounter.textContent = String(512 - desc.length);
      contactInfoDescCounter.classList.toggle('text-danger', desc.length > 512);
    }
    contactInfoDescForm.classList.remove('hidden');
    contactInfoAboutText?.classList.add('hidden');
    btnContactInfoEditDesc?.classList.add('hidden');
    contactInfoDescInput.focus();
    contactInfoDescInput.select();
  });

  contactInfoAboutText?.addEventListener('click', () => {
    if (contactInfoAboutText.classList.contains('contact-info-about-placeholder') && !btnContactInfoEditDesc?.classList.contains('hidden')) {
      btnContactInfoEditDesc?.click();
    }
  });

  btnContactInfoCancelDesc?.addEventListener('click', () => {
    contactInfoDescForm?.classList.add('hidden');
    contactInfoAboutText?.classList.remove('hidden');
    btnContactInfoEditDesc?.classList.remove('hidden');
  });

  contactInfoDescInput?.addEventListener('input', () => {
    const len = contactInfoDescInput.value.length;
    if (contactInfoDescCounter) {
      contactInfoDescCounter.textContent = String(512 - len);
      contactInfoDescCounter.classList.toggle('text-danger', len > 512);
    }
  });

  async function handleContactInfoSaveDesc() {
    if (!activeContactInfoRoomId) return;
    if (isSavingGroupDescription) return;
    const raw = contactInfoDescInput?.value || '';
    const val = validateGroupDescription(raw);
    if (!val.valid) {
      alert(val.error);
      contactInfoDescInput?.focus();
      return;
    }
    isSavingGroupDescription = true;
    setButtonLoading(btnContactInfoSaveDesc, true);
    try {
      const conv = shellState.conversations?.find((c) => c.roomId === activeContactInfoRoomId);
      const oldDesc = conv?.description || conv?.about || '';
      await window.ollacoreDesktop.chatApi.updateGroup(activeContactInfoRoomId, { description: val.description });
      const currentUserId = shellState.currentUser?.userId || shellState.userProfile?.userId;
      const actorName = resolveParticipantName(currentUserId, null, activeContactInfoRoomId);

      createAndRecordGroupDescriptionSystemMessage(activeContactInfoRoomId, {
        prevDescription: oldDesc,
        newDescription: val.description,
        actorId: currentUserId,
        actorName
      });

      if (conv) {
        conv.description = val.description;
        conv.about = val.description;
      }
      if (contactInfoAboutText) {
        if (val.description && val.description.trim() !== '') {
          contactInfoAboutText.textContent = val.description.trim();
          contactInfoAboutText.classList.remove('contact-info-about-placeholder');
        } else {
          contactInfoAboutText.textContent = 'Add group description';
          contactInfoAboutText.classList.add('contact-info-about-placeholder');
        }
      }
      contactInfoDescForm?.classList.add('hidden');
      contactInfoAboutText?.classList.remove('hidden');
      btnContactInfoEditDesc?.classList.remove('hidden');
    } catch (err) {
      alert(formatBackendGroupError('Update group description', err));
    } finally {
      isSavingGroupDescription = false;
      setButtonLoading(btnContactInfoSaveDesc, false);
    }
  }

  btnContactInfoSaveDesc?.addEventListener('click', handleContactInfoSaveDesc);
  contactInfoDescInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      handleContactInfoSaveDesc();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      contactInfoDescForm?.classList.add('hidden');
      contactInfoAboutText?.classList.remove('hidden');
      btnContactInfoEditDesc?.classList.remove('hidden');
    }
  });

  // Contact Info Personal Nickname Listeners
  btnContactInfoNicknameAction?.addEventListener('click', () => {
    if (!contactInfoNicknameForm || !activeContactInfoRoomId) return;
    const conv = shellState.conversations?.find((c) => c.roomId === activeContactInfoRoomId);
    const contactUserId = conv?.peer?.userId || conv?.peerUserId || conv?.peer_user_id || conv?.peerId;
    if (!contactUserId) return;

    const currentNick = shellState.getContactNickname(contactUserId) || '';
    if (contactInfoNicknameInput) {
      contactInfoNicknameInput.value = currentNick;
    }
    btnContactInfoRemoveNickname?.classList.toggle('hidden', !currentNick);
    contactInfoNicknameForm.classList.remove('hidden');
    contactInfoName?.classList.add('hidden');
    btnContactInfoNicknameAction?.classList.add('hidden');
    contactInfoNicknameInput?.focus();
    contactInfoNicknameInput?.select();
  });

  btnContactInfoCancelNickname?.addEventListener('click', () => {
    contactInfoNicknameForm?.classList.add('hidden');
    contactInfoName?.classList.remove('hidden');
    btnContactInfoNicknameAction?.classList.remove('hidden');
  });

  function handleSaveContactNickname() {
    if (!activeContactInfoRoomId) return;
    const conv = shellState.conversations?.find((c) => c.roomId === activeContactInfoRoomId);
    const contactUserId = conv?.peer?.userId || conv?.peerUserId || conv?.peer_user_id || conv?.peerId;
    if (!contactUserId) return;

    const raw = contactInfoNicknameInput?.value || '';
    const clean = raw.trim();
    if (clean === '') {
      shellState.removeContactNickname(contactUserId);
    } else {
      shellState.setContactNickname(contactUserId, clean);
    }

    contactInfoNicknameForm?.classList.add('hidden');
    contactInfoName?.classList.remove('hidden');
    btnContactInfoNicknameAction?.classList.remove('hidden');

    openContactInfo(activeContactInfoRoomId);

    if (activeContactInfoRoomId === shellState.selectedRoomId && selectedChatName) {
      selectedChatName.textContent = getConversationTitle(conv);
      if (selectedChatAvatar) {
        const title = getConversationTitle(conv);
        renderAvatarElement(selectedChatAvatar, getConversationAvatarUrl(conv), getAvatarInitials(title), getAvatarColor(title), false);
      }
    }
    renderConversationList();
  }

  btnContactInfoSaveNickname?.addEventListener('click', handleSaveContactNickname);

  btnContactInfoRemoveNickname?.addEventListener('click', () => {
    if (!activeContactInfoRoomId) return;
    const conv = shellState.conversations?.find((c) => c.roomId === activeContactInfoRoomId);
    const contactUserId = conv?.peer?.userId || conv?.peerUserId || conv?.peer_user_id || conv?.peerId;
    if (!contactUserId) return;

    shellState.removeContactNickname(contactUserId);
    contactInfoNicknameForm?.classList.add('hidden');
    contactInfoName?.classList.remove('hidden');
    btnContactInfoNicknameAction?.classList.remove('hidden');

    openContactInfo(activeContactInfoRoomId);

    if (activeContactInfoRoomId === shellState.selectedRoomId && selectedChatName) {
      selectedChatName.textContent = getConversationTitle(conv);
      if (selectedChatAvatar) {
        const title = getConversationTitle(conv);
        renderAvatarElement(selectedChatAvatar, getConversationAvatarUrl(conv), getAvatarInitials(title), getAvatarColor(title), false);
      }
    }
    renderConversationList();
  });

  contactInfoNicknameInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleSaveContactNickname();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      contactInfoNicknameForm?.classList.add('hidden');
      contactInfoName?.classList.remove('hidden');
      btnContactInfoNicknameAction?.classList.remove('hidden');
    }
  });

  // Add people button in participants section
  btnGroupAddPeople?.addEventListener('click', () => {
    const roomId = activeContactInfoRoomId || shellState.selectedRoomId;
    if (roomId) openGroupAddPeopleModal(roomId);
  });

  // Contact Info Nav Rows: Favourites, Lists, Clear, Exit, Delete
  contactInfoFavRow?.addEventListener('click', () => {
    const roomId = activeContactInfoRoomId || shellState.selectedRoomId;
    if (!roomId) return;
    shellState.toggleFavouriteChat(roomId);
    const isFav = shellState.isFavourite(roomId);
    if (contactInfoFavLabel) {
      contactInfoFavLabel.textContent = isFav ? 'Remove from favourites' : 'Add to favourites';
    }
    renderConversationList();
    renderArchivedList();
    updateChatFilterCounts();
  });

  contactInfoListsRow?.addEventListener('click', () => {
    const roomId = activeContactInfoRoomId || shellState.selectedRoomId;
    if (roomId) openChangeChatListsModal(roomId);
  });

  contactInfoClearChatRow?.addEventListener('click', () => {
    const roomId = activeContactInfoRoomId || shellState.selectedRoomId;
    if (roomId) requestClearChat(roomId);
  });

  contactInfoExitGroupRow?.addEventListener('click', () => {
    const roomId = activeContactInfoRoomId || shellState.selectedRoomId;
    if (roomId) requestExitGroup(roomId);
  });

  contactInfoDeleteChatRow?.addEventListener('click', () => {
    const roomId = activeContactInfoRoomId || shellState.selectedRoomId;
    if (roomId) requestDeleteChat(roomId);
  });

  contactInfoMuteRow?.addEventListener('click', () => {
    const roomId = activeContactInfoRoomId || shellState.selectedRoomId;
    if (!roomId) return;
    const conv = shellState.conversations?.find((c) => c.roomId === roomId);
    if (shellState.isConversationMuted(conv)) {
      handleUnmuteConversation(roomId);
    } else {
      openMuteDurationModal(roomId);
    }
  });

  contactInfoBlockRow?.addEventListener('click', (e) => {
    e?.stopPropagation?.();
    const roomId = activeContactInfoRoomId || shellState.selectedRoomId;
    if (!roomId) return;
    const conv = (shellState.getSelectedConversation && shellState.getSelectedConversation()) ||
      shellState.conversations?.find((c) => c && (c.roomId === roomId || c.room_id === roomId || c.id === roomId));
    const peerUserId = getDirectPeerUserId(conv, shellState.currentUser?.userId) ||
      conv?.peerUserId || conv?.peer_user_id || conv?.peer?.userId || conv?.peer?.user_id || conv?.peer?.id;
    if (!peerUserId) return;
    if (shellState.isUserBlocked(peerUserId)) {
      handleUnblockContact(peerUserId);
    } else {
      const displayName = conv ? getConversationTitle(conv) : peerUserId;
      openBlockContactModal(peerUserId, displayName);
    }
  });

  btnUnblockComposer?.addEventListener('click', (e) => {
    e?.stopPropagation?.();
    const roomId = shellState.selectedRoomId;
    if (!roomId) return;
    const conv = (shellState.getSelectedConversation && shellState.getSelectedConversation()) ||
      shellState.conversations?.find((c) => c && (c.roomId === roomId || c.room_id === roomId || c.id === roomId));
    const peerUserId = getDirectPeerUserId(conv, shellState.currentUser?.userId) ||
      conv?.peerUserId || conv?.peer_user_id || conv?.peer?.userId || conv?.peer?.user_id || conv?.peer?.id;
    if (peerUserId) {
      handleUnblockContact(peerUserId);
    }
  });

  settingItemBlockedContacts?.addEventListener('click', () => {
    openBlockedContactsModal();
  });

  btnCloseMuteDuration?.addEventListener('click', closeMuteDurationModal);
  btnCancelMuteDuration?.addEventListener('click', closeMuteDurationModal);
  btnConfirmMuteDuration?.addEventListener('click', confirmMuteConversation);
  muteDurationModal?.addEventListener('click', (e) => {
    if (e.target === muteDurationModal) {
      closeMuteDurationModal();
    }
  });

  btnCloseBlockConfirm?.addEventListener('click', closeBlockContactModal);
  btnCancelBlockConfirm?.addEventListener('click', closeBlockContactModal);
  btnConfirmBlock?.addEventListener('click', confirmBlockContact);
  blockContactConfirmModal?.addEventListener('click', (e) => {
    if (e.target === blockContactConfirmModal) {
      closeBlockContactModal();
    }
  });

  btnCloseBlockedContacts?.addEventListener('click', closeBlockedContactsModal);
  btnDoneBlockedContacts?.addEventListener('click', closeBlockedContactsModal);
  blockedContactsModal?.addEventListener('click', (e) => {
    if (e.target === blockedContactsModal) {
      closeBlockedContactsModal();
    }
  });

  // Participant Action Menu Item Listeners
  partMenuViewContact?.addEventListener('click', () => {
    const participant = activeMenuParticipant;
    closeParticipantActionMenu();
    if (!participant) return;
    const mId = participant.userId || participant.user_id || participant.principalId || participant.principal_id;
    const directConv = shellState.conversations?.find((c) => c.kind === 'direct' && c.peer?.userId === mId);
    if (directConv) {
      selectConversation(directConv.roomId);
    }
  });

  partMenuMakeAdmin?.addEventListener('click', () => {
    const participant = activeMenuParticipant;
    const roomId = activeMenuRoomId;
    closeParticipantActionMenu();
    if (!participant || !roomId) return;
    const mId = participant.userId || participant.user_id || participant.principalId || participant.principal_id;
    const resolved = resolveMemberInfo(mId);
    const pName = participant.displayName || resolved.displayName || 'this member';
    openConfirmModal(
      'Promote to Owner',
      `Promote ${pName} to group owner?`,
      async () => {
        closeConfirmModal();
        try {
          await window.ollacoreDesktop.chatApi.setMemberRole(roomId, mId, 'owner');
          const curUid = shellState.currentUser?.userId || shellState.userProfile?.userId;
          createAndRecordGroupSystemMessage(roomId, {
            action: 'promote',
            actorId: curUid,
            targetUserId: mId,
            targetName: pName,
            role: 'owner'
          });
          if (false) await window.ollacoreDesktop.chatApi.setMemberRole(roomId, mId, 'admin');
          await refreshContactInfoParticipants(roomId);
          showToast(`${pName} is now a group owner`);
        } catch (err) {
          alert(formatBackendGroupError('Promote to Owner', err));
        }
      },
      'Promote'
    );
  });

  partMenuDismissAdmin?.addEventListener('click', () => {
    const participant = activeMenuParticipant;
    const roomId = activeMenuRoomId;
    closeParticipantActionMenu();
    if (!participant || !roomId) return;
    const mId = participant.userId || participant.user_id || participant.principalId || participant.principal_id;
    const resolved = resolveMemberInfo(mId);
    const pName = participant.displayName || resolved.displayName || 'this member';
    openConfirmModal(
      'Demote to Member',
      `Demote ${pName} to regular member?`,
      async () => {
        closeConfirmModal();
        try {
          await window.ollacoreDesktop.chatApi.setMemberRole(roomId, mId, 'member');
          await refreshContactInfoParticipants(roomId);
          showToast(`${pName} is now a regular member`);
        } catch (err) {
          alert(formatBackendGroupError('Demote to Member', err));
        }
      },
      'Demote'
    );
  });

  partMenuRemove?.addEventListener('click', () => {
    const participant = activeMenuParticipant;
    const roomId = activeMenuRoomId;
    closeParticipantActionMenu();
    if (!participant || !roomId) return;
    const mId = participant.userId || participant.user_id || participant.principalId || participant.principal_id;
    const resolved = resolveMemberInfo(mId);
    const pName = participant.displayName || resolved.displayName || 'this member';
    openConfirmModal(
      'Remove from group',
      `Remove ${pName} from this group?`,
      async () => {
        closeConfirmModal();
        try {
          await window.ollacoreDesktop.chatApi.removeMember(roomId, mId);
          const curUid = shellState.currentUser?.userId || shellState.userProfile?.userId;
          createAndRecordGroupSystemMessage(roomId, {
            action: 'remove',
            actorId: curUid,
            targetUserId: mId,
            targetName: pName
          });
          await refreshContactInfoParticipants(roomId);
          showToast(`${pName} removed from group`);
        } catch (err) {
          alert(formatBackendGroupError('Remove member', err));
        }
      },
      'Remove'
    );
  });

  // Group Add People Modal Listeners
  async function handleLookupAddPeoplePhone() {
    const phone = groupAddPeopleInput?.value.trim();
    if (!phone) return;
    groupAddPeopleError?.classList.add('hidden');
    setButtonLoading(btnLookupGroupAddPeople, true);
    try {
      const res = await window.ollacoreDesktop.chatApi.lookupContacts([phone]);
      const contacts = Array.isArray(res?.contacts) ? res.contacts : [];
      const matched = contacts.find((c) => c.isRegistered && c.userId);
      if (!matched) {
        if (groupAddPeopleError) {
          groupAddPeopleError.textContent = 'No registered OllaChat user found with this phone number';
          groupAddPeopleError.classList.remove('hidden');
        }
        groupAddPeopleMatched?.classList.add('hidden');
        selectedAddContactUserId = null;
        updateAddPeopleConfirmButton();
        return;
      }

      const currentUserId = shellState.currentUser?.userId || shellState.userProfile?.userId;
      if (isParticipantSelf({ principalId: matched.userId }, currentUserId)) {
        if (groupAddPeopleError) {
          groupAddPeopleError.textContent = 'You are already a member of this group';
          groupAddPeopleError.classList.remove('hidden');
        }
        groupAddPeopleMatched?.classList.add('hidden');
        selectedAddContactUserId = null;
        updateAddPeopleConfirmButton();
        return;
      }

      if (activeGroupParticipants.some((p) => isParticipantSelf(p, matched.userId))) {
        if (groupAddPeopleError) {
          groupAddPeopleError.textContent = 'This user is already a member of the group';
          groupAddPeopleError.classList.remove('hidden');
        }
        groupAddPeopleMatched?.classList.add('hidden');
        selectedAddContactUserId = null;
        updateAddPeopleConfirmButton();
        return;
      }

      selectedAddContactUserId = matched.userId;
      selectedAddContactUserIds.add(matched.userId);
      if (groupAddPeopleName) groupAddPeopleName.textContent = matched.displayName || matched.phone || 'User';
      if (groupAddPeoplePhone) groupAddPeoplePhone.textContent = matched.phone || '';
      if (groupAddPeopleAvatar) {
        const title = matched.displayName || matched.phone || 'User';
        groupAddPeopleAvatar.textContent = getAvatarInitials(title);
        groupAddPeopleAvatar.style.backgroundColor = getAvatarColor(title);
      }
      groupAddPeopleMatched?.classList.remove('hidden');
      groupAddPeopleMatched?.classList.add('selected');
      if (btnSelectMatchedContact) btnSelectMatchedContact.textContent = 'Selected';
      updateAddPeopleConfirmButton();
    } catch (err) {
      if (groupAddPeopleError) {
        groupAddPeopleError.textContent = err.message || 'Lookup failed';
        groupAddPeopleError.classList.remove('hidden');
      }
    } finally {
      setButtonLoading(btnLookupGroupAddPeople, false);
    }
  }

  btnSelectMatchedContact?.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!selectedAddContactUserId) return;
    if (selectedAddContactUserIds.has(selectedAddContactUserId)) {
      selectedAddContactUserIds.delete(selectedAddContactUserId);
      groupAddPeopleMatched?.classList.remove('selected');
      if (btnSelectMatchedContact) btnSelectMatchedContact.textContent = 'Select';
    } else {
      selectedAddContactUserIds.add(selectedAddContactUserId);
      groupAddPeopleMatched?.classList.add('selected');
      if (btnSelectMatchedContact) btnSelectMatchedContact.textContent = 'Selected';
    }
    selectedAddContactUserId = selectedAddContactUserIds.values().next().value || null;
    updateAddPeopleConfirmButton();
  });

  btnCloseGroupAddPeople?.addEventListener('click', closeGroupAddPeopleModal);
  btnCancelGroupAddPeople?.addEventListener('click', closeGroupAddPeopleModal);
  btnLookupGroupAddPeople?.addEventListener('click', handleLookupAddPeoplePhone);
  groupAddPeopleInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleLookupAddPeoplePhone();
    }
  });

  btnConfirmGroupAddPeople?.addEventListener('click', async () => {
    const roomId = activeContactInfoRoomId || shellState.selectedRoomId;
    const userIds = Array.from(selectedAddContactUserIds);
    if (!roomId || userIds.length === 0) return;
    setButtonLoading(btnConfirmGroupAddPeople, true);
    try {
      if (userIds.length > 1 && typeof window.ollacoreDesktop.chatApi.addMembers === 'function') {
        await window.ollacoreDesktop.chatApi.addMembers(roomId, userIds);
      } else {
        selectedAddContactUserId = userIds[0] || selectedAddContactUserId;
        await window.ollacoreDesktop.chatApi.addMember(roomId, selectedAddContactUserId);
      }
      const curUid = shellState.currentUser?.userId || shellState.userProfile?.userId;
      createAndRecordGroupSystemMessage(roomId, {
        action: 'add',
        actorId: curUid,
        targetUserIds: userIds.length > 1 ? userIds : undefined,
        targetUserId: userIds.length === 1 ? userIds[0] : undefined
      });
      closeGroupAddPeopleModal();
      await refreshContactInfoParticipants(roomId);
      showToast(userIds.length > 1 ? `${userIds.length} members added` : 'Member added to group');
    } catch (err) {
      if (groupAddPeopleError) {
        groupAddPeopleError.textContent = formatBackendGroupError('Add member', err);
        groupAddPeopleError.classList.remove('hidden');
      }
    } finally {
      setButtonLoading(btnConfirmGroupAddPeople, false);
    }
  });


  btnCloseGroupInfo?.addEventListener('click', closeGroupInfo);
  btnCloseGroupInfoFooter?.addEventListener('click', closeGroupInfo);

  groupInfoModal?.addEventListener('click', (e) => {
    if (e.target === groupInfoModal) {
      closeGroupInfo();
    }
  });

  btnStartEditGroupName?.addEventListener('click', () => {
    if (groupInfoRenameForm) {
      groupInfoRenameForm.classList.remove('hidden');
      groupInfoName?.classList.add('hidden');
      groupRenameInput?.focus();
      groupRenameInput?.select();
    }
  });

  btnCancelGroupName?.addEventListener('click', () => {
    groupInfoRenameForm?.classList.add('hidden');
    groupInfoName?.classList.remove('hidden');
    showGroupError(null);
  });

  btnSaveGroupName?.addEventListener('click', handleRenameGroup);

  groupRenameInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleRenameGroup();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      groupInfoRenameForm?.classList.add('hidden');
      groupInfoName?.classList.remove('hidden');
      showGroupError(null);
    }
  });

  btnSubmitAddMember?.addEventListener('click', handleAddGroupMemberToExisting);
  groupAddMemberPhone?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleAddGroupMemberToExisting();
    }
  });

  // Group Confirm modal listeners
  btnCloseConfirm?.addEventListener('click', closeConfirmModal);
  btnConfirmCancel?.addEventListener('click', closeConfirmModal);
  groupConfirmModal?.addEventListener('click', (e) => {
    if (e.target === groupConfirmModal) {
      closeConfirmModal();
    }
  });
  btnConfirmProceed?.addEventListener('click', () => {
    if (typeof pendingConfirmAction === 'function') {
      pendingConfirmAction();
    }
  });

  // Leave Group Confirm modal listeners
  btnCloseLeaveGroup?.addEventListener('click', closeLeaveGroupConfirmModal);
  btnLeaveGroupCancel?.addEventListener('click', closeLeaveGroupConfirmModal);
  leaveGroupConfirmModal?.addEventListener('click', (e) => {
    if (e.target === leaveGroupConfirmModal) {
      closeLeaveGroupConfirmModal();
    }
  });
  btnLeaveGroupConfirm?.addEventListener('click', () => {
    handleConfirmLeaveGroup(pendingLeaveGroupRoomId, { deleteChat: false });
  });
  btnLeaveGroupDelete?.addEventListener('click', () => {
    handleConfirmDeleteGroupChat(pendingLeaveGroupRoomId);
  });

  // Clear Chat modal listeners
  btnCloseClearChat?.addEventListener('click', closeClearChatModal);
  btnClearChatCancel?.addEventListener('click', closeClearChatModal);
  clearChatModal?.addEventListener('click', (e) => {
    if (e.target === clearChatModal) {
      closeClearChatModal();
    }
  });
  btnClearChatProceed?.addEventListener('click', () => {
    handleClearChatProceed();
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Local Message Pinning — event listeners
  // ─────────────────────────────────────────────────────────────────────────────

  // Pinned bar: content click scrolls to current pin
  chatPinnedBarContent?.addEventListener('click', () => {
    const roomId = shellState.selectedRoomId;
    if (!roomId) return;
    const pins = shellState.getPinnedMessages(roomId);
    if (!pins || pins.length === 0) return;
    const pin = pins[currentPinnedBarIndex];
    if (pin?.messageId) {
      _scrollToAndHighlightMessage(pin.messageId);
    }
  });
  chatPinnedBarContent?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); chatPinnedBarContent.click(); }
  });

  // Pinned bar: previous / next navigation
  btnPinnedPrev?.addEventListener('click', () => {
    const roomId = shellState.selectedRoomId;
    if (!roomId) return;
    const pins = shellState.getPinnedMessages(roomId);
    if (!pins || pins.length <= 1) return;
    currentPinnedBarIndex = (currentPinnedBarIndex - 1 + pins.length) % pins.length;
    renderPinnedBar(roomId);
  });
  btnPinnedNext?.addEventListener('click', () => {
    const roomId = shellState.selectedRoomId;
    if (!roomId) return;
    const pins = shellState.getPinnedMessages(roomId);
    if (!pins || pins.length <= 1) return;
    currentPinnedBarIndex = (currentPinnedBarIndex + 1) % pins.length;
    renderPinnedBar(roomId);
  });

  // Pinned bar: unpin button
  btnPinnedUnpin?.addEventListener('click', () => {
    const roomId = shellState.selectedRoomId;
    if (!roomId) return;
    const pins = shellState.getPinnedMessages(roomId);
    if (!pins || pins.length === 0) return;
    const pin = pins[currentPinnedBarIndex];
    if (pin?.messageId) {
      shellState.unpinMessage(roomId, pin.messageId);
      currentPinnedBarIndex = 0;
      renderMessages();
      renderPinnedBar(roomId);
    }
  });

  // Pin duration modal buttons
  btnClosePinDuration?.addEventListener('click', closePinDurationModal);
  btnCancelPinDuration?.addEventListener('click', closePinDurationModal);
  pinDurationModal?.addEventListener('click', (e) => {
    if (e.target === pinDurationModal) closePinDurationModal();
  });
  btnConfirmPinDuration?.addEventListener('click', () => {
    confirmPinMessage();
  });

  // Pin limit modal buttons
  btnClosePinLimit?.addEventListener('click', closePinLimitModal);
  btnCancelPinLimit?.addEventListener('click', closePinLimitModal);
  pinLimitModal?.addEventListener('click', (e) => {
    if (e.target === pinLimitModal) closePinLimitModal();
  });

  // Forward modal buttons & events
  btnCloseForwardModal?.addEventListener('click', closeForwardModal);
  btnCancelForward?.addEventListener('click', closeForwardModal);
  btnConfirmForward?.addEventListener('click', executeForwarding);
  forwardChatSearch?.addEventListener('input', (e) => {
    renderForwardChatList(e.target.value);
  });
  forwardModal?.addEventListener('click', (e) => {
    if (e.target === forwardModal) closeForwardModal();
  });

  // Message selection bar buttons
  btnCancelSelection?.addEventListener('click', exitMessageSelectionMode);
  btnDeleteSelected?.addEventListener('click', () => {
    const selectedIds = shellState.getSelectedMessageIds();
    if (!selectedIds || selectedIds.length === 0) return;
    const currentUserId = roomMessagesState.currentUserId || shellState.currentUser?.userId;
    const canAllDeleteEveryone = selectedIds.every((id) => {
      const msg = roomMessagesState.messages.find((m) =>
        (m.id && String(m.id) === String(id)) ||
        (m.clientMessageId && String(m.clientMessageId) === String(id)) ||
        (m.client_message_id && String(m.client_message_id) === String(id))
      );
      return msg ? canDeleteMessageForEveryone(msg, currentUserId) : false;
    });

    if (canAllDeleteEveryone) {
      openConfirmModal({
        title: 'Delete messages?',
        message: 'Do you want to delete these messages for everyone or for yourself only?',
        confirmText: 'Delete for everyone',
        cancelText: 'Delete for me',
        onConfirm: () => {
          handleDeleteSelectedMessages({ forEveryone: true });
        },
        onCancel: () => {
          handleDeleteSelectedMessages({ forEveryone: false });
        }
      });
    } else {
      openConfirmModal({
        title: 'Delete messages?',
        message: 'Delete selected messages for yourself?',
        confirmText: 'Delete for me',
        onConfirm: () => {
          handleDeleteSelectedMessages({ forEveryone: false });
        }
      });
    }
  });
  btnForwardSelected?.addEventListener('click', () => {
    const selectedIds = shellState.getSelectedMessageIds();
    const msgs = roomMessagesState.messages.filter((m) => {
      return (m.id && selectedIds.includes(String(m.id))) ||
        (m.clientMessageId && selectedIds.includes(String(m.clientMessageId))) ||
        (m.client_message_id && selectedIds.includes(String(m.client_message_id)));
    });
    if (msgs.length > 0) {
      openForwardModal(msgs);
    }
  });

  // Pinned messages panel: close button
  btnClosePinnedMessages?.addEventListener('click', () => {
    closePinnedMessagesPanel();
    if (activeContactInfoRoomId) {
      contactInfoPanel?.classList.remove('hidden');
    }
  });

  // Contact info pinned row: open panel
  contactInfoPinnedRow?.addEventListener('click', () => {
    if (activeContactInfoRoomId) {
      contactInfoPanel?.classList.add('hidden');
      openPinnedMessagesPanel(activeContactInfoRoomId);
    }
  });
  contactInfoPinnedRow?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); contactInfoPinnedRow.click(); }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  let currentEditingTheme = {
    preset: 'default',
    bubbleStyle: 'default',
    wallpaper: { type: 'none', value: null, localPath: null, safeUrl: null }
  };
  let currentEditingThemeRoomId = null;
  let themeGalleriesRendered = false;

  function renderThemeGalleries() {
    if (themeGalleriesRendered) return;

    // 1. Presets gallery
    if (themePresetsScroll) {
      themePresetsScroll.innerHTML = '';
      PRESET_THEMES.forEach(preset => {
        const card = document.createElement('div');
        card.className = 'theme-preset-card';
        card.setAttribute('data-preset-id', preset.id);
        card.setAttribute('role', 'radio');
        card.setAttribute('aria-label', preset.name);
        card.title = preset.name;

        const check = document.createElement('div');
        check.className = 'theme-preset-checkmark';
        check.textContent = '✓';
        card.appendChild(check);

        const swatch = document.createElement('div');
        swatch.className = 'theme-preset-swatch';
        const split = document.createElement('div');
        split.className = 'theme-preset-swatch-split';
        split.style.setProperty('--swatch-outgoing', preset.outgoingBg.includes('gradient') ? '#005c4b' : preset.outgoingBg);
        split.style.setProperty('--swatch-incoming', preset.incomingBg);
        swatch.appendChild(split);
        card.appendChild(swatch);

        const label = document.createElement('span');
        label.className = 'theme-preset-name';
        label.textContent = preset.name;
        card.appendChild(label);

        card.addEventListener('click', () => {
          currentEditingTheme.custom = true;
          currentEditingTheme.preset = preset.id;
          updateThemePreview();
        });

        themePresetsScroll.appendChild(card);
      });
    }

    // 2. Bubble styles gallery
    if (bubbleStylesGallery) {
      bubbleStylesGallery.innerHTML = '';
      BUBBLE_STYLES.forEach(style => {
        const card = document.createElement('div');
        card.className = 'bubble-style-card';
        card.setAttribute('data-bubble-id', style.id);
        card.setAttribute('role', 'radio');
        card.setAttribute('aria-label', style.name);

        const check = document.createElement('div');
        check.className = 'theme-preset-checkmark';
        check.textContent = '✓';
        card.appendChild(check);

        const preview = document.createElement('div');
        preview.className = 'bubble-style-preview';
        preview.style.borderRadius = style.radius;
        card.appendChild(preview);

        const name = document.createElement('span');
        name.className = 'bubble-style-name';
        name.textContent = style.name;
        card.appendChild(name);

        card.addEventListener('click', () => {
          currentEditingTheme.custom = true;
          currentEditingTheme.bubbleStyle = style.id;
          updateThemePreview();
        });

        bubbleStylesGallery.appendChild(card);
      });
    }

    // 3. Wallpaper grid
    if (wallpaperGrid) {
      wallpaperGrid.innerHTML = '';
      PRESET_WALLPAPERS.forEach(wp => {
        const card = document.createElement('div');
        card.className = 'wallpaper-card';
        card.setAttribute('data-wallpaper-id', wp.id);
        card.setAttribute('role', 'radio');
        card.setAttribute('aria-label', wp.name);

        if (wp.bg && wp.bg.includes('gradient')) {
          card.style.background = wp.bg;
        } else {
          card.style.backgroundColor = wp.bg || '#f0f2f5';
        }
        if (wp.image && wp.image !== 'none') {
          card.style.backgroundImage = wp.image;
          card.style.backgroundSize = wp.size || '24px 24px';
          card.style.backgroundRepeat = 'repeat';
        }

        const check = document.createElement('div');
        check.className = 'theme-preset-checkmark';
        check.textContent = '✓';
        card.appendChild(check);

        const name = document.createElement('span');
        name.className = 'wallpaper-card-name';
        name.textContent = wp.name;
        card.appendChild(name);

        card.addEventListener('click', () => {
          currentEditingTheme.custom = true;
          if (wp.id === 'none') {
            currentEditingTheme.wallpaper = { type: 'none', value: null, localPath: null };
          } else {
            currentEditingTheme.wallpaper = { type: 'preset', value: wp.id, localPath: null };
          }
          updateThemePreview();
        });

        wallpaperGrid.appendChild(card);
      });
    }

    themeGalleriesRendered = true;
  }

  function updateThemePreview() {
    const isCustom = currentEditingTheme.custom === true;
    const resolved = getResolvedAppTheme();
    const effectivePresetId = isCustom
      ? currentEditingTheme.preset
      : (resolved === 'dark' ? 'dark-default' : 'default');

    const theme = getPresetTheme(effectivePresetId);
    const bubble = getBubbleStyle(isCustom ? currentEditingTheme.bubbleStyle : 'default');
    const wallpaper = isCustom
      ? (currentEditingTheme.wallpaper || { type: 'none', value: null, localPath: null })
      : { type: 'none', value: null, localPath: null };

    if (themePreviewStatusName) {
      if (!isCustom) {
        themePreviewStatusName.textContent = `App Theme (${resolved === 'dark' ? 'Dark' : 'Light'})`;
      } else {
        themePreviewStatusName.textContent = theme.name;
      }
    }

    // Chat Header in preview
    if (themePreviewChatTitle) {
      const list = Array.isArray(shellState.conversations)
        ? shellState.conversations
        : (Array.isArray(shellState.inbox) ? shellState.inbox : []);
      const conv = currentEditingThemeRoomId ? list.find(i => i && (i.id === currentEditingThemeRoomId || i.roomId === currentEditingThemeRoomId)) : null;
      const title = conv ? getConversationTitle(conv) : 'Malavika';
      themePreviewChatTitle.textContent = title;
      if (themePreviewAvatar) {
        themePreviewAvatar.textContent = (title || 'M').trim().charAt(0).toUpperCase();
      }
    }

    // Set scoped CSS variables on themePreviewScreen to reuse existing theme system
    if (themePreviewScreen) {
      themePreviewScreen.style.setProperty('--chat-incoming-bg', theme.incomingBg);
      themePreviewScreen.style.setProperty('--chat-incoming-text', theme.incomingText);
      themePreviewScreen.style.setProperty('--chat-outgoing-bg', theme.outgoingBg);
      themePreviewScreen.style.setProperty('--chat-outgoing-text', theme.outgoingText);
      themePreviewScreen.style.setProperty('--chat-secondary-text', theme.secondaryText);
      themePreviewScreen.style.setProperty('--chat-incoming-border', theme.bubbleBorder);
      themePreviewScreen.style.setProperty('--chat-bubble-radius', bubble.radius);
      themePreviewScreen.style.setProperty('--chat-bubble-padding', bubble.padding);
      themePreviewScreen.style.setProperty('--chat-bubble-font-size', bubble.fontSize);
    }

    // Incoming bubble preview
    if (themePreviewIncoming) {
      themePreviewIncoming.style.backgroundColor = theme.incomingBg;
      themePreviewIncoming.style.color = theme.incomingText;
      themePreviewIncoming.style.border = theme.bubbleBorder;
      themePreviewIncoming.style.borderRadius = bubble.radius;
      themePreviewIncoming.style.padding = bubble.padding;
      themePreviewIncoming.style.fontSize = bubble.fontSize;
      const incomingTime = themePreviewIncoming.querySelector('.theme-preview-time');
      if (incomingTime) {
        incomingTime.style.color = theme.secondaryText;
      }
    }

    // Outgoing bubble preview
    if (themePreviewOutgoing) {
      if (theme.outgoingBg.includes('gradient')) {
        themePreviewOutgoing.style.background = theme.outgoingBg;
      } else {
        themePreviewOutgoing.style.removeProperty('background');
        themePreviewOutgoing.style.backgroundColor = theme.outgoingBg;
      }
      themePreviewOutgoing.style.color = theme.outgoingText;
      themePreviewOutgoing.style.border = 'none';
      themePreviewOutgoing.style.borderRadius = bubble.radius;
      themePreviewOutgoing.style.padding = bubble.padding;
      themePreviewOutgoing.style.fontSize = bubble.fontSize;
      const outgoingTime = themePreviewOutgoing.querySelector('.theme-preview-time');
      if (outgoingTime) {
        outgoingTime.style.color = 'rgba(233, 237, 239, 0.8)';
      }
    }

    // Media bubble preview (outgoing media message)
    if (themePreviewMedia) {
      if (theme.outgoingBg.includes('gradient')) {
        themePreviewMedia.style.background = theme.outgoingBg;
      } else {
        themePreviewMedia.style.removeProperty('background');
        themePreviewMedia.style.backgroundColor = theme.outgoingBg;
      }
      themePreviewMedia.style.color = theme.outgoingText;
      themePreviewMedia.style.border = 'none';
      themePreviewMedia.style.borderRadius = bubble.radius;
      themePreviewMedia.style.padding = bubble.padding;
      themePreviewMedia.style.fontSize = bubble.fontSize;
      const mediaThumb = themePreviewMedia.querySelector('.theme-preview-media-thumb');
      if (mediaThumb) {
        mediaThumb.style.borderRadius = `calc(${bubble.radius} - 2px)`;
      }
      const mediaTime = themePreviewMedia.querySelector('.theme-preview-time');
      if (mediaTime) {
        mediaTime.style.color = 'rgba(233, 237, 239, 0.8)';
      }
    }

    // Screen wallpaper preview
    if (themePreviewScreen) {
      themePreviewScreen.style.removeProperty('background-image');
      themePreviewScreen.style.removeProperty('background-size');
      themePreviewScreen.style.removeProperty('background-position');
      themePreviewScreen.style.removeProperty('background-repeat');

      if (wallpaper.type === 'custom' && (wallpaper.safeUrl || wallpaper.previewDataUrl)) {
        const url = wallpaper.safeUrl || wallpaper.previewDataUrl;
        themePreviewScreen.style.backgroundColor = '#000000';
        themePreviewScreen.style.backgroundImage = `url("${url}")`;
        themePreviewScreen.style.backgroundSize = 'cover';
        themePreviewScreen.style.backgroundPosition = 'center';
        themePreviewScreen.style.backgroundRepeat = 'no-repeat';
      } else if (wallpaper.type === 'preset' && wallpaper.value) {
        const wp = getPresetWallpaper(wallpaper.value);
        if (wp.bg && wp.bg.includes('gradient')) {
          themePreviewScreen.style.background = wp.bg;
        } else {
          themePreviewScreen.style.backgroundColor = wp.bg || '#f0f2f5';
        }
        if (wp.image && wp.image !== 'none') {
          themePreviewScreen.style.backgroundImage = wp.image;
          themePreviewScreen.style.backgroundSize = wp.size || '24px 24px';
          themePreviewScreen.style.backgroundRepeat = 'repeat';
        }
      } else {
        themePreviewScreen.style.backgroundColor = theme.chatBg;
        if (theme.chatBgImage && theme.chatBgImage !== 'none') {
          themePreviewScreen.style.backgroundImage = theme.chatBgImage;
          themePreviewScreen.style.backgroundSize = theme.chatBgSize || '24px 24px';
          themePreviewScreen.style.backgroundRepeat = 'repeat';
        }
      }
    }

    // Update selected checkmarks across cards
    document.querySelectorAll('.theme-preset-card').forEach(card => {
      if (isCustom && card.getAttribute('data-preset-id') === currentEditingTheme.preset) {
        card.classList.add('selected');
      } else {
        card.classList.remove('selected');
      }
    });

    document.querySelectorAll('.bubble-style-card').forEach(card => {
      const activeBubble = isCustom ? currentEditingTheme.bubbleStyle : 'default';
      if (card.getAttribute('data-bubble-id') === activeBubble) {
        card.classList.add('selected');
      } else {
        card.classList.remove('selected');
      }
    });

    document.querySelectorAll('.wallpaper-card').forEach(card => {
      const wpId = card.getAttribute('data-wallpaper-id');
      const isSelected = isCustom
        ? ((wallpaper.type === 'preset' && wallpaper.value === wpId) || (wallpaper.type === 'none' && wpId === 'none'))
        : (wpId === 'none');
      if (isSelected) {
        card.classList.add('selected');
      } else {
        card.classList.remove('selected');
      }
    });

    // Custom wallpaper preview box
    if (isCustom && wallpaper.type === 'custom' && (wallpaper.safeUrl || wallpaper.previewDataUrl || wallpaper.localPath)) {
      const url = wallpaper.safeUrl || wallpaper.previewDataUrl;
      if (url && customWallpaperThumb) {
        customWallpaperThumb.src = url;
        customWallpaperThumb.classList.remove('hidden');
      }
      if (customWallpaperStatus) {
        customWallpaperStatus.textContent = wallpaper.value || 'Custom image applied';
      }
      btnRemoveCustomWallpaper?.classList.remove('hidden');
    } else {
      customWallpaperThumb?.classList.add('hidden');
      if (customWallpaperStatus) {
        customWallpaperStatus.textContent = 'No custom wallpaper chosen';
      }
      btnRemoveCustomWallpaper?.classList.add('hidden');
    }
  }

  let themeOpenedFromSettings = false;

  async function openThemeModal(targetRoomId = null) {
    try {
      currentEditingThemeRoomId = targetRoomId || shellState.selectedRoomId || null;

      if (chatThemeSubtitle) {
        if (currentEditingThemeRoomId) {
          const list = Array.isArray(shellState.conversations)
            ? shellState.conversations
            : (Array.isArray(shellState.inbox) ? shellState.inbox : []);
          const conv = list.find(i => i && (i.id === currentEditingThemeRoomId || i.roomId === currentEditingThemeRoomId));
          const title = conv ? getConversationTitle(conv) : 'This Chat';
          chatThemeSubtitle.textContent = `Theme for "${title}"`;
        } else {
          chatThemeSubtitle.textContent = 'Global default chat theme';
        }
      }

      try {
        if (currentEditingThemeRoomId && window.ollacoreDesktop?.theme?.getRoomTheme) {
          const res = await window.ollacoreDesktop.theme.getRoomTheme(currentEditingThemeRoomId);
          if (res?.ok && res.theme && res.theme.custom === true) {
            currentEditingTheme = JSON.parse(JSON.stringify(res.theme));
            currentEditingTheme.custom = true;
            if (currentEditingTheme.wallpaper?.type === 'custom' && currentEditingTheme.wallpaper.localPath) {
              const loadRes = await window.ollacoreDesktop.theme.loadWallpaperData(currentEditingTheme.wallpaper.localPath);
              if (loadRes?.ok && loadRes.dataUrl) {
                currentEditingTheme.wallpaper.safeUrl = loadRes.dataUrl;
              }
            }
          } else {
            const resolved = getResolvedAppTheme();
            currentEditingTheme = {
              custom: false,
              preset: resolved === 'dark' ? 'dark-default' : 'default',
              bubbleStyle: 'default',
              wallpaper: { type: 'none', value: null, localPath: null }
            };
          }
        } else {
          const resolved = getResolvedAppTheme();
          currentEditingTheme = {
            custom: false,
            preset: resolved === 'dark' ? 'dark-default' : 'default',
            bubbleStyle: 'default',
            wallpaper: { type: 'none', value: null, localPath: null }
          };
        }
      } catch (themeFetchErr) {
        console.error('[Theme] Failed to fetch theme from store:', themeFetchErr);
        const resolved = getResolvedAppTheme();
        currentEditingTheme = {
          custom: false,
          preset: resolved === 'dark' ? 'dark-default' : 'default',
          bubbleStyle: 'default',
          wallpaper: { type: 'none', value: null, localPath: null }
        };
      }

      renderThemeGalleries();
      updateThemePreview();
      chatThemeModal?.classList.remove('hidden');
    } catch (openErr) {
      console.error('[Theme] Error opening theme modal:', openErr);
      chatThemeModal?.classList.remove('hidden');
    }
  }

  function closeThemeModal() {
    chatThemeModal?.classList.add('hidden');
    if (themeOpenedFromSettings) {
      themeOpenedFromSettings = false;
      openSettings();
    }
  }

  // Hook Theme Modal event listeners
  btnChatTheme?.addEventListener('click', () => {
    themeOpenedFromSettings = false;
    openThemeModal(shellState.selectedRoomId);
  });

  settingItemChatTheme?.addEventListener('click', () => {
    themeOpenedFromSettings = true;
    closeSettings();
    openThemeModal(shellState.selectedRoomId);
  });

  btnCloseTheme?.addEventListener('click', closeThemeModal);
  btnCancelTheme?.addEventListener('click', closeThemeModal);
  chatThemeModal?.addEventListener('click', (e) => {
    if (e.target === chatThemeModal) {
      closeThemeModal();
    }
  });

  btnUploadCustomWallpaper?.addEventListener('click', async () => {
    if (!window.ollacoreDesktop?.theme?.pickWallpaper) return;
    try {
      const res = await window.ollacoreDesktop.theme.pickWallpaper();
      if (res?.ok && !res.canceled && res.localPath) {
        currentEditingTheme.custom = true;
        currentEditingTheme.wallpaper = {
          type: 'custom',
          value: res.safeFilename,
          localPath: res.localPath,
          safeUrl: res.previewDataUrl,
          previewDataUrl: res.previewDataUrl
        };
        updateThemePreview();
      }
    } catch (err) {
      console.error('[Theme] Failed to pick custom wallpaper:', err);
    }
  });

  btnRemoveCustomWallpaper?.addEventListener('click', () => {
    currentEditingTheme.custom = true;
    currentEditingTheme.wallpaper = { type: 'none', value: null, localPath: null };
    updateThemePreview();
  });

  btnResetTheme?.addEventListener('click', () => {
    const resolved = getResolvedAppTheme();
    currentEditingTheme = {
      custom: false,
      preset: resolved === 'dark' ? 'dark-default' : 'default',
      bubbleStyle: 'default',
      wallpaper: { type: 'none', value: null, localPath: null }
    };
    updateThemePreview();
  });

  btnSaveTheme?.addEventListener('click', async () => {
    if (currentEditingTheme.custom === false) {
      // User selected to use global app theme (reset custom room theme)
      if (currentEditingThemeRoomId && window.ollacoreDesktop?.theme) {
        try {
          if (typeof window.ollacoreDesktop.theme.resetRoomTheme === 'function') {
            await window.ollacoreDesktop.theme.resetRoomTheme(currentEditingThemeRoomId);
          } else if (typeof window.ollacoreDesktop.theme.setRoomTheme === 'function') {
            await window.ollacoreDesktop.theme.setRoomTheme(currentEditingThemeRoomId, { custom: false });
          }
        } catch (err) {
          console.error('[Theme] Failed to reset room theme:', err);
        }
      }

      if (!currentEditingThemeRoomId || currentEditingThemeRoomId === shellState.selectedRoomId) {
        await loadAndApplyThemeForRoom(shellState.selectedRoomId);
      }
    } else {
      const toSave = {
        custom: true,
        preset: currentEditingTheme.preset,
        bubbleStyle: currentEditingTheme.bubbleStyle,
        wallpaper: {
          type: currentEditingTheme.wallpaper?.type || 'none',
          value: currentEditingTheme.wallpaper?.value || null,
          localPath: currentEditingTheme.wallpaper?.localPath || null
        }
      };

      if (currentEditingThemeRoomId && window.ollacoreDesktop?.theme?.setRoomTheme) {
        try {
          await window.ollacoreDesktop.theme.setRoomTheme(currentEditingThemeRoomId, toSave);
        } catch (err) {
          console.error('[Theme] Failed to persist room theme:', err);
        }
      }

      if (!currentEditingThemeRoomId || currentEditingThemeRoomId === shellState.selectedRoomId) {
        applyRoomTheme(toSave);
      }
    }

    closeThemeModal();
  });

  // Appearance Theme Controls & Startup Integration
  function updateAppearanceButtons(activeSetting) {
    const setting = activeSetting || getAppThemeSetting();
    if (themeBtnLight) {
      themeBtnLight.classList.toggle('active', setting === 'light');
      themeBtnLight.setAttribute('aria-checked', String(setting === 'light'));
    }
    if (themeBtnDark) {
      themeBtnDark.classList.toggle('active', setting === 'dark');
      themeBtnDark.setAttribute('aria-checked', String(setting === 'dark'));
    }
    if (themeBtnSystem) {
      themeBtnSystem.classList.toggle('active', setting === 'system');
      themeBtnSystem.setAttribute('aria-checked', String(setting === 'system'));
    }
  }

  themeBtnLight?.addEventListener('click', async () => {
    applyAppTheme('light');
    updateAppearanceButtons('light');
    if (shellState.selectedRoomId) {
      await loadAndApplyThemeForRoom(shellState.selectedRoomId);
    }
  });

  themeBtnDark?.addEventListener('click', async () => {
    applyAppTheme('dark');
    updateAppearanceButtons('dark');
    if (shellState.selectedRoomId) {
      await loadAndApplyThemeForRoom(shellState.selectedRoomId);
    }
  });

  themeBtnSystem?.addEventListener('click', async () => {
    applyAppTheme('system');
    updateAppearanceButtons('system');
    if (shellState.selectedRoomId) {
      await loadAndApplyThemeForRoom(shellState.selectedRoomId);
    }
  });

  // Startup app theme initialization
  const initialSavedTheme = (typeof localStorage !== 'undefined' && localStorage.getItem('ollachat_app_theme')) || 'system';
  applyAppTheme(initialSavedTheme, { persist: false });
  updateAppearanceButtons(initialSavedTheme);

  if (window.ollacoreDesktop?.theme?.getAppTheme) {
    window.ollacoreDesktop.theme.getAppTheme().then((res) => {
      if (res?.ok && res.theme) {
        applyAppTheme(res.theme, { persist: false });
        updateAppearanceButtons(res.theme);
      }
    }).catch(() => { });
  }

  initSystemThemeListener(async () => {
    if (shellState.selectedRoomId) {
      await loadAndApplyThemeForRoom(shellState.selectedRoomId);
    }
  });

  // 11. Global keyboard shortcuts (Escape key closes modals)
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (contactInfoPanel && !contactInfoPanel.classList.contains('hidden')) {
        closeContactInfo();
      } else if (chatThemeModal && !chatThemeModal.classList.contains('hidden')) {
        closeThemeModal();
      } else if (groupConfirmModal && !groupConfirmModal.classList.contains('hidden')) {
        closeConfirmModal();
      } else if (leaveGroupConfirmModal && !leaveGroupConfirmModal.classList.contains('hidden')) {
        closeLeaveGroupConfirmModal();
      } else if (groupInfoModal && !groupInfoModal.classList.contains('hidden')) {
        closeGroupInfo();
      } else if (imagePreviewModal && !imagePreviewModal.classList.contains('hidden')) {
        closeImagePreview();
      } else if (attachmentMenuPopover && !attachmentMenuPopover.classList.contains('hidden')) {
        hideAttachmentMenu();
      } else if (newChatModal && !newChatModal.classList.contains('hidden')) {
        closeNewChatModal();
      } else if (settingsModal && !settingsModal.classList.contains('hidden')) {
        closeSettings();
      }
    }
  });

  // 12. Phase 4C: Message list actions & listeners
  btnRetryMessages?.addEventListener('click', () => {
    if (shellState.selectedRoomId) {
      loadMessagesForRoom(shellState.selectedRoomId);
    }
  });

  messagesScrollArea?.addEventListener('wheel', () => {
    lastUserScrollActionTime = Date.now();
  }, { passive: true });

  messagesScrollArea?.addEventListener('touchmove', () => {
    lastUserScrollActionTime = Date.now();
  }, { passive: true });

  messagesScrollArea?.addEventListener('pointerdown', () => {
    lastUserScrollActionTime = Date.now();
  }, { passive: true });

  window.addEventListener('keydown', (e) => {
    if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(e.key)) {
      if (document.activeElement === messagesScrollArea || messagesScrollArea?.contains(document.activeElement) || document.activeElement === document.body) {
        lastUserScrollActionTime = Date.now();
      }
    }
  }, { passive: true });

  scrollBottomBtn?.addEventListener('click', () => {
    lastUserScrollActionTime = Date.now();
    scrollToBottom(true);
    clearUnseenIncomingMessages(shellState.selectedRoomId);
    if (shellState.selectedRoomId) {
      saveRoomScrollPosition(shellState.selectedRoomId, { forceNearBottom: true });
      scheduleDismissUnreadDivider(shellState.selectedRoomId, 1000);
    }
  });

  messagesScrollArea?.addEventListener('scroll', () => {
    if (isRebuildingMessagesDom || isRestoringScroll || isPaginatingOlder) {
      return;
    }
    const isUserScroll = (Date.now() - lastUserScrollActionTime) < 1000;
    if (shellState.selectedRoomId) {
      const prevSaved = roomSavedScrollPositions.get(String(shellState.selectedRoomId));
      const distFromBottom = messagesScrollArea.scrollHeight - messagesScrollArea.scrollTop - messagesScrollArea.clientHeight;
      const isNear = distFromBottom <= 140 || messagesScrollArea.scrollHeight <= (messagesScrollArea.clientHeight + 5);

      // Guard: Synthetic/layout scroll events must NOT corrupt a conversation that was saved at the bottom!
      if (!isUserScroll && prevSaved && (prevSaved.isViewingLatest || prevSaved.isNearBottom) && !isNear) {
        // Ignore synthetic reflow scroll that would falsely flag an at-bottom room as reading older history
      } else {
        saveRoomScrollPosition(shellState.selectedRoomId);
      }
    }
    const canScrollUp = messagesScrollArea.scrollHeight > (messagesScrollArea.clientHeight + 60);
    if (canScrollUp && messagesScrollArea.scrollTop < 50) {
      loadOlderMessages();
    }
    const distFromBottom = messagesScrollArea.scrollHeight - messagesScrollArea.scrollTop - messagesScrollArea.clientHeight;
    if (distFromBottom > 150) {
      scrollBottomBtn?.classList.remove('hidden');
      updateScrollBottomBadge(shellState.selectedRoomId);
    } else {
      scrollBottomBtn?.classList.add('hidden');
      clearUnseenIncomingMessages(shellState.selectedRoomId);
      advanceReadCursorForActiveRoom();
      scheduleDismissUnreadDivider(shellState.selectedRoomId, 1500);
    }
    updateFloatingDateOnScroll();
  });

  // 13. Phase 4D: Message Composer & Emoji Picker Listeners
  if (btnEmojiPicker && emojiPickerPopover && composerInput) {
    emojiPicker = new EmojiPicker({
      triggerBtn: btnEmojiPicker,
      popover: emojiPickerPopover,
      input: composerInput,
      searchInput: emojiSearchInput,
      categoriesContainer: emojiPickerCategories,
      grid: emojiPickerGrid,
      previewChar: emojiPreviewChar,
      previewName: emojiPreviewName,
      closeBtn: btnCloseEmojiPicker,
      onSelect: () => {
        autoResizeComposer();
        updateSendButtonState();
      }
    });
  }

  if (composerInput) {
    composerInput.addEventListener('input', () => {
      autoResizeComposer();
      updateSendButtonState();
      handleLocalUserTyping();
    });

    composerInput.addEventListener('blur', () => {
      if (!composerInput.value || !composerInput.value.trim()) {
        stopLocalTyping();
      }
    });

    composerInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        if (e.isComposing || e.keyCode === 229) {
          return;
        }
        e.preventDefault();
        console.log('[CHECKPOINT 1-ENTER] Enter pressed in composer', { textLength: composerInput?.value?.length });
        handleSendMessage();
      } else if (e.key === 'Escape') {
        if (editingMessage) {
          exitEditMode();
        } else if (replyingToMessage) {
          exitReplyMode();
        }
      }
    });
  }

  if (btnSendMessage) {
    btnSendMessage.addEventListener('click', (e) => {
      console.log('[CHECKPOINT 1] Send button clicked', { disabled: btnSendMessage.disabled, textLength: composerInput?.value?.length });
      handleSendMessage();
    });
  }

  if (messageContextMenu) {
    messageContextMenu.addEventListener('click', (e) => {
      const reactionBtn = e.target.closest('.ctx-reaction-btn');
      if (reactionBtn && contextMenuTargetMessage) {
        const emoji = reactionBtn.getAttribute('data-emoji');
        const targetMsg = contextMenuTargetMessage;
        closeContextMenu();
        if (emoji) {
          handleToggleReaction(targetMsg, emoji);
        }
        return;
      }

      const btn = e.target.closest('.context-menu-item');
      if (!btn || !contextMenuTargetMessage) return;
      const action = btn.getAttribute('data-action');
      const msg = contextMenuTargetMessage;

      if (action === 'reply') {
        closeContextMenu();
        enterReplyMode(msg);
      } else if (action === 'copy') {
        const resolved = resolveMessageContent(msg);
        const textToCopy = resolved.text || resolved.filename || '';
        if (textToCopy && window.ollacoreDesktop?.app?.writeClipboardText) {
          const originalText = btn.innerHTML;
          window.ollacoreDesktop.app.writeClipboardText(textToCopy)
            .then(() => {
              btn.innerHTML = '<span class="context-item-text">Copied</span>';
              setTimeout(() => {
                btn.innerHTML = originalText;
                closeContextMenu();
              }, 1000);
            })
            .catch(() => {
              btn.innerHTML = '<span class="context-item-text text-danger">Unable to copy message</span>';
              setTimeout(() => {
                btn.innerHTML = originalText;
                closeContextMenu();
              }, 1500);
            });
          return; // prevent immediate close
        }
        closeContextMenu();
      } else if (action === 'edit') {
        closeContextMenu();
        enterEditMode(msg);
      } else if (action === 'info') {
        closeContextMenu();
        openMessageInfoModal(msg);
      } else if (action === 'star') {
        const targetRoom = msg.roomId || msg.room_id || shellState.selectedRoomId;
        const mid = msg.id || msg.clientMessageId || msg.client_message_id;
        const isStarredNow = roomMessagesState.isStarred(mid, targetRoom);
        if (isStarredNow) {
          roomMessagesState.unstarMessage(mid, targetRoom);
          persistMessageStarredToDb(mid, false, targetRoom).catch(() => { });
        } else {
          roomMessagesState.starMessage(mid, targetRoom);
          persistMessageStarredToDb(mid, true, targetRoom).catch(() => { });
        }
        closeContextMenu();
        renderMessages();
        updateContactInfoStarredCount(targetRoom);
        if (starredMessagesPanel && !starredMessagesPanel.classList.contains('hidden') && activeStarredRoomId === targetRoom) {
          _renderStarredMessages(targetRoom);
        }
      } else if (action === 'pin') {
        const targetRoom = msg.roomId || msg.room_id || shellState.selectedRoomId;
        const mid = msg.id || msg.clientMessageId || msg.client_message_id;
        closeContextMenu();
        if (mid && targetRoom) {
          if (shellState.isMessagePinned(mid, targetRoom)) {
            // Unpin immediately
            shellState.unpinMessage(targetRoom, mid);
            renderMessages();
            renderPinnedBar(targetRoom);
          } else {
            // Open pin duration modal
            const preview = getMessagePinPreview(msg);
            openPinDurationModal(targetRoom, mid, preview);
          }
        }
      } else if (action === 'delete-for-me') {
        closeContextMenu();
        handleDeleteForMe(msg);
      } else if (action === 'delete-for-everyone') {
        closeContextMenu();
        handleDeleteForEveryone(msg);
      } else if (action === 'forward') {
        closeContextMenu();
        handleForwardAction(msg);
      } else if (action === 'select') {
        closeContextMenu();
        handleSelectAction(msg);
      }
    });
  }

  // Conversation Context Menu Actions
  if (conversationContextMenu) {
    conversationContextMenu.addEventListener('click', (e) => {
      const btn = e.target.closest('.context-menu-item');
      if (!btn || !contextMenuTargetConversation) return;
      const action = btn.getAttribute('data-action');
      const item = contextMenuTargetConversation;
      const roomId = item.roomId;

      if (action === 'pin') {
        shellState.togglePinChat(roomId);
        renderConversationList();
        closeConversationContextMenu();
        if (item) persistConversationToDb(item).catch(() => { });
      } else if (action === 'favourite') {
        shellState.toggleFavouriteChat(roomId);
        renderConversationList();
        updateChatFilterCounts();
        closeConversationContextMenu();
        if (item) persistConversationToDb(item).catch(() => { });
      } else if (action === 'toggle-unread') {
        shellState.markConversationAsUnread(roomId);
        renderConversationList();
        updateChatFilterCounts();
        closeConversationContextMenu();
        if (item) persistConversationToDb(item).catch(() => { });
      } else if (action === 'archive') {
        shellState.archiveChat(roomId);
        renderConversationList();
        updateChatFilterCounts();
        closeConversationContextMenu();
        if (currentNavigationDestination === 'archived') {
          renderArchivedList();
        }
      } else if (action === 'toggle-mute') {
        closeConversationContextMenu();
        if (shellState.isConversationMuted(item)) {
          handleUnmuteConversation(roomId);
        } else {
          openMuteDurationModal(roomId);
        }
      } else if (action === 'leave-group' || action === 'exit-group') {
        closeConversationContextMenu();
        openLeaveGroupConfirmModal(roomId);
      } else if (action === 'delete' || action === 'delete-chat') {
        closeConversationContextMenu();
        requestDeleteChat(roomId);
      }
    });
  }

  // Archived Context Menu Actions
  if (archivedContextMenu) {
    archivedContextMenu.addEventListener('click', (e) => {
      const btn = e.target.closest('.context-menu-item');
      if (!btn || !contextMenuTargetArchivedConversation) return;
      const action = btn.getAttribute('data-action');
      const item = contextMenuTargetArchivedConversation;
      const roomId = item.roomId;

      if (action === 'open') {
        selectConversation(roomId);
        closeArchivedContextMenu();
      } else if (action === 'unarchive') {
        shellState.unarchiveChat(roomId);
        renderArchivedList();
        renderConversationList();
        updateChatFilterCounts();
        closeArchivedContextMenu();
        if (item) persistConversationToDb(item).catch(() => { });
      } else if (action === 'toggle-unread') {
        shellState.markConversationAsUnread(roomId);
        renderArchivedList();
        renderConversationList();
        updateChatFilterCounts();
        closeArchivedContextMenu();
        if (item) persistConversationToDb(item).catch(() => { });
      } else if (action === 'pin') {
        shellState.togglePinChat(roomId);
        renderArchivedList();
        closeArchivedContextMenu();
        if (item) persistConversationToDb(item).catch(() => { });
      } else if (action === 'favourite') {
        shellState.toggleFavouriteChat(roomId);
        renderArchivedList();
        closeArchivedContextMenu();
        if (item) persistConversationToDb(item).catch(() => { });
      }
    });
  }

  // Chat Filter Row Listener
  if (chatFilterRow) {
    chatFilterRow.addEventListener('click', (e) => {
      const btn = e.target.closest('.chat-filter-btn');
      if (!btn) return;
      if (btn.id === 'filter-btn-add') {
        openCustomListModal(null, 'create');
        return;
      }
      const filter = btn.getAttribute('data-filter');
      if (filter) {
        setActiveChatFilter(filter);
      }
    });
  }

  // Custom List Modal & Context Menu Listeners
  btnCloseCustomListModal?.addEventListener('click', closeCustomListModal);
  btnCancelCustomList?.addEventListener('click', closeCustomListModal);
  btnSaveCustomList?.addEventListener('click', handleSaveCustomList);

  customListNameInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleSaveCustomList();
    }
  });

  customListModal?.addEventListener('click', (e) => {
    if (e.target === customListModal) {
      closeCustomListModal();
    }
  });

  btnCloseDeleteCustomList?.addEventListener('click', closeDeleteCustomListModal);
  btnCancelDeleteCustomList?.addEventListener('click', closeDeleteCustomListModal);
  btnConfirmDeleteCustomList?.addEventListener('click', handleConfirmDeleteCustomList);

  customListDeleteModal?.addEventListener('click', (e) => {
    if (e.target === customListDeleteModal) {
      closeDeleteCustomListModal();
    }
  });

  btnEmptyEditList?.addEventListener('click', () => {
    const list = shellState.getCustomList(shellState.activeFilter);
    if (list) {
      openCustomListModal(list, 'edit-chats');
    }
  });

  if (customListContextMenu) {
    customListContextMenu.addEventListener('click', (e) => {
      const item = e.target.closest('.context-menu-item');
      if (!item || !contextMenuTargetList) return;
      const action = item.getAttribute('data-action');
      const target = contextMenuTargetList;

      if (action === 'edit-chats') {
        openCustomListModal(target, 'edit-chats');
      } else if (action === 'rename-list') {
        openCustomListModal(target, 'rename');
      } else if (action === 'delete-list') {
        openDeleteCustomListModal(target);
      }
    });
  }

  // Chat Header Three-Dot Options Menu Listeners
  btnChatMenu?.addEventListener('click', (e) => {
    e.stopPropagation();
    openChatHeaderMenu();
  });

  menuItemContactInfo?.addEventListener('click', () => {
    const roomId = shellState.selectedRoomId;
    closeChatHeaderMenu();
    if (roomId) {
      openContactInfo(roomId);
    }
  });

  menuItemChatSearch?.addEventListener('click', () => {
    closeChatHeaderMenu();
    openChatSearch();
  });

  menuItemStarredMessages?.addEventListener('click', () => {
    const roomId = shellState.selectedRoomId;
    closeChatHeaderMenu();
    if (roomId) {
      closeContactInfo();
      openStarredMessages(roomId);
    }
  });

  menuItemChatTheme?.addEventListener('click', () => {
    const roomId = shellState.selectedRoomId;
    closeChatHeaderMenu();
    if (roomId) {
      themeOpenedFromSettings = false;
      openThemeModal(roomId);
    }
  });

  menuItemToggleFav?.addEventListener('click', () => {
    const roomId = shellState.selectedRoomId;
    closeChatHeaderMenu();
    if (roomId) {
      shellState.toggleFavouriteChat(roomId);
      renderConversationList();
      renderArchivedList();
      updateChatFilterCounts();
      const conv = shellState.conversations?.find((c) => c.roomId === roomId);
      if (conv) persistConversationToDb(conv).catch(() => { });
    }
  });

  menuItemChangeList?.addEventListener('click', () => {
    const roomId = shellState.selectedRoomId;
    closeChatHeaderMenu();
    if (roomId) {
      openChangeChatListsModal(roomId);
    }
  });

  menuItemToggleArchive?.addEventListener('click', () => {
    const roomId = shellState.selectedRoomId;
    closeChatHeaderMenu();
    if (roomId) {
      shellState.toggleArchiveChat(roomId);
      renderConversationList();
      renderArchivedList();
      updateChatFilterCounts();
      const conv = shellState.conversations?.find((c) => c.roomId === roomId);
      if (conv) persistConversationToDb(conv).catch(() => { });
    }
  });

  menuItemClearChat?.addEventListener('click', () => {
    const roomId = shellState.selectedRoomId;
    closeChatHeaderMenu();
    if (roomId) {
      requestClearChat(roomId);
    }
  });

  menuItemExitGroup?.addEventListener('click', () => {
    const roomId = shellState.selectedRoomId;
    closeChatHeaderMenu();
    if (roomId) {
      requestExitGroup(roomId);
    }
  });

  menuItemDeleteChat?.addEventListener('click', () => {
    const roomId = shellState.selectedRoomId;
    closeChatHeaderMenu();
    if (roomId) {
      requestDeleteChat(roomId);
    }
  });

  menuItemToggleMute?.addEventListener('click', () => {
    const roomId = shellState.selectedRoomId;
    closeChatHeaderMenu();
    if (roomId) {
      const conv = shellState.conversations?.find((c) => c.roomId === roomId);
      if (shellState.isConversationMuted(conv)) {
        handleUnmuteConversation(roomId);
      } else {
        openMuteDurationModal(roomId);
      }
    }
  });

  menuItemBlockContact?.addEventListener('click', (e) => {
    e?.stopPropagation?.();
    const roomId = shellState.selectedRoomId;
    closeChatHeaderMenu();
    if (roomId) {
      const conv = (shellState.getSelectedConversation && shellState.getSelectedConversation()) ||
        shellState.conversations?.find((c) => c && (c.roomId === roomId || c.room_id === roomId || c.id === roomId));
      const peerUserId = getDirectPeerUserId(conv, shellState.currentUser?.userId) ||
        conv?.peerUserId || conv?.peer_user_id || conv?.peer?.userId || conv?.peer?.user_id || conv?.peer?.id;
      if (peerUserId) {
        if (shellState.isUserBlocked(peerUserId)) {
          handleUnblockContact(peerUserId);
        } else {
          const displayName = conv ? getConversationTitle(conv) : peerUserId;
          openBlockContactModal(peerUserId, displayName);
        }
      }
    }
  });

  // Change Chat Lists Modal Listeners
  btnCloseChangeChatLists?.addEventListener('click', closeChangeChatListsModal);
  btnDoneChangeChatLists?.addEventListener('click', closeChangeChatListsModal);

  btnCreateListFromChangeModal?.addEventListener('click', () => {
    const currentRoom = activeChangeChatListsRoomId;
    closeChangeChatListsModal();
    openCustomListModal(null, 'create');
    if (currentRoom && customListChatItems) {
      const cb = customListChatItems.querySelector(`input[value="${CSS.escape ? CSS.escape(currentRoom) : currentRoom}"]`);
      if (cb) cb.checked = true;
    }
  });

  changeChatListsModal?.addEventListener('click', (e) => {
    if (e.target === changeChatListsModal) {
      closeChangeChatListsModal();
    }
  });

  btnCancelReply?.addEventListener('click', () => {
    exitReplyMode();
  });

  btnCancelEdit?.addEventListener('click', () => {
    exitEditMode();
    if (composerInput) {
      composerInput.value = '';
      autoResizeComposer();
    }
  });

  btnCloseMessageInfo?.addEventListener('click', () => {
    closeMessageInfoModal();
  });

  messageInfoModal?.addEventListener('click', (e) => {
    if (e.target === messageInfoModal) {
      closeMessageInfoModal();
    }
  });

  // Global dismiss for context menu and modals on Escape & click outside
  document.addEventListener('click', (e) => {
    if (activeReactionPicker && !activeReactionPicker.contains(e.target)) {
      closeReactionPicker();
    }
    if (participantActionMenu && !participantActionMenu.classList.contains('hidden')) {
      if (!participantActionMenu.contains(e.target)) {
        closeParticipantActionMenu();
      }
    }
    if (chatHeaderMenu && !chatHeaderMenu.classList.contains('hidden')) {
      if (!chatHeaderMenu.contains(e.target) && (!btnChatMenu || !btnChatMenu.contains(e.target))) {
        closeChatHeaderMenu();
      }
    }
    if (messageContextMenu && !messageContextMenu.classList.contains('hidden')) {
      if (!messageContextMenu.contains(e.target)) {
        closeContextMenu();
      }
    }
    if (conversationContextMenu && !conversationContextMenu.classList.contains('hidden')) {
      if (!conversationContextMenu.contains(e.target)) {
        closeConversationContextMenu();
      }
    }
    if (archivedContextMenu && !archivedContextMenu.classList.contains('hidden')) {
      if (!archivedContextMenu.contains(e.target)) {
        closeArchivedContextMenu();
      }
    }
    if (customListContextMenu && !customListContextMenu.classList.contains('hidden')) {
      if (!customListContextMenu.contains(e.target)) {
        closeCustomListContextMenu();
      }
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (activeReactionPicker) {
        closeReactionPicker();
      } else if (participantActionMenu && !participantActionMenu.classList.contains('hidden')) {
        closeParticipantActionMenu();
      } else if (blockContactConfirmModal && !blockContactConfirmModal.classList.contains('hidden')) {
        closeBlockContactModal();
      } else if (leaveGroupConfirmModal && !leaveGroupConfirmModal.classList.contains('hidden')) {
        closeLeaveGroupConfirmModal();
      } else if (muteDurationModal && !muteDurationModal.classList.contains('hidden')) {
        closeMuteDurationModal();
      } else if (blockedContactsModal && !blockedContactsModal.classList.contains('hidden')) {
        closeBlockedContactsModal();
      } else if (groupAddPeopleModal && !groupAddPeopleModal.classList.contains('hidden')) {
        closeGroupAddPeopleModal();
      } else if (chatHeaderMenu && !chatHeaderMenu.classList.contains('hidden')) {
        closeChatHeaderMenu();
      } else if (changeChatListsModal && !changeChatListsModal.classList.contains('hidden')) {
        closeChangeChatListsModal();
      } else if (customListContextMenu && !customListContextMenu.classList.contains('hidden')) {
        closeCustomListContextMenu();
      } else if (customListDeleteModal && !customListDeleteModal.classList.contains('hidden')) {
        closeDeleteCustomListModal();
      } else if (customListModal && !customListModal.classList.contains('hidden')) {
        closeCustomListModal();
      } else if (archivedContextMenu && !archivedContextMenu.classList.contains('hidden')) {
        closeArchivedContextMenu();
      } else if (conversationContextMenu && !conversationContextMenu.classList.contains('hidden')) {
        closeConversationContextMenu();
      } else if (messageContextMenu && !messageContextMenu.classList.contains('hidden')) {
        closeContextMenu();
      } else if (messageInfoModal && !messageInfoModal.classList.contains('hidden')) {
        closeMessageInfoModal();
      } else if (editingMessage) {
        exitEditMode();
      } else if (replyingToMessage) {
        exitReplyMode();
      }
    }
  });

  // 14B. Voice Message Recording Listeners (Phase A)
  function resetRecordingVisualizer() {
    if (recordingTimer) recordingTimer.textContent = '0:00';
    if (recordingVisualizer) {
      const bars = recordingVisualizer.querySelectorAll('.recording-wave-bar');
      bars.forEach((bar) => {
        bar.style.height = '4px';
      });
    }
  }

  voiceRecorder.on('timeUpdate', ({ formatted }) => {
    if (recordingTimer) {
      recordingTimer.textContent = formatted;
    }
  });

  voiceRecorder.on('level', (level) => {
    if (recordingVisualizer) {
      const bars = recordingVisualizer.querySelectorAll('.recording-wave-bar');
      bars.forEach((bar, idx) => {
        const variation = Math.sin((Date.now() / 150) + idx) * 0.4 + 0.6;
        const heightPx = Math.max(4, Math.round(level * 20 * variation + 4));
        bar.style.height = `${heightPx}px`;
      });
    }
  });

  voiceRecorder.on('cancelled', () => {
    resetRecordingVisualizer();
  });

  btnVoiceRecord?.addEventListener('click', async () => {
    if (!shellState.selectedRoomId) {
      alert('Please select a conversation first');
      return;
    }
    const selConv = shellState.getSelectedConversation();
    if (selConv?.isExited || selConv?.exited) {
      return;
    }

    try {
      resetRecordingVisualizer();
      await voiceRecorder.start();
      composerBox?.classList.add('hidden');
      composerRecordingBar?.classList.remove('hidden');
    } catch (err) {
      alert(err.message || 'Could not start voice recording');
      composerBox?.classList.remove('hidden');
      composerRecordingBar?.classList.add('hidden');
      resetRecordingVisualizer();
    }
  });

  btnCancelRecording?.addEventListener('click', () => {
    voiceRecorder.cancel();
    composerRecordingBar?.classList.add('hidden');
    composerBox?.classList.remove('hidden');
    resetRecordingVisualizer();
  });

  btnSendRecording?.addEventListener('click', async () => {
    try {
      const result = await voiceRecorder.stop();
      composerRecordingBar?.classList.add('hidden');
      composerBox?.classList.remove('hidden');
      resetRecordingVisualizer();

      if (!result) {
        // Discarded if too short (< 0.5s) or cancelled
        return;
      }

      await processAndUploadVoiceNote({
        blob: result.blob,
        duration: result.duration,
        mimeType: result.mimeType
      });
    } catch (err) {
      console.error('Error stopping voice recorder:', err);
      composerRecordingBar?.classList.add('hidden');
      composerBox?.classList.remove('hidden');
      resetRecordingVisualizer();
    }
  });

  // 14. Media Sharing & Attachment Listeners (Phase 4-10)
  btnAttachmentPicker?.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleAttachmentMenu();
  });

  // Attachment menu category selections
  attachmentMenuPopover?.querySelectorAll('.attachment-menu-item').forEach((item) => {
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      const cat = item.getAttribute('data-category');
      handlePickAttachment(cat);
    });
  });

  // Hidden file input change event (fallback / programmatic testing)
  composerFileInput?.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (file) {
      await processAndUploadFile({ file });
      composerFileInput.value = '';
    }
  });

  // Upload progress event from main process IPC
  if (window.ollacoreDesktop?.media?.onUploadProgress) {
    window.ollacoreDesktop.media.onUploadProgress((data) => {
      if (data?.progress !== undefined) {
        updateUploadProgress(data.progress * 100);
      }
    });
  }

  // Click outside to close attachment menu
  document.addEventListener('click', (e) => {
    if (attachmentMenuPopover && !attachmentMenuPopover.classList.contains('hidden')) {
      if (!attachmentMenuPopover.contains(e.target) && e.target !== btnAttachmentPicker) {
        hideAttachmentMenu();
      }
    }
  });

  // Image preview lightbox modal controls
  previewBackdrop?.addEventListener('click', closeImagePreview);
  btnClosePreview?.addEventListener('click', closeImagePreview);
  btnDownloadPreview?.addEventListener('click', () => {
    if (previewImgElement?.src) {
      handleDownloadFile(null, previewFilename?.textContent || 'photo.jpg', previewImgElement.src);
    }
  });

  // 15. Phase 6B/6C: Voice & Video Call Listeners
  btnStartVoiceCall?.addEventListener('click', () => {
    if (!shellState.selectedRoomId) return;
    const selected = shellState.getSelectedConversation();
    if (selected?.isExited || selected?.exited) return;
    const { displayName, phone } = resolveCallerIdentity(shellState.selectedRoomId, null);
    const peerName = displayName || 'Voice Call';
    voiceCallManager.peerPhone = phone;
    voiceCallManager.startCall(shellState.selectedRoomId, peerName, { peerPhone: phone }).catch((err) => {
      console.error('Failed to start voice call:', err);
      showToast(err?.message || 'Failed to start voice call');
    });
  });

  btnStartVideoCall?.addEventListener('click', () => {
    if (!shellState.selectedRoomId) return;
    const selected = shellState.getSelectedConversation();
    if (selected?.isExited || selected?.exited) return;
    const { displayName, phone } = resolveCallerIdentity(shellState.selectedRoomId, null);
    const peerName = displayName || 'Video Call';
    voiceCallManager.peerPhone = phone;
    voiceCallManager.startVideoCall(shellState.selectedRoomId, peerName, { peerPhone: phone }).catch((err) => {
      console.error('Failed to start video call:', err);
      showToast(err?.message || 'Failed to start video call');
    });
  });

  btnCallMute?.addEventListener('click', () => {
    voiceCallManager.toggleMute();
  });

  btnCallCamera?.addEventListener('click', async () => {
    await voiceCallManager.toggleCamera();
    syncFloatingCallState();
  });

  // Phase 1 Screen Sharing UI & Picker Handlers
  let currentScreenSources = [];
  let selectedScreenSourceId = null;
  let activeScreenPickerTab = 'screen'; // 'screen' | 'window'

  function renderScreenSources() {
    if (!screenshareSourcesGrid) return;
    screenshareSourcesGrid.innerHTML = '';
    const filtered = currentScreenSources.filter((s) => s.type === activeScreenPickerTab);

    if (filtered.length === 0) {
      screenshareSourcesEmpty?.classList.remove('hidden');
      return;
    }
    screenshareSourcesEmpty?.classList.add('hidden');

    filtered.forEach((source) => {
      const item = document.createElement('div');
      item.className = 'screenshare-source-item' + (selectedScreenSourceId === source.id ? ' selected' : '');
      item.dataset.sourceId = source.id;

      const thumbWrap = document.createElement('div');
      thumbWrap.className = 'screenshare-thumb-wrapper';
      if (source.thumbnail) {
        const img = document.createElement('img');
        img.className = 'screenshare-thumb-img';
        img.src = source.thumbnail;
        img.alt = source.name;
        thumbWrap.appendChild(img);
      }
      item.appendChild(thumbWrap);

      const infoWrap = document.createElement('div');
      infoWrap.className = 'screenshare-source-info';
      if (source.appIcon) {
        const icon = document.createElement('img');
        icon.className = 'screenshare-app-icon';
        icon.src = source.appIcon;
        infoWrap.appendChild(icon);
      }
      const name = document.createElement('span');
      name.className = 'screenshare-source-name';
      name.textContent = source.name;
      infoWrap.appendChild(name);
      item.appendChild(infoWrap);

      item.addEventListener('click', () => {
        selectedScreenSourceId = source.id;
        screenshareSourcesGrid.querySelectorAll('.screenshare-source-item').forEach((el) => el.classList.remove('selected'));
        item.classList.add('selected');
        if (btnConfirmScreensharePicker) btnConfirmScreensharePicker.disabled = false;
      });

      item.addEventListener('dblclick', async () => {
        selectedScreenSourceId = source.id;
        closeScreenPicker();
        try {
          await voiceCallManager.startScreenShare(source.id);
        } catch (err) {
          console.error('Failed to start screen share on dblclick:', err);
        }
      });

      screenshareSourcesGrid.appendChild(item);
    });
  }

  async function openScreenPicker() {
    if (voiceCallManager.isScreenSharing) {
      try {
        await voiceCallManager.stopScreenShare();
      } catch (err) {
        console.error('Failed to stop screen share:', err);
      }
      return;
    }

    if (voiceCallManager.remoteScreenSharing || (voiceCallManager.canStartScreenShare && !voiceCallManager.canStartScreenShare())) {
      console.warn('[ScreenShare] Cannot share screen: another participant is already sharing');
      if (callErrorBanner) {
        callErrorBanner.textContent = 'Cannot share screen: another participant is already sharing';
        callErrorBanner.classList.remove('hidden');
        scheduleCallPresentation(voiceCallManager, () => { callErrorBanner.classList.add('hidden'); }, 4000);
      }
      return;
    }

    selectedScreenSourceId = null;
    activeScreenPickerTab = 'screen';
    tabScreenshareEntire?.classList.add('active');
    tabScreenshareWindows?.classList.remove('active');
    if (btnConfirmScreensharePicker) btnConfirmScreensharePicker.disabled = true;
    screensharePickerModal?.classList.remove('hidden');
    screenshareSourcesLoading?.classList.remove('hidden');
    screenshareSourcesEmpty?.classList.add('hidden');
    if (screenshareSourcesGrid) screenshareSourcesGrid.innerHTML = '';

    try {
      const fetcher = window.ollacoreDesktop?.desktopCapture?.getSources || window.ollacoreDesktop?.rtc?.getDesktopSources;
      if (!fetcher) {
        throw new Error('Desktop capturer bridge is not available');
      }
      currentScreenSources = await fetcher({ types: ['screen', 'window'] });
      screenshareSourcesLoading?.classList.add('hidden');
      renderScreenSources();
    } catch (err) {
      console.error('Failed to load screen capture sources:', err);
      screenshareSourcesLoading?.classList.add('hidden');
      screenshareSourcesEmpty?.classList.remove('hidden');
      if (screenshareSourcesEmpty) {
        screenshareSourcesEmpty.textContent = err?.message || 'No screens or windows available to share';
      }
      if (callErrorBanner) {
        callErrorBanner.textContent = err?.message || 'Failed to load screen capture sources';
        callErrorBanner.classList.remove('hidden');
        scheduleCallPresentation(voiceCallManager, () => { callErrorBanner.classList.add('hidden'); }, 4000);
      }
    }
  }

  function closeScreenPicker() {
    screensharePickerModal?.classList.add('hidden');
    selectedScreenSourceId = null;
    currentScreenSources = [];
  }

  btnCallScreenShare?.addEventListener('click', () => {
    openScreenPicker();
  });

  btnStopScreenshareBanner?.addEventListener('click', () => {
    voiceCallManager.stopScreenShare().catch((err) => {
      console.error('Failed to stop screen share from banner:', err);
    });
  });

  btnCloseScreensharePicker?.addEventListener('click', () => {
    closeScreenPicker();
  });

  btnCancelScreensharePicker?.addEventListener('click', () => {
    closeScreenPicker();
  });

  btnConfirmScreensharePicker?.addEventListener('click', async () => {
    if (!selectedScreenSourceId) return;
    const srcId = selectedScreenSourceId;
    closeScreenPicker();
    try {
      await voiceCallManager.startScreenShare(srcId);
    } catch (err) {
      console.error('Failed to start screen share from picker:', err);
      if (callErrorBanner) {
        callErrorBanner.textContent = err?.message || 'Failed to start screen share';
        callErrorBanner.classList.remove('hidden');
        scheduleCallPresentation(voiceCallManager, () => { callErrorBanner.classList.add('hidden'); }, 4000);
      }
    }
  });

  tabScreenshareEntire?.addEventListener('click', () => {
    activeScreenPickerTab = 'screen';
    tabScreenshareEntire.classList.add('active');
    tabScreenshareWindows?.classList.remove('active');
    renderScreenSources();
  });

  tabScreenshareWindows?.addEventListener('click', () => {
    activeScreenPickerTab = 'window';
    tabScreenshareWindows.classList.add('active');
    tabScreenshareEntire?.classList.remove('active');
    renderScreenSources();
  });

  btnCallEnd?.addEventListener('click', () => {
    voiceCallManager.endCall();
  });

  btnCallAccept?.addEventListener('click', () => {
    voiceCallManager.acceptCall().catch((err) => {
      console.error('Failed to accept call:', err);
      showToast(err?.message || 'Failed to accept call');
    });
  });

  btnCallDecline?.addEventListener('click', () => {
    voiceCallManager.declineCall();
  });

  btnIncomingCallClose?.addEventListener('click', () => {
    voiceCallManager.declineCall();
  });

  const btnIncomingCallMinimize = document.getElementById('btn-incoming-call-minimize');
  btnIncomingCallMinimize?.addEventListener('click', (e) => {
    e.stopPropagation();
    minimizeCall();
  });

  btnCallMinimize?.addEventListener('click', (e) => {
    e.stopPropagation();
    minimizeCall();
    if (typeof window !== 'undefined' && window.ollacoreDesktop?.floatingCall) {
      window.ollacoreDesktop.floatingCall.show().catch(() => { });
      syncFloatingCallState();
      startFloatingVideoBridge();
    }
  });

  btnCallRestore?.addEventListener('click', (e) => {
    e.stopPropagation();
    restoreCall();
  });

  btnCallMinimizedMute?.addEventListener('click', (e) => {
    e.stopPropagation();
    voiceCallManager.toggleMute();
    if (callMinimizedMuteIcon) {
      callMinimizedMuteIcon.innerHTML = voiceCallManager.isMuted ? UI_ICONS.micOff : UI_ICONS.mic;
    }
    btnCallMinimizedMute?.classList.toggle('is-muted', Boolean(voiceCallManager.isMuted));
    syncFloatingCallState();
  });

  btnCallMinimizedEnd?.addEventListener('click', (e) => {
    e.stopPropagation();
    voiceCallManager.endCall();
  });

  if (typeof window !== 'undefined' && window.ollacoreDesktop?.floatingCall) {
    window.ollacoreDesktop.floatingCall.onAction((action) => {
      const actionType = typeof action === 'string' ? action : action?.type;
      if (actionType === 'accept') {
        voiceCallManager.acceptCall().catch((err) => console.error('Failed to accept call:', err));
      } else if (actionType === 'decline') {
        voiceCallManager.declineCall();
      } else if (actionType === 'end') {
        voiceCallManager.endCall();
      } else if (actionType === 'toggle-mute') {
        voiceCallManager.toggleMute();
      } else if (actionType === 'toggle-camera') {
        Promise.resolve(voiceCallManager.toggleCamera()).then(() => syncFloatingCallState()).catch(() => { });
      } else if (actionType === 'start-screenshare') {
        const sourceId = action.sourceId;
        if (sourceId) {
          voiceCallManager.startScreenShare(sourceId).then(() => syncFloatingCallState()).catch((err) => {
            console.error('Failed to start screenshare from floating call:', err);
          });
        }
      } else if (actionType === 'stop-screenshare') {
        voiceCallManager.stopScreenShare().then(() => syncFloatingCallState()).catch(() => { });
      } else if (actionType === 'toggle-screenshare') {
        if (voiceCallManager.isScreenSharing) {
          voiceCallManager.stopScreenShare().then(() => syncFloatingCallState()).catch(() => { });
        } else if (!hasFloatingBridge) {
          if (typeof window.ollacoreDesktop?.app?.focusWindow === 'function') {
            window.ollacoreDesktop.app.focusWindow();
          }
          openScreenPicker();
        }
      } else if (actionType === 'get-call-participants') {
        const roomId = voiceCallManager.roomId;
        if (roomId && window.ollacoreDesktop?.chatApi?.getParticipants) {
          window.ollacoreDesktop.chatApi.getParticipants(roomId).then((res) => {
            const raw = Array.isArray(res?.participants) ? res.participants : [];
            const currentUserId = shellState.currentUser?.userId || shellState.userProfile?.userId;
            const eligible = filterEligibleCallParticipants(raw, currentUserId, voiceCallManager.participants);
            const mapped = eligible.map((p) => {
              const pId = p.principalId || p.principal_id;
              const resolved = resolveMemberInfo(pId);
              let nameText = resolved.hasNickname ? resolved.displayName : (p.displayName || resolved.displayName || p.phone || resolved.phone || pId);
              let phoneText = (p.phone || resolved.phone || '').trim();
              return {
                id: pId,
                name: nameText,
                phone: phoneText,
                isInvited: inFlightCallInvitations.has(pId)
              };
            });
            window.ollacoreDesktop.floatingCall.bridgeSignal({
              type: 'call-participants-list',
              participants: mapped
            }).catch(() => { });
          }).catch((err) => {
            window.ollacoreDesktop.floatingCall.bridgeSignal({
              type: 'call-participants-list',
              error: err?.message || 'Failed to load participants',
              participants: []
            }).catch(() => { });
          });
        }
      } else if (actionType === 'invite-participant') {
        const targetUserId = action.targetUserId;
        if (targetUserId) {
          inFlightCallInvitations.add(targetUserId);
          const isVideo = Boolean(voiceCallManager.isVideo || voiceCallManager.mode === 'video');
          const callType = voiceCallManager.mode || (isVideo ? 'video' : 'voice');
          sendCallSignal('invite', voiceCallManager.roomId, {
            callType,
            isVideo,
            callId: voiceCallManager.callId,
            callEpoch: voiceCallManager.callEpoch,
            targetUserId
          }).then(() => {
            syncFloatingCallState();
          }).catch(() => {
            inFlightCallInvitations.delete(targetUserId);
            syncFloatingCallState();
          });
          syncFloatingCallState();
        }
      } else if (actionType === 'add-participant') {
        if (!hasFloatingBridge) {
          if (typeof window.ollacoreDesktop?.app?.focusWindow === 'function') {
            window.ollacoreDesktop.app.focusWindow();
          }
          openCallAddParticipantModal();
        }
      } else if (actionType === 'restore') {
        if (typeof window.ollacoreDesktop?.app?.focusWindow === 'function') {
          window.ollacoreDesktop.app.focusWindow();
        }
        restoreCall();
      }
      syncFloatingCallState();
    });

    if (window.ollacoreDesktop?.floatingCall?.onWindowStateChange) {
      window.ollacoreDesktop.floatingCall.onWindowStateChange((state) => {
        if (!state || typeof state !== 'object') return;
        if (typeof state.isMinimized === 'boolean') isMainWindowMinimized = Boolean(state.isMinimized);
        if (typeof state.isVisible === 'boolean') isMainWindowVisible = Boolean(state.isVisible);
        if (typeof state.isFocused === 'boolean') isMainWindowFocused = Boolean(state.isFocused);

        const isMinimized = isMainWindowMinimized;
        if (voiceCallManager && voiceCallManager.state !== CALL_STATE.IDLE && !voiceCallManager.isEnded) {
          if (isMinimized) {
            syncFloatingCallState();
            startFloatingVideoBridge();
          } else {
            // Main application window restored
            if (!isCallMinimized) {
              restoreCall();
              updateVoiceCallUi(voiceCallManager.state, voiceCallManager.peerName, voiceCallManager.error);
            } else {
              // Call was minimized in-app: restore compact in-app widget at its saved position
              voiceCallOverlay.classList.remove('hidden');
              voiceCallOverlay.classList.add('is-minimized', 'is-floating');
              voiceCallCard?.classList.add('is-minimized', 'is-floating');
              callMinimizedControls?.classList.remove('hidden');
              clampMinimizedTilePosition();
              applyMinimizedTilePosition();
              syncFloatingCallState();
            }
          }
        }
        if (isAppActiveAndFocused()) {
          advanceReadCursorForActiveRoom();
        }
      });
    }

    if (window.ollacoreDesktop?.app?.onWindowStateChange && window.ollacoreDesktop.app.onWindowStateChange !== window.ollacoreDesktop?.floatingCall?.onWindowStateChange) {
      window.ollacoreDesktop.app.onWindowStateChange((state) => {
        if (!state || typeof state !== 'object') return;
        if (typeof state.isMinimized === 'boolean') isMainWindowMinimized = Boolean(state.isMinimized);
        if (typeof state.isVisible === 'boolean') isMainWindowVisible = Boolean(state.isVisible);
        if (typeof state.isFocused === 'boolean') isMainWindowFocused = Boolean(state.isFocused);
        if (isAppActiveAndFocused()) {
          advanceReadCursorForActiveRoom();
        }
      });
    }

    let pendingBridgeCandidates = [];
    window.ollacoreDesktop.floatingCall.onBridgeSignal(async (signal) => {
      if (!signal) return;
      try {
        if (signal.type === 'ready') {
          startFloatingVideoBridge();
          return;
        }
        if (!localVideoBridgePc) return;
        if (signal.type === 'answer' && signal.answer) {
          await localVideoBridgePc.setRemoteDescription(new RTCSessionDescription(signal.answer));
          for (const cand of pendingBridgeCandidates) {
            try { await localVideoBridgePc.addIceCandidate(new RTCIceCandidate(cand)); } catch (_) { }
          }
          pendingBridgeCandidates = [];
        } else if (signal.type === 'candidate' && signal.candidate && signal.candidate.candidate) {
          if (!localVideoBridgePc.remoteDescription) {
            pendingBridgeCandidates.push(signal.candidate);
          } else {
            try { await localVideoBridgePc.addIceCandidate(new RTCIceCandidate(signal.candidate)); } catch (_) { }
          }
        }
      } catch (err) {
        console.warn('[FloatingBridge] handle signal error:', err);
      }
    });
  }

  btnCallRequestVideo?.addEventListener('click', (e) => {
    e.stopPropagation();
    // Protocol check: OllaCore RTC protocol currently lacks peer video upgrade request/accept frames.
    // Cleanly report without sending unsupported frames or faking local state:
    if (callStatusLabel) {
      callStatusLabel.textContent = 'Video upgrade pending backend protocol';
      scheduleCallPresentation(voiceCallManager, () => {
        if (voiceCallManager.state === CALL_STATE.CONNECTED && callStatusLabel) {
          callStatusLabel.textContent = 'Connected';
        }
      }, 3000);
    }
  });

  // Draggable minimized call tile
  voiceCallCard?.addEventListener('pointerdown', (e) => {
    if (!isCallMinimized) return;
    if (e.target.closest('button')) return;
    callDragState.isDragging = true;
    callDragState.startX = e.clientX;
    callDragState.startY = e.clientY;
    hasDraggedCallTile = false;
    const rect = voiceCallCard.getBoundingClientRect();
    callDragState.tileInitialX = rect.left;
    callDragState.tileInitialY = rect.top;
    try {
      voiceCallCard.setPointerCapture?.(e.pointerId);
    } catch { }
  });

  voiceCallCard?.addEventListener('pointermove', (e) => {
    if (!callDragState?.isDragging || !isCallMinimized) return;
    const dx = e.clientX - callDragState.startX;
    const dy = e.clientY - callDragState.startY;
    if (Math.abs(dx) > 4 || Math.abs(dy) > 4) {
      hasDraggedCallTile = true;
    }
    if (hasDraggedCallTile) {
      const targetX = callDragState.tileInitialX + dx;
      const targetY = callDragState.tileInitialY + dy;
      minimizedTileCoords.x = targetX;
      minimizedTileCoords.y = targetY;
      clampMinimizedTilePosition();
      applyMinimizedTilePosition();
    }
  });

  const stopCallTileDrag = (e) => {
    if (!callDragState?.isDragging) return;
    callDragState.isDragging = false;
    try {
      if (e.pointerId && voiceCallCard.hasPointerCapture?.(e.pointerId)) {
        voiceCallCard.releasePointerCapture?.(e.pointerId);
      }
    } catch { }
  };

  voiceCallCard?.addEventListener('pointerup', stopCallTileDrag);
  voiceCallCard?.addEventListener('pointercancel', stopCallTileDrag);

  // Clicking anywhere on the minimized tile body (not buttons) restores full call UI unless user was dragging
  voiceCallCard?.addEventListener('click', (e) => {
    if (!isCallMinimized) return;
    if (e.target.closest('button')) return;
    if (hasDraggedCallTile) {
      hasDraggedCallTile = false;
      return;
    }
    restoreCall();
  });

  window.addEventListener('resize', () => {
    if (isCallMinimized && voiceCallCard) {
      clampMinimizedTilePosition();
      applyMinimizedTilePosition();
    }
  });

  btnCallAddParticipant?.addEventListener('click', () => {
    openCallAddParticipantModal();
  });

  btnCloseCallAddParticipant?.addEventListener('click', () => {
    closeCallAddParticipantModal();
  });

  btnCloseCallAddParticipantFooter?.addEventListener('click', () => {
    closeCallAddParticipantModal();
  });

  callAddParticipantModal?.addEventListener('click', (e) => {
    if (e.target === callAddParticipantModal) {
      closeCallAddParticipantModal();
    }
  });

  callParticipantSearch?.addEventListener('input', (e) => {
    const query = (e.target?.value || '').trim().toLowerCase();
    if (!query) {
      renderCallParticipantsList(activeCallEligibleParticipants);
      return;
    }
    const filtered = activeCallEligibleParticipants.filter((p) => {
      const name = (p.displayName || '').toLowerCase();
      const phone = (p.phone || '').toLowerCase();
      const pid = (p.principalId || p.principal_id || '').toLowerCase();
      return name.includes(query) || phone.includes(query) || pid.includes(query);
    });
    renderCallParticipantsList(filtered);
  });

  voiceCallManager.on('stateChange', ({ state, peerName, error }) => {
    if (state !== CALL_STATE.CONNECTED) {
      inFlightCallInvitations.clear();
    }

    // Call history lifecycle tracking
    const isVideo = Boolean(voiceCallManager.isVideo || voiceCallManager.mode === 'video');
    const roomId = voiceCallManager.roomId || shellState.selectedRoomId;

    if (state === CALL_STATE.IDLE) {
      const idleRoom = roomId || shellState.selectedRoomId;
      if (idleRoom) {
        recentlyInitiatedCalls.delete(String(idleRoom).trim());
      }
    }

    if (state === CALL_STATE.OUTGOING_RINGING) {
      const { displayName, phone } = resolveCallerIdentity(roomId, null);
      activeCallSession = {
        id: 'call_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8),
        callId: voiceCallManager.callId || '',
        roomId: roomId || '',
        participantId: voiceCallManager.peerId || '',
        participantName: displayName || peerName || (isVideo ? 'Video Call' : 'Voice Call'),
        participantPhone: phone || voiceCallManager.peerPhone || '',
        participantAvatar: '',
        direction: 'outgoing',
        callType: isVideo ? 'video' : 'voice',
        status: 'completed',
        startedAt: Date.now(),
        connectedAt: null,
        endedAt: null,
        duration: 0
      };
    } else if (state === CALL_STATE.INCOMING_RINGING) {
      const { displayName, phone } = resolveCallerIdentity(roomId, null);
      activeCallSession = {
        id: 'call_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8),
        callId: voiceCallManager.callId || '',
        roomId: roomId || '',
        participantId: voiceCallManager.peerId || '',
        participantName: displayName || peerName || (isVideo ? 'Incoming Video Call' : 'Incoming Voice Call'),
        participantPhone: phone || voiceCallManager.peerPhone || '',
        participantAvatar: '',
        direction: 'incoming',
        callType: isVideo ? 'video' : 'voice',
        status: 'missed',
        startedAt: Date.now(),
        connectedAt: null,
        endedAt: null,
        duration: 0
      };
    } else if (state === CALL_STATE.CONNECTED) {
      if (activeCallSession) {
        activeCallSession.connectedAt = voiceCallManager.callConnectedAt || activeCallSession.connectedAt;
        activeCallSession.status = 'completed';
      }
      if (isVideo) {
        startFloatingVideoBridge();
      }
    } else if (
      state === CALL_STATE.ENDED ||
      state === CALL_STATE.REMOTE_ENDED ||
      state === CALL_STATE.DECLINED ||
      state === CALL_STATE.REMOTE_DECLINED ||
      state === CALL_STATE.NO_ANSWER ||
      state === CALL_STATE.CANCELLED ||
      state === CALL_STATE.REMOTE_CANCELLED ||
      state === CALL_STATE.FAILED
    ) {
      const termRoomId = roomId || voiceCallManager.roomId || activeCallSession?.roomId || shellState.selectedRoomId;
      if (termRoomId) {
        recentlyInitiatedCalls.delete(String(termRoomId).trim());
      }
      if (!activeCallSession && (voiceCallManager.callId || voiceCallManager.roomId || shellState.selectedRoomId)) {
        const { displayName, phone } = resolveCallerIdentity(roomId, null);
        activeCallSession = {
          id: 'call_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8),
          callId: voiceCallManager.callId || '',
          roomId: roomId || '',
          participantId: voiceCallManager.peerId || '',
          participantName: displayName || peerName || (isVideo ? 'Video Call' : 'Voice Call'),
          participantPhone: phone || voiceCallManager.peerPhone || '',
          participantAvatar: '',
          direction: voiceCallManager.isInitiator ? 'outgoing' : 'incoming',
          callType: isVideo ? 'video' : 'voice',
          status: 'completed',
          startedAt: voiceCallManager.startTime || (Date.now() - ((voiceCallManager.durationSec || 0) * 1000)),
          connectedAt: voiceCallManager.callConnectedAt || null,
          endedAt: Date.now(),
          duration: voiceCallManager.durationSec || 0
        };
      }
      if (activeCallSession) {
        activeCallSession.endedAt = Date.now();
        if (state === CALL_STATE.DECLINED || state === CALL_STATE.REMOTE_DECLINED) {
          activeCallSession.status = 'declined';
          activeCallSession.duration = 0;
        } else if (!activeCallSession.connectedAt) {
          if (activeCallSession.direction === 'outgoing') {
            activeCallSession.status = 'cancelled';
          } else {
            activeCallSession.status = 'missed';
          }
          activeCallSession.duration = 0;
        } else {
          activeCallSession.status = 'completed';
          activeCallSession.duration = voiceCallManager.durationSec || Math.max(0, Math.round((activeCallSession.endedAt - activeCallSession.connectedAt) / 1000));
        }

        const callRoomId = activeCallSession.roomId || voiceCallManager.roomId || shellState.selectedRoomId;
        const authUserId = shellState.currentUser?.userId || shellState.userProfile?.userId;

        // 1. Persist to room call log and room messages state
        if (callRoomId) {
          recentlyInitiatedCalls.delete(String(callRoomId).trim());
          saveRoomCallRecord(callRoomId, activeCallSession, authUserId);
          const targetState = getOrCreateRoomMessagesState(callRoomId);
          targetState.addCallMessage(activeCallSession);
          if (shellState.selectedRoomId === callRoomId) {
            activeRoomMessagesState = targetState;
          }

          // If current room is actively selected, re-render and scroll
          if (shellState.selectedRoomId === callRoomId) {
            messagesEmpty?.classList.add('hidden');
            messagesLoading?.classList.add('hidden');
            messagesError?.classList.add('hidden');
            messagesScrollArea?.classList.remove('hidden');
            renderMessages();
            scrollToBottom(false);
          }

          // 2. Update conversation preview in sidebar without incrementing unread count
          const conv = shellState.conversations.find((c) => c.roomId === callRoomId);
          if (conv) {
            const isVideoCall = Boolean(activeCallSession.callType === 'video' || activeCallSession.isVideo);
            conv.lastMessage = {
              id: activeCallSession.id,
              preview: isVideoCall ? '📹 Video call' : '📞 Audio call',
              senderId: activeCallSession.direction === 'outgoing' ? authUserId : (activeCallSession.participantId || null),
              createdAt: new Date(activeCallSession.startedAt || Date.now()).toISOString(),
              kind: 'call',
              callType: activeCallSession.callType,
              isVideo: isVideoCall
            };
            renderConversationList();
          }
        }

        // 3. Add to global calls tab
        shellState.addCallRecord(activeCallSession);
        try {
          window.ollacoreDesktop?.db?.saveCallRecord?.(activeCallSession)?.catch?.(() => { });
        } catch (_) { }
        activeCallSession = null;
        if (currentNavigationDestination === 'calls') {
          renderCallsHistory();
        }
      }
    }

    updateVoiceCallUi(state, peerName, error);
  });

  voiceCallManager.on('modeChange', () => {
    updateVoiceCallUi(voiceCallManager.state, voiceCallManager.peerName, voiceCallManager.error);
  });

  voiceCallManager.on('timerTick', ({ formatted }) => {
    if (callTimerLabel) {
      callTimerLabel.textContent = formatted;
    }
    syncFloatingCallState();
  });

  voiceCallManager.on('muteChange', ({ isMuted }) => {
    if (callMuteIcon) callMuteIcon.innerHTML = isMuted ? UI_ICONS.micOff : UI_ICONS.mic;
    if (callMuteText) callMuteText.textContent = isMuted ? 'Unmute' : 'Mute';
    if (btnCallMute) {
      if (isMuted) {
        btnCallMute.classList.add('is-muted');
      } else {
        btnCallMute.classList.remove('is-muted');
      }
    }
    syncFloatingCallState();
  });

  voiceCallManager.on('cameraChange', ({ isCameraOff }) => {
    if (callCameraIcon) callCameraIcon.innerHTML = isCameraOff ? UI_ICONS.cameraOff : UI_ICONS.camera;
    if (callCameraText) callCameraText.textContent = isCameraOff ? 'Camera On' : 'Camera Off';
    if (btnCallCamera) {
      if (isCameraOff) {
        btnCallCamera.classList.add('is-camera-off');
      } else {
        btnCallCamera.classList.remove('is-camera-off');
      }
    }
    if (localVideoOffBadge) {
      if (isCameraOff) {
        localVideoOffBadge.classList.remove('hidden');
      } else {
        localVideoOffBadge.classList.add('hidden');
      }
    }
    if (localVideo) {
      localVideo.style.opacity = isCameraOff ? '0.2' : '1';
    }
    syncFloatingCallState();
    startFloatingVideoBridge();
  });

  voiceCallManager.on('remoteStream', () => {
    updateVoiceCallUi(voiceCallManager.state, voiceCallManager.peerName, voiceCallManager.error);
    syncFloatingCallState();
    startFloatingVideoBridge();
  });

  voiceCallManager.on('screenShareChange', ({ isScreenSharing }) => {
    updateVoiceCallUi(voiceCallManager.state, voiceCallManager.peerName, voiceCallManager.error);
    if (localVideoOffBadge) {
      if (isScreenSharing) {
        localVideoOffBadge.classList.add('hidden');
      } else if (voiceCallManager.isCameraOff) {
        localVideoOffBadge.classList.remove('hidden');
      } else {
        localVideoOffBadge.classList.add('hidden');
      }
    }
    if (localVideo) {
      localVideo.style.opacity = (isScreenSharing || !voiceCallManager.isCameraOff) ? '1' : '0.2';
    }
  });

  voiceCallManager.on('remoteScreenShareChange', () => {
    updateVoiceCallUi(voiceCallManager.state, voiceCallManager.peerName, voiceCallManager.error);
    syncFloatingCallState();
    startFloatingVideoBridge();
  });

  remoteVideo?.addEventListener('loadedmetadata', () => {
    startFloatingVideoBridge();
  });
  remoteVideo?.addEventListener('play', () => {
    startFloatingVideoBridge();
  });

  btnCallMaximize?.addEventListener('click', () => {
    isCallMaximized = !isCallMaximized;
    if (isCallFloating) {
      isCallFloating = false;
      voiceCallOverlay?.classList.remove('is-floating');
      voiceCallCard?.classList.remove('is-floating');
      if (callPopoutIcon) callPopoutIcon.innerHTML = UI_ICONS.popout;
      if (btnCallPopout) btnCallPopout.title = 'Pop out / Mini floating view';
    }
    if (isCallMaximized) {
      voiceCallCard?.classList.add('is-maximized');
      if (callMaximizeIcon) callMaximizeIcon.innerHTML = UI_ICONS.restoreMaximize;
      if (btnCallMaximize) btnCallMaximize.title = 'Restore size';
    } else {
      voiceCallCard?.classList.remove('is-maximized');
      if (callMaximizeIcon) callMaximizeIcon.innerHTML = UI_ICONS.maximize;
      if (btnCallMaximize) btnCallMaximize.title = 'Maximize call window';
    }
  });

  btnCallPopout?.addEventListener('click', () => {
    isCallFloating = !isCallFloating;
    if (isCallMaximized) {
      isCallMaximized = false;
      voiceCallCard?.classList.remove('is-maximized');
      if (callMaximizeIcon) callMaximizeIcon.innerHTML = UI_ICONS.maximize;
      if (btnCallMaximize) btnCallMaximize.title = 'Maximize call window';
    }
    if (isCallFloating) {
      voiceCallOverlay?.classList.add('is-floating');
      voiceCallCard?.classList.add('is-floating');
      if (callPopoutIcon) callPopoutIcon.innerHTML = UI_ICONS.restorePopout;
      if (btnCallPopout) btnCallPopout.title = 'Restore to modal';
    } else {
      voiceCallOverlay?.classList.remove('is-floating');
      voiceCallCard?.classList.remove('is-floating');
      if (callPopoutIcon) callPopoutIcon.innerHTML = UI_ICONS.popout;
      if (btnCallPopout) btnCallPopout.title = 'Pop out / Mini floating view';
    }
  });

  // 14. Real-time WebSocket connection state listener & event frames
  if (window.ollacoreDesktop?.chat) {
    window.ollacoreDesktop.chat.onStateChange((data) => {
      if (data?.state === 'connected') {
        outboxManager.flush({
          chatBridge: window.ollacoreDesktop?.chat,
          dbBridge: window.ollacoreDesktop?.db,
          requestToClientMap: requestToClient,
          getRoomState: (rId) => getOrCreateRoomMessagesState(rId),
          onStatusUpdate: (cid, status, rId) => {
            const targetState = getOrCreateRoomMessagesState(rId);
            targetState?.updateReceipt(cid, status, rId);
            if (shellState.selectedRoomId === rId) {
              updateMessageStatusInDom(cid, status);
            }
          }
        });
        if (shellState.selectedRoomId) {
          syncServerReadCursorForRoom(shellState.selectedRoomId).catch(() => { });
        }
      }
      // If currently inside a specific conversation, update with room state if available,
      // or with global connection state. If on home screen, display global connection state.
      if (!shellState.selectedRoomId) {
        updateWsIndicator(data?.state, data?.details);
        return;
      }
      if (data?.roomId && data.roomId !== shellState.selectedRoomId) {
        return;
      }
      updateWsIndicator(data?.state, data?.details, data?.roomId);
    });

    // Window online/offline connectivity listeners
    window.addEventListener('offline', () => {
      updateWsIndicator('disconnected', { message: 'Waiting for network', label: 'Waiting for network' });
    });

    window.addEventListener('online', async () => {
      updateWsIndicator('reconnecting', { message: 'Reconnecting...', label: 'Reconnecting...' });
      try {
        if (window.ollacoreDesktop?.chat?.reconnect) {
          await window.ollacoreDesktop.chat.reconnect();
        }
        if (shellState.selectedRoomId && window.ollacoreDesktop?.chat?.connect) {
          await window.ollacoreDesktop.chat.connect(shellState.selectedRoomId);
        } else if (!shellState.selectedRoomId && window.ollacoreDesktop?.chat?.connect) {
          await window.ollacoreDesktop.chat.connect();
        }
      } catch (err) {
        console.warn('[App] Reconnection error on online event:', err);
      }
      if (shellState.selectedRoomId) {
        syncServerReadCursorForRoom(shellState.selectedRoomId).catch(() => { });
      }
      outboxManager.flush({
        chatBridge: window.ollacoreDesktop?.chat,
        dbBridge: window.ollacoreDesktop?.db,
        requestToClientMap: requestToClient,
        getRoomState: (rId) => getOrCreateRoomMessagesState(rId),
        onStatusUpdate: (cid, status, rId) => {
          const targetState = getOrCreateRoomMessagesState(rId);
          targetState?.updateReceipt(cid, status, rId);
          if (shellState.selectedRoomId === rId) {
            updateMessageStatusInDom(cid, status);
          }
        }
      });
    });

    if (window.ollacoreDesktop.chat.onEvent) {
      window.ollacoreDesktop.chat.onEvent(handleRealtimeChatEvent);
    }

    if (window.ollacoreDesktop.chat.onNavigateRoom) {
      if (typeof navigateRoomUnsubscribe === 'function') {
        try { navigateRoomUnsubscribe(); } catch { }
        navigateRoomUnsubscribe = null;
      }
      navigateRoomUnsubscribe = window.ollacoreDesktop.chat.onNavigateRoom((roomId, messageId) => {
        if (!roomId) return;
        try { closeSettings(); } catch { }
        try { closeBackupModal(); } catch { }
        try { closeNewChatModal(); } catch { }
        if (messageId) {
          selectConversation(roomId, { forceReload: true, targetMessageId: messageId });
        } else {
          selectConversation(roomId, { forceReload: true });
        }
      });
    }

    if (window.ollacoreDesktop.app?.onIntent) {
      window.ollacoreDesktop.app.onIntent((intent) => {
        handleAppIntent(intent);
      });
    }

    try {
      const initialWs = await window.ollacoreDesktop.chat.getState();
      updateWsIndicator(initialWs, null, shellState.selectedRoomId);
    } catch {
      updateWsIndicator('disconnected');
    }
  }

  // 13. Restore initial authentication state
  try {
    const state = await window.ollacoreDesktop.auth.getState();
    if (state && state.step === 'authenticated') {
      updateProfileDisplay(state.session);
      showScreen('authenticated');
    } else if (state && state.step === 'otp') {
      if (displayOtpPhone) displayOtpPhone.textContent = state.phone;
      showScreen('otp');
      if (state.cooldownRemaining > 0) {
        startCooldownTimer(state.cooldownRemaining);
      }
    } else {
      showScreen('phone');
    }
  } catch {
    showScreen('phone');
  }

  // 14. Listen for external profile updates from main process
  if (window.ollacoreDesktop?.auth?.onProfileUpdated) {
    window.ollacoreDesktop.auth.onProfileUpdated((updatedSession) => {
      if (updatedSession) {
        updateProfileDisplay(updatedSession);
        renderConversationList();
        renderArchivedList();
      }
    });
  }

  // 15. Window focus & visibility listeners for read cursor advancement
  window.addEventListener('focus', () => {
    isMainWindowFocused = true;
    advanceReadCursorForActiveRoom();
  });
  window.addEventListener('blur', () => {
    isMainWindowFocused = false;
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      isMainWindowVisible = false;
    } else {
      isMainWindowVisible = true;
    }
    if (isAppActiveAndFocused()) {
      advanceReadCursorForActiveRoom();
    }
  });

  if (typeof window.ollacoreDesktop?.app?.getWindowState === 'function') {
    window.ollacoreDesktop.app.getWindowState().then((st) => {
      if (st) {
        if (typeof st.isMinimized === 'boolean') isMainWindowMinimized = Boolean(st.isMinimized);
        if (typeof st.isVisible === 'boolean') isMainWindowVisible = Boolean(st.isVisible);
        if (typeof st.isFocused === 'boolean') isMainWindowFocused = Boolean(st.isFocused);
      }
    }).catch(() => { });
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

if (typeof window !== 'undefined') {
  window.__TEST_HOOKS__ = {
    shellState,
    isAppActiveAndFocused: () => isAppActiveAndFocused(),
    setWindowStateForTesting: (st) => {
      if (typeof st?.isMinimized === 'boolean') isMainWindowMinimized = st.isMinimized;
      if (typeof st?.isVisible === 'boolean') isMainWindowVisible = st.isVisible;
      if (typeof st?.isFocused === 'boolean') isMainWindowFocused = st.isFocused;
    },
    roomMessagesState,
    getOrCreateRoomMessagesState,
    handleRealtimeChatEvent,
    attachmentUrls,
    handlePickAttachment,
    processAndUploadFile,
    selectConversation,
    showScreen,
    renderMessages,
    voiceCallManager,
    outboxManager,
    forwardSingleMessage,
    executeForwarding,
    loadMessagesForRoom,
    syncServerReadCursorForRoom,
    enterMessageSelectionMode,
    exitMessageSelectionMode,
    toggleMessageSelectionUI,
    updateSelectionToolbar,
    openForwardModal,
    closeForwardModal,
    isForwardingInProgress: () => isForwardingInProgress,
    openNewChatModal,
    closeNewChatModal,
    switchNewChatTab,
    renderGroupContactsList,
    directDraft,
    groupDraft,
    handleCreateGroup,
    handleAddGroupMember,
    updateCreateGroupButtonState,
    openSettings,
    closeSettings,
    getActiveTopDateLabel,
    updateFloatingDateOnScroll,
    hideFloatingDateIndicator,
    handleToggleReaction,
    openReactionPicker,
    closeReactionPicker,
    REACTION_EMOJIS,
    roomSavedScrollPositions,
    saveRoomScrollPosition,
    restoreRoomScrollPosition,
    appendMessageToDom,
    updateMessageElementInDom,
    removeMessageElementFromDom,
    captureScrollAnchor,
    restoreScrollAnchor,
    recentUnmatchedAcks,
    loadOlderMessages,
    markUserScrolled,
    lastUserScrollActionTime,
    createAndRecordGroupSystemMessage,
    createAndRecordGroupDescriptionSystemMessage,
    formatGroupDescriptionSystemText,
    resolveParticipantName,
    recentSystemEventsMap,
    chatSearchState,
    closeChatSearch,
    openStarredMessages,
    updateContactInfoStarredCount
  };
}
