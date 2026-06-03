import type { Command } from 'commander';
import { resolveConfig } from '../config.js';
import { createLinearClient } from '../client.js';
import {
  ColumnDefinition,
  emitError,
  renderPaginatedList,
} from '../format.js';
import { getGlobalOptions, type GlobalOptions } from '../options.js';
import { executeRawGraphQL, parseLinearError } from '../linear.js';

interface NotificationRow {
  id: string;
  type: string;
  read: string;
  createdAt: string;
}

export function runNotificationsCommands(program: Command): void {
  program
    .command('notifications')
    .description('Notification commands')
    .option('--unread-only', 'Only include unread notifications')
    .action(async options => {
      try {
        const globalOpts = getGlobalOptions(program);
        const resolved = resolveConfig(program.opts<{ profile?: string }>().profile);
        const client = createLinearClient(resolved);

        const data = await fetchNotifications(client, globalOpts, options.unreadOnly === true);

        const rows: NotificationRow[] = data.nodes.map((notification: any) => ({
          id: notification.id ?? '',
          type: notification.type ?? '',
          read: notification.readAt ? 'true' : 'false',
          createdAt: formatDateTime(notification.createdAt),
        }));

        const columns: ColumnDefinition<NotificationRow>[] = [
          { key: 'id', header: 'id', value: row => row.id },
          { key: 'type', header: 'type', value: row => row.type },
          { key: 'read', header: 'read', value: row => row.read },
          { key: 'createdAt', header: 'createdAt', value: row => row.createdAt },
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

async function fetchNotifications(
  client: any,
  globalOpts: GlobalOptions,
  unreadOnly: boolean
): Promise<{ nodes: any[]; pageInfo: any }> {
  if (!unreadOnly) {
    return client.notifications({
      first: globalOpts.limit,
      after: globalOpts.cursor,
    });
  }

  if (globalOpts.limit <= 0) {
    return { nodes: [], pageInfo: { endCursor: null, startCursor: null } };
  }

  const nodes: any[] = [];
  let cursor = globalOpts.cursor;
  let pageInfo: any = {};
  let firstReturnedCursor: string | null = null;
  let lastReturnedCursor: string | null = null;
  let nextCursor: string | null = null;
  const batchSize = Math.max(globalOpts.limit, 25);

  do {
    const response = await executeRawGraphQL(client, buildNotificationsQuery(), {
      first: batchSize,
      after: cursor,
    });
    const page = response.data?.notifications ?? {};
    pageInfo = page.pageInfo ?? {};

    for (const edge of page.edges ?? []) {
      const notification = edge.node;
      if (notification?.readAt) {
        continue;
      }
      if (nodes.length < globalOpts.limit) {
        firstReturnedCursor ??= edge.cursor ?? null;
        lastReturnedCursor = edge.cursor ?? lastReturnedCursor;
        nodes.push(notification);
      } else {
        nextCursor = lastReturnedCursor;
        break;
      }
    }
    cursor = pageInfo.endCursor ?? null;
  } while (!nextCursor && pageInfo.hasNextPage && cursor);

  return {
    nodes,
    pageInfo: {
      ...pageInfo,
      endCursor: nextCursor,
      startCursor: firstReturnedCursor,
    },
  };
}

function buildNotificationsQuery(): string {
  return `
    query LtuiNotifications($first: Int, $after: String) {
      notifications(first: $first, after: $after) {
        edges {
          cursor
          node {
            id
            type
            readAt
            createdAt
          }
        }
        pageInfo {
          endCursor
          startCursor
          hasNextPage
          hasPreviousPage
        }
      }
    }
  `;
}

function formatDateTime(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof (value as { toISOString?: unknown }).toISOString === 'function') {
    return (value as { toISOString: () => string }).toISOString();
  }
  return '';
}
