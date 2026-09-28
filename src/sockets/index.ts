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
// Même client JWKS que le middleware HTTP (cache partagé → pas de double appel réseau)
import { getSigningKey, SUPABASE_JWT_ALGORITHMS, SupabaseJwtPayload } from '../lib/jwt';
import { prisma } from '../lib/prisma';
import { userRoom } from '../lib/socket';
import { registerConversationHandlers } from './handlers';

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

    jwt.verify(token, getSigningKey, { algorithms: SUPABASE_JWT_ALGORITHMS }, async (err, decoded) => {
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

    // Room personnelle : reçoit new_message / message_read de toutes ses conversations,
    // y compris celles qui ne sont pas ouvertes à l'écran.
    socket.join(userRoom(socket.data.user.id));

    // Enregistre les handlers d'événements métier (join, send, etc.)
    registerConversationHandlers(io, socket);

    socket.on('disconnect', () => {
      console.log(`[socket] Client déconnecté : ${socket.data.user?.id}`);
    });
  });
};
