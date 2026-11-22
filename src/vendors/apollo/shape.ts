// Trimming and paging helpers for the Apollo connector. Apollo's people and
// company objects carry dozens of fields; results keep the ones an agent
// needs, under Apollo's own names.

import { truncate, type ApiRequest, type ToolHelpers } from '../../core/index.js';

/** Drops undefined, null, empty strings, empty lists and empty objects. */
export function compact(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => {
    if (item === undefined || item === null || item === '') return false;
    if (Array.isArray(item)) return item.length > 0;
    if (typeof item === 'object') return Object.keys(item as object).length > 0;
    return true;
  }));
}

const text = (value: unknown, max = 500) => (typeof value === 'string' && value ? truncate(value, max) : undefined);
const first = <T>(value: unknown, count: number): T[] | undefined => (Array.isArray(value) && value.length ? (value.slice(0, count) as T[]) : undefined);

export function trimOrganization(org: any): Record<string, unknown> {
  if (!org || typeof org !== 'object') return {};
  return compact({
    id: org.id,
    name: org.name,
    website_url: org.website_url,
    primary_domain: org.primary_domain,
    linkedin_url: org.linkedin_url,
    industry: org.industry,
    keywords: first<string>(org.keywords, 15),
    estimated_num_employees: org.estimated_num_employees,
    annual_revenue: org.annual_revenue,
    annual_revenue_printed: org.annual_revenue_printed,
    total_funding: org.total_funding,
    total_funding_printed: org.total_funding_printed,
    latest_funding_stage: org.latest_funding_stage,
    latest_funding_round_date: org.latest_funding_round_date,
    founded_year: org.founded_year,
    publicly_traded_symbol: org.publicly_traded_symbol,
    phone: org.primary_phone?.sanitized_number ?? org.primary_phone?.number ?? org.phone,
    city: org.city,
    state: org.state,
    country: org.country,
    short_description: text(org.short_description),
    technology_names: first<string>(org.technology_names, 30),
    // Fields of a people search result's organization: what Apollo has, without the values.
    has_industry: org.has_industry,
    has_phone: org.has_phone,
    has_employee_count: org.has_employee_count,
  });
}

export function trimPerson(person: any): Record<string, unknown> | null {
  if (!person || typeof person !== 'object') return null;
  const history: any[] = Array.isArray(person.employment_history) ? person.employment_history : [];
  return compact({
    id: person.id,
    first_name: person.first_name,
    last_name: person.last_name,
    last_name_obfuscated: person.last_name_obfuscated,
    name: person.name,
    title: person.title,
    headline: text(person.headline, 200),
    email: person.email,
    email_status: person.email_status,
    personal_emails: first<string>(person.personal_emails, 5),
    phone_numbers: first<any>(person.phone_numbers, 5)?.map((phone) => compact({ number: phone?.sanitized_number ?? phone?.raw_number, type: phone?.type_cd ?? phone?.type, status: phone?.status_cd ?? phone?.status })),
    linkedin_url: person.linkedin_url,
    seniority: person.seniority,
    departments: first<string>(person.departments, 5),
    city: person.city,
    state: person.state,
    country: person.country,
    has_email: person.has_email,
    has_direct_phone: person.has_direct_phone,
    has_city: person.has_city,
    has_country: person.has_country,
    organization_id: person.organization_id,
    organization: trimOrganization(person.organization),
    employment_history: history.length
      ? history.slice(0, 3).map((job) => compact({ title: job?.title, organization_name: job?.organization_name, start_date: job?.start_date, end_date: job?.end_date, current: job?.current }))
      : undefined,
  });
}

const phones = (value: unknown) => first<any>(value, 5)?.map((phone) => compact({ number: phone?.sanitized_number ?? phone?.raw_number, type: phone?.type_cd ?? phone?.type }));

export function trimContact(contact: any): Record<string, unknown> {
  return compact({
    id: contact?.id,
    first_name: contact?.first_name,
    last_name: contact?.last_name,
    name: contact?.name,
    title: contact?.title,
    email: contact?.email,
    email_status: contact?.email_status,
    organization_name: contact?.organization_name,
    account_id: contact?.account_id,
    owner_id: contact?.owner_id,
    contact_stage_id: contact?.contact_stage_id,
    label_ids: contact?.label_ids,
    linkedin_url: contact?.linkedin_url,
    phone_numbers: phones(contact?.phone_numbers),
    present_raw_address: contact?.present_raw_address,
    city: contact?.city,
    state: contact?.state,
    country: contact?.country,
    person_id: contact?.person_id,
    emailer_campaign_ids: contact?.emailer_campaign_ids,
    last_activity_date: contact?.last_activity_date,
    created_at: contact?.created_at,
    updated_at: contact?.updated_at,
    typed_custom_fields: contact?.typed_custom_fields,
  });
}

export function trimAccount(account: any): Record<string, unknown> {
  return compact({
    id: account?.id,
    name: account?.name,
    domain: account?.domain,
    website_url: account?.website_url,
    phone: account?.phone ?? account?.sanitized_phone,
    owner_id: account?.owner_id,
    account_stage_id: account?.account_stage_id,
    label_ids: account?.label_ids,
    organization_id: account?.organization_id,
    linkedin_url: account?.linkedin_url,
    raw_address: account?.raw_address,
    last_activity_date: account?.last_activity_date,
    created_at: account?.created_at,
    updated_at: account?.updated_at,
    typed_custom_fields: account?.typed_custom_fields,
  });
}

export function trimDeal(deal: any): Record<string, unknown> {
  return compact({
    id: deal?.id,
    name: deal?.name,
    amount: deal?.amount,
    opportunity_stage_id: deal?.opportunity_stage_id,
    opportunity_pipeline_id: deal?.opportunity_pipeline_id,
    owner_id: deal?.owner_id,
    account_id: deal?.account_id,
    closed_date: deal?.closed_date,
    is_closed: deal?.is_closed,
    is_won: deal?.is_won,
    forecast_category: deal?.forecast_category,
    deal_probability: deal?.deal_probability,
    source: deal?.source,
    created_at: deal?.created_at,
    updated_at: deal?.updated_at,
    typed_custom_fields: deal?.typed_custom_fields,
  });
}

export function trimSequence(sequence: any): Record<string, unknown> {
  return compact({
    id: sequence?.id,
    name: sequence?.name,
    active: sequence?.active,
    archived: sequence?.archived,
    num_steps: sequence?.num_steps,
    user_id: sequence?.user_id,
    created_at: sequence?.created_at,
    last_used_at: sequence?.last_used_at,
    unique_scheduled: sequence?.unique_scheduled,
    unique_delivered: sequence?.unique_delivered,
    unique_bounced: sequence?.unique_bounced,
    unique_opened: sequence?.unique_opened,
    unique_replied: sequence?.unique_replied,
    unique_clicked: sequence?.unique_clicked,
    unique_unsubscribed: sequence?.unique_unsubscribed,
    open_rate: sequence?.open_rate,
    reply_rate: sequence?.reply_rate,
    bounce_rate: sequence?.bounce_rate,
    click_rate: sequence?.click_rate,
  });
}

export function trimTask(task: any): Record<string, unknown> {
  return compact({
    id: task?.id,
    type: task?.type,
    status: task?.status,
    priority: task?.priority,
    title: task?.title ?? task?.subject,
    note: text(task?.note, 1000),
    due_at: task?.due_at,
    completed_at: task?.completed_at,
    skipped_at: task?.skipped_at,
    contact_id: task?.contact_id,
    account_id: task?.account_id,
    user_id: task?.user_id,
    emailer_campaign_id: task?.emailer_campaign_id,
    created_at: task?.created_at,
  });
}

export function trimEmailMessage(message: any): Record<string, unknown> {
  return compact({
    id: message?.id,
    emailer_campaign_id: message?.emailer_campaign_id,
    contact_id: message?.contact_id,
    user_id: message?.user_id,
    email_account_id: message?.email_account_id,
    to_email: message?.to_email,
    subject: text(message?.subject, 300),
    status: message?.status,
    reply_class: message?.reply_class,
    not_sent_reason: message?.not_sent_reason,
    due_at: message?.due_at,
    completed_at: message?.completed_at,
    num_opens: message?.num_opens,
    num_clicks: message?.num_clicks,
    replied: message?.replied,
  });
}

export function trimCall(call: any): Record<string, unknown> {
  return compact({
    id: call?.id,
    status: call?.status,
    inbound: call?.inbound,
    duration: call?.duration,
    start_time: call?.start_time,
    end_time: call?.end_time,
    note: text(call?.note, 1000),
    contact_id: call?.contact_id,
    account_id: call?.account_id,
    user_id: call?.user_id,
    to_number: call?.to_number,
    from_number: call?.from_number,
    phone_call_outcome_id: call?.phone_call_outcome_id,
    phone_call_purpose_id: call?.phone_call_purpose_id,
    created_at: call?.created_at,
  });
}

export interface PagedOptions {
  key: string;
  /** Apollo's field that holds the list (default: key). */
  listField?: string;
  perPage: number;
  /** The request for one page. */
  request(page: number, perPage: number): ApiRequest;
  trim(item: any): unknown;
  /** The highest page Apollo serves (500 for people search). */
  maxPage?: number;
  extra?(data: any): Record<string, unknown>;
}

/**
 * One page of an Apollo search that pages with page and per_page and reports
 * `pagination` (or `total_entries`). The cursor carries the page, its size and
 * how many items were already returned when the 32 KB limit cut it.
 */
export async function paged(h: ToolHelpers, cursor: string | undefined, options: PagedOptions): Promise<Record<string, unknown>> {
  const state = h.cursor(cursor);
  const page = typeof state?.['p'] === 'number' ? state['p'] : 1;
  const perPage = typeof state?.['n'] === 'number' ? state['n'] : options.perPage;
  const skip = typeof state?.['s'] === 'number' ? state['s'] : 0;
  const { data } = await h.api(options.request(page, perPage));
  const items: unknown[] = Array.isArray(data?.[options.listField ?? options.key]) ? data[options.listField ?? options.key] : [];
  const total = typeof data?.pagination?.total_entries === 'number' ? data.pagination.total_entries : typeof data?.total_entries === 'number' ? data.total_entries : undefined;
  const pages = typeof data?.pagination?.total_pages === 'number' ? data.pagination.total_pages : total !== undefined ? Math.ceil(total / perPage) : undefined;
  const more = (pages !== undefined ? page < pages : items.length >= perPage) && page < (options.maxPage ?? Number.MAX_SAFE_INTEGER);
  return h.page({
    key: options.key,
    items: items.map(options.trim).slice(skip),
    extra: compact({ total_entries: total, page, ...options.extra?.(data) }),
    resumeAt: (index) => h.makeCursor({ p: page, n: perPage, s: skip + index }),
    ...(more && items.length ? { nextPage: h.makeCursor({ p: page + 1, n: perPage, s: 0 }) } : {}),
  });
}
