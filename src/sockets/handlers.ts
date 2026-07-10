// Handlers des événements Socket.io.
//
// Ce fichier enregistre les handlers pour tous les événements émis par le client mobile.
// Chaque handler est une fonction qui reçoit un payload et exécute une action métier.
//
// Principe clé : les handlers Socket.io appellent les MÊMES services que les routes REST.
// Par exemple, send_message appelle createMessage() exactement comme POST /conversations/:id/messages.
// Cela garantit un comportement identique quel que soit le transport utilisé.
//
// Récapitulatif des événements :
//
//  Client → Serveur :
//    join_conversation  { conversationId }            → rejoindre la room
//    send_message       { conversationId, content }   → envoyer un message
//    mark_read          { conversationId }             → marquer les messages comme lus
//    typing             { conversationId }             → indicateur de frappe
//
//  Serveur → Client (émis depuis les services) :
//    new_message        { id, conversationId, ... }   → nouveau message reçu
//    message_read       { conversationId, readAt, ... }→ messages lus par le destinataire
//    user_typing        { conversationId, userId }     → quelqu'un est en train d'écrire

import { Server, Socket } from 'socket.io';
import { assertParticipant } from '../services/conversationService';
import { createMessage, markConversationAsRead } from '../services/messageService';

/**
 * Enregistre tous les handlers d'événements Socket.io pour un client connecté.
 * Appelé depuis sockets/index.ts à chaque nouvelle connexion.
 *
 * @param io - L'instance Socket.io serveur (pour émettre vers des rooms)
 * @param socket - Le socket du client connecté (pour lire ses événements)
 */
export const registerConversationHandlers = (io: Server, socket: Socket): void => {
  // L'utilisateur authentifié est attaché au socket par le middleware dans sockets/index.ts
  const user = socket.data.user as { id: string; username: string };

  // ─────────────────────────────────────────────
  // join_conversation
  // Le client envoie cet événement dès qu'il ouvre une conversation dans l'app.
  // Rejoindre la "room" permet de recevoir les événements new_message et user_typing
  // ciblés sur cette conversation spécifique.
  //
  // Une "room" Socket.io est simplement un groupe de sockets identifié par un nom.
  // io.to('conv-123').emit(...) envoie à tous les sockets qui ont rejoint cette room.
  // ─────────────────────────────────────────────
  socket.on('join_conversation', async (payload: { conversationId: string }) => {
    const { conversationId } = payload;

    try {
      // Vérification de sécurité : l'utilisateur doit être participant
      // pour rejoindre la room (évite qu'un tiers écoute des conversations privées)
      await assertParticipant(conversationId, user.id);

      socket.join(conversationId);
      console.log(`[socket] ${user.username} a rejoint la room ${conversationId}`);
    } catch (err) {
      // On émet une erreur spécifique au socket émetteur (pas à toute la room)
      socket.emit('error', { message: 'Accès refusé à cette conversation' });
    }
  });

  // ─────────────────────────────────────────────
  // send_message
  // Le client envoie ce message depuis le champ de saisie de l'app.
  // On appelle createMessage() qui :
  //   1. Persiste le message en base
  //   2. Émet new_message à TOUTE la room (y compris l'expéditeur, pour confirmation)
  // ─────────────────────────────────────────────
  socket.on('send_message', async (payload: { conversationId: string; content: string }) => {
    const { conversationId, content } = payload;

    if (!content || content.trim().length === 0) {
      socket.emit('error', { message: 'Le contenu du message ne peut pas être vide' });
      return;
    }

    try {
      await assertParticipant(conversationId, user.id);
      // createMessage émet new_message via Socket.io en interne
      await createMessage(conversationId, user.id, content.trim());
    } catch (err) {
      socket.emit('error', { message: 'Impossible d\'envoyer le message' });
    }
  });

  // ─────────────────────────────────────────────
  // mark_read
  // Déclenché quand l'utilisateur ouvre une conversation ou la met au premier plan.
  // markConversationAsRead() met à jour tous les messages non lus en une seule
  // requête SQL et émet message_read à la room pour notifier l'expéditeur.
  // ─────────────────────────────────────────────
  socket.on('mark_read', async (payload: { conversationId: string }) => {
    const { conversationId } = payload;

    try {
      await assertParticipant(conversationId, user.id);
      await markConversationAsRead(conversationId, user.id);
    } catch (err) {
      socket.emit('error', { message: 'Impossible de marquer les messages comme lus' });
    }
  });

  // ─────────────────────────────────────────────
  // typing
  // Événement éphémère : rien n'est persisté en base.
  // Le serveur rebroadcast simplement à tous les AUTRES membres de la room
  // (socket.to() exclut l'émetteur, contrairement à io.to() qui l'inclut).
  //
  // Le client mobile doit "throttler" cet événement (ex: max 1 fois / seconde)
  // pour ne pas saturer le réseau.
  // ─────────────────────────────────────────────
  socket.on('typing', async (payload: { conversationId: string }) => {
    const { conversationId } = payload;

    try {
      await assertParticipant(conversationId, user.id);

      // socket.to(room) = émet à tous les membres de la room SAUF l'émetteur
      socket.to(conversationId).emit('user_typing', {
        conversationId,
        userId: user.id,
        username: user.username,
      });
    } catch {
      // On ignore silencieusement les erreurs sur typing (événement non critique)
    }
  });
};
