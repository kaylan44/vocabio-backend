// Routes de gestion des conversations.
//
// POST /conversations         → créer ou récupérer une conversation 1:1
// GET  /conversations         → lister les conversations de l'utilisateur connecté

import { Router, Response } from 'express';
import { authMiddleware } from '../middleware/auth';
import { getOrCreateConversation, getUserConversations } from '../services/conversationService';
import { AuthRequest } from '../types';

const router = Router();

router.use(authMiddleware);

// ─────────────────────────────────────────────
// POST /conversations
// Corps attendu : { recipientId: string }
// ─────────────────────────────────────────────
router.post('/', async (req: AuthRequest, res: Response) => {
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
    console.error('[POST /conversations]', error);
    res.status(500).json({ error: 'Erreur lors de la création de la conversation' });
  }
});

// ─────────────────────────────────────────────
// GET /conversations
// ─────────────────────────────────────────────
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const conversations = await getUserConversations(req.user.id);
    res.json(conversations);
  } catch (error) {
    console.error('[GET /conversations]', error);
    res.status(500).json({ error: 'Erreur lors de la récupération des conversations' });
  }
});

export default router;
