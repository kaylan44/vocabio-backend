// Conversation repository: every query on the Conversation and Participant tables.
//
// Same rule as the other repositories (see userRepository.ts): Prisma only, no
// business decision. In particular this file does NOT decide who may read a
// conversation: `isParticipant` answers a question, and conversationService turns
// the answer into a 403.

import { prisma } from '../lib/prisma';
import { ConversationWithLastMessage, ConversationWithParticipants } from '../types/conversation';
import { PUBLIC_USER_SELECT } from './userRepository';

// ─────────────────────────────────────────────
// Shapes returned to the services
// ─────────────────────────────────────────────
// The return types are declared in src/types/conversation.ts: written by hand instead
// of inferred from Prisma, so that a service (and the REST response built from it)
// does not change shape because a query changed.
//
// An interface alone would not be enough: TypeScript accepts an object that has MORE
// fields than its type says. This is why every query below uses `select` and never
// `include`: `include` returns all the columns of the table, so a column added later
// would reach the client while these interfaces still claimed otherwise.

// Single definition of "a conversation with its participants", shared by the three
// queries below so they can never return different fields. It lists exactly the
// fields of ConversationWithParticipants.
const CONVERSATION_SELECT = {
  id: true,
  createdAt: true,
  participants: {
    select: {
      conversationId: true,
      userId: true,
      user: { select: PUBLIC_USER_SELECT },
    },
  },
} as const;

// ─────────────────────────────────────────────
// Conversations
// ─────────────────────────────────────────────

/**
 * The conversation in which both users are participants, or null.
 *
 * La requête : "trouve une conversation dont les participants incluent userId
 * ET dont les participants incluent recipientId" (deux "some" imbriqués).
 */
export const findConversationBetween = async (
  userId: string,
  recipientId: string
): Promise<ConversationWithParticipants | null> => {
  return prisma.conversation.findFirst({
    where: {
      AND: [
        { participants: { some: { userId } } },
        { participants: { some: { userId: recipientId } } },
      ],
    },
    select: CONVERSATION_SELECT,
  });
};

/**
 * Creates a conversation and its two participants.
 *
 * On crée la conversation ET les deux participants en une seule opération Prisma
 * grâce aux "nested creates" (create imbriqué). This is why it is ONE repository
 * function: split in two, a failure in between would leave a conversation nobody
 * belongs to.
 */
export const createConversation = async (
  userId: string,
  recipientId: string
): Promise<ConversationWithParticipants> => {
  return prisma.conversation.create({
    data: {
      participants: {
        create: [
          { userId },          // L'utilisateur connecté
          { userId: recipientId }, // Le destinataire
        ],
      },
    },
    select: CONVERSATION_SELECT,
  });
};

/**
 * Every conversation of a user, each with its participants and its latest message.
 *
 * Not sorted: the order wanted by the app (most recent message first) depends on the
 * latest message, and Prisma cannot order a findMany by a field of a relation list.
 * The service sorts.
 */
export const findConversationsOf = async (userId: string): Promise<ConversationWithLastMessage[]> => {
  const conversations = await prisma.conversation.findMany({
    where: {
      participants: { some: { userId } },
    },
    select: {
      ...CONVERSATION_SELECT,
      // On prend uniquement le dernier message (orderBy + take: 1)
      messages: {
        orderBy: { createdAt: 'desc' },
        take: 1,
        select: {
          id: true,
          content: true,
          createdAt: true,
          senderId: true,
          readAt: true,
        },
      },
    },
  });

  // "A list of at most one message" is how Prisma expresses "the latest message".
  // That detail stops here: the service receives `lastMessage`, not an array.
  return conversations.map(({ messages, ...conversation }) => ({
    ...conversation,
    lastMessage: messages[0] ?? null,
  }));
};

// ─────────────────────────────────────────────
// Participants
// ─────────────────────────────────────────────

/**
 * Whether `userId` is a participant of the conversation.
 */
export const isParticipant = async (conversationId: string, userId: string): Promise<boolean> => {
  const participant = await prisma.participant.findUnique({
    where: {
      // La clé primaire composite de la table participants
      conversationId_userId: { conversationId, userId },
    },
  });

  return participant !== null;
};

/**
 * Ids of the users taking part in a conversation.
 */
export const findParticipantUserIds = async (conversationId: string): Promise<string[]> => {
  const participants = await prisma.participant.findMany({
    where: { conversationId },
    select: { userId: true },
  });

  return participants.map((participant) => participant.userId);
};
