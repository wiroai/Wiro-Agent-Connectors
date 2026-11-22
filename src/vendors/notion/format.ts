// Trimming and parsing helpers for the Notion connector: IDs from links,
// property values as plain JSON, blocks and pages cut to the fields an agent
// needs, and long Markdown returned in windows.

import { ToolFailure, truncate, utf8Length } from '../../core/index.js';

/** Drops undefined and null fields. */
export function compact(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null));
}

/**
 * A Notion ID from an ID or a link: the 32 hexadecimal characters at the end
 * of the link's last path segment, with or without dashes. For a block, a
 * link's #fragment names the block and wins. Returned in the dashed form
 * Notion prints.
 */
export function notionId(value: string, name: string, block = false): string {
  const text = String(value ?? '').trim();
  let path = text;
  let fragment = '';
  try {
    if (/^https?:\/\//i.test(text)) {
      const url = new URL(text);
      path = url.pathname;
      fragment = url.hash.slice(1);
    }
  } catch {
    // reported below
  }
  path = path.split(/[?#]/)[0] ?? '';
  const last = path.split('/').filter(Boolean).pop() ?? '';
  const fromFragment = block ? /^([0-9a-f]{32})$/i.exec(fragment.replace(/-/g, '')) : null;
  const match = fromFragment ?? /([0-9a-f]{32})$/i.exec(last.replace(/-/g, ''));
  if (!match?.[1]) {
    throw new ToolFailure(
      `${name} is not a Notion ID or link. Use the 32 hexadecimal characters at the end of the page's link, `
        + 'such as 1429989fe8ac4effbc8f57f56486db54, or the whole link. Nothing was sent.',
    );
  }
  const hex = match[1].toLowerCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The plain text of a rich text list. */
export function plain(richText: unknown): string {
  if (!Array.isArray(richText)) return '';
  return richText.map((item: any) => (typeof item?.plain_text === 'string' ? item.plain_text : typeof item?.text?.content === 'string' ? item.text.content : '')).join('');
}

/** The parent of a page, block, database or data source: { type, id }. */
export function parentOf(item: any): Record<string, unknown> | undefined {
  const parent = item?.parent;
  if (!parent || typeof parent !== 'object' || typeof parent.type !== 'string') return undefined;
  if (parent.type === 'workspace') return { type: 'workspace' };
  return compact({
    type: parent.type,
    id: typeof parent[parent.type] === 'string' ? parent[parent.type] : undefined,
    database_id: parent.type === 'data_source_id' && typeof parent.database_id === 'string' ? parent.database_id : undefined,
  });
}

/** The title of a page: the text of its title property. */
export function pageTitle(page: any): string {
  const properties = page?.properties;
  if (!properties || typeof properties !== 'object') return '';
  for (const property of Object.values(properties) as any[]) {
    if (property?.type === 'title') return plain(property.title);
  }
  return '';
}

function person(user: any): Record<string, unknown> | undefined {
  if (!user || typeof user !== 'object') return undefined;
  return compact({ id: user.id, name: typeof user.name === 'string' ? user.name : undefined });
}

function scalar(value: any): unknown {
  if (value === undefined) return null;
  return value;
}

function formulaValue(formula: any): unknown {
  if (!formula || typeof formula !== 'object') return null;
  const value = formula[formula.type];
  if (formula.type === 'date') return value ? compact({ start: value.start, end: value.end }) : null;
  return scalar(value);
}

function rollupValue(rollup: any): unknown {
  if (!rollup || typeof rollup !== 'object') return null;
  if (rollup.type === 'array') return { items: Array.isArray(rollup.array) ? rollup.array.length : 0 };
  if (rollup.type === 'date') return rollup.date ? compact({ start: rollup.date.start, end: rollup.date.end }) : null;
  return scalar(rollup[rollup.type]);
}

/** A property's value as plain JSON: text, a number, a name, a list of names, a date range, and so on. */
export function propertyValue(property: any): unknown {
  if (!property || typeof property !== 'object') return null;
  switch (property.type) {
    case 'title':
    case 'rich_text':
      return truncate(plain(property[property.type]), 2000);
    case 'number':
      return scalar(property.number);
    case 'select':
    case 'status':
      return property[property.type]?.name ?? null;
    case 'multi_select':
      return Array.isArray(property.multi_select) ? property.multi_select.map((option: any) => option?.name) : [];
    case 'date':
      return property.date ? compact({ start: property.date.start, end: property.date.end, time_zone: property.date.time_zone }) : null;
    case 'checkbox':
      return property.checkbox === true;
    case 'url':
    case 'email':
    case 'phone_number':
      return scalar(property[property.type]);
    case 'people':
      return Array.isArray(property.people) ? property.people.map(person) : [];
    case 'relation':
      return Array.isArray(property.relation) ? property.relation.map((item: any) => item?.id) : [];
    case 'files':
      return Array.isArray(property.files)
        ? property.files.map((file: any) => compact({ name: file?.name, url: file?.external?.url ?? file?.file?.url }))
        : [];
    case 'formula':
      return formulaValue(property.formula);
    case 'rollup':
      return rollupValue(property.rollup);
    case 'created_time':
    case 'last_edited_time':
      return scalar(property[property.type]);
    case 'created_by':
    case 'last_edited_by':
      return person(property[property.type]) ?? null;
    case 'unique_id': {
      const id = property.unique_id;
      if (!id || typeof id.number !== 'number') return null;
      return id.prefix ? `${id.prefix}-${id.number}` : id.number;
    }
    case 'verification':
      return property.verification?.state ?? null;
    default:
      return `(${String(property.type ?? 'unknown')} value)`;
  }
}

/** Every property of a page: { name: { type, value } } or, flat, { name: value }. */
export function pageProperties(page: any, flat: boolean, only?: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const properties = page?.properties;
  if (!properties || typeof properties !== 'object') return out;
  for (const [name, property] of Object.entries(properties) as Array<[string, any]>) {
    if (only && only.length && property?.type !== 'title' && !only.includes(name)) continue;
    out[name] = flat ? propertyValue(property) : { type: property?.type, value: propertyValue(property) };
  }
  return out;
}

/** A page in a result: what it is and where, with its properties when asked. */
export function trimPage(page: any, properties: 'none' | 'typed' | 'flat' = 'typed', only?: readonly string[]): Record<string, unknown> {
  return compact({
    id: page?.id,
    title: truncate(pageTitle(page), 500) || '(untitled)',
    url: page?.url,
    parent: parentOf(page),
    in_trash: page?.in_trash === true ? true : undefined,
    created_time: page?.created_time,
    last_edited_time: page?.last_edited_time,
    properties: properties === 'none' ? undefined : pageProperties(page, properties === 'flat', only),
  });
}

/** One search result: a page or a data source. */
export function trimSearchResult(item: any): Record<string, unknown> {
  const title = item?.object === 'page' ? pageTitle(item) : plain(item?.title);
  return compact({
    object: item?.object,
    id: item?.id,
    title: truncate(title, 300) || '(untitled)',
    url: item?.url,
    parent: parentOf(item),
    last_edited_time: item?.last_edited_time,
    in_trash: item?.in_trash === true ? true : undefined,
  });
}

const URL_BLOCKS = new Set(['bookmark', 'embed', 'link_preview', 'video', 'pdf', 'file', 'audio', 'image']);

/** One block: its ID and type, its text, and what else identifies it. */
export function trimBlock(block: any): Record<string, unknown> {
  const type = typeof block?.type === 'string' ? block.type : 'unknown';
  const body = block?.[type] ?? {};
  const text = plain(body?.rich_text);
  return compact({
    id: block?.id,
    type,
    text: text ? truncate(text, 1000) : undefined,
    checked: type === 'to_do' ? body?.checked === true : undefined,
    language: type === 'code' ? body?.language : undefined,
    title: type === 'child_page' || type === 'child_database' ? body?.title : undefined,
    url: URL_BLOCKS.has(type) ? body?.url ?? body?.external?.url ?? body?.file?.url : undefined,
    caption: URL_BLOCKS.has(type) && plain(body?.caption) ? truncate(plain(body.caption), 300) : undefined,
    icon: type === 'callout' ? body?.icon?.emoji : undefined,
    expression: type === 'equation' ? body?.expression : undefined,
    table_width: type === 'table' ? body?.table_width : undefined,
    has_column_header: type === 'table' ? body?.has_column_header : undefined,
    cells: type === 'table_row' && Array.isArray(body?.cells) ? body.cells.map((cell: unknown) => truncate(plain(cell), 300)) : undefined,
    unsupported_type: type === 'unsupported' ? body?.block_type : undefined,
    has_children: block?.has_children === true ? true : undefined,
    in_trash: block?.in_trash === true ? true : undefined,
  });
}

/** A data source's schema: each property with its type and ID, the title property first. */
export function schemaProperties(dataSource: any): Array<Record<string, unknown>> {
  const properties = dataSource?.properties;
  if (!properties || typeof properties !== 'object') return [];
  const readOnly = new Set(['formula', 'rollup', 'created_time', 'created_by', 'last_edited_time', 'last_edited_by', 'unique_id', 'button']);
  const rows = (Object.entries(properties) as Array<[string, any]>).map(([name, property]) => {
    const type = property?.type;
    const options = ['select', 'multi_select', 'status'].includes(type) && Array.isArray(property?.[type]?.options)
      ? property[type].options.map((option: any) => option?.name)
      : undefined;
    return compact({
      name,
      type,
      id: property?.id,
      options,
      links_to: type === 'relation' ? property?.relation?.data_source_id ?? property?.relation?.database_id : undefined,
      read_only: readOnly.has(type) ? true : undefined,
    });
  });
  return rows.sort((a, b) => Number(b['type'] === 'title') - Number(a['type'] === 'title'));
}

/** The room a window of long text may take in a result, in UTF-8 bytes of its JSON form. */
export const TEXT_WINDOW_BYTES = 24_000;

/**
 * A window of a long text that fits `budget` bytes once JSON-encoded, starting
 * at `offset`. It ends at a line break when one is near, never inside a
 * character, and says where the next window starts.
 */
export function textWindow(text: string, offset: number, budget = TEXT_WINDOW_BYTES): { text: string; offset: number; next?: number } {
  const start = Math.max(0, Math.min(Math.floor(offset), text.length));
  const rest = text.length - start;
  const size = (count: number): number => utf8Length(JSON.stringify(text.slice(start, start + count)));
  let count = Math.min(rest, budget);
  if (size(count) > budget) {
    let low = 0;
    let high = count;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (size(middle) <= budget) low = middle;
      else high = middle - 1;
    }
    count = low;
  }
  if (count < rest) {
    const lineBreak = text.lastIndexOf('\n', start + count - 1);
    if (lineBreak >= start + Math.floor(count / 2)) count = lineBreak + 1 - start;
    const code = text.charCodeAt(start + count - 1);
    if (code >= 0xd800 && code <= 0xdbff) count -= 1;
  }
  const end = start + Math.max(count, 0);
  return { text: text.slice(start, end), offset: start, ...(end < text.length ? { next: end } : {}) };
}
