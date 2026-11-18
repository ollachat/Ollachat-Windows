/**
 * floating-call.js
 * =========================================================================
 * Renderer logic for OllaChat Windows Dedicated Floating Call Window.
 * Communicates via window.ollacoreDesktop.floatingCall context bridge.
 * =========================================================================
 */

function formatDuration(seconds = 0) {
  const s = Math.max(0, Math.floor(seconds));
  const mins = Math.floor(s / 60);
  const secs = s % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function renderSynchronizedDuration(seconds = 0) {
  const formatted = formatDuration(seconds);
  if (audioTimer) audioTimer.textContent = formatted;
  if (videoTimer) videoTimer.textContent = formatted;
  if (compactTimer) compactTimer.textContent = formatted;
}

function getInitials(name = '') {
  if (!name || typeof name !== 'string') return '?';
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

const UI_ICONS = {
  micOn: '<path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="22"/>',
  micOff: '<line x1="2" y1="2" x2="22" y2="22"/><path d="M18.89 13.23A7.12 7.12 0 0 0 19 12v-2"/><path d="M5 10v2a7 7 0 0 0 12 5"/><path d="M15 9.34V5a3 3 0 0 0-5.68-1.33"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12"/><line x1="12" y1="19" x2="12" y2="22"/>',
  cameraOn: '<path d="m22 8-6 4 6 4V8Z"/><rect width="14" height="12" x="2" y="6" rx="2" ry="2"/>',
  cameraOff: '<line x1="2" y1="2" x2="22" y2="22"/><path d="M10.41 10.41a2 2 0 0 0 2.83 2.83"/><path d="M13.5 6.5A6.5 6.5 0 0 1 20 13c0 .87-.17 1.7-.48 2.46L22 17.92V8l-6 4v-.5a6.5 6.5 0 0 0-6.5-6.5c-.87 0-1.7.17-2.46.48L9.08 7.42A6.47 6.47 0 0 1 13.5 6.5Z"/><rect width="14" height="12" x="2" y="6" rx="2" ry="2"/>'
};

// DOM Elements
const viewCompact = document.getElementById('view-compact');
const compactWidgetBody = document.getElementById('compact-widget-body');
const compactAvatar = document.getElementById('compact-avatar');
const compactPeerName = document.getElementById('compact-peer-name');
const compactTimer = document.getElementById('compact-timer');
const btnCompactRestore = document.getElementById('btn-compact-restore');

const viewIncoming = document.getElementById('view-incoming');
const incomingAvatar = document.getElementById('incoming-avatar');
const incomingPeerName = document.getElementById('incoming-peer-name');
const incomingSubtitle = document.getElementById('incoming-subtitle');
const btnIncomingMute = document.getElementById('btn-incoming-mute');
const incomingMuteIcon = document.getElementById('incoming-mute-icon');
const btnIncomingAccept = document.getElementById('btn-incoming-accept');
const btnIncomingDecline = document.getElementById('btn-incoming-decline');
const btnIncomingRestore = document.getElementById('btn-incoming-restore');

const viewOutgoing = document.getElementById('view-outgoing');
const outgoingAvatar = document.getElementById('outgoing-avatar');
const outgoingPeerName = document.getElementById('outgoing-peer-name');
const outgoingSubtitle = document.getElementById('outgoing-subtitle');
const btnOutgoingMute = document.getElementById('btn-outgoing-mute');
const outgoingMuteIcon = document.getElementById('outgoing-mute-icon');
const btnOutgoingHangup = document.getElementById('btn-outgoing-hangup');
const btnOutgoingRestore = document.getElementById('btn-outgoing-restore');

const viewAudio = document.getElementById('view-audio');
const audioAvatar = document.getElementById('audio-avatar');
const audioPeerName = document.getElementById('audio-peer-name');
const audioTimer = document.getElementById('audio-timer');
const btnAudioMute = document.getElementById('btn-audio-mute');
const audioMuteIcon = document.getElementById('audio-mute-icon');
const btnAudioHangup = document.getElementById('btn-audio-hangup');
const btnAudioRestore = document.getElementById('btn-audio-restore');

const viewVideo = document.getElementById('view-video');
const floatingRemoteVideo = document.getElementById('floating-remote-video');
const floatingVideoPlaceholder = document.getElementById('floating-video-placeholder');
const videoAvatarPlaceholder = document.getElementById('video-avatar-placeholder');
const videoPeerName = document.getElementById('video-peer-name');
const videoTimer = document.getElementById('video-timer');
const btnVideoMute = document.getElementById('btn-video-mute');
const videoMuteIcon = document.getElementById('video-mute-icon');
const btnVideoCamera = document.getElementById('btn-video-camera');
const videoCameraIcon = document.getElementById('video-camera-icon');
const btnVideoScreenshare = document.getElementById('btn-video-screenshare');
const btnVideoAddParticipant = document.getElementById('btn-video-add-participant');
const btnAudioAddParticipant = document.getElementById('btn-audio-add-participant');
const btnVideoHangup = document.getElementById('btn-video-hangup');
const btnVideoRestore = document.getElementById('btn-video-restore');

const floatingLocalVideoContainer = document.getElementById('floating-local-video-container');
const floatingLocalVideo = document.getElementById('floating-local-video');
const floatingLocalVideoOff = document.getElementById('floating-local-video-off');

// Floating Modal Elements: Screen Share & Add People
const floatingScreenshareModal = document.getElementById('floating-screenshare-modal');
const btnCloseFloatingScreenshare = document.getElementById('btn-close-floating-screenshare');
const btnCancelFloatingScreenshare = document.getElementById('btn-cancel-floating-screenshare');
const btnConfirmFloatingScreenshare = document.getElementById('btn-confirm-floating-screenshare');
const tabFloatingScreens = document.getElementById('tab-floating-screens');
const tabFloatingWindows = document.getElementById('tab-floating-windows');
const floatingScreenshareGrid = document.getElementById('floating-screenshare-grid');
const floatingScreenshareLoading = document.getElementById('floating-screenshare-loading');
const floatingScreenshareEmpty = document.getElementById('floating-screenshare-empty');

const floatingAddModal = document.getElementById('floating-add-participant-modal');
const btnCloseFloatingAdd = document.getElementById('btn-close-floating-add');
const btnDoneFloatingAdd = document.getElementById('btn-done-floating-add');
const floatingParticipantSearch = document.getElementById('floating-participant-search');
const floatingParticipantLoading = document.getElementById('floating-participant-loading');
const floatingParticipantEmpty = document.getElementById('floating-participant-empty');
const floatingParticipantList = document.getElementById('floating-participant-list');

let currentFloatingSources = [];
let activeScreenshareTab = 'screen';
let selectedFloatingSourceId = null;
let allFloatingParticipants = [];

const btnHeaderMinimize = document.getElementById('btn-header-minimize');
const btnHeaderRestore = document.getElementById('btn-header-restore');
const btnHeaderClose = document.getElementById('btn-header-close');

let currentState = null;
let currentMode = 'detailed'; // 'compact' | 'detailed'
let bridgePeerConnection = null;
let remotePlaybackRejectionLogged = false;
let lastFloatingUiDiagnostic = '';

function logFloatingUiSynchronization(state) {
  const diagnostic = {
    event: 'floating_ui_synchronized',
    direction: state?.direction || 'unknown',
    state: state?.state || 'idle',
    localOwnershipEpoch: state?.localOwnershipEpoch || 0,
    signalingCorrelation: state?.signalingCorrelation || 'expected_unavailable',
    ownsManagerState: state?.ownsManagerState === true,
    ownsPeer: state?.ownsPeer === true
  };
  const key = Object.values(diagnostic).join('|');
  if (key === lastFloatingUiDiagnostic) return;
  lastFloatingUiDiagnostic = key;
  console.info('[FloatingCall] CALL_UI_LIFECYCLE', diagnostic);
}

function applyMode(mode) {
  currentMode = mode || 'detailed';
  if (currentMode === 'compact') {
    document.body.classList.add('is-compact-mode');
    document.body.classList.remove('is-detailed-mode');
    viewCompact?.classList.remove('hidden');
    viewIncoming?.classList.add('hidden');
    viewOutgoing?.classList.add('hidden');
    viewAudio?.classList.add('hidden');
    viewVideo?.classList.add('hidden');
  } else {
    document.body.classList.remove('is-compact-mode');
    document.body.classList.add('is-detailed-mode');
    viewCompact?.classList.add('hidden');
    if (currentState) {
      renderState(currentState);
    }
  }
}

function renderState(state) {
  if (!state) return;
  currentState = state;
  logFloatingUiSynchronization(state);

  const isOutgoing = (state.state === 'outgoing_ringing');
  const isIncoming = (state.state === 'incoming_ringing');
  const isVideo = Boolean(state.isVideo);
  const peerName = state.peerName || state.peerUserId || 'Contact';
  const initials = getInitials(peerName);

  // Duration is authoritative in the main renderer/manager and only rendered here.
  if (compactPeerName) compactPeerName.textContent = peerName;
  renderSynchronizedDuration(state.state === 'connected' ? (state.duration || 0) : 0);

  if (currentMode === 'compact') {
    viewCompact?.classList.remove('hidden');
    viewIncoming?.classList.add('hidden');
    viewOutgoing?.classList.add('hidden');
    viewAudio?.classList.add('hidden');
    viewVideo?.classList.add('hidden');
  } else if (isOutgoing) {
    viewOutgoing?.classList.remove('hidden');
    viewIncoming?.classList.add('hidden');
    viewAudio?.classList.add('hidden');
    viewVideo?.classList.add('hidden');

    if (outgoingAvatar) outgoingAvatar.textContent = initials;
    if (outgoingPeerName) outgoingPeerName.textContent = peerName;
    if (outgoingSubtitle) {
      outgoingSubtitle.textContent = isVideo ? 'Calling (video)...' : 'Calling...';
    }

    if (state.isMuted) {
      btnOutgoingMute?.classList.add('btn-muted');
      if (outgoingMuteIcon) outgoingMuteIcon.innerHTML = UI_ICONS.micOff;
    } else {
      btnOutgoingMute?.classList.remove('btn-muted');
      if (outgoingMuteIcon) outgoingMuteIcon.innerHTML = UI_ICONS.micOn;
    }
  } else if (isIncoming) {
    viewIncoming?.classList.remove('hidden');
    viewOutgoing?.classList.add('hidden');
    viewAudio?.classList.add('hidden');
    viewVideo?.classList.add('hidden');

    if (incomingAvatar) incomingAvatar.textContent = initials;
    if (incomingPeerName) incomingPeerName.textContent = peerName;
    if (incomingSubtitle) {
      incomingSubtitle.textContent = `Incoming ${isVideo ? 'video' : 'voice'} call...`;
    }

    if (state.isMuted) {
      btnIncomingMute?.classList.add('btn-muted');
      if (incomingMuteIcon) incomingMuteIcon.innerHTML = UI_ICONS.micOff;
    } else {
      btnIncomingMute?.classList.remove('btn-muted');
      if (incomingMuteIcon) incomingMuteIcon.innerHTML = UI_ICONS.micOn;
    }
  } else if (isVideo) {
    viewVideo?.classList.remove('hidden');
    viewOutgoing?.classList.add('hidden');
    viewIncoming?.classList.add('hidden');
    viewAudio?.classList.add('hidden');

    if (videoPeerName) videoPeerName.textContent = peerName;
    if (videoAvatarPlaceholder) videoAvatarPlaceholder.textContent = initials;
    if (videoTimer) videoTimer.textContent = formatDuration(state.duration || 0);

    const hasLiveVideo = Boolean(floatingRemoteVideo?.srcObject);
    const placeholderText = floatingVideoPlaceholder?.querySelector('span');
    if (!hasLiveVideo) {
      floatingVideoPlaceholder?.classList.remove('hidden');
      if (placeholderText) {
        placeholderText.textContent = state.state === 'connecting'
          ? 'Connecting video...'
          : (state.isCameraOff ? 'Camera is off' : 'Waiting for video...');
      }
      if (floatingRemoteVideo) floatingRemoteVideo.style.opacity = '0';
    } else {
      floatingVideoPlaceholder?.classList.add('hidden');
      if (floatingRemoteVideo) floatingRemoteVideo.style.opacity = '1';
    }

    // Update Mute Button State
    if (state.isMuted) {
      btnVideoMute?.classList.add('btn-muted');
      if (videoMuteIcon) videoMuteIcon.innerHTML = UI_ICONS.micOff;
    } else {
      btnVideoMute?.classList.remove('btn-muted');
      if (videoMuteIcon) videoMuteIcon.innerHTML = UI_ICONS.micOn;
    }

    // Camera button visibility: always available in video call mode
    btnVideoCamera?.classList.remove('hidden');

    // Update Camera Button State
    if (state.isCameraOff) {
      btnVideoCamera?.classList.add('btn-camera-off');
      if (videoCameraIcon) videoCameraIcon.innerHTML = UI_ICONS.cameraOff;
    } else {
      btnVideoCamera?.classList.remove('btn-camera-off');
      if (videoCameraIcon) videoCameraIcon.innerHTML = UI_ICONS.cameraOn;
    }

    // Update Local PIP Camera Thumbnail State
    if (floatingLocalVideoContainer) {
      if (state.isCameraOff) {
        floatingLocalVideoOff?.classList.remove('hidden');
        if (floatingLocalVideo) floatingLocalVideo.style.opacity = '0';
      } else {
        floatingLocalVideoOff?.classList.add('hidden');
        if (floatingLocalVideo) floatingLocalVideo.style.opacity = '1';
      }
    }

    // Update Screen Share Button State
    if (btnVideoScreenshare) {
      btnVideoScreenshare.classList.toggle('btn-sharing', Boolean(state.isScreenSharing));
      btnVideoScreenshare.title = state.isScreenSharing ? 'Stop sharing screen' : 'Share screen';
    }
  } else {
    // Audio call
    viewAudio?.classList.remove('hidden');
    viewOutgoing?.classList.add('hidden');
    viewIncoming?.classList.add('hidden');
    viewVideo?.classList.add('hidden');

    if (audioAvatar) audioAvatar.textContent = initials;
    if (audioPeerName) audioPeerName.textContent = peerName;
    if (audioTimer) audioTimer.textContent = formatDuration(state.duration || 0);

    // Update Mute Button State
    if (state.isMuted) {
      btnAudioMute?.classList.add('btn-muted');
      if (audioMuteIcon) audioMuteIcon.innerHTML = UI_ICONS.micOff;
    } else {
      btnAudioMute?.classList.remove('btn-muted');
      if (audioMuteIcon) audioMuteIcon.innerHTML = UI_ICONS.micOn;
    }
  }

  // No local interval: timer progression arrives through synchronized IPC state.
}

// Setup local WebRTC loopback video bridge with mainWindow
function initLocalVideoBridge() {
  const bridge = window.ollacoreDesktop?.floatingCall;
  if (!bridge || typeof RTCPeerConnection === 'undefined') return;

  if (floatingRemoteVideo) {
    floatingRemoteVideo.muted = true;
    floatingRemoteVideo.playsInline = true;
  }
  if (floatingLocalVideo) {
    floatingLocalVideo.muted = true;
    floatingLocalVideo.playsInline = true;
  }

  let signalTrackMeta = null;
  let pendingCandidates = [];

  function createBridgePeerConnection(meta) {
    if (bridgePeerConnection) {
      try { bridgePeerConnection.close(); } catch { }
      bridgePeerConnection = null;
    }

    const pc = new RTCPeerConnection();
    bridgePeerConnection = pc;

    pc.ontrack = (event) => {
      const track = event.track;
      const stream = event.streams[0] || new MediaStream([track]);
      const mid = event.transceiver?.mid;
      const transceivers = pc.getTransceivers ? pc.getTransceivers() : [];
      const tcIndex = event.transceiver ? transceivers.indexOf(event.transceiver) : -1;

      let isLocalTrack = false;
      if (meta) {
        if (meta.localMid && mid === meta.localMid) {
          isLocalTrack = true;
        } else if (meta.remoteMid && mid === meta.remoteMid) {
          isLocalTrack = false;
        } else if (meta.localIndex !== undefined && meta.localIndex >= 0 && tcIndex === meta.localIndex) {
          isLocalTrack = true;
        } else if (meta.remoteIndex !== undefined && meta.remoteIndex >= 0 && tcIndex === meta.remoteIndex) {
          isLocalTrack = false;
        } else if (meta.localStreamId && stream.id === meta.localStreamId) {
          isLocalTrack = true;
        } else if (meta.localId && !meta.remoteId) {
          isLocalTrack = true;
        }
      } else {
        isLocalTrack = (tcIndex === 1);
      }

      if (isLocalTrack) {
        if (floatingLocalVideo) {
          floatingLocalVideo.srcObject = stream;
          floatingLocalVideo.muted = true;
          floatingLocalVideo.playsInline = true;
          floatingLocalVideo.style.opacity = '1';
          floatingLocalVideoOff?.classList.add('hidden');
          floatingLocalVideo.play().catch(() => { });
        }
      } else {
        if (floatingRemoteVideo) {
          floatingRemoteVideo.srcObject = stream;
          floatingRemoteVideo.muted = true;
          floatingRemoteVideo.playsInline = true;
          floatingRemoteVideo.style.opacity = '1';
          floatingVideoPlaceholder?.classList.add('hidden');
          floatingRemoteVideo.play().then(() => {
            remotePlaybackRejectionLogged = false;
          }).catch((error) => {
            if (remotePlaybackRejectionLogged) return;
            remotePlaybackRejectionLogged = true;
            console.warn('[FloatingCall] REMOTE_PLAYBACK_REJECTED', {
              kind: 'video',
              errorName: error?.name || 'Error'
            });
          });
        }
      }
    };

    pc.onicecandidate = (event) => {
      if (event.candidate && event.candidate.candidate) {
        bridge.bridgeSignal({
          type: 'candidate',
          candidate: {
            candidate: event.candidate.candidate,
            sdpMid: event.candidate.sdpMid,
            sdpMLineIndex: event.candidate.sdpMLineIndex
          }
        }).catch(() => { });
      }
    };

    return pc;
  }

  let activePc = createBridgePeerConnection(null);

  bridge.onBridgeSignal(async (signal) => {
    if (!signal) return;
    try {
      if (signal.type === 'call-participants-list') {
        floatingParticipantLoading?.classList.add('hidden');
        allFloatingParticipants = signal.participants || [];
        renderFloatingParticipants(allFloatingParticipants);
        return;
      }
      if (signal.type === 'offer') {
        signalTrackMeta = signal.tracks || null;
        activePc = createBridgePeerConnection(signalTrackMeta);
        await activePc.setRemoteDescription(new RTCSessionDescription(signal.offer));
        for (const cand of pendingCandidates) {
          try { await activePc.addIceCandidate(new RTCIceCandidate(cand)); } catch (_) { }
        }
        pendingCandidates = [];
        const answer = await activePc.createAnswer();
        await activePc.setLocalDescription(answer);
        await bridge.bridgeSignal({
          type: 'answer',
          answer: {
            type: answer.type,
            sdp: answer.sdp
          }
        });
      } else if (signal.type === 'candidate' && signal.candidate && signal.candidate.candidate) {
        if (!activePc.remoteDescription) {
          pendingCandidates.push(signal.candidate);
        } else {
          try { await activePc.addIceCandidate(new RTCIceCandidate(signal.candidate)); } catch (_) { }
        }
      }
    } catch (err) {
      console.warn('[FloatingCall] Bridge signal error:', err);
    }
  });

  // Notify mainWindow that floating call window is initialized and ready for video bridge
  bridge.bridgeSignal({ type: 'ready' }).catch(() => { });
}

// In-Window Screen Share Picker Logic
async function openFloatingScreensharePicker() {
  if (currentState?.isScreenSharing) {
    window.ollacoreDesktop?.floatingCall?.sendAction({ type: 'stop-screenshare' });
    return;
  }
  selectedFloatingSourceId = null;
  activeScreenshareTab = 'screen';
  tabFloatingScreens?.classList.add('active');
  tabFloatingWindows?.classList.remove('active');
  if (btnConfirmFloatingScreenshare) btnConfirmFloatingScreenshare.disabled = true;
  floatingScreenshareModal?.classList.remove('hidden');
  floatingScreenshareLoading?.classList.remove('hidden');
  floatingScreenshareEmpty?.classList.add('hidden');
  if (floatingScreenshareGrid) floatingScreenshareGrid.innerHTML = '';

  try {
    const fetcher = window.ollacoreDesktop?.desktopCapture?.getSources || window.ollacoreDesktop?.rtc?.getDesktopSources;
    if (!fetcher) {
      throw new Error('Screen capture not supported');
    }
    currentFloatingSources = await fetcher({ types: ['screen', 'window'] });
    floatingScreenshareLoading?.classList.add('hidden');
    renderFloatingScreenshareGrid();
  } catch (err) {
    console.warn('[FloatingCall] Failed to load screen sources:', err);
    floatingScreenshareLoading?.classList.add('hidden');
    floatingScreenshareEmpty?.classList.remove('hidden');
    if (floatingScreenshareEmpty) floatingScreenshareEmpty.textContent = err?.message || 'Failed to load screens/windows';
  }
}

function closeFloatingScreensharePicker() {
  floatingScreenshareModal?.classList.add('hidden');
  selectedFloatingSourceId = null;
  currentFloatingSources = [];
}

function renderFloatingScreenshareGrid() {
  if (!floatingScreenshareGrid) return;
  floatingScreenshareGrid.innerHTML = '';
  const filtered = currentFloatingSources.filter((s) => s.type === activeScreenshareTab);
  if (filtered.length === 0) {
    floatingScreenshareEmpty?.classList.remove('hidden');
    return;
  }
  floatingScreenshareEmpty?.classList.add('hidden');

  filtered.forEach((source) => {
    const item = document.createElement('div');
    item.className = 'screenshare-item' + (selectedFloatingSourceId === source.id ? ' selected' : '');
    item.title = source.name;

    const thumbBox = document.createElement('div');
    thumbBox.className = 'screenshare-thumb-box';
    if (source.thumbnail) {
      const img = document.createElement('img');
      img.className = 'screenshare-thumb-img';
      img.src = source.thumbnail;
      img.alt = source.name;
      thumbBox.appendChild(img);
    }
    item.appendChild(thumbBox);

    const nameEl = document.createElement('div');
    nameEl.className = 'screenshare-name';
    nameEl.textContent = source.name;
    item.appendChild(nameEl);

    item.addEventListener('click', () => {
      selectedFloatingSourceId = source.id;
      floatingScreenshareGrid.querySelectorAll('.screenshare-item').forEach((el) => el.classList.remove('selected'));
      item.classList.add('selected');
      if (btnConfirmFloatingScreenshare) btnConfirmFloatingScreenshare.disabled = false;
    });

    item.addEventListener('dblclick', () => {
      selectedFloatingSourceId = source.id;
      confirmFloatingScreenshare();
    });

    floatingScreenshareGrid.appendChild(item);
  });
}

function confirmFloatingScreenshare() {
  if (!selectedFloatingSourceId) return;
  const srcId = selectedFloatingSourceId;
  closeFloatingScreensharePicker();
  window.ollacoreDesktop?.floatingCall?.sendAction({
    type: 'start-screenshare',
    sourceId: srcId
  });
}

tabFloatingScreens?.addEventListener('click', () => {
  activeScreenshareTab = 'screen';
  tabFloatingScreens.classList.add('active');
  tabFloatingWindows?.classList.remove('active');
  selectedFloatingSourceId = null;
  if (btnConfirmFloatingScreenshare) btnConfirmFloatingScreenshare.disabled = true;
  renderFloatingScreenshareGrid();
});

tabFloatingWindows?.addEventListener('click', () => {
  activeScreenshareTab = 'window';
  tabFloatingWindows.classList.add('active');
  tabFloatingScreens?.classList.remove('active');
  selectedFloatingSourceId = null;
  if (btnConfirmFloatingScreenshare) btnConfirmFloatingScreenshare.disabled = true;
  renderFloatingScreenshareGrid();
});

btnConfirmFloatingScreenshare?.addEventListener('click', confirmFloatingScreenshare);
btnCancelFloatingScreenshare?.addEventListener('click', closeFloatingScreensharePicker);
btnCloseFloatingScreenshare?.addEventListener('click', closeFloatingScreensharePicker);
floatingScreenshareModal?.addEventListener('click', (e) => {
  if (e.target === floatingScreenshareModal) closeFloatingScreensharePicker();
});

// In-Window Add Participants Modal Logic
function openFloatingAddParticipantModal() {
  floatingAddModal?.classList.remove('hidden');
  floatingParticipantLoading?.classList.remove('hidden');
  floatingParticipantEmpty?.classList.add('hidden');
  if (floatingParticipantSearch) floatingParticipantSearch.value = '';
  if (floatingParticipantList) floatingParticipantList.innerHTML = '';
  window.ollacoreDesktop?.floatingCall?.sendAction({ type: 'get-call-participants' });
}

function closeFloatingAddParticipantModal() {
  floatingAddModal?.classList.add('hidden');
}

function renderFloatingParticipants(participants) {
  if (!floatingParticipantList) return;
  floatingParticipantList.innerHTML = '';
  if (!participants || participants.length === 0) {
    floatingParticipantEmpty?.classList.remove('hidden');
    return;
  }
  floatingParticipantEmpty?.classList.add('hidden');

  participants.forEach((p) => {
    const item = document.createElement('div');
    item.className = 'participant-item';

    const info = document.createElement('div');
    info.className = 'participant-info';

    const avatar = document.createElement('div');
    avatar.className = 'participant-avatar';
    avatar.textContent = getInitials(p.name);
    info.appendChild(avatar);

    const meta = document.createElement('div');
    meta.className = 'participant-meta';
    const nameEl = document.createElement('span');
    nameEl.className = 'participant-name';
    nameEl.textContent = p.name || 'Member';
    meta.appendChild(nameEl);
    if (p.phone) {
      const phoneEl = document.createElement('span');
      phoneEl.className = 'participant-phone';
      phoneEl.textContent = p.phone;
      meta.appendChild(phoneEl);
    }
    info.appendChild(meta);
    item.appendChild(info);

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn-invite' + (p.isInvited ? ' invited' : '');
    btn.textContent = p.isInvited ? 'Invited' : 'Invite';
    btn.disabled = Boolean(p.isInvited);

    btn.addEventListener('click', () => {
      btn.textContent = 'Inviting...';
      btn.disabled = true;
      window.ollacoreDesktop?.floatingCall?.sendAction({
        type: 'invite-participant',
        targetUserId: p.id
      });
      p.isInvited = true;
      btn.textContent = 'Invited';
      btn.classList.add('invited');
    });

    item.appendChild(btn);
    floatingParticipantList.appendChild(item);
  });
}

floatingParticipantSearch?.addEventListener('input', (e) => {
  const query = (e.target?.value || '').trim().toLowerCase();
  if (!query) {
    renderFloatingParticipants(allFloatingParticipants);
    return;
  }
  const filtered = allFloatingParticipants.filter((p) => {
    return (p.name || '').toLowerCase().includes(query) || (p.phone || '').toLowerCase().includes(query);
  });
  renderFloatingParticipants(filtered);
});

btnCloseFloatingAdd?.addEventListener('click', closeFloatingAddParticipantModal);
btnDoneFloatingAdd?.addEventListener('click', closeFloatingAddParticipantModal);
floatingAddModal?.addEventListener('click', (e) => {
  if (e.target === floatingAddModal) closeFloatingAddParticipantModal();
});

// Wire Event Handlers
function wireAction(btn, action) {
  btn?.addEventListener('click', (e) => {
    e.stopPropagation();
    window.ollacoreDesktop?.floatingCall?.sendAction(action);
  });
}

wireAction(btnHeaderRestore, 'restore');
wireAction(btnCompactRestore, 'restore');
wireAction(btnIncomingRestore, 'restore');
wireAction(btnOutgoingRestore, 'restore');
wireAction(btnAudioRestore, 'restore');
wireAction(btnVideoRestore, 'restore');

wireAction(btnIncomingMute, 'toggle-mute');
wireAction(btnOutgoingMute, 'toggle-mute');

wireAction(btnIncomingAccept, 'accept');
wireAction(btnIncomingDecline, 'decline');

wireAction(btnOutgoingHangup, 'end');

wireAction(btnAudioMute, 'toggle-mute');
wireAction(btnVideoMute, 'toggle-mute');
wireAction(btnVideoCamera, 'toggle-camera');

btnVideoScreenshare?.addEventListener('click', (e) => {
  e.stopPropagation();
  openFloatingScreensharePicker();
});

btnVideoAddParticipant?.addEventListener('click', (e) => {
  e.stopPropagation();
  openFloatingAddParticipantModal();
});

btnAudioAddParticipant?.addEventListener('click', (e) => {
  e.stopPropagation();
  openFloatingAddParticipantModal();
});

wireAction(btnAudioHangup, 'end');
wireAction(btnVideoHangup, 'end');

function updateMaximizeButton(isMaximized) {
  if (!btnHeaderRestore) return;
  btnHeaderRestore.title = isMaximized ? 'Restore Down' : 'Maximize';
  btnHeaderRestore.setAttribute('aria-label', isMaximized ? 'Restore Down' : 'Maximize');
  if (isMaximized) {
    // Windows 10/11 standard overlapping boxes Restore Down icon
    btnHeaderRestore.innerHTML = '<svg viewBox="0 0 10 10"><path d="M3.5 1.5h5v5h-1v-4h-4v-1z" fill="currentColor"/><rect x="1.5" y="3.5" width="5" height="5" fill="none" stroke="currentColor" stroke-width="1"/></svg>';
  } else {
    // Windows 10/11 standard single square Maximize icon
    btnHeaderRestore.innerHTML = '<svg viewBox="0 0 10 10"><rect x="1.5" y="1.5" width="7" height="7" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>';
  }
}

window.ollacoreDesktop?.floatingCall?.onMaximizedState?.((isMaximized) => {
  updateMaximizeButton(isMaximized);
});

btnHeaderMinimize?.addEventListener('click', (e) => {
  e.stopPropagation();
  if (typeof window.ollacoreDesktop?.floatingCall?.minimize === 'function') {
    window.ollacoreDesktop.floatingCall.minimize();
  }
});

btnHeaderRestore?.addEventListener('click', async (e) => {
  e.stopPropagation();
  if (typeof window.ollacoreDesktop?.floatingCall?.maximize === 'function') {
    const res = await window.ollacoreDesktop.floatingCall.maximize();
    if (res && typeof res.isMaximized === 'boolean') {
      updateMaximizeButton(res.isMaximized);
    }
  } else {
    window.ollacoreDesktop?.floatingCall?.sendAction('restore');
  }
});

btnHeaderClose?.addEventListener('click', (e) => {
  e.stopPropagation();
  window.ollacoreDesktop?.floatingCall?.sendAction('end');
});

// Setup Draggable Pointer Tracking with Off-Screen Clamping and Click-to-Restore
function setupWindowDraggable(element, isCompact = false) {
  if (!element) return;
  let isPointerDown = false;
  let isDragging = false;
  let startScreenX = 0;
  let startScreenY = 0;
  let hasMoved = false;

  element.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button')) return;
    isPointerDown = true;
    isDragging = false;
    hasMoved = false;
    startScreenX = e.screenX;
    startScreenY = e.screenY;
    try { element.setPointerCapture(e.pointerId); } catch { }
  });

  element.addEventListener('pointermove', (e) => {
    if (!isPointerDown) return;
    const dx = e.screenX - startScreenX;
    const dy = e.screenY - startScreenY;
    if (!isDragging) {
      if (Math.hypot(dx, dy) >= 4) {
        isDragging = true;
        hasMoved = true;
      }
    }
    if (isDragging) {
      startScreenX = e.screenX;
      startScreenY = e.screenY;
      window.ollacoreDesktop?.floatingCall?.moveBy?.(dx, dy);
    }
  });

  const finishDrag = (e) => {
    if (!isPointerDown) return;
    const wasDragging = isDragging;
    isPointerDown = false;
    isDragging = false;
    try { element.releasePointerCapture(e.pointerId); } catch { }

    // If user tapped/clicked on compact widget without dragging, restore full call UI!
    if (!wasDragging && !hasMoved && isCompact) {
      window.ollacoreDesktop?.floatingCall?.sendAction('restore');
    }
  };

  element.addEventListener('pointerup', finishDrag);
  element.addEventListener('pointercancel', finishDrag);
}

setupWindowDraggable(compactWidgetBody, true);
setupWindowDraggable(document.querySelector('.floating-header'), false);

// Clicking floating widget anywhere (outside buttons) restores call interface
document.body.addEventListener('click', (e) => {
  if (e.target.closest('button')) return;
  window.ollacoreDesktop?.floatingCall?.sendAction('restore');
});

// Subscribe to state and mode updates
if (window.ollacoreDesktop?.floatingCall) {
  window.ollacoreDesktop.floatingCall.onStateChange((state) => {
    renderState(state);
  });

  window.ollacoreDesktop.floatingCall.onModeChange?.((mode) => {
    applyMode(mode);
  });

  window.ollacoreDesktop.floatingCall.getState().then((state) => {
    if (state) renderState(state);
  }).catch(() => { });

  window.ollacoreDesktop.floatingCall.getMode?.().then((mode) => {
    if (mode) applyMode(mode);
  }).catch(() => { });

  initLocalVideoBridge();
}
