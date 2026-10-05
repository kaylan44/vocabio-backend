# Implementation plan — Vocabio backend

Steps 1 to 5 cover the 1:1 messaging system, the original scope of this backend.
Step 6 adds quiz results and user statistics, an independent feature.

## Repo structure

```
vocabio-backend/
├── src/
│   ├── middleware/
│   │   └── auth.ts                 # JWT verification + lazy user upsert
│   ├── routes/
│   │   ├── users.ts                # GET /users/search
│   │   ├── conversations.ts        # GET/POST /conversations
│   │   └── messages.ts             # GET/POST/PATCH messages
│   ├── services/
│   │   ├── userService.ts          # Users business logic (upsert, search)
│   │   ├── conversationService.ts  # Conversations business logic
│   │   └── messageService.ts       # Messages business logic (createMessage shared by REST + Socket)
│   ├── sockets/
│   │   ├── index.ts                # Socket.io init, auth handshake
│   │   └── handlers.ts             # Socket event handlers
│   ├── lib/
│   │   ├── prisma.ts               # Prisma singleton instance
│   │   └── socket.ts               # Socket.io singleton instance (shared between routes and services)
│   ├── types/
│   │   └── index.ts                # Shared types (AuthUser, etc.)
│   └── app.ts                      # Express + Socket.io setup
├── prisma/
│   └── schema.prisma               # Database schema
├── tests/
│   ├── middleware/
│   │   └── auth.test.ts
│   ├── services/
│   │   ├── userService.test.ts
│   │   ├── conversationService.test.ts
│   │   └── messageService.test.ts
│   └── routes/
│       ├── conversations.test.ts
│       └── messages.test.ts
├── .env
├── jest.config.ts
├── tsconfig.json
└── package.json
```

---

## Step 1 — Setup & Auth

**Branch:** `feat/setup-auth`

### Packages

| Package | Role |
|---|---|
| `express` | HTTP server |
| `socket.io` | WebSockets |
| `prisma`, `@prisma/client` | ORM + migrations |
| `jsonwebtoken`, `jwks-rsa` | Supabase JWT verification (JWKS public key, cached) |
| `typescript`, `tsx` | TypeScript transpilation |
| `jest`, `ts-jest`, `supertest` | Tests |

### Prisma schema (`prisma/schema.prisma`)

```prisma
model User {
  id            String         @id           // Same UUID as Supabase Auth
  username      String
  avatarUrl     String?
  createdAt     DateTime       @default(now())
  participants  Participant[]
  sentMessages  Message[]
}

model Conversation {
  id           String        @id @default(uuid())
  createdAt    DateTime      @default(now())
  participants Participant[]
  messages     Message[]
}

model Participant {
  conversationId  String
  userId          String
  conversation    Conversation  @relation(fields: [conversationId], references: [id])
  user            User          @relation(fields: [userId], references: [id])
  @@id([conversationId, userId])
}

model Message {
  id              String       @id @default(uuid())
  conversationId  String
  senderId        String
  content         String
  createdAt       DateTime     @default(now())
  readAt          DateTime?    // NULL = unread
  conversation    Conversation @relation(fields: [conversationId], references: [id])
  sender          User         @relation(fields: [senderId], references: [id])
}
```

### Auth middleware (`src/middleware/auth.ts`)

Runs on every protected request, in this order:

1. Extracts the JWT from the `Authorization: Bearer <token>` header
2. Verifies the signature with the Supabase public key via JWKS (the Supabase JWKS endpoint is cached by `jwks-rsa` — no network call on each request)
3. Extracts `sub` (= Supabase user_id), `email`, `user_metadata.username` from the JWT payload
4. **Lazy upsert**: `prisma.user.upsert({ where: { id: sub }, create: { id, username, email }, update: {} })`
   - If the user already exists → no-op (`update: {}` changes nothing)
   - If the user does not exist (missed webhook) → it is silently created here
5. Attaches the user object to `req.user` for all following handlers

### Supabase webhook (`POST /webhooks/auth`)

- Receives an `INSERT` event on `auth.users` at each sign-up
- Verifies the webhook's HMAC signature (secret configured in the Supabase Dashboard)
- Performs the same upsert as the middleware
- **Non-critical**: if this webhook fails, the lazy upsert in the middleware catches up on the user's first API call

### Shared types (`src/types/index.ts`)

```typescript
// Represents the authenticated user, attached to req.user by the middleware
export interface AuthUser {
  id: string;
  username: string;
  email: string;
}

// Extends Express's Request type to include req.user
declare global {
  namespace Express {
    interface Request {
      user: AuthUser;
    }
  }
}
```

---

## Step 2 — Conversations & Messages (REST)

**Branch:** `feat/rest-api`

### `POST /conversations`

**Payload:** `{ recipientId: string }`

**Logic in `conversationService.getOrCreate(userId, recipientId)`:**

```
1. SQL query: look for a conversation where userId AND recipientId
   are both participants (join on participants)
2. If found → return the existing conversation (idempotent)
3. If not found →
   a. Create a new Conversation
   b. Create two Participant rows (userId + recipientId)
   c. Return the new conversation
```

**Why idempotent?** The mobile client may call this endpoint several times (unstable network, retry) without creating duplicates.

### `GET /conversations`

Returns the list of the logged-in user's conversations, sorted by the date of the last message.

**For each conversation:**
- The other participant: `username`, `avatarUrl`
- The last message: `content`, `createdAt`, `senderId`
- The number of unread messages: `COUNT(*) WHERE read_at IS NULL AND sender_id != userId`

> ⚠️ **Complexity point:** this query combines several aggregations (last message + unread count) for N conversations in one pass. Prisma ORM alone does not support this cleanly. Strategy: first try with Prisma (several queries assembled in the service), and if performance is insufficient, switch to `prisma.$queryRaw` with raw SQL.

### `GET /conversations/:id/messages?offset=0&limit=30`

**Participant guard** (reused on all `/conversations/:id/*` endpoints):
- Checks that a `Participant` row exists for `(conversationId, userId)`
- If not → 403 Forbidden

**Offset pagination:**
```
prisma.message.findMany({
  where: { conversationId },
  orderBy: { createdAt: 'desc' },
  skip: offset,
  take: limit
})
```
Messages are returned from most recent to oldest (the mobile app reverses the order for display).

### `POST /conversations/:id/messages`

**Payload:** `{ content: string }`

Calls `messageService.createMessage(conversationId, senderId, content)`.

**This function is shared between REST and Socket.io — it is the core rule of the architecture:**
```
1. Persists the message in the database (Prisma)
2. Emits the new_message event on the conversation's Socket.io room
3. Returns the created message
```
This way, whether a message arrives over HTTP or over WebSocket, the behavior is identical.

### `PATCH /conversations/:id/read`

Marks **all** unread messages of the conversation as read in a single query:

```sql
UPDATE messages
SET read_at = NOW()
WHERE conversation_id = :id
  AND sender_id != :userId   -- we do not mark our own messages
  AND read_at IS NULL
```

After the update, emits a `message_read` Socket.io event to notify the sender that their messages have been read.

---

## Step 3 — Real time (Socket.io)

**Branch:** `feat/realtime`

### Socket.io singleton (`src/lib/socket.ts`)

`messageService` must emit Socket.io events, but importing `io` directly from `sockets/index.ts` would create a circular dependency. The solution: a singleton module initialized once at server startup, then imported by any service.

```typescript
// src/lib/socket.ts
let io: Server;
export const initSocket = (server: http.Server) => { io = new Server(server); return io; };
export const getIO = () => { if (!io) throw new Error('Socket.io non initialisé'); return io; };
```

```typescript
// messageService.ts can then do:
import { getIO } from '../lib/socket';
getIO().to(conversationId).emit('new_message', message);
```

### Express + Socket.io architecture

Express and Socket.io share the same Node.js HTTP server:

```typescript
const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer);
// → a single port, two protocols (HTTP + WS)
```

### Auth handshake (`src/sockets/index.ts`)

Socket.io middleware run on every new WebSocket connection:

```
1. Extracts the JWT from socket.handshake.auth.token
2. Verifies the signature (same logic as the HTTP middleware)
3. Lazy upsert of the user
4. Attaches the user to socket.data.user
5. If the JWT is invalid → socket.disconnect()
```

### Socket handlers (`src/sockets/handlers.ts`)

| Received event | Payload | Server action | Emitted event |
|---|---|---|---|
| `join_conversation` | `{ conversationId }` | Checks participation → `socket.join(conversationId)` | — |
| `send_message` | `{ conversationId, content }` | Calls `messageService.createMessage(...)` | `new_message` → room |
| `mark_read` | `{ conversationId }` | Bulk-updates `read_at` | `message_read` → room |
| `typing` | `{ conversationId }` | — | `user_typing` → room (broadcast except sender) |

### Server → client events

| Event | Payload | Recipient |
|---|---|---|
| `new_message` | `{ id, conversationId, senderId, content, createdAt }` | All members of the room |
| `message_read` | `{ conversationId, readAt }` | All members of the room |
| `user_typing` | `{ conversationId, userId }` | Everyone except the sender |

---

## Step 4 — Read receipts & Typing indicator

**Branch:** `feat/read-receipts`

Included in step 3 above. Points to watch:

- **Bulk `mark_read`**: the client calls `mark_read` when the user opens a conversation, not message by message. A single SQL query, a single Socket event.
- **`typing`**: ephemeral event, nothing is persisted in the database. The client sends `typing` on each keystroke (throttled on the mobile side). The server rebroadcasts immediately.

---

## Step 5 — Unit tests

**Branch:** `feat/tests`

### Mocking strategy

Services are tested with Prisma mocked via `jest.mock('../lib/prisma')`. Routes are tested with `supertest` + a mock of the auth middleware (which injects a fake `req.user`).

### Target coverage

**Auth middleware (`tests/middleware/auth.test.ts`):**
- Valid JWT → `req.user` filled, user upserted
- Expired JWT → 401
- Missing header → 401
- User absent from the database before the upsert → created automatically

**`conversationService` (`tests/services/conversationService.test.ts`):**
- `getOrCreate` with an existing conversation → returns the existing one (idempotent)
- `getOrCreate` with no conversation → creates the conversation + 2 participants
- `getOrCreate` with a non-existent recipientId → business error

**`messageService` (`tests/services/messageService.test.ts`):**
- `createMessage` → persists in the database AND emits `new_message` on Socket.io
- `createMessage` in a conversation you are not a participant of → rejected

> ⚠️ **Complexity point:** testing the Socket.io emission requires mocking `getIO()` via `jest.mock('../lib/socket')` and checking that `.to().emit()` was called with the right arguments. The Jest config will need to include a mock of this module.

**`userService` (`tests/services/userService.test.ts`):**
- `searchUsers` → returns the users whose username matches
- `searchUsers` with an empty query → returns nothing (or a validation error)

**REST routes (`tests/routes/`):**
- E2E scenario: create conversation → send message → fetch history → mark as read → check `read_at` is not null

---

## Step 6 — Quiz results & statistics

**Branch:** `feat/quiz-stats`

Detailed plan: `.claude/plans/stats-backend.md`. This step is unrelated to messaging: it
stores the quizzes finished in the mobile app and serves statistics for the account page.

### Data model

Two new tables, `QuizSession` (one row per finished quiz) and `QuizAnswer` (one row per
question). The vocabulary lives inside the app, so the backend stores `wordId` as an opaque
string and copies `category` / `level` onto each answer.

### `POST /quiz-sessions`

**Payload:** `{ id, mode, answers: [{ wordId, category, level, isCorrect }] }`

**Logic in `quizService.createQuizSession(userId, sessionId, mode, answers)`:**

```
1. Session with this id already stored?
   - owned by the caller → return it (200, idempotent replay)
   - owned by someone else → 409, nothing returned
2. Rate limit: latest session of the user younger than 10 s → 429
3. Compute score and total from the answers (never sent by the client)
4. Create the session and its answers in one nested create (atomic)
5. Unique violation (P2002, two identical requests racing) → back to step 1's check
```

### `GET /quiz-sessions/stats`

`quizService.getQuizStats(userId)` runs four `groupBy` queries in parallel (sessions by
mode, answers by category, answers by level, most missed words) and shapes the result in
memory. Every query is filtered by the user of the JWT.

### Tests

`tests/services/quizService.test.ts` (Prisma mocked) and `tests/routes/quizSessions.test.ts`
(supertest, service mocked). The RLS guard `tests/prisma/rls.test.ts` covers the new migration.

---

## Step 7 — Easy Spanish articles with audio

**Branch:** `feat/articles`

Detailed plan: `.claude/plans/articles-backend.md`. A third independent feature: the backend
copies short news articles written for Spanish learners (source: Hola Qué Pasa, through its
public WordPress REST API) and serves them to the app, text and audio. Private testing only:
the content is not licensed for reuse, so the job is behind `ARTICLES_SYNC_ENABLED`, off by
default.

### Data model

`Article` (text as structured JSON, level, audio duration) and `ArticleAudio`
(the MP3 as `Bytes`, in its own table so that no query on `Article` loads it by mistake).
`(source, externalId)` is unique: it is the dedupe key of the ingestion.

### Ingestion

```
articleScheduler (in-process timer: 30 s after boot, then every 6 h)
  └─ articleIngestService.runIngestion()
       1. holaQuePasa.fetchLatestPosts(10)          one call to the source API
       2. articleParser.parsePost(post)             HTML → paragraphs, pure function
       3. new article → download its MP3 → create Article (+ ArticleAudio)
          stored without audio → retry the download
          stored with audio → nothing
       4. delete articles published more than 30 days ago (cascade removes the audio)
```

Every URL found in the remote content is checked (https, host `holaquepasa.com`) before
being stored or fetched; the MP3 download also refuses redirects, non-audio types and
files over 10 MB.

### `GET /articles`, `GET /articles/:id`, `GET /articles/:id/audio`

All behind `authMiddleware`. The list is paginated (offset) and can be filtered by level.
The audio route returns the whole file: the app downloads it with its JWT, then plays and
seeks locally, so no `Range` support and no unauthenticated URL are needed.

### Tests

Parser (hand-written HTML fixtures), source client (`fetch` mocked), ingestion, read
service, routes, scheduler (fake timers). The RLS guard covers the new migration.

---

## Architecture decisions — Summary

| Decision | Choice | Reason |
|---|---|---|
| User sync | Lazy upsert in the middleware | Resilience if the Supabase webhook fails |
| REST + Socket | Shared `createMessage` | Single source of truth, no divergence |
| Mark as read | Per conversation (bulk) | Avoids N queries when opening a chat |
| Pagination | Offset | Simpler, sufficient for V1 |
| Read receipts | `read_at` on `Message` | Simple for 1:1, refactor if groups come one day |
| Socket auth | JWT at handshake | Same mechanism as REST, consistent |
| Quiz session id | UUID generated by the client | Idempotency key: a retried request stores the quiz once |
| Quiz `mode` / `category` / `level` | `String` validated by the route, not Prisma enums | `fr-es` is not a valid enum identifier; no migration for each new value |
| Quiz `category` / `level` | Copied onto each answer | No word table in the backend, needed for stats by category/level |
| Quiz rate limit | Latest session read from the database | No new dependency, survives restarts, works with several instances |
| Article source | WordPress REST API, not the RSS feed | The feed has no full text; the API also gives the level and the audio |
| Article text | Structured JSON (paragraphs of segments), not HTML | No HTML renderer in the app, no script injection, vocabulary glosses kept |
| Article audio | `Bytes` in PostgreSQL, in its own table | No file storage to configure for a private test; never loaded by a list query |
| Audio delivery | Whole file behind the JWT, no `Range` | An audio element cannot send the JWT on web; the app downloads then plays locally |
| Article sync | In-process timer behind a feature flag | Single Railway instance; off by default because the content is not licensed |

---

## Out of scope V1

- Group messages (> 2 participants)
- File / image sharing
- End-to-end encryption
- Deleting / editing messages
- Message reactions
- Push notifications
