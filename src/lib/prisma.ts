// Ce fichier expose une instance unique (singleton) de PrismaClient.
//
// Pourquoi un singleton ?
// PrismaClient ouvre un pool de connexions vers la base de données.
// Si on instanciait PrismaClient dans chaque fichier qui en a besoin,
// on ouvrirait des dizaines de pools en parallèle → saturation de la BDD.
// Avec un singleton, toute l'application partage le même pool.
//
// Le pattern `global.prisma` est une précaution pour le mode watch (tsx watch) :
// en développement, chaque rechargement de fichier réexécute ce module,
// ce qui recrée un nouveau PrismaClient. En le stockant sur l'objet global,
// on réutilise l'instance existante entre les rechargements.

import { PrismaClient } from '@prisma/client';

// On déclare prisma sur le type global pour éviter l'erreur TypeScript
declare global {
  // eslint-disable-next-line no-var
  var prisma: PrismaClient | undefined;
}

// En production : crée toujours une nouvelle instance
// En développement : réutilise l'instance stockée sur global si elle existe
export const prisma = global.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== 'production') {
  global.prisma = prisma;
}
