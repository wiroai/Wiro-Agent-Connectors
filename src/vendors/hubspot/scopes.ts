// The HubSpot OAuth scopes each tool uses, to name them when HubSpot refuses a
// call for a missing scope. The README's Scopes table says which ones a
// sign-in asks for as required and which as optional; hubspot.test.mjs keeps
// the two in step.
//
// HubSpot answers a missing scope with HTTP 403, category MISSING_SCOPES and
// "This app hasn't been granted all required scopes to make this call". Only
// such a refusal gets the advice: a 403 for another reason (the account's
// plan, a user's permissions) is passed on as HubSpot said it.

import { andList, orList, ToolFailure, type ToolDefinition } from '../../core/index.js';

type Access = 'read' | 'write';

/** HubSpot's ids of its standard record types, by the names the tools also take. */
const TYPE_IDS: Record<string, string> = {
  '0-1': 'contacts',
  '0-2': 'companies',
  '0-3': 'deals',
  '0-5': 'tickets',
  '0-7': 'products',
  '0-8': 'line_items',
  '0-14': 'quotes',
  '0-18': 'communications',
  '0-27': 'tasks',
  '0-46': 'notes',
  '0-47': 'meetings',
  '0-48': 'calls',
  '0-49': 'emails',
  '0-116': 'postal_mail',
  '0-136': 'leads',
};

/** Engagements: HubSpot lets them be read and written with the contact scopes, which every sign-in grants. */
const ENGAGEMENTS = new Set(['notes', 'calls', 'tasks', 'meetings', 'emails', 'communications', 'postal_mail']);

/** The scope for reading or changing records of a type, or undefined for a type it does not know. */
function recordScope(objectType: string, access: Access): string | undefined {
  const type = TYPE_IDS[objectType] ?? objectType;
  if (type === 'contacts' || ENGAGEMENTS.has(type)) return `crm.objects.contacts.${access}`;
  if (type === 'companies' || type === 'deals' || type === 'quotes' || type === 'leads') return `crm.objects.${type}.${access}`;
  if (type === 'tickets') return 'tickets';
  if (type === 'products' || type === 'line_items') return 'e-commerce';
  // A custom object: its id (2-1234567) or its fully qualified name (p1234567_cars).
  if (/^2-\d+$/.test(type) || /^p\d+_/.test(type)) return `crm.objects.custom.${access}`;
  return undefined;
}

/** What a call needs: every scope listed, or (any) one of them. */
interface ScopeNeed {
  scopes: string[];
  any?: boolean;
}

/** The scopes of the record types a call touches; nothing when its own type is one this table does not know. */
function records(main: [string, Access], ...others: [string | undefined, Access][]): ScopeNeed | undefined {
  const first = recordScope(...main);
  if (!first) return undefined;
  const scopes = new Set([first]);
  for (const [type, access] of others) {
    const scope = type === undefined ? undefined : recordScope(type, access);
    if (scope) scopes.add(scope);
  }
  return { scopes: [...scopes] };
}

const EITHER_EMAIL_SCOPE: ScopeNeed = { scopes: ['marketing-email', 'transactional-email'], any: true };

/** The scopes each tool needs, from its arguments. The tools not listed need only what every sign-in grants. */
const TOOL_SCOPES: Record<string, (args: any) => ScopeNeed | undefined> = {
  list_objects: (args) => records([args.object_type, 'read'], ...(args.associations ?? []).map((type: string): [string, Access] => [type, 'read'])),
  get_object: (args) => records([args.object_type, 'read'], ...(args.associations ?? []).map((type: string): [string, Access] => [type, 'read'])),
  search_objects: (args) => records([args.object_type, 'read']),
  create_object: (args) => records([args.object_type, 'write'], ...(args.associations ?? []).map((item: { to_object_type: string }): [string, Access] => [item.to_object_type, 'read'])),
  update_object: (args) => records([args.object_type, 'write']),
  delete_object: (args) => records([args.object_type, 'write']),
  list_properties: (args) => records([args.object_type, 'read']),
  list_pipelines: (args) => records([args.object_type, 'read']),
  list_owners: () => ({ scopes: ['crm.objects.owners.read'] }),
  list_associations: (args) => records([args.object_type, 'read'], [args.to_object_type, 'read']),
  create_associations: (args) => records([args.from_object_type, 'write'], [args.to_object_type, 'write']),
  remove_associations: (args) => records([args.from_object_type, 'write'], [args.to_object_type, 'write']),
  search_lists: () => ({ scopes: ['crm.lists.read'] }),
  list_list_members: (args) => {
    // With properties it also reads the members as records of their type.
    const members = args.properties?.length ? recordScope(args.object_type, 'read') : undefined;
    return { scopes: members ? ['crm.lists.read', members] : ['crm.lists.read'] };
  },
  add_to_list: () => ({ scopes: ['crm.lists.write'] }),
  remove_from_list: () => ({ scopes: ['crm.lists.write'] }),
  list_marketing_emails: () => ({ scopes: ['content'] }),
  get_marketing_email: () => ({ scopes: ['content'] }),
  create_marketing_email: () => ({ scopes: ['content'] }),
  update_marketing_email: () => ({ scopes: ['content'] }),
  publish_marketing_email: () => EITHER_EMAIL_SCOPE,
  send_single_email: (args) => (args.type === 'marketing' ? EITHER_EMAIL_SCOPE : { scopes: ['transactional-email'] }),
  get_send_status: () => EITHER_EMAIL_SCOPE,
  list_files: () => ({ scopes: ['files'] }),
  upload_file: () => ({ scopes: ['files'] }),
};

/** The sentence that names what a refused call needs. */
function scopeAdvice(need: ScopeNeed): string {
  const { scopes } = need;
  if (scopes.length === 1) return `This call needs the ${scopes[0]} scope: connect HubSpot again and grant it (an app of your own must list it first).`;
  if (need.any) {
    const either = scopes.length === 2 ? scopes.join(' or ') : orList(scopes);
    return `This call needs the ${either} scope: connect HubSpot again and grant one of them (an app of your own must list it first).`;
  }
  return `This call needs the ${andList(scopes)} scopes: connect HubSpot again and grant those the connection lacks (an app of your own must list them first).`;
}

/** HubSpot's refusal for a scope the sign-in did not grant: a 403 whose words, which the failure quotes, are about scopes. */
function missingScope(error: unknown): error is ToolFailure {
  return error instanceof ToolFailure && error.details.status === 403 && /\bscopes?\b/i.test(error.message);
}

/** The tools, each adding the scopes it needs to HubSpot's refusal for a missing scope. */
export function withScopeAdvice(tools: ToolDefinition[]): ToolDefinition[] {
  return tools.map((tool) => {
    const needOf = TOOL_SCOPES[tool.name];
    if (!needOf) return tool;
    return {
      ...tool,
      async run(args, h) {
        try {
          return await tool.run(args, h);
        } catch (error) {
          if (!missingScope(error)) throw error;
          const need = needOf(args);
          if (!need?.scopes.length) throw error;
          throw new ToolFailure(`${error.message} ${scopeAdvice(need)}`, error.details);
        }
      },
    };
  });
}
