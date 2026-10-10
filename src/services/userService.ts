// Service utilisateurs.
//
// Contient la logique métier liée aux utilisateurs.
// Les routes appellent ces fonctions plutôt que Prisma directement,
// ce qui permet de tester la logique sans passer par HTTP.

import * as userRepository from '../repositories/userRepository';
import { PublicUser } from '../repositories/userRepository';

// Plafond de sécurité : la liste est chargée d'un bloc par l'app (pas de pagination).
// Au-delà, l'écran bascule naturellement sur la recherche par nom.
export const LIST_USERS_LIMIT = 100;
// Limite à 20 résultats pour ne pas surcharger le client mobile
export const SEARCH_USERS_LIMIT = 20;

/**
 * Makes sure the authenticated user has a row in our database.
 *
 * Called on every authenticated HTTP request (src/middleware/auth.ts) and on every
 * Socket.io handshake (src/sockets/index.ts). Both used to write the same Prisma
 * upsert themselves; they now share this single entry point.
 *
 * Nominal case: the Postgres trigger on auth.users (sync_auth_users migration) already
 * created the user, and nothing changes. Catch-up case: the trigger did not run (e.g. a
 * database without it), and the user is silently created here.
 *
 * Existing data is never overwritten (see upsertUser).
 *
 * @param user - Identity read from the verified JWT, never from a request body
 */
export const ensureUser = async (user: PublicUser): Promise<void> => {
  await userRepository.upsertUser(user);
};

/**
 * Liste les utilisateurs par ordre alphabétique, sans l'utilisateur connecté.
 * Affichée à l'ouverture de l'écran "Nouvelle conversation", avant toute saisie.
 *
 * @param excludeUserId - L'ID de l'utilisateur connecté
 */
export const listUsers = async (excludeUserId: string) => {
  return userRepository.findUsers(excludeUserId, LIST_USERS_LIMIT);
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

  // On exclut l'utilisateur connecté de ses propres résultats de recherche
  return userRepository.searchUsersByUsername(query.trim(), excludeUserId, SEARCH_USERS_LIMIT);
};
