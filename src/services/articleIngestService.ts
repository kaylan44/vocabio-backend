// Article ingestion service.
//
// One function, runIngestion: fetch the latest articles of the source, store the ones
// we do not have yet (text + MP3), and delete the ones that are too old.
//
// It is called by a timer (src/jobs/articleScheduler.ts), never by a user request:
// nothing a client sends can change what is fetched or from where.
//
// Guiding rule: one article failing must never stop the others, and a run that fails
// halfway must leave the database in a state the next run can simply continue from.
// That is why each article is its own try/catch, and why "already stored" is decided
// by the database (unique constraint on source + externalId), not by memory.

import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { downloadAudio, fetchLatestPosts } from '../lib/holaQuePasa';
import { ParsedArticle, parsePost } from './articleParser';

// ─────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────
export const ARTICLE_SOURCE = 'holaquepasa';
export const ARTICLE_LANG = 'es';

// The source publishes one article per day. 10 means: the first run backfills ten
// days, and the server can be down for up to ten days without missing an article.
export const INGEST_BATCH_SIZE = 10;
// Articles older than this are deleted (their audio goes with them, by cascade).
// At ~2 MB of audio per article, 30 days keep about 60 MB in the database.
export const RETENTION_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface IngestionReport {
  created: number; // new articles stored
  audioAdded: number; // audio added to an article stored earlier without it
  skipped: number; // already stored, or too old to keep
  failed: number; // unusable post, or error while storing
  purged: number; // old articles deleted
}

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

// An Error's message only: the full error of a failed fetch can be very long, and we
// never want article content in the logs.
const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Downloads the audio of an article, or returns null if that is not possible.
 *
 * Never throws: a missing audio must not prevent the text from being stored. The
 * article is then created without audio and a later run tries again.
 */
const tryDownloadAudio = async (article: ParsedArticle) => {
  if (!article.audioSourceUrl) {
    return null;
  }

  try {
    return await downloadAudio(article.audioSourceUrl);
  } catch (error) {
    console.warn(`[articles] audio download failed for post ${article.externalId}: ${reason(error)}`);
    return null;
  }
};

const isUniqueViolation = (error: unknown): boolean =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';

// ─────────────────────────────────────────────
// runIngestion
// ─────────────────────────────────────────────
/**
 * Runs one ingestion pass.
 *
 * ```
 * 1. Fetch the latest posts of the source
 * 2. Parse each one (unusable → failed)
 * 3. Read which ones are already stored, and whether they have their audio
 * 4. For each article, one after the other:
 *    - older than the retention → skipped (it would be purged right away)
 *    - not stored               → download the audio, create the article
 *    - stored without audio     → retry the audio download
 *    - stored with audio        → skipped, nothing is downloaded
 * 5. Delete the articles older than the retention
 * ```
 *
 * Sequential on purpose (no Promise.all): at most one MP3 is held in memory at a
 * time, and the source receives one request at a time.
 *
 * @param now - Current date, injectable so the tests control the retention cutoff
 * @throws only if the source cannot be reached at step 1. In that case NOTHING is
 *         purged: a source that is down must not slowly empty the app.
 */
export const runIngestion = async (now: Date = new Date()): Promise<IngestionReport> => {
  const report: IngestionReport = { created: 0, audioAdded: 0, skipped: 0, failed: 0, purged: 0 };
  const cutoff = new Date(now.getTime() - RETENTION_DAYS * DAY_MS);

  // ── 1 and 2 ──────────────────────────────────
  const posts = await fetchLatestPosts(INGEST_BATCH_SIZE);

  const articles: ParsedArticle[] = [];
  for (const post of posts) {
    const parsed = parsePost(post);
    if (parsed) {
      articles.push(parsed);
    } else {
      report.failed += 1;
    }
  }

  // ── 3 ────────────────────────────────────────
  // One query for the whole batch instead of one per article. `audio` only selects
  // the key: we need to know whether the row exists, not to load the MP3.
  const stored = await prisma.article.findMany({
    where: {
      source: ARTICLE_SOURCE,
      externalId: { in: articles.map((article) => article.externalId) },
    },
    select: { id: true, externalId: true, audio: { select: { articleId: true } } },
  });
  const storedByExternalId = new Map(stored.map((row) => [row.externalId, row]));

  // ── 4 ────────────────────────────────────────
  for (const article of articles) {
    try {
      // Without this check, an article older than the retention would be created,
      // purged at step 5, and downloaded again on every run: this happens if the
      // source stops publishing for a month.
      if (article.publishedAt < cutoff) {
        report.skipped += 1;
        continue;
      }

      const existing = storedByExternalId.get(article.externalId);

      if (!existing) {
        const audio = await tryDownloadAudio(article);

        // Nested create: the article and its audio are written in ONE transaction.
        // We can never end up with an audio row pointing to nothing.
        await prisma.article.create({
          data: {
            source: ARTICLE_SOURCE,
            externalId: article.externalId,
            lang: ARTICLE_LANG,
            level: article.level,
            title: article.title,
            excerpt: article.excerpt,
            // Prisma's Json input type does not accept our interface directly
            // (it wants an index signature). The value IS plain JSON: arrays of
            // objects of strings.
            content: article.content as unknown as Prisma.InputJsonValue,
            url: article.url,
            audioSourceUrl: article.audioSourceUrl,
            audioDurationSec: article.audioDurationSec,
            publishedAt: article.publishedAt,
            ...(audio && {
              audio: {
                create: { data: audio.data, mimeType: audio.mimeType, size: audio.data.length },
              },
            }),
          },
        });
        report.created += 1;
        continue;
      }

      if (!existing.audio && article.audioSourceUrl) {
        const audio = await tryDownloadAudio(article);
        if (audio) {
          await prisma.articleAudio.create({
            data: {
              articleId: existing.id,
              data: audio.data,
              mimeType: audio.mimeType,
              size: audio.data.length,
            },
          });
          report.audioAdded += 1;
          continue;
        }
      }

      // Already stored. The text is NOT refreshed if the source edited it: known
      // limit, accepted to keep the job simple.
      report.skipped += 1;
    } catch (error) {
      // P2002 = another run stored the same article (or its audio) between our read
      // at step 3 and our write. The data is there, which is what we wanted.
      if (isUniqueViolation(error)) {
        report.skipped += 1;
        continue;
      }

      report.failed += 1;
      console.warn(`[articles] could not store post ${article.externalId}: ${reason(error)}`);
    }
  }

  // ── 5 ────────────────────────────────────────
  const { count } = await prisma.article.deleteMany({ where: { publishedAt: { lt: cutoff } } });
  report.purged = count;

  return report;
};
