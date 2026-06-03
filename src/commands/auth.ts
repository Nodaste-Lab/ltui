import type { Command } from 'commander';
import {
  loadGlobalConfig,
  saveGlobalConfig,
  loadProfilesFile,
  saveProfilesFile,
  resolveConfig,
} from '../config.js';
import {
  ColumnDefinition,
  emitError,
  renderDetailOrJsonRecord,
  renderPaginatedList,
} from '../format.js';
import { getGlobalOptions } from '../options.js';

interface ProfileRow {
  id: string;
  workspace: string;
  hasKey: string;
}

export function runAuthCommands(program: Command): void {
  const auth = program.command('auth').description('Authentication and profile management');

  auth
    .command('list')
    .description('List configured profiles')
    .action(() => {
      const globalOpts = getGlobalOptions(program);
      const config = loadGlobalConfig();
      const profiles = loadProfilesFile();
      const rows: ProfileRow[] = [];
      const entries = config.profiles ?? {};
      for (const [name, profile] of Object.entries(entries)) {
        const hasKey = profiles[name]?.apiKey ? 'true' : 'false';
        rows.push({ id: name, workspace: profile.workspace, hasKey });
      }
      const columns: ColumnDefinition<ProfileRow>[] = [
        { key: 'id', header: 'id', value: row => row.id },
        { key: 'workspace', header: 'workspace', value: row => row.workspace },
        { key: 'hasKey', header: 'hasKey', value: row => row.hasKey },
      ];
      const out = renderPaginatedList(
        rows,
        columns,
        { next: null, prev: null, count: rows.length },
        { format: globalOpts.format, fields: globalOpts.fields }
      );
      process.stdout.write(out + '\n');
    });

  auth
    .command('add')
    .description('Add or update a profile')
    .requiredOption('--profile <name>', 'Profile name')
    .option('--workspace <slug>', 'Workspace slug')
    .option('--api-key <key>', 'API key (optional, or use LINEAR_API_KEY)')
    .action(options => {
      const globalOpts = getGlobalOptions(program);
      const { profile, workspace, apiKey } = options as {
        profile: string;
        workspace?: string;
        apiKey?: string;
      };
      const config = loadGlobalConfig();
      if (!config.profiles) config.profiles = {};
      const existing = config.profiles[profile] ?? { workspace: workspace ?? '', keyRef: profile };
      const updated = {
        workspace: workspace ?? existing.workspace,
        keyRef: existing.keyRef,
      };
      config.profiles[profile] = updated;
      if (!config.defaultProfile) {
        config.defaultProfile = profile;
      }
      saveGlobalConfig(config);

      const profiles = loadProfilesFile();
      const key = apiKey || process.env.LINEAR_API_KEY;
      if (key) {
        profiles[profile] = { apiKey: key };
        saveProfilesFile(profiles);
      }

      const detailFields = {
        PROFILE: profile,
        WORKSPACE: updated.workspace,
        KEY_STORED: key ? 'true' : 'false',
      };
      const block = renderDetailOrJsonRecord(
        'PROFILE_SAVED',
        detailFields,
        {
          profile,
          workspace: updated.workspace,
          keyStored: !!key,
        },
        { format: globalOpts.format, fields: globalOpts.fields }
      );
      process.stdout.write(block + '\n');
    });

  auth
    .command('remove')
    .description('Remove a profile')
    .requiredOption('--profile <name>', 'Profile name')
    .action(options => {
      const globalOpts = getGlobalOptions(program);
      const { profile } = options as { profile: string };
      const config = loadGlobalConfig();
      if (config.profiles && config.profiles[profile]) {
        delete config.profiles[profile];
        saveGlobalConfig(config);
      }
      const profiles = loadProfilesFile();
      if (profiles[profile]) {
        delete profiles[profile];
        saveProfilesFile(profiles);
      }
      const detailFields = {
        PROFILE: profile,
      };
      const block = renderDetailOrJsonRecord(
        'PROFILE_REMOVED',
        detailFields,
        { profile },
        { format: globalOpts.format, fields: globalOpts.fields }
      );
      process.stdout.write(block + '\n');
    });

  auth
    .command('test')
    .description('Test auth for a profile')
    .option('--profile <name>', 'Profile name')
    .action(options => {
      try {
        const globalOpts = getGlobalOptions(program);
        const resolved = resolveConfig(options.profile as string | undefined);
        const detailFields = {
          PROFILE: resolved.profileName || '',
        };
        const block = renderDetailOrJsonRecord(
          'AUTH_OK',
          detailFields,
          { profile: resolved.profileName || '' },
          { format: globalOpts.format, fields: globalOpts.fields }
        );
        process.stdout.write(block + '\n');
      } catch (error) {
        const err = error as Error;
        const message = err.message || 'Unknown error';
        const out = emitError('auth_error', message);
        process.stderr.write(out + '\n');
        process.exitCode = 1;
      }
    });
}
