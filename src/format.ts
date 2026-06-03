import type { RateLimitInfo } from './rateLimit.js';

export type OutputFormat = 'tsv' | 'table' | 'detail' | 'json';

export interface AgentOutputOptions {
  format: OutputFormat;
  fields?: string[];
}

export interface PaginationMeta {
  cursorNext: string;
  cursorPrev: string;
  count: number;
  rateLimit?: RateLimitInfo;
}

export interface ColumnDefinition<T> {
  key: string;
  header: string;
  value: (row: T) => string;
}

export function emitError(code: string, message: string, hint?: string): string {
  const lines = [`ERROR: ${code} ${message}`];
  if (hint) {
    lines.push(`HINT: ${hint}`);
  }
  return lines.join('\n');
}

export function emitPaginationMeta(next: string | null, prev: string | null, count: number): string {
  return [
    `CURSOR_NEXT: ${next ?? ''}`,
    `CURSOR_PREV: ${prev ?? ''}`,
    `COUNT: ${count}`,
  ].join('\n');
}

export function renderPaginatedList<T>(
  rows: T[],
  columns: ColumnDefinition<T>[],
  meta: { next: string | null; prev: string | null; count: number; rateLimit?: RateLimitInfo },
  options: AgentOutputOptions & { allowedFormats?: OutputFormat[] }
): string {
  const allowedFormats = options.allowedFormats ?? ['tsv', 'table', 'json'];
  if (!allowedFormats.includes(options.format)) {
    throw new Error(`validation_error Format '${options.format}' not supported for this command`);
  }

  if (options.format === 'json') {
    const selectedColumns = selectColumns(columns, options.fields);
    const jsonRows = rows.map(row => {
      const entry: Record<string, string> = {};
      for (const column of selectedColumns) {
        entry[column.key] = column.value(row);
      }
      return entry;
    });
    const envelope: { meta: PaginationMeta; rows: Record<string, string>[] } = {
      meta: {
        cursorNext: meta.next ?? '',
        cursorPrev: meta.prev ?? '',
        count: meta.count,
        ...(meta.rateLimit ? { rateLimit: meta.rateLimit } : {}),
      },
      rows: jsonRows,
    };
    return JSON.stringify(envelope);
  }

  const header = emitPaginationMeta(meta.next, meta.prev, meta.count);
  const body = renderList(rows, columns, options);
  return `${header}\n${body}`;
}

export function emitDetailBlock(header: string, fields: Record<string, string>): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(fields)) {
    lines.push(`${key}: ${value}`);
  }
  return `${header}\n${lines.join('\n')}`;
}

export function renderDetailOrJsonRecord(
  header: string,
  detailFields: Record<string, string>,
  jsonRecord: Record<string, unknown>,
  options: AgentOutputOptions
): string {
  if (options.format === 'json') {
    return JSON.stringify(selectObjectFields(jsonRecord, options.fields));
  }
  if (options.format === 'tsv' || options.format === 'table' || options.format === 'detail') {
    return emitDetailBlock(header, detailFields);
  }
  throw new Error(`validation_error Format '${options.format}' not supported for this command`);
}

export function renderList<T>(
  rows: T[],
  columns: ColumnDefinition<T>[],
  options: AgentOutputOptions & { allowedFormats?: OutputFormat[] }
): string {
  const allowedFormats = options.allowedFormats ?? ['tsv', 'table', 'json'];
  if (!allowedFormats.includes(options.format)) {
    throw new Error(`validation_error Format '${options.format}' not supported for this command`);
  }

  const selectedColumns = selectColumns(columns, options.fields);
  switch (options.format) {
    case 'tsv':
      return renderTsv(rows, selectedColumns);
    case 'table':
      return renderTable(rows, selectedColumns);
    case 'json':
      return renderJson(rows, selectedColumns);
    case 'detail':
      throw new Error('validation_error Detail format is not available for list commands');
    default:
      return renderTsv(rows, selectedColumns);
  }
}

export function sanitizeSingleLine(text: string): string {
  return text.replace(/[\r\n\t]/g, ' ');
}

export function truncateMultiline(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) {
    return { text, truncated: false };
  }
  return {
    text: text.slice(0, Math.max(0, max - 1)) + '…',
    truncated: true,
  };
}

function selectColumns<T>(
  columns: ColumnDefinition<T>[],
  fields?: string[]
): ColumnDefinition<T>[] {
  if (!fields || fields.length === 0) {
    return columns;
  }
  const fieldSet = new Set(fields);
  const selected = columns.filter(column => fieldSet.has(column.key));
  if (selected.length !== fieldSet.size) {
    const missing = fields.filter(field => !selected.find(column => column.key === field));
    throw new Error(`validation_error Unknown field(s): ${missing.join(', ')}`);
  }
  return selected;
}

export function selectObjectFields(
  record: Record<string, unknown>,
  fields?: string[]
): Record<string, unknown> {
  if (!fields || fields.length === 0) {
    return record;
  }

  const fieldSet = new Set(fields);
  const selected: Record<string, unknown> = {};
  const available = new Set(Object.keys(record));

  for (const field of fieldSet) {
    if (!available.has(field)) {
      throw new Error(`validation_error Unknown field(s): ${field}`);
    }
    selected[field] = record[field];
  }

  return selected;
}

function renderTsv<T>(rows: T[], columns: ColumnDefinition<T>[]): string {
  const headerLine = columns.map(col => col.header).join('\t');
  const lines = rows.map(row =>
    columns.map(col => sanitizeTsvValue(col.value(row))).join('\t')
  );
  return [headerLine, ...lines].join('\n');
}

function renderTable<T>(rows: T[], columns: ColumnDefinition<T>[]): string {
  const widths = columns.map(column =>
    Math.max(
      column.header.length,
      ...rows.map(row => sanitizeSingleLine(column.value(row)).length)
    )
  );

  const headerLine = columns
    .map((column, index) => padValue(column.header, widths[index]))
    .join(' | ');
  const separator = widths.map(width => '-'.repeat(width)).join('-|-');
  const valueLines = rows.map(row =>
    columns
      .map((column, index) => padValue(sanitizeSingleLine(column.value(row)), widths[index]))
      .join(' | ')
  );
  return [headerLine, separator, ...valueLines].join('\n');
}

function renderJson<T>(rows: T[], columns: ColumnDefinition<T>[]): string {
  const items = rows.map(row => {
    const entry: Record<string, string> = {};
    for (const column of columns) {
      entry[column.key] = column.value(row);
    }
    return entry;
  });
  return JSON.stringify(items);
}

function sanitizeTsvValue(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return '';
  const str = String(value);
  return str.replace(/[\t\r\n]/g, ' ');
}

function padValue(value: string, width: number): string {
  if (value.length >= width) return value;
  return value + ' '.repeat(width - value.length);
}
