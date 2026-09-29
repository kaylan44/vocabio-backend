// Tests de la configuration CORS.
// On teste le parsing de CORS_ORIGINS, puis le comportement réel d'un preflight
// sur une app Express avec authMiddleware (qui rejetterait un OPTIONS sans token).

import request from 'supertest';
import express from 'express';
import cors from 'cors';
import { parseAllowedOrigins } from '../../src/lib/cors';

describe('parseAllowedOrigins', () => {
  it('découpe la liste et ignore les espaces et entrées vides', () => {
    expect(parseAllowedOrigins(' http://a.test , https://b.test,, ')).toEqual([
      'http://a.test',
      'https://b.test',
    ]);
  });

  it('retombe sur le front de production si la variable est absente ou vide', () => {
    expect(parseAllowedOrigins(undefined)).toEqual(['https://vocabio.vercel.app']);
    expect(parseAllowedOrigins('  ')).toEqual(['https://vocabio.vercel.app']);
  });
});

describe('preflight CORS', () => {
  const app = express();
  app.use(cors({ origin: ['http://localhost:8081'] }));
  // Simule authMiddleware : toute requête sans token est rejetée
  app.use((_req, res) => {
    res.status(401).json({ error: 'Token manquant' });
  });

  it('répond au preflight d\'une origine autorisée avant le middleware auth', async () => {
    const res = await request(app)
      .options('/conversations')
      .set('Origin', 'http://localhost:8081')
      .set('Access-Control-Request-Method', 'PATCH')
      .set('Access-Control-Request-Headers', 'authorization,content-type');

    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:8081');
    expect(res.headers['access-control-allow-methods']).toContain('PATCH');
  });

  it('n\'ajoute pas d\'en-tête pour une origine non autorisée', async () => {
    const res = await request(app)
      .options('/conversations')
      .set('Origin', 'https://evil.test')
      .set('Access-Control-Request-Method', 'GET');

    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});
