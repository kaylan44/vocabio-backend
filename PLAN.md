# Plan d'implémentation — Vocabio Messagerie 1:1

## Structure du repo

```
vocabio-backend/
├── src/
│   ├── middleware/
│   │   └── auth.ts                 # Vérification JWT + upsert lazy du user
│   ├── routes/
│   │   ├── users.ts                # GET /users/search
│   │   ├── conversations.ts        # GET/POST /conversations
│   │   └── messages.ts             # GET/POST/PATCH messages
│   ├── services/
│   │   ├── userService.ts          # Logique métier users (upsert, search)
│   │   ├── conversationService.ts  # Logique métier conversations
│   │   └── messageService.ts       # Logique métier messages (createMessage partagé REST + Socket)
│   ├── sockets/
│   │   ├── index.ts                # Init Socket.io, auth handshake
│   │   └── handlers.ts             # Handlers des événements Socket
│   ├── lib/
│   │   ├── prisma.ts               # Instance Prisma singleton
│   │   └── socket.ts               # Instance Socket.io singleton (partagée entre routes et services)
│   ├── types/
│   │   └── index.ts                # Types partagés (AuthUser, etc.)
│   └── app.ts                      # Setup Express + Socket.io
├── prisma/
│   └── schema.prisma               # Schéma BDD
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

## Étape 1 — Setup & Auth

**Branche :** `feat/setup-auth`

### Packages

| Package | Rôle |
|---|---|
| `express` | Serveur HTTP |
| `socket.io` | WebSockets |
| `prisma`, `@prisma/client` | ORM + migrations |
| `jsonwebtoken`, `jwks-rsa` | Vérification JWT Supabase (clé publique JWKS, mise en cache) |
| `typescript`, `tsx` | Transpilation TypeScript |
| `jest`, `ts-jest`, `supertest` | Tests |

### Schéma Prisma (`prisma/schema.prisma`)

```prisma
model User {
  id            String         @id           // UUID identique à Supabase Auth
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
  readAt          DateTime?    // NULL = non lu
  conversation    Conversation @relation(fields: [conversationId], references: [id])
  sender          User         @relation(fields: [senderId], references: [id])
}
```

### Middleware auth (`src/middleware/auth.ts`)

Exécuté sur toutes les requêtes protégées, dans l'ordre :

1. Extrait le JWT du header `Authorization: Bearer <token>`
2. Vérifie la signature avec la clé publique Supabase via JWKS (l'endpoint JWKS Supabase est mis en cache côté `jwks-rsa` — pas d'appel réseau à chaque requête)
3. Extrait `sub` (= user_id Supabase), `email`, `user_metadata.username` du payload JWT
4. **Upsert lazy** : `prisma.user.upsert({ where: { id: sub }, create: { id, username, email }, update: {} })`
   - Si le user existe déjà → no-op (le `update: {}` ne modifie rien)
   - Si le user n'existe pas (webhook raté) → il est créé silencieusement ici
5. Attache l'objet user à `req.user` pour tous les handlers suivants

### Webhook Supabase (`POST /webhooks/auth`)

- Reçoit un événement `INSERT` sur `auth.users` à chaque inscription
- Vérifie la signature HMAC du webhook (secret configuré dans Supabase Dashboard)
- Fait le même upsert que le middleware
- **Non critique** : si ce webhook échoue, l'upsert lazy dans le middleware rattrape au premier appel API de l'user

### Types partagés (`src/types/index.ts`)

```typescript
// Représente l'utilisateur authentifié, attaché à req.user par le middleware
export interface AuthUser {
  id: string;
  username: string;
  email: string;
}

// Extension du type Request d'Express pour inclure req.user
declare global {
  namespace Express {
    interface Request {
      user: AuthUser;
    }
  }
}
```

---

## Étape 2 — Conversations & Messages (REST)

**Branche :** `feat/rest-api`

### `POST /conversations`

**Payload :** `{ recipientId: string }`

**Logique dans `conversationService.getOrCreate(userId, recipientId)` :**

```
1. Requête SQL : cherche une conversation où userId ET recipientId
   sont tous les deux participants (jointure sur participants)
2. Si trouvée → retourne la conversation existante (idempotent)
3. Si non trouvée →
   a. Crée une nouvelle Conversation
   b. Crée deux lignes Participant (userId + recipientId)
   c. Retourne la nouvelle conversation
```

**Pourquoi idempotent ?** Le client mobile peut appeler cet endpoint plusieurs fois (réseau instable, retry) sans créer de doublons.

### `GET /conversations`

Retourne la liste des conversations de l'user connecté, triées par date du dernier message.

**Pour chaque conversation :**
- L'autre participant : `username`, `avatarUrl`
- Le dernier message : `content`, `createdAt`, `senderId`
- Le nombre de messages non lus : `COUNT(*) WHERE read_at IS NULL AND sender_id != userId`

> ⚠️ **Point de complexité :** cette requête combine plusieurs agrégations (dernier message + count non lus) pour N conversations en une passe. Prisma ORM seul ne le supporte pas proprement. Stratégie : tenter d'abord avec Prisma (plusieurs requêtes assemblées en service), et si les performances sont insuffisantes, basculer sur `prisma.$queryRaw` avec du SQL brut.

### `GET /conversations/:id/messages?offset=0&limit=30`

**Guard participant** (réutilisé sur tous les endpoints `/conversations/:id/*`) :
- Vérifie qu'une ligne `Participant` existe pour `(conversationId, userId)`
- Si non → 403 Forbidden

**Pagination offset :**
```
prisma.message.findMany({
  where: { conversationId },
  orderBy: { createdAt: 'desc' },
  skip: offset,
  take: limit
})
```
Les messages sont renvoyés du plus récent au plus ancien (l'app mobile inverse l'ordre à l'affichage).

### `POST /conversations/:id/messages`

**Payload :** `{ content: string }`

Appelle `messageService.createMessage(conversationId, senderId, content)`.

**Cette fonction est partagée entre REST et Socket.io — c'est la règle centrale de l'architecture :**
```
1. Persiste le message en base (Prisma)
2. Émet l'événement new_message sur la room Socket.io de la conversation
3. Retourne le message créé
```
Ainsi, qu'un message arrive par HTTP ou par WebSocket, le comportement est identique.

### `PATCH /conversations/:id/read`

Marque **tous** les messages non lus de la conversation comme lus en une seule requête :

```sql
UPDATE messages
SET read_at = NOW()
WHERE conversation_id = :id
  AND sender_id != :userId   -- on ne marque pas ses propres messages
  AND read_at IS NULL
```

Après la mise à jour, émet un événement `message_read` en Socket.io pour notifier l'expéditeur que ses messages ont été lus.

---

## Étape 3 — Temps réel (Socket.io)

**Branche :** `feat/realtime`

### Singleton Socket.io (`src/lib/socket.ts`)

`messageService` doit émettre des événements Socket.io, mais importer `io` directement depuis `sockets/index.ts` créerait un couplage circulaire. La solution : un module singleton initialisé une fois au démarrage du serveur, puis importé par n'importe quel service.

```typescript
// src/lib/socket.ts
let io: Server;
export const initSocket = (server: http.Server) => { io = new Server(server); return io; };
export const getIO = () => { if (!io) throw new Error('Socket.io non initialisé'); return io; };
```

```typescript
// messageService.ts peut alors faire :
import { getIO } from '../lib/socket';
getIO().to(conversationId).emit('new_message', message);
```

### Architecture Express + Socket.io

Express et Socket.io partagent le même serveur HTTP Node.js :

```typescript
const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer);
// → un seul port, deux protocoles (HTTP + WS)
```

### Auth handshake (`src/sockets/index.ts`)

Middleware Socket.io exécuté à chaque nouvelle connexion WebSocket :

```
1. Extrait le JWT depuis socket.handshake.auth.token
2. Vérifie la signature (même logique que le middleware HTTP)
3. Upsert lazy du user
4. Attache l'user à socket.data.user
5. Si JWT invalide → socket.disconnect()
```

### Handlers Socket (`src/sockets/handlers.ts`)

| Événement reçu | Payload | Action serveur | Événement émis |
|---|---|---|---|
| `join_conversation` | `{ conversationId }` | Vérifie participation → `socket.join(conversationId)` | — |
| `send_message` | `{ conversationId, content }` | Appelle `messageService.createMessage(...)` | `new_message` → room |
| `mark_read` | `{ conversationId }` | Met à jour `read_at` en masse | `message_read` → room |
| `typing` | `{ conversationId }` | — | `user_typing` → room (broadcast sauf émetteur) |

### Événements serveur → client

| Événement | Payload | Destinataire |
|---|---|---|
| `new_message` | `{ id, conversationId, senderId, content, createdAt }` | Tous les membres de la room |
| `message_read` | `{ conversationId, readAt }` | Tous les membres de la room |
| `user_typing` | `{ conversationId, userId }` | Tous sauf l'émetteur |

---

## Étape 4 — Read receipts & Typing indicator

**Branche :** `feat/read-receipts`

Inclus dans l'étape 3 ci-dessus. Points d'attention :

- **`mark_read` en masse** : le client appelle `mark_read` quand l'utilisateur ouvre une conversation, pas message par message. Une seule requête SQL, un seul événement Socket.
- **`typing`** : événement éphémère, rien n'est persisté en base. Le client envoie `typing` à chaque frappe (throttlé côté mobile). Le serveur rebroadcast immédiatement.

---

## Étape 5 — Tests unitaires

**Branche :** `feat/tests`

### Stratégie de mock

Les services sont testés avec Prisma mocké via `jest.mock('../lib/prisma')`. Les routes sont testées avec `supertest` + un mock du middleware auth (qui injecte un `req.user` fictif).

### Couverture cible

**Middleware auth (`tests/middleware/auth.test.ts`) :**
- JWT valide → `req.user` rempli, user upserted
- JWT expiré → 401
- Header absent → 401
- User absent de la base avant upsert → créé automatiquement

**`conversationService` (`tests/services/conversationService.test.ts`) :**
- `getOrCreate` avec conversation existante → retourne l'existante (idempotent)
- `getOrCreate` sans conversation → crée conv + 2 participants
- `getOrCreate` avec un recipientId inexistant → erreur métier

**`messageService` (`tests/services/messageService.test.ts`) :**
- `createMessage` → persiste en base ET émet `new_message` sur Socket.io
- `createMessage` dans une conversation dont on n'est pas participant → rejeté

> ⚠️ **Point de complexité :** tester l'émission Socket.io nécessite de mocker `getIO()` via `jest.mock('../lib/socket')` et de vérifier que `.to().emit()` a bien été appelé avec les bons arguments. La config Jest devra inclure un mock de ce module.

**`userService` (`tests/services/userService.test.ts`) :**
- `searchUsers` → retourne les users dont le username matche
- `searchUsers` avec query vide → retourne rien (ou erreur de validation)

**Routes REST (`tests/routes/`) :**
- Scénario E2E : créer conv → envoyer message → récupérer historique → marquer comme lu → vérifier `read_at` non null

---

## Décisions d'architecture — Résumé

| Décision | Choix | Raison |
|---|---|---|
| Sync users | Upsert lazy dans le middleware | Résilience si webhook Supabase échoue |
| REST + Socket | `createMessage` partagé | Single source of truth, pas de divergence |
| Marquer lu | Par conversation (bulk) | Évite N requêtes à l'ouverture d'un chat |
| Pagination | Offset | Plus simple, suffisant pour V1 |
| Read receipts | `read_at` sur `Message` | Simple pour 1:1, refactor si groupes un jour |
| Auth Socket | JWT au handshake | Même mécanisme que REST, cohérent |

---

## Hors périmètre V1

- Messages groupes (> 2 participants)
- Partage de fichiers / images
- Chiffrement end-to-end
- Suppression / édition de messages
- Réactions aux messages
- Notifications push
