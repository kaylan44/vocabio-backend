// Service utilisateurs.
//
// Contient la logique métier liée aux utilisateurs.
// Les routes appellent ces fonctions plutôt que Prisma directement,
// ce qui permet de tester la logique sans passer par HTTP.

import { prisma } from '../lib/prisma';

// Plafond de sécurité : la liste est chargée d'un bloc par l'app (pas de pagination).
// Au-delà, l'écran bascule naturellement sur la recherche par nom.
export const LIST_USERS_LIMIT = 100;

/**
 * Liste les utilisateurs par ordre alphabétique, sans l'utilisateur connecté.
 * Affichée à l'ouverture de l'écran "Nouvelle conversation", avant toute saisie.
 *
 * @param excludeUserId - L'ID de l'utilisateur connecté
 */
export const listUsers = async (excludeUserId: string) => {
  return prisma.user.findMany({
    where: { NOT: { id: excludeUserId } },
    select: { id: true, username: true, avatarUrl: true },
    orderBy: { username: 'asc' },
    take: LIST_USERS_LIMIT,
  });
};

/**
 * Recherche des utilisateurs par username (recherche partielle, insensible à la casse).
 *
 * Pourquoi "contains" + "mode insensitive" ?
 * Un utilisateur qui tape "alice" doit trouver "Alice", "ALICE", etc.
 * Prisma traduit ça en ILIKE '%alice%' côté PostgreSQL.
 *
 * @param query - Le texte saisi par l'utilisateur dans la barre de recherche
 * @param excludeUserId - L'ID de l'utilisateur connecté (on ne s'affiche pas dans ses propres résultats)
 */
export const searchUsers = async (query: string, excludeUserId: string) => {
  if (!query || query.trim().length === 0) {
    return [];
  }

  return prisma.user.findMany({
    where: {
      username: {
        contains: query.trim(),
        mode: 'insensitive', // Équivalent ILIKE en PostgreSQL
      },
      // On exclut l'utilisateur connecté de ses propres résultats de recherche
      NOT: { id: excludeUserId },
    },
    // On ne retourne que les champs nécessaires (jamais de données sensibles)
    select: {
      id: true,
      username: true,
      avatarUrl: true,
    },
    take: 20, // Limite à 20 résultats pour ne pas surcharger le client mobile
  });
};
