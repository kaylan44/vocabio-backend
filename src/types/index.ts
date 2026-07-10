// Ce fichier centralise les types TypeScript partagés entre les différents modules.
// Importer depuis ici plutôt que de redéfinir les mêmes types partout.

import { Request } from 'express';

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
// AuthRequest
// Extension du type Request d'Express pour inclure req.user.
// On l'utilise dans les handlers à la place de Request pour avoir
// l'autocomplétion TypeScript sur req.user.
// ─────────────────────────────────────────────
export interface AuthRequest extends Request {
  user: AuthUser;
}
