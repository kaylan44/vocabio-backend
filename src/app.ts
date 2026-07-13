// Point d'entrée du serveur.
//
// Ce fichier :
//   1. Crée l'application Express
//   2. Crée le serveur HTTP Node.js (nécessaire pour que Socket.io puisse s'y greffer)
//   3. Initialise Socket.io sur ce serveur HTTP (via le singleton src/lib/socket.ts)
//   4. Enregistre les middlewares globaux (parsing JSON, CORS si besoin)
//   5. Monte les routes
//   6. Démarre l'écoute sur le port configuré
//
// Pourquoi séparer Express et http.createServer ?
// Express seul gère uniquement HTTP. Socket.io a besoin d'accéder au serveur HTTP
// sous-jacent pour "upgrader" une connexion HTTP en WebSocket.
// En créant le serveur HTTP manuellement et en y greffant Express,
// on donne à Socket.io accès à ce serveur.

import 'dotenv/config'; // Charge .env en local — no-op en prod si le fichier est absent
import express from 'express';
import { createServer } from 'http';
import { initSocket } from './lib/socket';
import { initSocketHandlers } from './sockets';
import webhookRouter from './routes/webhooks';
import userRouter from './routes/users';
import conversationRouter from './routes/conversations';
import messageRouter from './routes/messages';

const app = express();

// ─────────────────────────────────────────────
// Middlewares globaux
// ─────────────────────────────────────────────

// Webhook Supabase : on a besoin du body brut (string) pour vérifier le HMAC.
// On monte cette route AVANT express.json() pour capter le body non parsé.
app.use('/webhooks', express.raw({ type: 'application/json' }), (req, _res, next) => {
  // Convertit le Buffer en objet JS pour que la route webhook puisse le lire normalement
  if (Buffer.isBuffer(req.body)) {
    req.body = JSON.parse(req.body.toString());
  }
  next();
}, webhookRouter);

// Pour toutes les autres routes : parse le body JSON automatiquement
app.use(express.json());

// ─────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────
app.get('/health', (_req, res) => {
  // Route de vérification : Railway l'utilise pour savoir si le serveur est up
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.use('/users', userRouter);
app.use('/conversations', conversationRouter);
// Les routes messages sont imbriquées sous /conversations/:id
// ex: GET /conversations/abc/messages
app.use('/conversations', messageRouter);

// ─────────────────────────────────────────────
// Serveur HTTP + Socket.io
// ─────────────────────────────────────────────

// On crée le serveur HTTP en lui passant l'app Express comme handler de requêtes
const httpServer = createServer(app);

// On initialise Socket.io sur ce serveur HTTP.
// initSocket retourne l'instance io et la stocke dans src/lib/socket.ts (singleton)
// pour que les services puissent y accéder via getIO().
const io = initSocket(httpServer);

// On enregistre tous les handlers d'événements Socket.io
// (join_conversation, send_message, etc.) — implémentés à l'étape 3
initSocketHandlers(io);

// ─────────────────────────────────────────────
// Démarrage
// ─────────────────────────────────────────────
const PORT = process.env.PORT ?? 3000;

httpServer.listen(PORT, () => {
  console.log(`Serveur démarré sur le port ${PORT}`);
});

export { app, httpServer };
