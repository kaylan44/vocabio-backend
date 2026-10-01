# Vocabio — 1:1 Messaging Architecture

## Overview

Instant messaging system between users of the Vocabio application. Scope: 1:1 conversations, text messages, read indicators, real time.

---

## Tech stack

| Layer | Technology | Role |
|---|---|---|
| Mobile | React Native | iOS / Android client |
| Auth | Supabase Auth | Google SSO, JWT issuance |
| Database | Supabase PostgreSQL | Data persistence |
| ORM | Prisma | Typed schema, migrations |
| API server | Node.js + Express | REST endpoints, business logic |
| Real time | Socket.io | WebSockets, message delivery |
| Server hosting | Railway | Express + Socket.io deployment |

---

## General architecture

```
┌─────────────────────────────────────────────────────┐
│                   React Native App                  │
│                                                     │
│  ┌──────────────┐          ┌──────────────────────┐ │
│  │ Supabase SDK │          │     Socket.io client │ │
│  └──────┬───────┘          └──────────┬───────────┘ │
└─────────┼────────────────────────────┼─────────────┘
          │                            │
          │ Auth (Google SSO)          │ WebSocket (JWT)
          │ JWT                        │
          ▼                            ▼
┌─────────────────┐        ┌──────────────────────────┐
│  Supabase Auth  │        │   Express + Socket.io    │
│  + PostgreSQL   │◄───────│       (Railway)          │
└─────────────────┘ Prisma └──────────────────────────┘
```

---

## Authentication flow

1. The user signs in through **Google SSO** on Supabase Auth
2. Supabase returns a **signed JWT** containing the `user_id`
3. React Native stores the JWT securely (`expo-secure-store`)
4. Every HTTP request and Socket.io connection includes the JWT in a header
5. The Express server **verifies the JWT** with the Supabase public key (no network call)
6. The user's identity is extracted from the token on every request

---

## Data model

### `users` table
Synchronized from Supabase Auth by a Postgres trigger on `auth.users` (`sync_auth_users`
migration, which also backfills existing accounts). The lazy upsert in the auth middleware
and the sign-up webhook remain as a safety net.

```sql
users (
  id          UUID PRIMARY KEY,  -- same ID as Supabase Auth
  username    TEXT NOT NULL,
  avatar_url  TEXT,
  created_at  TIMESTAMP DEFAULT NOW()
)
```

### `conversations` table
Represents a 1:1 channel between two users.

```sql
conversations (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at  TIMESTAMP DEFAULT NOW()
)
```

### `participants` table
Join table linking users and conversations.

```sql
participants (
  conversation_id  UUID REFERENCES conversations(id),
  user_id          UUID REFERENCES users(id),
  PRIMARY KEY (conversation_id, user_id)
)
```

### `messages` table
```sql
messages (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id  UUID REFERENCES conversations(id),
  sender_id        UUID REFERENCES users(id),
  content          TEXT NOT NULL,
  created_at       TIMESTAMP DEFAULT NOW(),
  read_at          TIMESTAMP  -- NULL = unread
)
```

---

## REST API (Express)

### Auth
All endpoints require the `Authorization: Bearer <JWT>` header.

### Endpoints

| Method | Route | Description |
|---|---|---|
| `GET` | `/users` | List users (except yourself), sorted by username, 100 max |
| `GET` | `/users/search?q=` | Search for a user by username |
| `POST` | `/conversations` | Create or fetch a 1:1 conversation |
| `GET` | `/conversations` | List the user's conversations |
| `GET` | `/conversations/:id/messages` | Paginated message history |
| `POST` | `/conversations/:id/messages` | Send a message (fallback without WebSocket) |
| `PATCH` | `/messages/:id/read` | Mark a message as read |

---

## Socket.io events (real time)

### Connection
The client authenticates on connection by passing the JWT:
```js
const socket = io(SERVER_URL, {
  auth: { token: supabaseJWT }
})
```

### Client → server events

| Event | Payload | Description |
|---|---|---|
| `join_conversation` | `{ conversationId }` | Join a conversation's room |
| `send_message` | `{ conversationId, content }` | Send a message |
| `mark_read` | `{ conversationId }` | Mark all received messages of the conversation as read |
| `typing` | `{ conversationId }` | Typing indicator |

### Server → client events

On connection, each socket automatically joins its personal room `user:<id>`.
`new_message` and `message_read` are emitted to the conversation room **and** to the
participants' personal rooms: a client therefore receives new messages from all its
conversations without having to join them. `user_typing` stays limited to the conversation room.

| Event | Payload | Description |
|---|---|---|
| `new_message` | `{ id, conversationId, senderId, sender, content, createdAt, readAt }` | New message (including the ones you sent yourself) |
| `message_read` | `{ conversationId, readAt, readByUserId }` | Messages of the conversation read by `readByUserId` |
| `user_typing` | `{ conversationId, userId, username }` | A user is typing |

### CORS

Calls from a browser (Expo web) require the origin to be listed in
`CORS_ORIGINS` (comma-separated list, default `https://vocabio.vercel.app`).
A defined value replaces the default: to also allow local dev, use
`CORS_ORIGINS="http://localhost:8081,https://vocabio.vercel.app"`.
The same list applies to REST routes and to Socket.io.

---

## Security

- All endpoints verify the Supabase JWT before processing
- Server-side check that the user is indeed a **participant** of the conversation before any access to messages
- The JWT is verified locally (Supabase public key) — no network call to Supabase on each request
- Messages are only accessible to the participants of the conversation
- **RLS enabled with no policy** on all `public` tables (`enable_rls` migration):
  the Supabase Data API (PostgREST, `anon` key) has no access to them, the mobile app
  only goes through this backend. Prisma connects as `postgres` (owner of the tables)
  and is therefore not subject to RLS. **Any new table must enable RLS in its
  migration** (checked by `tests/prisma/rls.test.ts`).

---

## Development plan

### Step 1 — Setup & Auth
- Initialize the Express + TypeScript project
- Configure Prisma + Supabase PostgreSQL connection
- Supabase JWT verification middleware
- Supabase webhook → user creation in the database
- Railway deployment

### Step 2 — Conversations & Messages (REST)
- Conversation management endpoints
- Endpoint for sending and fetching messages
- History pagination

### Step 3 — Real time (Socket.io)
- Socket.io authentication via JWT
- One room per conversation
- Real-time message delivery

### Step 4 — Read receipts & UX
- Marking messages as read
- Notifying the sender through Socket.io
- Typing indicator

### Step 5 — Push notifications (optional)
- Expo Push Notifications integration
- Sending a notification when the recipient is offline

---

## Out of scope (V1)

- Group messages (> 2 participants)
- File / image sharing
- End-to-end encryption
- Deleting / editing messages
- Message reactions
