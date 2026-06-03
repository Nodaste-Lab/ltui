import type { Command } from 'commander';
import { resolveConfig } from '../config.js';
import { createLinearClient } from '../client.js';
import {
  ColumnDefinition,
  emitError,
  renderDetailOrJsonRecord,
  renderPaginatedList,
  sanitizeSingleLine,
} from '../format.js';
import { getGlobalOptions } from '../options.js';
import { findTeamByKeyOrId, parseLinearError } from '../linear.js';

interface TeamRow {
  id: string;
  key: string;
  name: string;
  defaultAssignee: string;
  active: string;
}

export function runTeamsCommands(program: Command): void {
  const teams = program.command('teams').description('Team commands');

  teams
    .command('list')
    .description('List teams')
    .action(async () => {
      try {
        const globalOpts = getGlobalOptions(program);
        const resolved = resolveConfig(program.opts<{ profile?: string }>().profile);
        const client = createLinearClient(resolved);

        const data = await client.teams({ first: globalOpts.limit, after: globalOpts.cursor });
        const rows: TeamRow[] = data.nodes.map((team: any) => ({
          id: team.id ?? '',
          key: team.key ?? '',
          name: sanitizeSingleLine(team.name ?? ''),
          defaultAssignee: '-',
          active: team.archivedAt ? 'false' : 'true',
        }));

        const columns: ColumnDefinition<TeamRow>[] = [
          { key: 'id', header: 'id', value: row => row.id },
          { key: 'key', header: 'key', value: row => row.key },
          { key: 'name', header: 'name', value: row => row.name },
          { key: 'default_assignee', header: 'default_assignee', value: row => row.defaultAssignee },
          { key: 'active', header: 'active', value: row => row.active },
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
        writeTeamsError(error);
      }
    });

  teams
    .command('view')
    .description('View team details')
    .argument('<key-or-id>', 'Team key or id')
    .action(async (ref: string) => {
      try {
        const globalOpts = getGlobalOptions(program);
        const resolved = resolveConfig(program.opts<{ profile?: string }>().profile);
        const client = createLinearClient(resolved);
        const team = await findTeamByKeyOrId(client, ref);
        if (!team) {
          const out = emitError('not_found', `Team '${ref}' not found`);
          process.stderr.write(out + '\n');
          process.exitCode = 1;
          return;
        }

        const fields: Record<string, string> = {
          TEAM: `${team.name ?? ''} (${team.id ?? ''})`,
          KEY: team.key ?? '',
          DESCRIPTION: sanitizeSingleLine(team.description ?? ''),
          ACTIVE: team.archivedAt ? 'false' : 'true',
        };

        const statesFromTeam =
          typeof team.states === 'function'
            ? await team.states({ first: 50 })
            : { nodes: Array.isArray(team.states?.nodes) ? team.states.nodes : [] };
        let states = statesFromTeam.nodes.map((state: any) => ({
          id: state.id ?? '',
          name: state.name ?? '',
          type: state.type ?? '',
        }));

        if (states.length === 0 && team.id && typeof client.workflowStates === 'function') {
          const fallbackStatesConnection = await client.workflowStates({
            first: 50,
            filter: {
              team: { id: { eq: team.id } },
            },
          });
          states = fallbackStatesConnection.nodes.map((state: any) => ({
            id: state.id ?? '',
            name: state.name ?? '',
            type: state.type ?? '',
          }));
        }

        const jsonPayload: Record<string, unknown> = {
          id: team.id ?? '',
          key: team.key ?? '',
          name: team.name ?? '',
          description: team.description ?? '',
          active: !team.archivedAt,
          states,
        };

        if (globalOpts.format === 'json') {
          const output = renderDetailOrJsonRecord('TEAM_DETAIL', fields, jsonPayload, {
            format: globalOpts.format,
            fields: globalOpts.fields,
          });
          process.stdout.write(output + '\n');
          return;
        }

        let output = renderDetailOrJsonRecord('TEAM_DETAIL', fields, jsonPayload, {
          format: globalOpts.format,
          fields: globalOpts.fields,
        });

        const stateLines: string[] = ['STATES_START'];
        for (const state of states) {
          stateLines.push(`${state.id}\t${state.name}\t${state.type}`);
        }
        stateLines.push('STATES_END');
        output += `\n${stateLines.join('\n')}\n`;

        process.stdout.write(output);
      } catch (error) {
        writeTeamsError(error);
      }
    });
}

function writeTeamsError(error: unknown): void {
  const parsed = parseLinearError(error);
  const out = emitError(parsed.code, parsed.message);
  process.stderr.write(out + '\n');
  process.exitCode = 1;
}
