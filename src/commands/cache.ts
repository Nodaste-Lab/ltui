import type { Command } from 'commander';
import { clearCache, clearCacheBucket } from '../cache.js';
import { renderDetailOrJsonRecord } from '../format.js';
import { getGlobalOptions } from '../options.js';

export function runCacheCommands(program: Command): void {
  const cache = program.command('cache').description('Metadata cache operations');

  cache
    .command('clear')
    .description('Clear cached Linear metadata')
    .option('--bucket <name>', 'Clear one cache bucket only')
    .action(options => {
      const globalOpts = getGlobalOptions(program);
      const bucket = options.bucket ? String(options.bucket) : null;
      if (bucket) {
        clearCacheBucket(bucket);
      } else {
        clearCache();
      }

      const output = renderDetailOrJsonRecord(
        'CACHE_CLEARED',
        { BUCKET: bucket ?? 'all' },
        { bucket: bucket ?? 'all' },
        { format: globalOpts.format, fields: globalOpts.fields }
      );
      process.stdout.write(output + '\n');
    });
}
