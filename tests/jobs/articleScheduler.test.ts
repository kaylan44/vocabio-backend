// Tests of the article sync scheduler.
//
// The ingestion itself is mocked: these tests only check WHEN it is called. Time is
// controlled with Jest fake timers, so "6 hours later" takes no real time.

jest.mock('../../src/services/articleIngestService', () => ({
  runIngestion: jest.fn(),
}));

import { runIngestion } from '../../src/services/articleIngestService';
import {
  FIRST_RUN_DELAY_MS,
  runScheduledIngestion,
  startArticleScheduler,
  SYNC_INTERVAL_MS,
} from '../../src/jobs/articleScheduler';

const mockRunIngestion = runIngestion as jest.Mock;

const REPORT = { created: 0, audioAdded: 0, skipped: 0, failed: 0, purged: 0 };
const originalFlag = process.env.ARTICLES_SYNC_ENABLED;

describe('articleScheduler', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    mockRunIngestion.mockResolvedValue(REPORT);
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    // Removes the timers created by the test, so nothing fires in the next one.
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
    if (originalFlag === undefined) {
      delete process.env.ARTICLES_SYNC_ENABLED;
    } else {
      process.env.ARTICLES_SYNC_ENABLED = originalFlag;
    }
  });

  // ─────────────────────────────────────────────
  describe('startArticleScheduler', () => {
    // The flag must be exactly 'true': a typo or "1" must leave the feature OFF,
    // since off is the safe side for content we are not licensed to copy.
    it.each([[undefined], ['false'], [''], ['1'], ['TRUE'], ['yes']])(
      'creates no timer when ARTICLES_SYNC_ENABLED is %p',
      async (value) => {
        if (value === undefined) {
          delete process.env.ARTICLES_SYNC_ENABLED;
        } else {
          process.env.ARTICLES_SYNC_ENABLED = value;
        }

        expect(startArticleScheduler()).toBe(false);
        expect(jest.getTimerCount()).toBe(0);

        await jest.advanceTimersByTimeAsync(SYNC_INTERVAL_MS * 2);
        expect(mockRunIngestion).not.toHaveBeenCalled();
      }
    );

    it('runs once shortly after start, then at every interval', async () => {
      process.env.ARTICLES_SYNC_ENABLED = 'true';

      expect(startArticleScheduler()).toBe(true);

      // Nothing at second 0: the server gets time to start.
      expect(mockRunIngestion).not.toHaveBeenCalled();

      await jest.advanceTimersByTimeAsync(FIRST_RUN_DELAY_MS - 1);
      expect(mockRunIngestion).not.toHaveBeenCalled();

      await jest.advanceTimersByTimeAsync(1);
      expect(mockRunIngestion).toHaveBeenCalledTimes(1);

      // First interval tick, counted from the start (not from the first run).
      await jest.advanceTimersByTimeAsync(SYNC_INTERVAL_MS - FIRST_RUN_DELAY_MS);
      expect(mockRunIngestion).toHaveBeenCalledTimes(2);

      await jest.advanceTimersByTimeAsync(SYNC_INTERVAL_MS);
      expect(mockRunIngestion).toHaveBeenCalledTimes(3);
    });
  });

  // ─────────────────────────────────────────────
  describe('runScheduledIngestion', () => {
    it('skips a run while the previous one is still in progress', async () => {
      // A run that we finish by hand, to hold it "in progress".
      let finish: (report: typeof REPORT) => void = () => undefined;
      mockRunIngestion.mockReturnValueOnce(
        new Promise((resolve) => {
          finish = resolve;
        })
      );

      const first = runScheduledIngestion();
      await runScheduledIngestion(); // overlaps the first one

      expect(mockRunIngestion).toHaveBeenCalledTimes(1);

      finish(REPORT);
      await first;

      // Once the first run is over, the next one is allowed again.
      await runScheduledIngestion();
      expect(mockRunIngestion).toHaveBeenCalledTimes(2);
    });

    it('never rejects, and allows the next run after a failure', async () => {
      mockRunIngestion.mockRejectedValueOnce(new Error('Article source answered 503'));

      // A rejection here would be an unhandled rejection in the timer callback.
      await expect(runScheduledIngestion()).resolves.toBeUndefined();

      // The "running" guard must have been released by the failure.
      await runScheduledIngestion();
      expect(mockRunIngestion).toHaveBeenCalledTimes(2);
    });
  });
});
