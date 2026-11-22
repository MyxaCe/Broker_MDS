import { z } from 'zod';
import type { CatalogInstrument, Quote } from './types.js';

export const CATEGORIES = [
  'forex',
  'metals',
  'crypto',
  'indices',
  'stocks',
  'energy',
] as const satisfies readonly Quote['category'][];

export type Category = Quote['category'];

export const ADAPTER_KINDS = ['binance', 'twelvedata', 'modulev2'] as const;
export type AdapterKind = (typeof ADAPTER_KINDS)[number];

const categorySchema = z.enum(CATEGORIES);

const providerSchema = z
  .object({
    id: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]{0,31}$/, 'id: строчные латинские, цифры и дефис, до 32 символов'),
    adapter: z.enum(ADAPTER_KINDS),
    label: z.string().min(1).max(80),
    enabled: z.boolean(),
    priority: z.number().int().min(0).max(10_000),
    covers: z.array(categorySchema).max(CATEGORIES.length),
    maxSilenceMs: z.number().int().positive().nullable(),
    requiresKey: z.boolean(),
  })
  .strict();

export const registrySchema = z
  .object({
    version: z.number().int().min(0),
    updatedAt: z.string().min(1),
    updatedBy: z.string().min(1).max(120),
    providers: z.array(providerSchema).max(32),
    categoryPrecedence: z.array(categorySchema),
  })
  .strict()
  .superRefine((value, ctx) => {
    const ids = new Set<string>();
    for (const p of value.providers) {
      if (ids.has(p.id)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `дубль id провайдера: ${p.id}` });
      }
      ids.add(p.id);
    }
    const seen = new Set<Category>();
    for (const c of value.categoryPrecedence) {
      if (seen.has(c)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `дубль категории в precedence: ${c}` });
      }
      seen.add(c);
    }
    for (const c of CATEGORIES) {
      if (!seen.has(c)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `categoryPrecedence не покрывает категорию ${c} — коллизии по ней решать нечем`,
        });
      }
    }
  });

export type ProviderEntry = z.infer<typeof providerSchema>;
export type Registry = z.infer<typeof registrySchema>;

export function builtinRegistry(): Registry {
  return {
    version: 0,
    updatedAt: new Date(0).toISOString(),
    updatedBy: 'builtin-default',
    providers: [
      {
        id: 'binance',
        adapter: 'binance',
        label: 'Binance — публичные данные, ключ не нужен',
        enabled: true,
        priority: 10,
        covers: ['crypto'],
        maxSilenceMs: 60_000,
        requiresKey: false,
      },
      {
        id: 'twelvedata',
        adapter: 'twelvedata',
        label: 'Twelve Data — форекс, металлы, акции, индексы',
        enabled: false,
        priority: 20,
        covers: ['forex', 'metals', 'stocks', 'indices'],
        maxSilenceMs: null,
        requiresKey: true,
      },
      {
        id: 'modulev2',
        adapter: 'modulev2',
        label: 'Модуль рыночных данных v2 — форекс, металлы, акции, энергоносители, индексы',
        enabled: true,
        priority: 15,
        covers: ['forex', 'metals', 'stocks', 'energy', 'indices'],
        maxSilenceMs: 60_000,
        requiresKey: false,
      },
    ],
    categoryPrecedence: ['forex', 'metals', 'indices', 'stocks', 'energy', 'crypto'],
  };
}

export const ROUTE_REASONS = [
  'primary',
  'failover',
  'silent',
  'source-disabled',
  'no-source',
] as const;

export type RouteReason = (typeof ROUTE_REASONS)[number];

export interface RouteCandidate {
  providerId: string;
  priority: number;
  enabled: boolean;
  silent: boolean;
}

export interface Route {
  symbol: string;
  category: Category;
  leader: { providerId: string; instrument: CatalogInstrument } | null;
  reason: RouteReason;
  candidates: RouteCandidate[];
  hiddenByCollision: { providerId: string; category: Category }[];
}

export interface RoutingRuntime {
  silent: Set<string>;
  sticky: Map<string, string>;
}

export interface RoutingTable {
  routes: Map<string, Route>;
  byProvider: Map<string, CatalogInstrument[]>;
  failedOver: Map<string, string>;
}

function emptyRuntime(): RoutingRuntime {
  return { silent: new Set(), sticky: new Map() };
}

export function resolveRouting(
  instruments: CatalogInstrument[],
  registry: Registry,
  runtime: RoutingRuntime = emptyRuntime(),
): RoutingTable {
  const byId = new Map(registry.providers.map((p) => [p.id, p]));
  const rank = new Map(registry.categoryPrecedence.map((c, index) => [c, index]));

  const bySymbol = new Map<string, CatalogInstrument[]>();
  for (const instrument of instruments) {
    const list = bySymbol.get(instrument.symbol);
    if (list) list.push(instrument);
    else bySymbol.set(instrument.symbol, [instrument]);
  }

  const routes = new Map<string, Route>();
  const byProvider = new Map<string, CatalogInstrument[]>();
  const failedOver = new Map<string, string>();
  for (const provider of registry.providers) byProvider.set(provider.id, []);

  for (const [symbol, entries] of bySymbol) {
    const rankOf = (c: Category) => rank.get(c) ?? Number.MAX_SAFE_INTEGER;
    const bestRank = Math.min(...entries.map((e) => rankOf(e.category)));
    const winners = entries.filter((e) => rankOf(e.category) === bestRank);
    const hiddenByCollision = entries
      .filter((e) => rankOf(e.category) !== bestRank)
      .map((e) => ({ providerId: e.provider, category: e.category }));
    const category = winners[0]!.category;

    const candidateEntries = winners
      .map((instrument) => ({ instrument, provider: byId.get(instrument.provider) }))
      .filter((c): c is { instrument: CatalogInstrument; provider: ProviderEntry } =>
        c.provider !== undefined && c.provider.covers.includes(category),
      )
      .sort(
        (a, b) => a.provider.priority - b.provider.priority || a.provider.id.localeCompare(b.provider.id),
      );

    const candidates: RouteCandidate[] = candidateEntries.map((c) => ({
      providerId: c.provider.id,
      priority: c.provider.priority,
      enabled: c.provider.enabled,
      silent: runtime.silent.has(c.provider.id),
    }));

    if (candidateEntries.length === 0) {
      routes.set(symbol, {
        symbol,
        category,
        leader: null,
        reason: 'no-source',
        candidates,
        hiddenByCollision,
      });
      continue;
    }

    const enabled = candidateEntries.filter((c) => c.provider.enabled);
    if (enabled.length === 0) {
      routes.set(symbol, {
        symbol,
        category,
        leader: null,
        reason: 'source-disabled',
        candidates,
        hiddenByCollision,
      });
      continue;
    }

    const live = enabled.filter((c) => !runtime.silent.has(c.provider.id));
    const stickyId = runtime.sticky.get(symbol);
    const stickyPick = stickyId ? live.find((c) => c.provider.id === stickyId) : undefined;
    const chosen = stickyPick ?? live[0] ?? enabled[0]!;
    const primaryId = enabled[0]!.provider.id;

    const reason: RouteReason =
      live.length === 0 ? 'silent' : chosen.provider.id === primaryId ? 'primary' : 'failover';
    if (reason === 'failover') failedOver.set(symbol, chosen.provider.id);

    routes.set(symbol, {
      symbol,
      category,
      leader: { providerId: chosen.provider.id, instrument: chosen.instrument },
      reason,
      candidates,
      hiddenByCollision,
    });
    byProvider.get(chosen.provider.id)!.push(chosen.instrument);
  }

  return { routes, byProvider, failedOver };
}

export function diffRouting(
  previous: RoutingTable | null,
  next: RoutingTable,
): { invalidate: string[]; changed: { symbol: string; from: string | null; to: string | null }[] } {
  const changed: { symbol: string; from: string | null; to: string | null }[] = [];
  const invalidate: string[] = [];
  const symbols = new Set<string>([...(previous?.routes.keys() ?? []), ...next.routes.keys()]);
  for (const symbol of symbols) {
    const from = previous?.routes.get(symbol)?.leader?.providerId ?? null;
    const to = next.routes.get(symbol)?.leader?.providerId ?? null;
    if (from === to) continue;
    changed.push({ symbol, from, to });
    if (from !== null) invalidate.push(symbol);
  }
  return { invalidate, changed };
}

export interface LeaderIdentityChange {
  symbol: string;
  from: string;
  to: string;
}

export function leaderIdentityChanges(
  instruments: CatalogInstrument[],
  current: Registry,
  next: Registry,
): LeaderIdentityChange[] {
  const before = resolveRouting(instruments, current);
  const after = resolveRouting(instruments, next);
  const out: LeaderIdentityChange[] = [];
  for (const { symbol, from, to } of diffRouting(before, after).changed) {
    if (from !== null && to !== null) out.push({ symbol, from, to });
  }
  return out;
}

export interface SymbolInstrumentChange {
  symbol: string;
  from: string;
  to: string;
}

function nameMeans(instruments: CatalogInstrument[], registry: Registry): Map<string, string> {
  const table = resolveRouting(instruments, registry);
  const out = new Map<string, string>();
  for (const [symbol, route] of table.routes) {
    const winners = instruments
      .filter((i) => i.symbol === symbol && i.category === route.category)
      .map((i) => `${i.providerSymbol} (${i.category}, ${i.provider})`)
      .sort();
    out.set(symbol, winners.join(' + ') || `(${route.category})`);
  }
  return out;
}

export function symbolInstrumentChanges(
  instruments: CatalogInstrument[],
  current: Registry,
  next: Registry,
): SymbolInstrumentChange[] {
  const before = nameMeans(instruments, current);
  const after = nameMeans(instruments, next);
  const out: SymbolInstrumentChange[] = [];
  for (const [symbol, meant] of after) {
    const was = before.get(symbol);
    if (was === undefined) continue;
    if (was !== meant) out.push({ symbol, from: was, to: meant });
  }
  return out;
}

export interface RoutingSummary {
  unit: 'канонических символов каталога после разрешения коллизий';
  checked: number;
  routed: number;
  byReason: Record<RouteReason, number>;
  byProvider: { providerId: string; symbols: number }[];
  hiddenByCollision: number;
  multiCandidate: number;
}

export function summarizeRouting(table: RoutingTable): RoutingSummary {
  const byReason: Record<RouteReason, number> = {
    primary: 0,
    failover: 0,
    silent: 0,
    'source-disabled': 0,
    'no-source': 0,
  };
  let routed = 0;
  let hidden = 0;
  let multiCandidate = 0;
  for (const route of table.routes.values()) {
    byReason[route.reason] += 1;
    if (route.leader) routed += 1;
    hidden += route.hiddenByCollision.length;
    if (route.candidates.length > 1) multiCandidate += 1;
  }
  return {
    unit: 'канонических символов каталога после разрешения коллизий',
    checked: table.routes.size,
    routed,
    byReason,
    byProvider: [...table.byProvider].map(([providerId, list]) => ({ providerId, symbols: list.length })),
    hiddenByCollision: hidden,
    multiCandidate,
  };
}
