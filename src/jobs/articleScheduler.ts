// Article sync scheduler.
//
// Runs the ingestion (src/services/articleIngestService.ts) shortly after the server
// starts, then at a fixed interval.
//
// Why a timer inside the web server rather than a separate cron job: the backend
// runs as ONE Railway instance (Socket.io has no adapter to share rooms between
// several), so "one timer per process" really means "one timer". If the app is ever
// scaled to several instances, each would run its own timer: the unique constraint
// on articles keeps the data correct, but the work would be done several times. The
// fix at that point is a Railway cron service calling runIngestion(); nothing in the
// service has to change.
//
// Why a feature flag: the source's content is not licensed for reuse. Copying it is
// only acceptable for private testing, so the job does nothing unless
// ARTICLES_SYNC_ENABLED is exactly 'true'. Off by default, including in the tests.

import { runIngestion } from '../services/articleIngestService';

// The source publishes once a day (12:00 UTC). Every 6 hours means a new article
// shows up at most 6 hours late, for 4 small API calls a day.
export const SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000;
// Not at second 0: let the server start listening and answer Railway's health check
// before it starts downloading MP3s.
export const FIRST_RUN_DELAY_MS = 30 * 1000;

// True while a run is in progress. A run normally takes a few seconds, but the first
// one downloads ten MP3s and the source can be slow: two overlapping runs would
// download the same files twice.
let running = false;

/**
 * Runs one ingestion unless one is already in progress. Never throws: it is called by
 * a timer, where a rejected promise would be an unhandled rejection.
 *
 * Exported for the tests.
 */
export const runScheduledIngestion = async (): Promise<void> => {
  if (running) {
    console.warn('[articles] previous sync still running, this one is skipped');
    return;
  }

  running = true;
  try {
    const report = await runIngestion();
    console.log('[articles] sync done', report);
  } catch (error) {
    // Typically: the source is down or too slow. The next tick tries again.
    console.error('[articles] sync failed:', error instanceof Error ? error.message : error);
  } finally {
    running = false;
  }
};

/**
 * Starts the timers if the feature is enabled.
 *
 * Called once from src/app.ts. The tests import routers and services, never app.ts,
 * so no timer is ever created during a test run unless a test asks for it.
 *
 * @returns true if the timers were created, false if the feature is disabled
 */
export const startArticleScheduler = (): boolean => {
  if (process.env.ARTICLES_SYNC_ENABLED !== 'true') {
    return false;
  }

  // unref(): these timers alone must not keep the Node process alive. The HTTP
  // server does that; on shutdown we do not want a 6-hour timer to block the exit.
  setTimeout(() => void runScheduledIngestion(), FIRST_RUN_DELAY_MS).unref();
  setInterval(() => void runScheduledIngestion(), SYNC_INTERVAL_MS).unref();

  console.log('[articles] sync enabled');
  return true;
};
