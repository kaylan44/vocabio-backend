// Service conversations.
//
// Contient toute la logique métier autour des conversations 1:1 :
//   - Créer ou récupérer une conversation existante (idempotent)
//   - Lister les conversations d'un utilisateur avec les métadonnées d'affichage
//   - Vérifier qu'un utilisateur est bien participant d'une conversation (guard de sécurité)

import { prisma } from '../lib/prisma';

// ─────────────────────────────────────────────
// getOrCreateConversation
// ─────────────────────────────────────────────
/**
 * Retourne la conversation 1:1 existante entre deux utilisateurs,
 * ou en crée une nouvelle si elle n'existe pas encore.
 *
 * Pourquoi "idempotent" ?
 * Si le client mobile appelle cet endpoint deux fois (réseau instable, retry),
 * on ne doit pas créer deux conversations entre les mêmes personnes.
 * La logique "cherche d'abord, crée si absent" garantit l'unicité.
 *
 * Comment on trouve une conversation existante entre A et B ?
 * On cherche une conversation où A est participant ET B est participant.
 * La requête Prisma utilise deux "some" imbriqués pour ça.
 */
export const getOrCreateConversation = async (userId: string, recipientId: string) => {
  // Étape 1 : chercher une conversation existante entre les deux utilisateurs.
  // La requête : "trouve une conversation dont les participants incluent userId
  // ET dont les participants incluent recipientId"
  const existing = await prisma.conversation.findFirst({
    where: {
      AND: [
        { participants: { some: { userId } } },
        { participants: { some: { userId: recipientId } } },
      ],
    },
    // On inclut les participants pour pouvoir les retourner au client
    include: {
      participants: {
        include: { user: { select: { id: true, username: true, avatarUrl: true } } },
      },
    },
  });

  if (existing) {
    return existing;
  }

  // Étape 2 : aucune conversation trouvée → on en crée une nouvelle.
  // On crée la conversation ET les deux participants en une seule opération Prisma
  // grâce aux "nested creates" (create imbriqué).
  return prisma.conversation.create({
    data: {
      participants: {
        create: [
          { userId },          // L'utilisateur connecté
          { userId: recipientId }, // Le destinataire
        ],
      },
    },
    include: {
      participants: {
        include: { user: { select: { id: true, username: true, avatarUrl: true } } },
      },
    },
  });
};

// ─────────────────────────────────────────────
// getUserConversations
// ─────────────────────────────────────────────
/**
 * Retourne toutes les conversations de l'utilisateur, enrichies des métadonnées
 * nécessaires pour afficher la liste des chats dans l'app mobile :
 *   - L'autre participant (nom + avatar)
 *   - Le dernier message (contenu + date)
 *   - Le nombre de messages non lus
 *
 * Stratégie : on fait plusieurs requêtes Prisma et on assemble en mémoire.
 * C'est plus lisible qu'une seule requête SQL complexe avec des sous-agrégations.
 * Si les performances deviennent un problème à grande échelle,
 * on pourra basculer sur prisma.$queryRaw (voir PLAN.md).
 */
export const getUserConversations = async (userId: string) => {
  // Récupère toutes les conversations de l'user avec leurs participants et messages
  const conversations = await prisma.conversation.findMany({
    where: {
      participants: { some: { userId } },
    },
    include: {
      participants: {
        include: { user: { select: { id: true, username: true, avatarUrl: true } } },
      },
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
    // Pas de orderBy ici : on trie après enrichissement par lastMessage.createdAt
    // (Prisma ne supporte pas orderBy sur une relation agrégée dans findMany)
  });

  // Pour chaque conversation, on compte les messages non lus séparément.
  // Prisma ne supporte pas COUNT dans un include, donc on fait des requêtes parallèles.
  const enriched = await Promise.all(
    conversations.map(async (conv) => {
      // L'autre participant = celui qui n'est pas l'utilisateur connecté
      const otherParticipant = conv.participants.find((p) => p.userId !== userId);

      // Compte les messages non lus : envoyés par l'autre, pas encore lus
      const unreadCount = await prisma.message.count({
        where: {
          conversationId: conv.id,
          senderId: { not: userId }, // Messages envoyés par l'autre participant
          readAt: null,              // Pas encore lus (readAt NULL = non lu)
        },
      });

      return {
        id: conv.id,
        createdAt: conv.createdAt,
        otherParticipant: otherParticipant?.user ?? null,
        lastMessage: conv.messages[0] ?? null,
        unreadCount,
      };
    })
  );

  // Tri par date du dernier message décroissante (les conversations les plus actives en premier).
  // Les conversations sans aucun message se retrouvent à la fin (null < toute date).
  enriched.sort((a, b) => {
    const dateA = a.lastMessage?.createdAt ?? '';
    const dateB = b.lastMessage?.createdAt ?? '';
    // Comparaison de strings ISO 8601 : ordre lexicographique = ordre chronologique
    return dateB > dateA ? 1 : dateB < dateA ? -1 : 0;
  });

  return enriched;
};

// ─────────────────────────────────────────────
// assertParticipant (guard de sécurité)
// ─────────────────────────────────────────────
/**
 * Vérifie que l'utilisateur est bien participant de la conversation.
 * Lance une erreur si ce n'est pas le cas.
 *
 * Ce guard est appelé au début de chaque handler qui accède aux messages
 * d'une conversation, pour éviter qu'un utilisateur lise les messages
 * d'une conversation à laquelle il n'appartient pas.
 *
 * Pattern "throw on failure" : le handler n'a qu'à appeler assertParticipant()
 * et s'il ne throw pas, on sait que l'accès est autorisé.
 */
export const assertParticipant = async (conversationId: string, userId: string): Promise<void> => {
  const participant = await prisma.participant.findUnique({
    where: {
      // La clé primaire composite de la table participants
      conversationId_userId: { conversationId, userId },
    },
  });

  if (!participant) {
    // On utilise une erreur avec un code personnalisé pour que le handler
    // puisse retourner exactement un 403 (et non un 500 générique)
    const err = new Error('Accès refusé : vous n\'êtes pas participant de cette conversation');
    (err as any).statusCode = 403;
    throw err;
  }
};
