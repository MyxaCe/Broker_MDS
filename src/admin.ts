import { timingSafeEqual } from 'node:crypto';
import {
  leaderIdentityChanges,
  symbolInstrumentChanges,
  registrySchema,
  summarizeRouting,
  type Registry,
  type RoutingTable,
} from './registry.js';
import type { RegistryOrigin } from './registry-store.js';
import type { CatalogInstrument } from './types.js';

export type AuthOutcome =
  | { ok: true }
  | { ok: false; code: Extract<AdminCode, 'control-plane-disabled'>; status: 503; detail: string }
  | { ok: false; code: Extract<AdminCode, 'no-token' | 'bad-token'>; status: 401; detail: string };

export const ADMIN_CODES = [
  'control-plane-disabled',
  'no-token',
  'bad-token',
  'registry-unreadable',
  'bad-body',
  'version-required',
  'version-conflict',
  'invalid-registry',
  'method-not-allowed',
  'not-found',
  'routing-identity-change',
  'symbol-instrument-change',
] as const;

export type AdminCode = (typeof ADMIN_CODES)[number];

export const MIN_ADMIN_TOKEN_LENGTH = 24;

export function authorize(header: string | string[] | undefined, configured: string | undefined): AuthOutcome {
  if (configured === undefined || configured.trim() === '') {
    return {
      ok: false,
      code: 'control-plane-disabled',
      status: 503,
      detail: 'MDS_ADMIN_TOKEN не задан — служебная ручка выключена',
    };
  }
  if (!/^[!-~]+$/.test(configured)) {
    return {
      ok: false,
      code: 'control-plane-disabled',
      status: 503,
      detail: 'MDS_ADMIN_TOKEN содержит символы, непередаваемые в HTTP-заголовке (нужен ASCII без пробелов)',
    };
  }
  if (configured.length < MIN_ADMIN_TOKEN_LENGTH) {
    return {
      ok: false,
      code: 'control-plane-disabled',
      status: 503,
      detail: `MDS_ADMIN_TOKEN короче ${MIN_ADMIN_TOKEN_LENGTH} символов — считаем настройку непригодной`,
    };
  }
  const supplied = Array.isArray(header) ? header[0] : header;
  if (supplied === undefined || supplied === '') {
    return {
      ok: false,
      code: 'no-token',
      status: 401,
      detail: 'заголовок x-mds-admin-token не прислан',
    };
  }
  const a = Buffer.from(supplied, 'utf8');
  const b = Buffer.from(configured, 'utf8');
  const equal = a.length === b.length && timingSafeEqual(a, b);
  return equal
    ? { ok: true }
    : { ok: false, code: 'bad-token', status: 401, detail: 'секрет не совпал' };
}

export interface AdminView {
  registry: Registry | null;
  origin: RegistryOrigin;
  error?: string;
  adapters: readonly string[];
  routing: ReturnType<typeof summarizeRouting> | null;
  keys: { providerId: string; required: boolean; present: boolean }[];
}

export function buildAdminView(input: {
  registry: Registry | null;
  origin: RegistryOrigin;
  error?: string;
  adapters: readonly string[];
  routing: RoutingTable | null;
  keyPresence: Map<string, boolean>;
}): AdminView {
  return {
    registry: input.registry,
    origin: input.origin,
    ...(input.error === undefined ? {} : { error: input.error }),
    adapters: input.adapters,
    routing: input.routing ? summarizeRouting(input.routing) : null,
    keys: (input.registry?.providers ?? []).map((p) => ({
      providerId: p.id,
      required: p.requiresKey,
      present: input.keyPresence.get(p.id) ?? false,
    })),
  };
}

export type UpdateOutcome =
  | { ok: true; registry: Registry }
  | { ok: false; status: 400 | 409 | 503; code: AdminCode; detail: string };

export interface RoutingGuard {
  catalog: CatalogInstrument[];
  allowIdentityChange: boolean;
}

export function applyRegistryUpdate(
  current: Registry | null,
  body: unknown,
  meta: { now: Date; actor: string },
  guard: RoutingGuard,
): UpdateOutcome {
  if (current === null) {
    return {
      ok: false,
      status: 503,
      code: 'registry-unreadable',
      detail: 'действующий реестр не прочитан — чинить файл, а не писать поверх вслепую',
    };
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, status: 400, code: 'bad-body', detail: 'тело запроса — объект JSON' };
  }
  const incoming = body as Record<string, unknown>;
  if (typeof incoming.version !== 'number' || !Number.isInteger(incoming.version)) {
    return {
      ok: false,
      status: 400,
      code: 'version-required',
      detail: 'version обязателен: без него правка затирает чужую молча',
    };
  }
  if (incoming.version !== current.version) {
    return {
      ok: false,
      status: 409,
      code: 'version-conflict',
      detail: `реестр уже версии ${current.version}, прислана правка от ${incoming.version}`,
    };
  }

  const candidate = {
    ...incoming,
    version: current.version + 1,
    updatedAt: meta.now.toISOString(),
    updatedBy: meta.actor,
  };

  const parsed = registrySchema.safeParse(candidate);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 8)
      .map((i) => `${i.path.join('.') || '(корень)'}: ${i.message}`)
      .join('; ');
    return { ok: false, status: 400, code: 'invalid-registry', detail: issues };
  }

  if (!guard.allowIdentityChange) {
    const changes = leaderIdentityChanges(guard.catalog, current, parsed.data);
    if (changes.length > 0) {
      const named = changes
        .slice(0, 5)
        .map((c) => `${c.symbol}: ${c.from} → ${c.to}`)
        .join('; ');
      const more = changes.length > 5 ? ` (и ещё ${changes.length - 5})` : '';
      return {
        ok: false,
        status: 409,
        code: 'routing-identity-change',
        detail:
          `правка меняет личность ведущего источника у ${changes.length} символов — ${named}${more}. ` +
          'Смена источника на живом символе — РАЗРЫВ РЯДА, а потребитель показывает её очередным ' +
          'тиком, то есть скачком цены как движением рынка. Запрет снимается переменной ' +
          'MDS_ALLOW_ROUTING_IDENTITY_CHANGE=true, когда потребитель научится показывать разрыв. ' +
          'Оговорка: предикат считается по ЖИВОМУ каталогу — вселенная биржи меняется сама, ' +
          'и правка, принятая вчера, может быть отклонена сегодня без изменений в самой правке.',
      };
    }
  }

  if (!guard.allowIdentityChange) {
    const changes = symbolInstrumentChanges(guard.catalog, current, parsed.data);
    if (changes.length > 0) {
      const named = changes
        .slice(0, 5)
        .map((c) => `${c.symbol}: означало ${c.from} → станет означать ${c.to}`)
        .join('; ');
      const more = changes.length > 5 ? ` (и ещё ${changes.length - 5})` : '';
      return {
        ok: false,
        status: 409,
        code: 'symbol-instrument-change',
        detail:
          `правка меняет сам инструмент у ${changes.length} символов — ${named}${more}. ` +
          'Это НЕ смена источника: под постоянным именем встаёт ДРУГОЙ АКТИВ, и потребитель ' +
          'покажет правдоподобное число не о том инструменте. Прочерк безопаснее такого числа. ' +
          'Запрет снимается переменной MDS_ALLOW_ROUTING_IDENTITY_CHANGE=true. ' +
          'Оговорка: предикат считается по ЖИВОМУ каталогу — вселенная биржи меняется сама, ' +
          'и правка, принятая вчера, может быть отклонена сегодня без изменений в самой правке.',
      };
    }
  }

  return { ok: true, registry: parsed.data };
}

export interface AuditEntry {
  at: string;
  actor: string;
  remote: string;
  outcome: string;
  fromVersion: number | null;
  toVersion: number | null;
  changes: string[];
}

export function describeChanges(before: Registry | null, after: Registry): string[] {
  const out: string[] = [];
  const prev = new Map((before?.providers ?? []).map((p) => [p.id, p]));
  for (const p of after.providers) {
    const was = prev.get(p.id);
    if (!was) {
      out.push(`+${p.id} (adapter=${p.adapter}, enabled=${p.enabled}, priority=${p.priority})`);
      continue;
    }
    if (was.enabled !== p.enabled) out.push(`${p.id}: enabled ${was.enabled} → ${p.enabled}`);
    if (was.priority !== p.priority) out.push(`${p.id}: priority ${was.priority} → ${p.priority}`);
    if (was.covers.join(',') !== p.covers.join(',')) {
      out.push(`${p.id}: covers [${was.covers.join(',')}] → [${p.covers.join(',')}]`);
    }
    if (was.maxSilenceMs !== p.maxSilenceMs) {
      out.push(`${p.id}: maxSilenceMs ${was.maxSilenceMs} → ${p.maxSilenceMs}`);
    }
    prev.delete(p.id);
  }
  for (const id of prev.keys()) out.push(`-${id}`);
  if (before && before.categoryPrecedence.join(',') !== after.categoryPrecedence.join(',')) {
    out.push(`categoryPrecedence [${before.categoryPrecedence.join(',')}] → [${after.categoryPrecedence.join(',')}]`);
  }
  return out;
}

export class AuditLog {
  private readonly entries: AuditEntry[] = [];
  constructor(private readonly limit = 200) {}

  record(entry: AuditEntry): void {
    this.entries.push(entry);
    if (this.entries.length > this.limit) this.entries.shift();
    console.info(
      `[mds:admin] ${entry.at} ${entry.outcome} actor=${entry.actor} remote=${entry.remote} ` +
        `v${entry.fromVersion} → v${entry.toVersion} ${entry.changes.join(' | ') || '(без изменений состава)'}`,
    );
  }

  list(): AuditEntry[] {
    return [...this.entries];
  }
}
