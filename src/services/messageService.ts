// Service messages.
//
// Contient la logique métier des messages.
// La fonction clé est createMessage() : elle est appelée depuis
// le handler REST ET le handler Socket.io, garantissant un comportement
// identique peu importe le transport utilisé par le client.
//
// Flux : REST handler → createMessage() → persiste + émet Socket
//        Socket handler → createMessage() → persiste + émet Socket

import { prisma } from '../lib/prisma';
import { getIO, userRoom } from '../lib/socket';

/**
 * Rooms à notifier pour un événement de conversation : la room de la conversation
 * (sockets qui l'ont ouverte) + la room personnelle de chaque participant
 * (pour mettre à jour la liste des conversations et les badges non lus).
 * Socket.io dédoublonne : un socket présent dans plusieurs rooms ne reçoit l'événement qu'une fois.
 */
const conversationRooms = async (conversationId: string): Promise<string[]> => {
  const participants = await prisma.participant.findMany({
    where: { conversationId },
    select: { userId: true },
  });
  return [conversationId, ...participants.map((p) => userRoom(p.userId))];
};

// ─────────────────────────────────────────────
// createMessage
// ─────────────────────────────────────────────
/**
 * Crée un message en base de données et le diffuse en temps réel
 * via Socket.io à tous les participants connectés à la conversation.
 *
 * C'est la fonction centrale de toute la messagerie.
 * Elle est volontairement indépendante du transport (HTTP ou WebSocket) :
 * les deux appellent cette même fonction, ce qui évite toute divergence.
 *
 * @param conversationId - L'ID de la conversation cible
 * @param senderId - L'ID de l'utilisateur qui envoie le message
 * @param content - Le contenu textuel du message
 */
export const createMessage = async (
  conversationId: string,
  senderId: string,
  content: string
) => {
  // Étape 1 : Persister le message en base de données
  const message = await prisma.message.create({
    data: {
      conversationId,
      senderId,
      content,
      // readAt reste NULL : le message est non lu jusqu'à ce que le destinataire ouvre la conv
    },
    // On inclut les infos de l'expéditeur pour ne pas avoir à faire
    // une deuxième requête côté client pour afficher son nom/avatar
    include: {
      sender: {
        select: { id: true, username: true, avatarUrl: true },
      },
    },
  });

  // Étape 2 : Diffuser le message en temps réel via Socket.io
  // Cible la room de la conversation ET la room personnelle de chaque participant,
  // y compris l'expéditeur lui-même (utile pour confirmer l'envoi et synchroniser
  // ses autres appareils).
  try {
    const rooms = await conversationRooms(conversationId);
    getIO().to(rooms).emit('new_message', {
      id: message.id,
      conversationId: message.conversationId,
      senderId: message.senderId,
      sender: message.sender,
      content: message.content,
      createdAt: message.createdAt,
      readAt: message.readAt,
    });
  } catch (socketError) {
    // Si Socket.io n'est pas encore initialisé (ex: tests unitaires),
    // on ne bloque pas : le message est quand même persisté en base.
    // En production, ce cas ne devrait jamais arriver.
    console.warn('[messageService] Socket.io non disponible, émission ignorée:', socketError);
  }

  return message;
};

// ─────────────────────────────────────────────
// getMessages
// ─────────────────────────────────────────────
/**
 * Retourne l'historique paginé des messages d'une conversation.
 * Les messages sont triés du plus récent au plus ancien (ordre chronologique inversé)
 * car l'app mobile affiche les plus récents en bas et charge le passé en scrollant vers le haut.
 *
 * @param conversationId - L'ID de la conversation
 * @param offset - Nombre de messages à sauter (pour la pagination)
 * @param limit - Nombre de messages à retourner (défaut : 30)
 */
export const getMessages = async (
  conversationId: string,
  offset: number = 0,
  limit: number = 30
) => {
  return prisma.message.findMany({
    where: { conversationId },
    orderBy: { createdAt: 'desc' }, // Plus récents d'abord
    skip: offset,
    take: limit,
    include: {
      sender: {
        select: { id: true, username: true, avatarUrl: true },
      },
    },
  });
};

// ─────────────────────────────────────────────
// markConversationAsRead
// ─────────────────────────────────────────────
/**
 * Marque TOUS les messages non lus d'une conversation comme lus, en une seule requête.
 *
 * Pourquoi en masse et pas message par message ?
 * Quand un utilisateur ouvre une conversation avec 50 messages non lus,
 * faire 50 requêtes PATCH serait catastrophique pour les performances.
 * Une seule UPDATE en masse est bien plus efficace.
 *
 * On ne marque que les messages REÇUS (senderId !== userId) :
 * inutile de marquer ses propres messages comme "lus par soi-même".
 *
 * Après la mise à jour, on notifie l'expéditeur via Socket.io
 * que ses messages ont été lus (pour afficher les "coches bleues").
 *
 * @param conversationId - L'ID de la conversation
 * @param userId - L'ID de l'utilisateur qui a lu les messages (le destinataire)
 * @returns Le nombre de messages marqués comme lus
 */
export const markConversationAsRead = async (
  conversationId: string,
  userId: string
): Promise<number> => {
  const readAt = new Date();

  // UPDATE en masse : tous les messages non lus envoyés par l'autre participant
  const result = await prisma.message.updateMany({
    where: {
      conversationId,
      senderId: { not: userId }, // Seulement les messages reçus, pas envoyés
      readAt: null,              // Seulement les messages pas encore lus
    },
    data: { readAt },
  });

  // Notifier les autres participants via Socket.io que les messages ont été lus
  // Utile pour afficher les indicateurs de lecture (✓✓) côté expéditeur
  if (result.count > 0) {
    try {
      // Rooms personnelles incluses : l'expéditeur voit ses messages lus même hors
      // de la conversation, et les autres appareils du lecteur remettent le badge à zéro.
      const rooms = await conversationRooms(conversationId);
      getIO().to(rooms).emit('message_read', {
        conversationId,
        readAt,
        readByUserId: userId,
      });
    } catch {
      // Même logique que createMessage : on ne bloque pas si Socket.io est absent
    }
  }

  // Retourne le nombre de messages effectivement marqués comme lus
  return result.count;
};
