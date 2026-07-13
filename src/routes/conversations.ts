// Routes de gestion des conversations.
//
// POST /conversations         → créer ou récupérer une conversation 1:1
// GET  /conversations         → lister les conversations de l'utilisateur connecté

import { Router, Request, Response } from 'express';
import { authMiddleware } from '../middleware/auth';
import { getOrCreateConversation, getUserConversations } from '../services/conversationService';
import { handleError } from '../utils/errors';

const router = Router();

router.use(authMiddleware);

// ─────────────────────────────────────────────
// POST /conversations
// Corps attendu : { recipientId: string }
// ─────────────────────────────────────────────
router.post('/', async (req: Request, res: Response) => {
  // req.user est garanti par le middleware auth (déclaré dans src/types/index.ts)
  const { recipientId } = req.body as { recipientId?: string };

  if (!recipientId) {
    res.status(400).json({ error: 'recipientId requis dans le corps de la requête' });
    return;
  }

  // On ne peut pas démarrer une conversation avec soi-même
  if (recipientId === req.user.id) {
    res.status(400).json({ error: 'Impossible de créer une conversation avec soi-même' });
    return;
  }

  try {
    const conversation = await getOrCreateConversation(req.user.id, recipientId);
    // 200 si conversation existante, 201 si nouvelle — les deux sont gérés côté client
    res.status(200).json(conversation);
  } catch (error) {
    handleError(res, error, 'POST /conversations');
  }
});

// ─────────────────────────────────────────────
// GET /conversations
// ─────────────────────────────────────────────
router.get('/', async (req: Request, res: Response) => {
  try {
    const conversations = await getUserConversations(req.user.id);
    res.json(conversations);
  } catch (error) {
    handleError(res, error, 'GET /conversations');
  }
});

export default router;
