// Initialisation de Socket.io et enregistrement des handlers.
//
// Ce fichier :
//   1. Applique le middleware d'authentification JWT sur chaque connexion WebSocket
//   2. À la connexion d'un client, enregistre les handlers d'événements
//
// Le middleware Socket.io fonctionne comme le middleware Express :
// il est exécuté avant que la connexion soit acceptée.
// Si le JWT est invalide, on déconnecte immédiatement le socket.
//
// NOTE : ce fichier sera complété à l'étape 3 (Temps réel).
// Pour l'instant il expose juste initSocketHandlers() pour que app.ts compile.

import { Server, Socket } from 'socket.io';
import jwt from 'jsonwebtoken';
import jwksRsa from 'jwks-rsa';
import { prisma } from '../lib/prisma';
import { registerConversationHandlers } from './handlers';

// Réutilise le même client JWKS que le middleware HTTP
// (le cache est partagé → pas de double appel réseau)
const jwksClient = jwksRsa({
  jwksUri: `${process.env.SUPABASE_URL}/auth/v1/.well-known/jwks.json`,
  cache: true,
  cacheMaxEntries: 5,
  cacheMaxAge: 10 * 60 * 1000,
});

const getSigningKey = (
  header: jwt.JwtHeader,
  callback: jwt.SigningKeyCallback
) => {
  jwksClient.getSigningKey(header.kid, (err, key) => {
    if (err || !key) return callback(err ?? new Error('Clé JWKS introuvable'));
    callback(null, key.getPublicKey());
  });
};

interface SupabaseJwtPayload extends jwt.JwtPayload {
  sub: string;
  email: string;
  user_metadata?: { full_name?: string; name?: string; avatar_url?: string };
}

/**
 * Initialise les handlers Socket.io.
 * Appelé une seule fois depuis app.ts après initSocket().
 */
export const initSocketHandlers = (io: Server): void => {
  // ─────────────────────────────────────────────
  // Middleware d'authentification Socket.io
  // Exécuté à chaque tentative de connexion WebSocket, avant que
  // l'événement "connection" ne soit émis.
  // ─────────────────────────────────────────────
  io.use((socket: Socket, next) => {
    // Le client React Native envoie le JWT dans socket.handshake.auth.token
    // ex: io(URL, { auth: { token: supabaseJWT } })
    const token = socket.handshake.auth?.token as string | undefined;

    if (!token) {
      return next(new Error('Token manquant'));
    }

    jwt.verify(token, getSigningKey, { algorithms: ['RS256'] }, async (err, decoded) => {
      if (err || !decoded) {
        return next(new Error('Token invalide ou expiré'));
      }

      const payload = decoded as SupabaseJwtPayload;
      const username =
        payload.user_metadata?.full_name ??
        payload.user_metadata?.name ??
        payload.email.split('@')[0];

      try {
        // Upsert lazy : même logique que le middleware HTTP
        await prisma.user.upsert({
          where: { id: payload.sub },
          create: { id: payload.sub, username, avatarUrl: payload.user_metadata?.avatar_url ?? null },
          update: {},
        });

        // Attacher l'user au socket pour y accéder dans les handlers
        socket.data.user = { id: payload.sub, username, email: payload.email };
        next();
      } catch (dbError) {
        console.error('[socket auth] Erreur upsert:', dbError);
        next(new Error('Erreur serveur'));
      }
    });
  });

  // ─────────────────────────────────────────────
  // Connexion d'un client
  // ─────────────────────────────────────────────
  io.on('connection', (socket: Socket) => {
    console.log(`[socket] Client connecté : ${socket.data.user?.id}`);

    // Enregistre les handlers d'événements métier (join, send, etc.)
    registerConversationHandlers(io, socket);

    socket.on('disconnect', () => {
      console.log(`[socket] Client déconnecté : ${socket.data.user?.id}`);
    });
  });
};
