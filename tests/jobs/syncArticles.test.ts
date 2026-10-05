// Tests of the one-shot article sync command.
//
// The ingestion is mocked: these tests check what the command does AROUND it, which is
// the feature flag and the exit code. Importing the module must not start a sync by
// itself (see the `require.main === module` guard), which the first test relies on.

jest.mock('../../src/lib/prisma', () => ({
  prisma: { $disconnect: jest.fn() },
}));

jest.mock('../../src/services/articleIngestService', () => ({
  runIngestion: jest.fn(),
}));

import { runIngestion } from '../../src/services/articleIngestService';
import { syncArticlesOnce } from '../../src/jobs/syncArticles';

const mockRunIngestion = runIngestion as jest.Mock;

const REPORT = { created: 2, audioAdded: 0, skipped: 8, failed: 0, purged: 1 };
const originalFlag = process.env.ARTICLES_SYNC_ENABLED;

describe('syncArticlesOnce', () => {
  let logSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    mockRunIngestion.mockResolvedValue(REPORT);
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (originalFlag === undefined) {
      delete process.env.ARTICLES_SYNC_ENABLED;
    } else {
      process.env.ARTICLES_SYNC_ENABLED = originalFlag;
    }
  });

  it('does not run a sync just because the module is imported', () => {
    expect(mockRunIngestion).not.toHaveBeenCalled();
  });

  // Same rule as the timer: only the exact value 'true' allows copying the source.
  it.each([[undefined], ['false'], [''], ['1'], ['TRUE']])(
    'refuses to run and exits 1 when ARTICLES_SYNC_ENABLED is %p',
    async (value) => {
      if (value === undefined) {
        delete process.env.ARTICLES_SYNC_ENABLED;
      } else {
        process.env.ARTICLES_SYNC_ENABLED = value;
      }

      await expect(syncArticlesOnce()).resolves.toBe(1);

      expect(mockRunIngestion).not.toHaveBeenCalled();
      // The message must say how to enable it: exit code 1 alone would look like a crash.
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('ARTICLES_SYNC_ENABLED'));
    }
  );

  it('runs exactly one ingestion, prints its report and exits 0', async () => {
    process.env.ARTICLES_SYNC_ENABLED = 'true';

    await expect(syncArticlesOnce()).resolves.toBe(0);

    expect(mockRunIngestion).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledWith('[articles] sync done', REPORT);
  });

  // Unusable posts are reported, not fatal: the next run retries them.
  it('exits 0 when the run completed with some failed posts', async () => {
    process.env.ARTICLES_SYNC_ENABLED = 'true';
    mockRunIngestion.mockResolvedValue({ ...REPORT, failed: 3 });

    await expect(syncArticlesOnce()).resolves.toBe(0);
  });

  it('exits 1 without rejecting when the source cannot be reached', async () => {
    process.env.ARTICLES_SYNC_ENABLED = 'true';
    mockRunIngestion.mockRejectedValue(new Error('Article source answered 403'));

    await expect(syncArticlesOnce()).resolves.toBe(1);

    expect(errorSpy).toHaveBeenCalledWith('[articles] sync failed:', 'Article source answered 403');
    expect(logSpy).not.toHaveBeenCalled();
  });
});
