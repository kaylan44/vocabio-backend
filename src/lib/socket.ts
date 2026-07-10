// Ce fichier expose l'instance Socket.io sous forme de singleton.
//
// Problème résolu :
// messageService doit émettre des événements Socket.io quand un message est créé.
// Mais messageService ne doit pas dépendre de sockets/index.ts (risque de dépendance
// circulaire : sockets → services → sockets).
//
// Solution : ce module intermédiaire.
// 1. app.ts appelle initSocket(httpServer) au démarrage → stocke l'instance io
// 2. n'importe quel service appelle getIO() pour récupérer l'instance
//
// Flux : app.ts → initSocket() → [plus tard] messageService → getIO() → io.to(...).emit(...)

import { Server } from 'socket.io';
import { createServer } from 'http';

// L'instance Socket.io, initialisée une seule fois au démarrage du serveur.
// Elle est undefined jusqu'à ce que initSocket() soit appelé.
let io: Server | undefined;

/**
 * Initialise l'instance Socket.io sur le serveur HTTP fourni.
 * Doit être appelé UNE SEULE FOIS au démarrage, dans app.ts.
 */
export const initSocket = (httpServer: ReturnType<typeof createServer>): Server => {
  io = new Server(httpServer, {
    // CORS : autorise les connexions depuis n'importe quelle origine en développement.
    // En production, remplacer "*" par l'URL de l'app React Native.
    cors: {
      origin: '*',
      methods: ['GET', 'POST'],
    },
  });
  return io;
};

/**
 * Retourne l'instance Socket.io existante.
 * Lance une erreur si initSocket() n'a pas encore été appelé
 * (protection contre les bugs d'ordre d'initialisation).
 */
export const getIO = (): Server => {
  if (!io) {
    throw new Error(
      'Socket.io non initialisé. Appelle initSocket(httpServer) dans app.ts avant tout.'
    );
  }
  return io;
};
