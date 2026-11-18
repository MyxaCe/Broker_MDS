import type { SnapshotResult } from './hub.js';
import type { RouteReason } from './registry.js';
import type { RegistryOrigin } from './registry-store.js';

export interface ProviderView {
  name: string;
  lastTickAt: number;
}

export interface RegistryHealthInput {
  origin: RegistryOrigin;
  error?: string;
  version: number | null;
  providers: { id: string; enabled: boolean; silent: boolean }[];
  routed: number | null;
  checked: number | null;
  multiCandidate: number | null;
  missingKeys: string[];
}

export interface HealthInput {
  ages: { symbol: string; ageMs: number }[];
  providers: ProviderView[];
  providerOf: Map<string, string>;
  primaryProvider: string;
  staleAfterMs: number | null;
  catalog: { source: string; instruments: number };
  registry: RegistryHealthInput;
  clients: number;
  startedAt: number;
  now?: number;
}

export interface ProviderHealth {
  name: string;
  lastTickAt: number;
  lastTickAgeMs: number | null;
  quoted: number;
  fresh: number | null;
  stale: number | null;
  oldestQuoteAgeMs: number | null;
}

export interface HealthBody {
  status: 'ok' | 'degraded';
  reason?: string;
  warning?: string;
  quotes: { staleAfterMs: number | null; total: number; fresh: number | null };
  providers: ProviderHealth[];
  catalog: { source: string; instruments: number };
  registry: RegistryHealthInput;
  clients: number;
  uptimeSec: number;
  time: string;
}

export function buildHealth(input: HealthInput): { httpStatus: 200 | 503; body: HealthBody } {
  const now = input.now ?? Date.now();
  const { staleAfterMs } = input;

  const perProvider = new Map<string, { quoted: number; fresh: number; oldestMs: number | null }>();
  for (const { symbol, ageMs } of input.ages) {
    const provider = input.providerOf.get(symbol) ?? 'unknown';
    const acc = perProvider.get(provider) ?? { quoted: 0, fresh: 0, oldestMs: null };
    acc.quoted += 1;
    if (staleAfterMs !== null && ageMs <= staleAfterMs) acc.fresh += 1;
    acc.oldestMs = acc.oldestMs === null ? ageMs : Math.max(acc.oldestMs, ageMs);
    perProvider.set(provider, acc);
  }

  const providers: ProviderHealth[] = input.providers.map((p) => {
    const acc = perProvider.get(p.name) ?? { quoted: 0, fresh: 0, oldestMs: null };
    return {
      name: p.name,
      lastTickAt: p.lastTickAt,
      lastTickAgeMs: p.lastTickAt === 0 ? null : now - p.lastTickAt,
      quoted: acc.quoted,
      fresh: staleAfterMs === null ? null : acc.fresh,
      stale: staleAfterMs === null ? null : acc.quoted - acc.fresh,
      oldestQuoteAgeMs: acc.oldestMs,
    };
  });

  const primary = providers.find((p) => p.name === input.primaryProvider);
  const registry = input.registry;
  const enabledProviders = registry.providers.filter((p) => p.enabled);

  const reason =
    registry.origin === 'error'
      ? `реестр провайдеров не прочитан (${registry.error ?? 'причина не названа'}) — источники не запущены`
      : registry.providers.length === 0
        ? 'реестр провайдеров пуст — ни один источник не описан'
        : enabledProviders.length === 0
          ? 'в реестре провайдеров нет ни одного включённого источника'
          : registry.missingKeys.length > 0
            ? `включён источник без ключа: ${registry.missingKeys.join(', ')} — он не запущен`
            : registry.routed === null
              ? 'маршрутизация не построена — сколько символов назначено, неизвестно'
              : registry.routed === 0
            ? `ни один из ${registry.checked} символов каталога не назначен источнику`
            : staleAfterMs === null
              ? 'QUOTE_STALE_AFTER_MS не задан — свежесть не проверялась, котировки не отдаются'
              : !primary
                ? `провайдер ${input.primaryProvider} не подключён к сервису`
                : (primary.fresh ?? 0) === 0
                  ? `у ${primary.name} нет ни одной котировки свежее ${staleAfterMs} мс`
                  : null;

  const warning =
    registry.multiCandidate !== null && registry.multiCandidate > 0
      ? `у ${registry.multiCandidate} символов больше одного кандидата в источники: ` +
        'смена источника на живом символе возможна, а потребитель показывает её ' +
        'очередным тиком — скачком цены как движением рынка (Р-317)'
      : null;

  const body: HealthBody = {
    status: reason === null ? 'ok' : 'degraded',
    ...(reason === null ? {} : { reason }),
    ...(warning === null ? {} : { warning }),
    quotes: {
      staleAfterMs,
      total: input.ages.length,
      fresh: staleAfterMs === null ? null : providers.reduce((n, p) => n + (p.fresh ?? 0), 0),
    },
    providers,
    catalog: input.catalog,
    registry,
    clients: input.clients,
    uptimeSec: Math.round((now - input.startedAt) / 1000),
    time: new Date(now).toISOString(),
  };

  return { httpStatus: reason === null ? 200 : 503, body };
}

export const UNAVAILABLE_REASONS = [
  'threshold-unset',
  'stale',
  'source-silent',
  'source-disabled',
  'no-source',
  'not-in-catalog',
  'registry-unreadable',
] as const;

export type UnavailableReason = (typeof UNAVAILABLE_REASONS)[number];

export interface QuotesRouting {
  readable: boolean;
  reasons: Map<string, RouteReason>;
}

export interface QuotesBody extends SnapshotResult {
  staleAfterMs: number | null;
  unavailable: { symbol: string; reason: UnavailableReason }[];
  reason?: string;
}

function routeToUnavailable(reason: RouteReason | undefined): UnavailableReason {
  switch (reason) {
    case 'no-source':
      return 'no-source';
    case 'source-disabled':
      return 'source-disabled';
    case 'primary':
    case 'failover':
    case 'silent':
      return 'source-silent';
    default:
      return 'not-in-catalog';
  }
}

export function buildQuotes(
  snapshot: SnapshotResult,
  staleAfterMs: number | null,
  routing: QuotesRouting,
  requested: string[] | null,
): QuotesBody {
  const unavailable: { symbol: string; reason: UnavailableReason }[] = [];
  const fresh = new Set(snapshot.items.map((q) => q.symbol));

  if (!routing.readable) {
    for (const symbol of requested ?? [...routing.reasons.keys()]) {
      unavailable.push({ symbol, reason: 'registry-unreadable' });
    }
    return {
      items: [],
      staleAfterMs,
      staleSymbols: snapshot.staleSymbols,
      checked: snapshot.checked,
      missing: snapshot.missing,
      unavailable,
      reason: 'реестр провайдеров не прочитан — котировки не отдаются',
    };
  }

  const universe = requested ?? [...routing.reasons.keys()];
  for (const symbol of universe) {
    if (fresh.has(symbol)) continue;
    if (staleAfterMs === null) {
      unavailable.push({ symbol, reason: 'threshold-unset' });
      continue;
    }
    unavailable.push({
      symbol,
      reason: snapshot.staleSymbols?.includes(symbol)
        ? 'stale'
        : routeToUnavailable(routing.reasons.get(symbol)),
    });
  }

  return {
    items: snapshot.items,
    staleAfterMs,
    staleSymbols: snapshot.staleSymbols,
    checked: snapshot.checked,
    missing: snapshot.missing,
    unavailable,
    ...(staleAfterMs === null
      ? { reason: 'QUOTE_STALE_AFTER_MS не задан — свежесть не проверялась' }
      : {}),
  };
}
