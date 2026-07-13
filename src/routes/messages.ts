// Routes de gestion des messages.
//
// GET   /conversations/:id/messages  → historique paginé des messages
// POST  /conversations/:id/messages  → envoyer un message
// PATCH /conversations/:id/read      → marquer tous les messages comme lus

import { Router, Request, Response } from 'express';
import { authMiddleware } from '../middleware/auth';
import { assertParticipant } from '../services/conversationService';
import { createMessage, getMessages, markConversationAsRead } from '../services/messageService';
import { handleError } from '../utils/errors';

const router = Router();

router.use(authMiddleware);

// ─────────────────────────────────────────────
// Helper : parse et valide les paramètres de pagination
// ─────────────────────────────────────────────
const parsePagination = (query: Record<string, unknown>) => {
  // parseInt avec un fallback sur les valeurs par défaut si absent ou invalide
  const offset = Math.max(0, parseInt(query.offset as string) || 0);
  // offset sans borne haute = vecteur DoS (PostgreSQL scanne 2^31 lignes)
  // On plafonne à 10 000 — au-delà, la pagination par curseur est recommandée
  const safOffset = Math.min(10_000, offset);
  const limit = Math.min(100, Math.max(1, parseInt(query.limit as string) || 30));
  return { offset: safOffset, limit };
};

// ─────────────────────────────────────────────
// GET /conversations/:id/messages?offset=0&limit=30
// ─────────────────────────────────────────────
router.get('/:id/messages', async (req: Request, res: Response) => {
  // req.user garanti par authMiddleware (src/types/index.ts)
  const conversationId = req.params.id;

  try {
    // Guard de sécurité : vérifie que l'utilisateur est bien participant
    // Lance une erreur 403 si ce n'est pas le cas
    await assertParticipant(conversationId, req.user.id);

    const { offset, limit } = parsePagination(req.query);
    const messages = await getMessages(conversationId, offset, limit);

    res.json({
      messages,
      pagination: { offset, limit, count: messages.length },
    });
  } catch (error) {
    handleError(res, error, 'GET /conversations/:id/messages');
  }
});

// ─────────────────────────────────────────────
// POST /conversations/:id/messages
// Corps attendu : { content: string }
// ─────────────────────────────────────────────
router.post('/:id/messages', async (req: Request, res: Response) => {
  // req.user garanti par authMiddleware (src/types/index.ts)
  const conversationId = req.params.id;
  const { content } = req.body as { content?: string };

  if (!content || content.trim().length === 0) {
    res.status(400).json({ error: 'Le contenu du message ne peut pas être vide' });
    return;
  }

  try {
    await assertParticipant(conversationId, req.user.id);

    // createMessage persiste en base ET émet l'événement Socket.io new_message
    const message = await createMessage(conversationId, req.user.id, content.trim());
    res.status(201).json(message);
  } catch (error) {
    handleError(res, error, 'POST /conversations/:id/messages');
  }
});

// ─────────────────────────────────────────────
// PATCH /conversations/:id/read
// Marque tous les messages non lus de la conversation comme lus
// ─────────────────────────────────────────────
router.patch('/:id/read', async (req: Request, res: Response) => {
  // req.user garanti par authMiddleware (src/types/index.ts)
  const conversationId = req.params.id;

  try {
    await assertParticipant(conversationId, req.user.id);

    const count = await markConversationAsRead(conversationId, req.user.id);
    res.json({ markedAsRead: count });
  } catch (error) {
    handleError(res, error, 'PATCH /conversations/:id/read');
  }
});

export default router;
