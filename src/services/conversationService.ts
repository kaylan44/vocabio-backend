// Service conversations.
//
// Contient toute la logique métier autour des conversations 1:1 :
//   - Créer ou récupérer une conversation existante (idempotent)
//   - Lister les conversations d'un utilisateur avec les métadonnées d'affichage
//   - Vérifier qu'un utilisateur est bien participant d'une conversation (guard de sécurité)

import * as conversationRepository from '../repositories/conversationRepository';
import * as messageRepository from '../repositories/messageRepository';
import { ConversationWithParticipants } from '../types/conversation';

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
export const getOrCreateConversation = async (
  userId: string,
  recipientId: string
): Promise<ConversationWithParticipants> => {
  // Étape 1 : chercher une conversation existante entre les deux utilisateurs.
  const existing = await conversationRepository.findConversationBetween(userId, recipientId);

  if (existing) {
    return existing;
  }

  // Étape 2 : aucune conversation trouvée → on en crée une nouvelle.
  return conversationRepository.createConversation(userId, recipientId);
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
  // Récupère toutes les conversations de l'user avec leurs participants et leur dernier message.
  // Pas triées : on trie après enrichissement par lastMessage.createdAt
  // (Prisma ne supporte pas orderBy sur une relation agrégée dans findMany)
  const conversations = await conversationRepository.findConversationsOf(userId);

  // Pour chaque conversation, on compte les messages non lus séparément.
  // Prisma ne supporte pas COUNT dans un include, donc on fait des requêtes parallèles.
  const enriched = await Promise.all(
    conversations.map(async (conv) => {
      // L'autre participant = celui qui n'est pas l'utilisateur connecté
      const otherParticipant = conv.participants.find((p) => p.userId !== userId);

      // Compte les messages non lus : envoyés par l'autre, pas encore lus
      const unreadCount = await messageRepository.countUnreadMessages(conv.id, userId);

      return {
        id: conv.id,
        createdAt: conv.createdAt,
        otherParticipant: otherParticipant?.user ?? null,
        lastMessage: conv.lastMessage,
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
  const participant = await conversationRepository.isParticipant(conversationId, userId);

  if (!participant) {
    // On utilise une erreur avec un code personnalisé pour que le handler
    // puisse retourner exactement un 403 (et non un 500 générique)
    const err = new Error('Accès refusé : vous n\'êtes pas participant de cette conversation');
    (err as any).statusCode = 403;
    throw err;
  }
};
