# Vocabio — Architecture Messagerie 1:1

## Vue d'ensemble

Système de messagerie instantanée entre utilisateurs de l'application Vocabio. Périmètre : conversations 1:1, messages texte, indicateurs de lecture, temps réel.

---

## Stack technique

| Couche | Technologie | Rôle |
|---|---|---|
| Mobile | React Native | Client iOS / Android |
| Auth | Supabase Auth | Google SSO, émission de JWTs |
| Base de données | Supabase PostgreSQL | Persistance des données |
| ORM | Prisma | Schéma typé, migrations |
| Serveur API | Node.js + Express | REST endpoints, logique métier |
| Temps réel | Socket.io | WebSockets, livraison des messages |
| Hébergement serveur | Railway | Déploiement Express + Socket.io |

---

## Architecture générale

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

## Flux d'authentification

1. L'utilisateur se connecte via **Google SSO** sur Supabase Auth
2. Supabase retourne un **JWT signé** contenant l'`user_id`
3. React Native stocke le JWT de manière sécurisée (`expo-secure-store`)
4. Chaque requête HTTP et connexion Socket.io inclut le JWT en header
5. Le serveur Express **vérifie le JWT** avec la clé publique Supabase (sans appel réseau)
6. L'identité de l'utilisateur est extraite du token à chaque requête

---

## Modèle de données

### Table `users`
Synchronisée depuis Supabase Auth via webhook à l'inscription.

```sql
users (
  id          UUID PRIMARY KEY,  -- même ID que Supabase Auth
  username    TEXT NOT NULL,
  avatar_url  TEXT,
  created_at  TIMESTAMP DEFAULT NOW()
)
```

### Table `conversations`
Représente un canal 1:1 entre deux utilisateurs.

```sql
conversations (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at  TIMESTAMP DEFAULT NOW()
)
```

### Table `participants`
Table pivot liant utilisateurs et conversations.

```sql
participants (
  conversation_id  UUID REFERENCES conversations(id),
  user_id          UUID REFERENCES users(id),
  PRIMARY KEY (conversation_id, user_id)
)
```

### Table `messages`
```sql
messages (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id  UUID REFERENCES conversations(id),
  sender_id        UUID REFERENCES users(id),
  content          TEXT NOT NULL,
  created_at       TIMESTAMP DEFAULT NOW(),
  read_at          TIMESTAMP  -- NULL = non lu
)
```

---

## API REST (Express)

### Auth
Tous les endpoints requièrent le header `Authorization: Bearer <JWT>`.

### Endpoints

| Méthode | Route | Description |
|---|---|---|
| `GET` | `/users/search?q=` | Rechercher un utilisateur par username |
| `POST` | `/conversations` | Créer ou récupérer une conversation 1:1 |
| `GET` | `/conversations` | Lister les conversations de l'utilisateur |
| `GET` | `/conversations/:id/messages` | Historique paginé des messages |
| `POST` | `/conversations/:id/messages` | Envoyer un message (fallback sans WebSocket) |
| `PATCH` | `/messages/:id/read` | Marquer un message comme lu |

---

## Événements Socket.io (temps réel)

### Connexion
Le client s'authentifie à la connexion en passant le JWT :
```js
const socket = io(SERVER_URL, {
  auth: { token: supabaseJWT }
})
```

### Événements client → serveur

| Événement | Payload | Description |
|---|---|---|
| `join_conversation` | `{ conversationId }` | Rejoindre la room d'une conversation |
| `send_message` | `{ conversationId, content }` | Envoyer un message |
| `mark_read` | `{ messageId }` | Marquer un message comme lu |
| `typing` | `{ conversationId }` | Indicateur de saisie |

### Événements serveur → client

| Événement | Payload | Description |
|---|---|---|
| `new_message` | `{ id, conversationId, senderId, content, createdAt }` | Nouveau message reçu |
| `message_read` | `{ messageId, readAt }` | Confirmation de lecture (pour l'expéditeur) |
| `user_typing` | `{ conversationId, userId }` | Un utilisateur est en train d'écrire |

---

## Sécurité

- Tous les endpoints vérifient le JWT Supabase avant traitement
- Vérification côté serveur que l'utilisateur est bien **participant** de la conversation avant tout accès aux messages
- Le JWT est vérifié en local (clé publique Supabase) — pas d'appel réseau à Supabase à chaque requête
- Les messages ne sont accessibles qu'aux participants de la conversation

---

## Plan de développement

### Étape 1 — Setup & Auth
- Initialiser le projet Express + TypeScript
- Configurer Prisma + connexion Supabase PostgreSQL
- Middleware de vérification JWT Supabase
- Webhook Supabase → création utilisateur en base
- Déploiement Railway

### Étape 2 — Conversations & Messages (REST)
- Endpoints de gestion des conversations
- Endpoint d'envoi et récupération des messages
- Pagination de l'historique

### Étape 3 — Temps réel (Socket.io)
- Authentification Socket.io via JWT
- Rooms par conversation
- Livraison temps réel des messages

### Étape 4 — Read receipts & UX
- Marquage des messages comme lus
- Notification à l'expéditeur via Socket.io
- Indicateur de frappe (typing indicator)

### Étape 5 — Notifications push (optionnel)
- Intégration Expo Push Notifications
- Envoi de notification quand le destinataire est hors ligne

---

## Ce qui est hors périmètre (V1)

- Messages groupes (> 2 participants)
- Partage de fichiers / images
- Chiffrement end-to-end
- Suppression / édition de messages
- Réactions aux messages