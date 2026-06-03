import type { Command } from 'commander';
import { resolveConfig } from '../config.js';
import { createLinearClient } from '../client.js';
import {
  ColumnDefinition,
  emitError,
  renderPaginatedList,
} from '../format.js';
import { getGlobalOptions } from '../options.js';
import { findTeamByKeyOrId, parseLinearError } from '../linear.js';

interface LabelRow {
  id: string;
  name: string;
  group: string;
  color: string;
}

export function runLabelsCommands(program: Command): void {
  program
    .command('labels')
    .description('Label commands')
    .option('--team <key-or-id>', 'Filter by team')
    .action(async options => {
      try {
        const globalOpts = getGlobalOptions(program);
        const resolved = resolveConfig(program.opts<{ profile?: string }>().profile);
        const client = createLinearClient(resolved);

        const filter: Record<string, unknown> = {};
        if (options.team) {
          const team = await findTeamByKeyOrId(client, options.team);
          if (!team) {
            const out = emitError('not_found', `Team '${options.team}' not found`);
            process.stderr.write(out + '\n');
            process.exitCode = 1;
            return;
          }
          filter.team = { id: { eq: team.id } };
        }

        const data = await client.issueLabels({
          first: globalOpts.limit,
          after: globalOpts.cursor,
          filter,
        });

        // Await parent as it's a promise in the Linear SDK
        const rows: LabelRow[] = await Promise.all(
          data.nodes.map(async (label: any) => {
            const parent = label.parent ? await label.parent : undefined;
            return {
              id: label.id ?? '',
              name: label.name ?? '',
              group: parent?.name ?? (label.isGroup ? 'group' : ''),
              color: label.color ?? '',
            };
          })
        );

        const columns: ColumnDefinition<LabelRow>[] = [
          { key: 'id', header: 'id', value: row => row.id },
          { key: 'name', header: 'name', value: row => row.name },
          { key: 'group', header: 'group', value: row => row.group },
          { key: 'color', header: 'color', value: row => row.color },
        ];

        const out = renderPaginatedList(
          rows,
          columns,
          {
            next: data.pageInfo?.endCursor ?? null,
            prev: data.pageInfo?.startCursor ?? null,
            count: rows.length,
          },
          { format: globalOpts.format, fields: globalOpts.fields }
        );
        process.stdout.write(out + '\n');
      } catch (error) {
        const parsed = parseLinearError(error);
        const out = emitError(parsed.code, parsed.message);
        process.stderr.write(out + '\n');
        process.exitCode = 1;
      }
    });
}
