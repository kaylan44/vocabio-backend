// Utilitaire de gestion d'erreurs HTTP partagé entre toutes les routes.
//
// Pourquoi centraliser ici ?
// Plusieurs routes doivent gérer le cas où assertParticipant() lance une erreur
// avec un statusCode personnalisé (ex: 403). Sans helper partagé, chaque route
// devait dupliquer la même logique de vérification d'err.statusCode.
// Ce helper garantit que le code HTTP est toujours propagé correctement.

import { Response } from 'express';

/**
 * Gère une erreur catch dans un handler Express.
 *
 * Comportement :
 * - Si l'erreur a un champ `statusCode`, on utilise ce code HTTP (ex: 403 depuis assertParticipant)
 * - Sinon, on retourne 500 avec un message générique et on log l'erreur
 *
 * @param res     - L'objet Response Express pour envoyer la réponse
 * @param error   - L'erreur catchée (type unknown pour forcer la vérification)
 * @param context - Label pour le log (ex: 'POST /conversations') — aide au débogage
 */
export const handleError = (res: Response, error: unknown, context: string): void => {
  // On cast en `any` uniquement ici, dans le helper isolé, pour vérifier statusCode
  // Partout ailleurs dans le code, on utilise ce helper sans cast
  const err = error as { statusCode?: number; message?: string };

  if (err.statusCode) {
    // Erreur applicative avec code HTTP explicite (ex: 403 depuis assertParticipant)
    res.status(err.statusCode).json({ error: err.message });
    return;
  }

  // Erreur inattendue → log serveur + réponse générique au client
  // On ne renvoie jamais le détail de l'erreur au client (risque de fuite d'info)
  console.error(`[${context}]`, error);
  res.status(500).json({ error: 'Erreur serveur' });
};
