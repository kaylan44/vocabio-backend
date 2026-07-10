// Route webhook Supabase Auth.
//
// Supabase peut envoyer un événement HTTP à chaque inscription utilisateur.
// Ce webhook fait le même upsert que le middleware auth, mais en amont,
// pour que le user soit déjà en base dès sa première connexion.
//
// IMPORTANT : ce webhook est NON CRITIQUE.
// Si l'appel échoue (Railway en cold start, réseau instable),
// l'upsert lazy dans le middleware auth rattrapera la situation
// à la première requête de l'utilisateur.
//
// Sécurité : Supabase signe chaque payload avec un secret HMAC.
// On vérifie cette signature pour s'assurer que la requête vient bien de Supabase
// et non d'un tiers malveillant qui appellerait cette route directement.

import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { prisma } from '../lib/prisma';

const router = Router();

// ─────────────────────────────────────────────
// Vérification de la signature HMAC Supabase
// Supabase envoie un header "x-supabase-signature" contenant
// un HMAC-SHA256 du body signé avec le secret webhook.
// On recalcule ce HMAC côté serveur et on compare.
// ─────────────────────────────────────────────
const verifyWebhookSignature = (body: string, signature: string): boolean => {
  const secret = process.env.SUPABASE_WEBHOOK_SECRET;
  if (!secret) return false;

  const expected = crypto
    .createHmac('sha256', secret)
    .update(body)
    .digest('hex');

  // timingSafeEqual protège contre les attaques par timing (comparaison octet par octet
  // en temps constant pour ne pas révéler d'info sur le secret)
  try {
    return crypto.timingSafeEqual(
      Buffer.from(expected, 'hex'),
      Buffer.from(signature, 'hex')
    );
  } catch {
    return false;
  }
};

// POST /webhooks/auth
// Déclenché par Supabase à chaque inscription (INSERT sur auth.users)
router.post('/auth', async (req: Request, res: Response) => {
  // Récupérer le body brut pour vérifier la signature
  // (express.json() parse le body, on a besoin du JSON brut pour le HMAC)
  const rawBody = JSON.stringify(req.body);
  const signature = req.headers['x-supabase-signature'] as string | undefined;

  if (!signature || !verifyWebhookSignature(rawBody, signature)) {
    res.status(401).json({ error: 'Signature webhook invalide' });
    return;
  }

  // Structure du payload Supabase Auth webhook
  const { type, record } = req.body as {
    type: string;
    record: {
      id: string;
      email: string;
      raw_user_meta_data?: {
        full_name?: string;
        name?: string;
        avatar_url?: string;
      };
    };
  };

  // On ne traite que les inscriptions (INSERT), pas les mises à jour ou suppressions
  if (type !== 'INSERT') {
    res.status(200).json({ message: 'Événement ignoré' });
    return;
  }

  const username =
    record.raw_user_meta_data?.full_name ??
    record.raw_user_meta_data?.name ??
    record.email.split('@')[0];

  const avatarUrl = record.raw_user_meta_data?.avatar_url ?? null;

  try {
    await prisma.user.upsert({
      where: { id: record.id },
      create: { id: record.id, username, avatarUrl },
      update: {}, // Ne pas écraser si le user a déjà été créé via l'upsert lazy
    });

    res.status(200).json({ message: 'Utilisateur synchronisé' });
  } catch (error) {
    console.error('[webhook/auth] Erreur upsert:', error);
    // On retourne 500 pour que Supabase réessaie le webhook (retry automatique)
    res.status(500).json({ error: 'Erreur lors de la synchronisation' });
  }
});

export default router;
