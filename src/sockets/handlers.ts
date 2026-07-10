// Handlers des événements Socket.io.
//
// Ce fichier sera complété à l'étape 3 (Temps réel).
// Pour l'instant il expose registerConversationHandlers() comme stub vide
// pour que sockets/index.ts compile sans erreur.

import { Server, Socket } from 'socket.io';

/**
 * Enregistre les handlers d'événements Socket.io pour un client connecté.
 * Appelé à chaque nouvelle connexion dans sockets/index.ts.
 *
 * Événements qui seront implémentés à l'étape 3 :
 *   - join_conversation : rejoindre la room d'une conversation
 *   - send_message      : envoyer un message
 *   - mark_read         : marquer les messages comme lus
 *   - typing            : indicateur de frappe
 */
export const registerConversationHandlers = (_io: Server, _socket: Socket): void => {
  // TODO étape 3 : implémenter les handlers temps réel
};
