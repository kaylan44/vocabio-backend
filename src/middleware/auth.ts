// Middleware d'authentification JWT Supabase.
//
// Ce middleware est exécuté AVANT chaque handler de route protégée.
// Son rôle :
//   1. Extraire le JWT du header Authorization
//   2. Vérifier sa signature avec la clé publique Supabase (via JWKS)
//   3. Faire un upsert lazy du user en base (au cas où le webhook d'inscription aurait raté)
//   4. Attacher req.user pour les handlers suivants
//
// Pourquoi JWKS et pas un secret partagé ?
// Supabase signe le JWT avec sa clé PRIVÉE (asymétrique, ES256 sur ce projet),
// et notre serveur vérifie avec la clé PUBLIQUE exposée par l'endpoint JWKS.
// Avantage : on n'a jamais besoin de connaître la clé privée.
// Client JWKS, cache et algorithmes acceptés : voir src/lib/jwt.ts.

import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { getSigningKey, SUPABASE_JWT_ALGORITHMS, SupabaseJwtPayload } from '../lib/jwt';
import { prisma } from '../lib/prisma';
import { AuthUser } from '../types';

// ─────────────────────────────────────────────
// Middleware authMiddleware
// Usage : router.get('/ma-route', authMiddleware, monHandler)
// ─────────────────────────────────────────────
export const authMiddleware = (req: Request, res: Response, next: NextFunction): void => {
  // 1. Extraire le token du header "Authorization: Bearer <token>"
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Token manquant ou mal formaté' });
    return;
  }

  const token = authHeader.split(' ')[1];

  // 2. Vérifier la signature du JWT avec la clé publique JWKS
  // jwt.verify est asynchrone quand on lui passe un callback de clé (getSigningKey)
  jwt.verify(token, getSigningKey, { algorithms: SUPABASE_JWT_ALGORITHMS }, async (err, decoded) => {
    if (err || !decoded) {
      res.status(401).json({ error: 'Token invalide ou expiré' });
      return;
    }

    const payload = decoded as SupabaseJwtPayload;

    // 3. Extraire les infos du payload
    // Le username vient de user_metadata (rempli par Google SSO).
    // Fallback sur la partie locale de l'email si absent.
    const username =
      payload.user_metadata?.full_name ??
      payload.user_metadata?.name ??
      payload.email.split('@')[0];

    const avatarUrl = payload.user_metadata?.avatar_url ?? null;

    try {
      // 4. Upsert lazy : créer le user s'il n'existe pas encore en base.
      // Cas nominal : le webhook Supabase a déjà créé le user → update: {} ne modifie rien.
      // Cas de rattrapage : webhook raté → on crée le user ici silencieusement.
      await prisma.user.upsert({
        where: { id: payload.sub },
        create: {
          id: payload.sub,
          username,
          avatarUrl,
        },
        // On ne met pas à jour les données existantes pour ne pas écraser
        // d'éventuelles modifications manuelles (ex: username personnalisé)
        update: {},
      });

      // 5. Attacher l'utilisateur authentifié à la requête pour les handlers suivants
      (req as Request & { user: AuthUser }).user = {
        id: payload.sub,
        username,
        email: payload.email,
      };

      next();
    } catch (dbError) {
      console.error('[authMiddleware] Erreur upsert user:', dbError);
      res.status(500).json({ error: 'Erreur serveur lors de l\'authentification' });
    }
  });
};
