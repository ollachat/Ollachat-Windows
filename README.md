# OllaChat Windows Desktop Application

This directory contains the desktop Windows implementation of the **OllaChat** client.

> [!IMPORTANT]
> The parent directory contains the existing Android implementation (`OllaCore_Android`).
> The Android project and documentation serve as **reference material only**.
> All Windows desktop application code resides exclusively within this `windows/` directory.

---

## Technology Stack

- **Platform:** Windows x64
- **Runtime / Framework:** Electron `33.4.11`
- **Language & Modules:** JavaScript (ES modules, `"type": "module"`)
- **Bundler:** `esbuild` (`^0.25.0`)
- **Packaging:** `electron-builder` (`^26.0.0`)
- **Target Formats:**
  - Windows x64 NSIS One-Click Installer (`.exe`)
  - Windows x64 Portable Executable (`.exe`)
  - Both builds are unsigned
- **Testing:** Node.js built-in test runner (`node --test`)

---

## Directory Structure

```
windows/
├── src/
│   ├── main/
│   │   └── main.js               # Electron main process (secure BrowserWindow, IPC handlers)
│   ├── preload/
│   │   └── preload.js            # Minimal contextBridge surface
│   ├── renderer/
│   │   ├── index.html            # Application UI entry point
│   │   ├── app.js                # Renderer logic & diagnostics
│   │   └── styles.css            # Desktop application styling
│   ├── storage/
│   │   ├── session-store.js      # Encrypted session persistence
│   │   └── device-id.js          # Ephemeral device ID generator
│   ├── api/
│   │   ├── ollacore-api.js       # Directory REST API client (Auth/Profile)
│   │   ├── chat-api.js           # Conversations & Rooms REST API client
│   │   └── api-error.js          # Standardized API error abstraction
│   ├── auth/
│   │   └── auth-controller.js    # Authentication state machine
│   └── chat/
│       └── chat-websocket.js     # Real-Time Chat WebSocket transport & protocol
├── tests/
│   ├── smoke.test.js             # Basic structure and config verification
│   ├── session-store.test.js     # SessionStore & device ID tests
│   ├── api.test.js               # OllacoreApi mock HTTP tests
│   ├── auth-controller.test.js   # AuthController unit tests
│   ├── chat-websocket.test.js    # WebSocket protocol & lifecycle tests
│   └── chat-api.test.js          # Conversations & Rooms REST API unit tests
├── package.json                  # NPM metadata and scripts
├── esbuild.config.js             # Build configuration for main, preload, and renderer
├── electron-builder.yml          # Desktop packaging configuration (NSIS + portable)
├── README.md                     # Project documentation
└── .gitignore                    # Windows workspace ignore rules
```

---

## Real-Time Chat WebSocket Layer (Phase 2)

### 1. WebSocket Architecture
The WebSocket layer operates strictly in the **Electron main process** (`windows/src/chat/chat-websocket.js`) to guarantee secure credential isolation and persistent connection management across renderer reloads. The renderer interacts exclusively through controlled IPC channels exposed via `preload.js`:
- IPC Handlers: `chat:connect`, `chat:disconnect`, `chat:get-state`, `chat:send`
- IPC Push Events: `chat:state-change`, `chat:event`
- Preload Bridge: `window.ollacoreDesktop.chat.{connect, disconnect, getState, send, onStateChange, onEvent}`

### 2. Authentication Mechanism
- **Subprotocol Handshake:** Conforms to Android reference (`ChatWebSocket.kt`):
  `Sec-WebSocket-Protocol: chatbox, bearer.<sessionToken>`
- **Token Handling:** Retrieved dynamically from `SessionStore.getSession()`. The raw token is never passed to or stored in the renderer.
- **Zero Logging:** Tokens and authentication headers are never written to logs or console outputs.
- **Explicit Lifecycle:** Connections require an authenticated session and are initiated on explicit application request. Logging out immediately tears down the socket and resets reconnection state.

### 3. Connection Lifecycle & Resilience
- **State Machine:** Tracks 5 distinct states: `disconnected`, `connecting`, `connected`, `reconnecting`, `error`.
- **Duplicate Prevention:** Guard checks prevent redundant socket instances if already connecting or connected.
- **Bounded Exponential Backoff:** On unexpected close (e.g. code 1006 or network drop), reconnects using bounded exponential backoff (`1s -> 2s -> 4s -> 8s -> 16s -> 30s`), capped at 5 attempts before transitioning to `error`.
- **Sequence Tracking & Catchup:** Tracks incoming sequence numbers (`highestSeq`). Upon reconnection, automatically sends a `catchup` frame (`{ after_seq, limit }`) to retrieve missed events.
- **Heartbeat Maintenance:** Runs a 30-second interval sending `ping` frames and processes incoming `pong` frames. All timers are unreferenced and cleaned up on disconnect.

### 4. Supported Event Categories
Conforms strictly to the Ollacore specification and Android reference protocol:
- **Frame Structure:** `{ v: 1, request_id: UUID, type: string, room_id?: string, payload: object }`
- **Messages:** `message.created`, `message.updated`, `message.deleted`, `message.send`, `message.edit`, `message.delete`
- **Presence & Typing:** `presence.changed`, `typing.started`, `typing.stopped`
- **Receipts & Reactions:** `receipt.delivered`, `receipt.read`, `reaction.added`, `reaction.removed`
- **Membership & Calls:** `member.added`, `member.removed`, `call.started`, `call.ended`
- **Media & Sync:** `attachment.ready`, `attachment.failed`, `catchup`, `resync`, `ack`, `error`, `ping`, `pong`

---

## Conversations / Rooms REST API Layer (Phase 3)

### 1. Two-Tier Authentication Architecture
Ollacore enforces a clean separation of concerns across two API planes:
1. **Directory Plane (`Authorization: Bearer <sessionToken>`):**
   Manages user identity, global conversation listing, inbox queries, contact lookups, direct conversation opening, group creation, and scoped room token generation.
2. **Room Plane (`Authorization: Bearer <roomToken>`):**
   Manages room-scoped resources including message history, participants, unread state, search, and group moderation.

### 2. Confirmed REST Endpoints
Conforms 1:1 with Android `OllacoreApi.kt` and `Models.kt`:
- **Directory Plane:**
  - `GET /v1/directory/conversations` (returns `ConversationSummary` list)
  - `GET /v1/directory/inbox?limit={limit}` (returns `InboxItem` list with peer info, last message preview, and unread count)
  - `POST /v1/directory/conversations/direct` (body: `{ peer_user_id }`, returns direct room identity)
  - `POST /v1/directory/conversations/group` (body: `{ member_user_ids, name }`, returns group room identity)
  - `GET /v1/directory/conversations/{roomId}/token?device_id={deviceId}` (returns scoped room `access_token` and expiry)
  - `POST /v1/directory/contacts/lookup` (body: `{ phones }`, returns contact user identities)
- **Room Plane:**
  - `GET /v1/rooms/{roomId}/messages?limit={limit}&after_seq={afterSeq}&before_seq={beforeSeq}` (message history with sequence cursors)
  - `GET /v1/rooms/{roomId}/participants` (member list and roles)
  - `GET /v1/rooms/{roomId}/unread` (unread count and `last_read_seq`)
  - `GET /v1/rooms/{roomId}/messages/search?q={query}&limit={limit}` (room message search)
  - `POST /v1/rooms/{roomId}/messages` (REST message send fallback)
  - `PATCH /v1/rooms/{roomId}/messages/{id}` (REST edit message)
  - `DELETE /v1/rooms/{roomId}/messages/{id}` (REST delete message)
  - Group Management: `POST /rooms/{id}/members`, `DELETE /rooms/{id}/members/{id}`, `DELETE /rooms/{id}/members/me` (leave), `PATCH /rooms/{id}` (update group), `POST /rooms/{id}/members/{id}/role`, `POST /rooms/{id}/invites`.

### 3. In-Memory Room Token Caching
- Handled by `RoomTokenCache` inside `ChatApi`:
  - Caches room tokens mapped by `roomId` with millisecond expiration timestamps.
  - Automatically reuses valid cached tokens and proactively evicts tokens within 10 seconds of expiration.
  - Zero disk persistence (tokens reside in volatile memory only).
  - Cleared immediately upon user logout.

### 4. Sequence Cursor Pagination
- Message history uses sequence ordering (`event_seq`):
  - `before_seq`: cursor to fetch older historical messages.
  - `after_seq`: cursor to fetch newer catchup messages.
  - `limit`: defaults to 50 items.
  - `has_more`: Boolean flag indicating further history availability.

### 5. Electron IPC Security Boundary
- Preload bridge exposes `ollacoreDesktop.chatApi`:
  - `listConversations()`, `getInbox(limit)`, `openDirect(peerUserId)`, `createGroup(name, memberUserIds)`, `getRoomToken(roomId)`, `getMessages(roomId, options)`, `getParticipants(roomId)`, `getUnread(roomId)`, `searchMessages(roomId, query, options)`.
- Main process resolves tokens and ephemeral device IDs; renderer never receives, transmits, or logs authentication credentials.

### 6. Operations Intentionally Deferred
As documented in `ARCHITECTURE.md` and `OLLACORE-BACKEND-SPEC.txt`, the following WhatsApp features are Category 2 (unsupported by backend) and intentionally deferred:
- Status / Stories (`/v1/status` service)
- Voice notes & video notes metadata contracts
- Communities & Channels (`/v1/communities`, `/v1/channels`)
- Polls & Events (`/v1/rooms/{id}/polls`, `/v1/rooms/{id}/events`)
- Directory Privacy Settings Store (`/v1/directory/privacy`)

---

## Main Chat Application Shell (Phase 4A)

### 1. Application Architecture & Layout
The desktop messaging shell is built with modern HTML/CSS/JavaScript, targeting Windows desktop with responsive desktop flexbox layouts and zero external UI frameworks:
- **Top Application Bar (`.chat-app-bar`):**
  - Brand header with logo badge and desktop title.
  - Real-time Gateway status indicator pill (`#ws-indicator`) with color-coded dot and descriptive label (`Connected`, `Connecting...`, `Reconnecting...`, `Disconnected`, `Connection Error`).
- **Sidebar (`.chat-sidebar`):**
  - **Search Input (`#conversation-search`):** Real-time client-side search filtering by peer display name, phone number, group title, or message preview. Includes clear button (`#btn-clear-search`).
  - **Conversation List (`#conversation-list`):** Renders actual conversations from `window.ollacoreDesktop.chatApi.getInbox(50)`.
  - **State Panels:** Dedicated states for loading (`#inbox-loading`), empty inbox (`#inbox-empty`), error with retry (`#inbox-error`), and empty search results (`#inbox-no-search`).
  - **Profile & Settings Area (`.sidebar-footer`):** Displays authenticated user's avatar (with deterministic HSL initials), display name, and phone. Provides triggers for Settings dialog and secure logout.
- **Main Chat Area (`.chat-main-area`):**
  - **Welcome / Empty State Panel (`#chat-empty-panel`):** Displayed when no conversation is selected, with branding and end-to-end encryption assurance note.
  - **Selected Conversation Panel (`#chat-selected-panel`):** Displayed when a conversation is active:
    - **Chat Header (`.chat-header`):** Shows peer/group avatar, title, subtitle (phone or group info), and action buttons.
    - **Message Area Container (`#chat-messages-container`):** Placeholder box indicating selected conversation, with encryption badge (prepared for Phase 4C message history rendering).
    - **Composer Container Placeholder (`#chat-composer-container`):** Placeholder input with emoji and attachment actions (prepared for Phase 4D message dispatch).
- **Settings & Profile Modal (`#settings-modal`):**
  - Clean dialog showing display name, phone, user ID, about bio, client build metadata, and secondary logout trigger.

### 2. State Management & Data Normalization
Encapsulated in `windows/src/renderer/chat-shell-state.js`:
- `ChatShellState`: Tracks conversations, active room ID (`selectedRoomId`), loading states, inbox errors, search query, WebSocket status, and current profile.
- Formatting utilities:
  - `getConversationTitle(item)`: Resolves group name, peer display name, phone, or userId fallback.
  - `getConversationSubtitle(item)`: Displays group label or peer phone.
  - `getAvatarInitials(title)`: Generates clean 1-2 character initials.
  - `getAvatarColor(title)`: Deterministic HSL avatar color generator.
  - `formatConversationTime(timestamp)`: Formats time relative to today (`HH:MM AM/PM`), `Yesterday`, day of week, or date.
  - `getConversationPreview(item)`: Formats text previews, photos (`📷 Photo`), videos (`🎥 Video`), audio (`🎵 Voice message`), attachments (`📎 Attachment`), or fallback.
  - `filterConversations(conversations, query)`: Real-time case-insensitive filtering.

### 3. IPC & Authentication Integration
- Automatically triggers `chatApi.getInbox()` upon authenticated screen load.
- Connects `chat.connect()` in background and subscribes to `chat.onStateChange()` events.
- On logout: invokes `auth.logout()`, disconnects WebSocket, resets all shell state, and returns to the phone sign-in screen.
- The renderer never handles, stores, or logs `sessionToken` or `roomToken`.

---

## Direct Chat & Group Creation (Phase 4B)

### 1. New Chat Flow & Contact Lookup Architecture
- **Sidebar Action:** A "New Chat" button (`#btn-new-chat`) in the conversation sidebar header opens the New Chat dialog (`#new-chat-modal`).
- **Tabbed Modal:** Supports switching between "Direct Chat" (`#panel-direct`) and "Create Group" (`#panel-group`) with keyboard support (`Escape` closes modal, `Enter` submits/looks up).
- **Secure Contact Lookup Bridge:**
  - IPC handler: `chat-api:lookup-contacts` in Electron main process resolves `sessionToken` internally from `SessionStore`.
  - Context bridge: `window.ollacoreDesktop.chatApi.lookupContacts(phones)` in `preload.js`.
  - Renderer never has access to the user's `sessionToken`.

### 2. Direct Chat Creation Flow
1. **Input & Validation:** User enters peer phone number in international or local format (validated via `validatePhone`).
2. **Contact Lookup:** Triggers `lookupContacts([phone])` against `POST /v1/directory/contacts/lookup`.
3. **Contact Preview:** Displays matched user card with avatar initials, display name, phone, and verified badge.
4. **Conversation Opening:** User clicks "Start Chat", calling `openDirect(peerUserId)` using the backend-returned `userId` (never inventing IDs from phone numbers).
5. **Inbox Sync & Selection:** Closes modal, refreshes the inbox via `getInbox()`, and automatically selects the opened conversation in the sidebar and header.

### 3. Group Conversation Creation Flow
1. **Group Name:** Group subject/title input validated (1-60 characters via `validateGroupName`).
2. **Member Selection:**
   - Members are looked up by phone number and added to `GroupCreationDraft`.
   - Validated members are rendered as removable chips with avatar initials, name, and a remove button.
   - Guard checks prevent duplicate member additions and disallow adding the creator's own user ID.
3. **Group Submission:** User clicks "Create Group", calling `createGroup(name, memberUserIds)` with an array of verified `userId` strings.
4. **Inbox Sync & Selection:** Closes modal, reloads inbox, and automatically focuses the new group conversation.

### 4. Draft State Management (`windows/src/renderer/chat-shell-state.js`)
- `DirectChatDraft`: Manages phone input, matched contact state, loading state, error display, and can-start validation.
- `GroupCreationDraft`: Manages group name, member list, member chips, duplicate checks, loading state, and can-submit validation.

---

## Message History & Message Rendering (Phase 4C)

### 1. Message History Architecture
- **Room State Management (`RoomMessagesState`):**
  - Manages loaded message list, sequence ordering, loading states (`isLoadingInitial`, `isLoadingOlder`), errors, and cursor metadata (`oldestSeq`, `newestSeq`, `hasMore`).
  - Strict sequence bound tracking ensuring valid integer sequence cursors.
  - In-place deduplication by `id` and `clientMessageId`.
- **Safe DOM Rendering (XSS Immune):**
  - Built exclusively via DOM APIs (`document.createElement`, `textContent`, `setAttribute`); raw server strings are never interpolated into `innerHTML`.
- **WhatsApp-Style Desktop Bubbles:**
  - Incoming messages aligned left with subtle card background and border.
  - Outgoing messages aligned right with brand teal/green background (`#005c4b`).
  - Group conversation sender labels with deterministic HSL avatar colors.
  - Delivery status ticks for outgoing messages: clock (`🕒` sending), single check (`✓` sent), double check (`✓✓` delivered), blue double check (`✓✓` read), warning (`⚠️` failed). Status strictly progresses and never moves backwards.
  - Reaction badges displaying emoji and participant count.
  - Safe fallbacks for media/attachments (`📷 Photo`, `🎥 Video`, `🎵 Voice message`, `📎 Attachment`) and unsupported kinds without crashing.
- **Day Dividers:**
  - Group messages into local calendar day sections with centered frosted pills: `Today`, `Yesterday`, or formatted local date (`Monday, Sep 21` or `Sep 21, 2026`).
- **Seamless Pagination:**
  - Backward pagination triggers near top scroll (`beforeSeq = oldestSeq`).
  - Viewport scroll position is preserved seamlessly via scrollHeight offset calculation (`newScrollTop = newScrollHeight - prevScrollHeight + prevScrollTop`).
- **Conversation Switching Safety:**
  - Token-based load tracking (`activeLoadToken`) rejects stale responses from previously selected rooms.
- **Real-Time Event Reconciliation:**
  - Subscribes to `ollacoreDesktop.chat.onEvent()`: live reconciliation for `message.created`, `message.updated`, `message.deleted`, `receipt.delivered`, `receipt.read`, `reaction.added`, and `reaction.removed`.
  - Auto-scrolls only if user is already reading near the bottom; preserves position and shows floating scroll-to-bottom button if user is reading older history.

---

## Message Sending & Composer (Phase 4D)

### 1. Functional Text Composer UI
- **Multiline Textarea Input (`#composer-input`):**
  - Replaces the single-line placeholder input.
  - Auto-resizes upward up to approximately 140px based on content height, scrolling internally beyond the threshold.
  - Keyboard shortcuts: `Enter` sends the message; `Shift+Enter` inserts a newline.
- **Dynamic Send Button (`#btn-send-message`):**
  - Disabled when the composer is empty or contains only whitespace.
  - Enabled when valid text exists and an active conversation is open.
- **Draft Isolation Per Room (`roomComposerDrafts`):**
  - Automatically caches unsent drafts when switching conversations.
  - Restores drafts when returning to previously opened rooms.
  - Prevents accidental cross-room message leaks.

### 2. Message Validation & Outgoing Send Protocol
- **Validation (`validateComposerText`):**
  - Rejects null, undefined, non-string, empty, and whitespace-only inputs.
  - Trims outer whitespace while strictly preserving internal newlines, paragraphs, and indentation.
- **WebSocket Transport (`message.send`):**
  - Reuses the Phase 2 `ChatWebSocket` transport.
  - Frame payload:
    ```json
    {
      "v": 1,
      "type": "message.send",
      "room_id": "<roomId>",
      "payload": {
        "client_message_id": "<clientMessageId>",
        "kind": "text",
        "body": { "text": "<text>" },
        "attachment_ids": []
      }
    }
    ```
  - Zero REST message sending endpoints; zero secondary WebSockets.

### 3. Optimistic UI, Status Model & Monotonicity
- **Optimistic Rendering (`createOptimisticMessage`):**
  - Immediately appends the message to `RoomMessagesState` with status `sending` (`🕒`).
  - Renders the outgoing bubble instantly and scrolls to the bottom.
  - Clears the composer and updates the sidebar preview.
- **Status Progression & Recovery Model:**
  - Delivery ticks: `sending (0) -> sent (1) -> delivered (2) -> read (3)`
  - Failure: `failed (-1)`
  - Allowed recovery: `failed -> sending -> sent -> delivered -> read`
  - Rejects all downgrades: `sent` cannot become `sending`; `delivered` cannot become `sent`; `read` cannot downgrade; `sent/delivered/read` cannot become `failed`.
- **ACK Reconciliation:**
  - Correlates incoming `{ type: "ack", request_id }` with the pending `clientMessageId`.
  - Advances status from `sending` to `sent` (`✓`).
- **Server `message.created` Reconciliation:**
  - Matches the echoed server frame by `client_message_id`.
  - Reconciles the optimistic message in-place, assigning server `id` and sequence numbers without duplicating the visible bubble.
- **Failure & In-Bubble Retry:**
  - Transport errors or disconnected sockets mark the message as `failed` (`⚠️`).
  - Outgoing bubble displays a `↻ Retry` action.
  - Clicking retry re-dispatches the preserved text and payload using the same `clientMessageId` without creating duplicate messages.

---

## Getting Started

From inside the `windows/` directory:

### 1. Install Dependencies
```powershell
npm install
```

### 2. Run Tests (Built-in Node Test Runner)
```powershell
npm test
```

### 3. Build with esbuild
```powershell
npm run build
```

### 4. Run in Development Mode
```powershell
npm run dev
```

---

## Clean Rebuilding from GitHub Repository

This repository is designed to be cloned and cleanly rebuilt on any modern Windows system or CI/CD environment with zero manual state requirements.

### Prerequisites

- **Operating System:** Windows 10/11 x64 (or `windows-latest` GitHub Actions runner)
- **Node.js:** `v20.x` LTS or `v22.x` LTS recommended
- **Build Tools:** Standard Windows C++ Build Tools (installed automatically with Visual Studio Community or Visual Studio Build Tools with "Desktop development with C++") for native Node modules (`sqlite3`).

### 1. Clone Repository
```powershell
git clone <REPO_URL> ollachat-windows-client
cd ollachat-windows-client
```

### 2. Clean Dependency Installation
Use `npm ci` to install dependencies deterministically from `package-lock.json`:
```powershell
npm ci
```

### 3. Run Verification Test Suite
Execute the built-in test suite (all 2,389 unit, integration, and invariant tests):
```powershell
npm test
```

### 4. Build Bundles (esbuild)
Bundles `src/main`, `src/preload`, and `src/renderer` into `dist/`:
```powershell
npm run build
```

### 5. Package Windows Executables (electron-builder)
Produces both the NSIS One-Click Installer and Portable Executable in `release/`:
```powershell
npm run dist
```

Artifacts produced:
- `release/OllaChat Setup 1.0.0.exe` (NSIS Installer)
- `release/OllaChat-Portable-1.0.0-x64.exe` (Portable Binary)
- `release/latest.yml` (Electron Auto-Updater Manifest)

---

## CI/CD Pipeline (GitHub Actions)

Continuous Integration and Continuous Deployment are fully configured under `.github/workflows/`:

1. **`ci.yml` (Continuous Integration)**:
   - Triggers on every `push` and `pull_request` to `main` and `feature/**` branches.
   - Runs on `windows-latest`.
   - Executes `npm ci`, runs the 2,389 tests (`npm test`), bundles code (`npm run build`), packages the installers (`npm run dist`), and uploads binaries as GitHub workflow artifacts.

2. **`release.yml` (Release Deployment)**:
   - Triggers on tag pushes matching `v*.*.*` (e.g., `git tag v1.0.0 && git push origin v1.0.0`).
   - Runs clean builds and tests on `windows-latest`.
   - Computes SHA-256 integrity checksums (`SHA256SUMS.txt`).
   - Automatically drafts and publishes a GitHub Release containing the NSIS installer, portable executable, checksums, and `latest.yml`.

---

## Infrastructure as Code (IaC) - Release CDN

Hosting and auto-update distribution infrastructure is provisioned declaratively with Terraform in `infra/terraform/`:

- **Amazon S3 (`aws_s3_bucket.releases`)**: Encrypted, versioned private bucket storing release binaries.
- **CloudFront Origin Access Control (OAC)**: Enforces that S3 artifacts can only be accessed via the CDN.
- **CloudFront CDN Distribution**:
  - Global HTTPS distribution with fast edge caching.
  - Specialized low-TTL caching (5 minutes) for `latest.yml` to allow auto-updaters to promptly detect new versions.
  - Long TTL (24h+) for immutable `.exe` binaries.

To deploy release infrastructure:
```powershell
cd infra/terraform
terraform init
cp terraform.tfvars.example terraform.tfvars
terraform apply
```
See [`infra/README.md`](infra/README.md) for complete details.

---

## Packaging Commands & Output Locations

All packaged artifacts are output to the `windows/release/` directory:

| Build Type | Command | Description | Output Artifact |
|---|---|---|---|
| **Unpacked Directory** | `npm run package` | Builds and creates unpacked executable folder for quick verification | `windows/release/win-unpacked/` |
| **NSIS Installer** | `npm run installer` | Builds Windows x64 NSIS one-click installer | `windows/release/OllaChat Setup 1.0.0.exe` |
| **Portable Executable** | `npm run portable` | Builds standalone Windows x64 portable executable | `windows/release/OllaChat-Portable-1.0.0-x64.exe` |
| **All Windows Targets** | `npm run dist` | Builds both NSIS installer and portable executable | `windows/release/` |

---

## Security Architecture

- **Context Isolation:** Enabled (`contextIsolation: true`).
- **Node Integration:** Disabled (`nodeIntegration: false`).
- **Preload Isolation:** Preload scripts run in an isolated world with access to a strictly bounded `ollacoreDesktop` API via `contextBridge`.
- **Navigation Guard:** Arbitrary navigations are blocked with `will-navigate`.
- **Window Open Guard:** Popups/new windows are blocked via `setWindowOpenHandler`.
- **Content Security Policy:** Strict CSP headers are applied to the session and document.

---

## QA Testing with OllaCore OTP Simulator

For manual QA and automated test verification, an out-of-band helper script is provided to query the official OllaCore OTP Simulator (`https://ollacore-otp-sim.vikas4988.workers.dev`).

### 1. Configure Token in PowerShell Session
```powershell
$env:SIM_TOKEN="YOUR_TOKEN"
```
*(Alternatively, `OLLACORE_SIM_TOKEN` is supported as a fallback).*

### 2. Retrieve OTP for Test Routes
Supported QA test routes: `+15550001111`, `+15550002222`, `+15550003333`.

```powershell
npm run get-otp -- +15550001111
```

Optional: Specify an exact Unix millisecond timestamp captured immediately prior to requesting/resending OTP:
```powershell
npm run get-otp -- +15550001111 --since 1758440000000
```

### 3. Security Guidelines
- **QA-Only Credential:** `SIM_TOKEN` is for QA out-of-band verification only.
- **No Client Inclusion:** `SIM_TOKEN` must never be placed in the Electron application (main, preload, renderer).
- **No Commits:** `SIM_TOKEN` must never be hardcoded, saved to repo files, or committed to source control.
- **Direct Backend Architecture:** The Windows application continues to communicate directly with `api.ollacore.com`. The helper only reads the intercepted OTP from the simulator out-of-band.

