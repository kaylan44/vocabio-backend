// Message repository: every query on the Message table.
//
// Same rule as the other repositories (see userRepository.ts): Prisma only. Nothing
// is emitted on Socket.io from here; messageService persists through this file, THEN
// emits. Keeping the two apart is what lets a message be stored even when the
// real-time broadcast fails.

import { prisma } from '../lib/prisma';
import { PublicUser } from './userRepository';

export interface MessageWithSender {
  id: string;
  conversationId: string;
  senderId: string;
  content: string;
  createdAt: Date;
  readAt: Date | null;
  sender: PublicUser;
}

// On inclut les infos de l'expéditeur pour ne pas avoir à faire
// une deuxième requête côté client pour afficher son nom/avatar
const SENDER_INCLUDE = {
  sender: {
    select: { id: true, username: true, avatarUrl: true },
  },
} as const;

/**
 * Stores a message and returns it with its sender.
 */
export const createMessage = async (
  conversationId: string,
  senderId: string,
  content: string
): Promise<MessageWithSender> => {
  return prisma.message.create({
    data: {
      conversationId,
      senderId,
      content,
      // readAt reste NULL : le message est non lu jusqu'à ce que le destinataire ouvre la conv
    },
    include: SENDER_INCLUDE,
  });
};

/**
 * One page of the messages of a conversation, newest first.
 *
 * @param offset - Number of messages to skip
 * @param limit - Maximum number of messages
 */
export const findMessages = async (
  conversationId: string,
  offset: number,
  limit: number
): Promise<MessageWithSender[]> => {
  return prisma.message.findMany({
    where: { conversationId },
    orderBy: { createdAt: 'desc' }, // Plus récents d'abord
    skip: offset,
    take: limit,
    include: SENDER_INCLUDE,
  });
};

/**
 * Number of messages of a conversation that `userId` received and has not read.
 */
export const countUnreadMessages = async (conversationId: string, userId: string): Promise<number> => {
  return prisma.message.count({
    where: {
      conversationId,
      senderId: { not: userId }, // Messages envoyés par l'autre participant
      readAt: null,              // Pas encore lus (readAt NULL = non lu)
    },
  });
};

/**
 * Marks as read, in ONE update, every unread message that `userId` received in the
 * conversation.
 *
 * @param readAt - Date to store; given by the service so the same value is also sent
 *                 in the `message_read` event
 * @returns the number of messages that were actually marked
 */
export const markMessagesAsRead = async (
  conversationId: string,
  userId: string,
  readAt: Date
): Promise<number> => {
  const result = await prisma.message.updateMany({
    where: {
      conversationId,
      senderId: { not: userId }, // Seulement les messages reçus, pas envoyés
      readAt: null,              // Seulement les messages pas encore lus
    },
    data: { readAt },
  });

  return result.count;
};
