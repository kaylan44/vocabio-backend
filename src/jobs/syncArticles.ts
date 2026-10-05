// One-shot article sync: `npm run sync:articles`.
//
// Runs ONE ingestion pass (src/services/articleIngestService.ts) and exits, without
// starting the web server.
//
// Why this exists next to the timer (src/jobs/articleScheduler.ts): the source sits
// behind Cloudflare, which answers 403 to requests coming from Railway. The timer is
// therefore useless in production for now. This command lets the sync run from a
// machine the source accepts (a developer's computer), writing into the same
// database, while Railway only serves what is stored.
//
// Why it calls runIngestion() and not runScheduledIngestion(): the scheduler's
// wrapper swallows errors on purpose (a timer must never reject). A command needs the
// opposite: tell the shell, through the exit code, whether the run worked, so a
// scheduled task or a script can react to a failure.
//
// Why there is no `import 'dotenv/config'` here, unlike src/app.ts: the npm script
// preloads it (`tsx -r dotenv/config`). Importing it in this file would also load the
// real .env into Jest when the tests import this module.

import { prisma } from '../lib/prisma';
import { runIngestion } from '../services/articleIngestService';

/**
 * Runs one ingestion pass and returns the exit code of the command.
 *
 * The feature flag applies here exactly as it does to the timer: ARTICLES_SYNC_ENABLED
 * is the single switch for "this machine may copy the source's content". Rejected
 * alternative: letting the command ignore the flag because typing it is already an
 * explicit act. It would make two ways to turn the copy on, and one of them would not
 * show in the configuration.
 *
 * Never throws: every outcome is an exit code.
 *
 * @returns 0 if the run completed, 1 if the feature is disabled or the run failed
 */
export const syncArticlesOnce = async (): Promise<number> => {
  if (process.env.ARTICLES_SYNC_ENABLED !== 'true') {
    console.error('[articles] sync is disabled: set ARTICLES_SYNC_ENABLED="true" to run it');
    return 1;
  }

  try {
    const report = await runIngestion();
    console.log('[articles] sync done', report);
    // A run with `failed > 0` still returns 0: some posts being unusable is a normal
    // outcome that the report shows, and the next run retries them.
    return 0;
  } catch (error) {
    // Same rule as the scheduler: the message only, never the full error.
    console.error('[articles] sync failed:', error instanceof Error ? error.message : error);
    return 1;
  }
};

// True only when this file is the one being executed (`tsx src/jobs/syncArticles.ts`),
// false when it is imported, which is what the tests do. Without this guard, importing
// the module in a test would start a real sync.
if (require.main === module) {
  void syncArticlesOnce().then((exitCode) => {
    // exitCode rather than process.exit(): Node exits by itself once nothing is
    // pending, so the logs above are fully written first.
    // Set before disconnecting, so the exit code does not depend on the disconnect
    // succeeding.
    process.exitCode = exitCode;

    // Closes the connection pool: an open pool can keep the process alive after the
    // work is done.
    return prisma.$disconnect();
  });
}
