// Route de recherche d'utilisateurs.
//
// GET /users/search?q=alice
// Retourne les utilisateurs dont le username contient la query,
// en excluant l'utilisateur connecté de ses propres résultats.

import { Router, Request, Response } from 'express';
import { authMiddleware } from '../middleware/auth';
import { searchUsers } from '../services/userService';
import { AuthRequest } from '../types';

const router = Router();

// Toutes les routes de ce router nécessitent une authentification
router.use(authMiddleware);

// GET /users/search?q=<query>
router.get('/search', async (req: Request, res: Response) => {
  const { user } = req as AuthRequest;
  const query = req.query.q as string | undefined;

  if (!query) {
    res.status(400).json({ error: 'Paramètre q requis (ex: /users/search?q=alice)' });
    return;
  }

  try {
    const users = await searchUsers(query, user.id);
    res.json(users);
  } catch (error) {
    console.error('[GET /users/search]', error);
    res.status(500).json({ error: 'Erreur lors de la recherche' });
  }
});

export default router;
