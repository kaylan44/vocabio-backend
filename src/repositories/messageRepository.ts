// Message repository: every query on the Message table.
//
// Same rule as the other repositories (see userRepository.ts): Prisma only. Nothing
// is emitted on Socket.io from here; messageService persists through this file, THEN
// emits. Keeping the two apart is what lets a message be stored even when the
// real-time broadcast fails.

import { prisma } from '../lib/prisma';
import { PUBLIC_USER_SELECT, PublicUser } from './userRepository';

export interface MessageWithSender {
  id: string;
  conversationId: string;
  senderId: string;
  content: string;
  createdAt: Date;
  readAt: Date | null;
  sender: PublicUser;
}

// Exactly the fields of MessageWithSender. `select` and not `include`: `include`
// returns every column of Message, so a column added later would be sent to the
// client (REST response and `new_message` event) without anyone deciding it.
//
// The sender comes with the message so the client does not need a second request to
// show a name and an avatar.
const MESSAGE_SELECT = {
  id: true,
  conversationId: true,
  senderId: true,
  content: true,
  createdAt: true,
  readAt: true,
  sender: { select: PUBLIC_USER_SELECT },
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
    select: MESSAGE_SELECT,
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
    select: MESSAGE_SELECT,
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
