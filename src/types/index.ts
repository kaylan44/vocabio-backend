// Ce fichier centralise les types TypeScript partagés entre les différents modules.
// Importer depuis ici plutôt que de redéfinir les mêmes types partout.

// ─────────────────────────────────────────────
// AuthUser
// Représente l'utilisateur authentifié extrait du JWT Supabase.
// Ces informations sont disponibles dans TOUS les handlers après le middleware auth,
// via req.user.
// ─────────────────────────────────────────────
export interface AuthUser {
  id: string;       // UUID Supabase Auth (champ "sub" du JWT)
  username: string; // Extrait de user_metadata.username ou de l'email
  email: string;
}

// ─────────────────────────────────────────────
// Augmentation globale du namespace Express
//
// Pourquoi cette approche plutôt qu'une interface AuthRequest ?
// Express's router.get/post/patch overloads n'acceptent pas les sous-types de Request
// dans la signature du handler, ce qui forçait des casts `req as AuthRequest`
// non vérifiables par TypeScript.
//
// En augmentant le namespace global Express.Request, req.user devient disponible
// sur le type Request de base directement — sans cast.
// TypeScript garantit au compile-time que user est défini si authMiddleware a tourné.
// ─────────────────────────────────────────────
declare global {
  namespace Express {
    interface Request {
      user: AuthUser;
    }
  }
}

// AuthRequest reste exporté pour compatibilité avec le middleware auth qui l'utilise encore
import { Request } from 'express';
export interface AuthRequest extends Request {
  user: AuthUser;
}
