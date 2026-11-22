import { mkdtempSync, readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ADMIN_CODES, applyRegistryUpdate } from './admin.js';
import { builtinRegistry, type ProviderEntry, type Registry } from './registry.js';
import { loadRegistry } from './registry-store.js';
import { createMdsServer, type MdsServer, type MdsServerDeps, type RunningProvider } from './server.js';
import type { CatalogInstrument, Quote } from './types.js';

const TOKEN = 'mds-admin-token-dostatochnoy-dliny';
const STALE_AFTER = 30_000;

function instrument(symbol: string, provider: string, category: Quote['category'] = 'crypto'): CatalogInstrument {
  return {
    symbol,
    name: symbol,
    category,
    segment: null,
    digits: 2,
    provider: provider as CatalogInstrument['provider'],
    providerSymbol: symbol.toLowerCase(),
  };
}

const CATALOG: CatalogInstrument[] = [
  instrument('BTCUSD', 'binance'),
  instrument('XAUUSD', 'twelvedata', 'metals'),
  instrument('XAUUSD', 'metals-alt', 'metals'),
];

function twoSourceRegistry(): Registry {
  const base = builtinRegistry();
  const alt: ProviderEntry = {
    id: 'metals-alt',
    adapter: 'twelvedata',
    label: 'Запасной источник металлов',
    enabled: true,
    priority: 30,
    covers: ['metals'],
    maxSilenceMs: 60_000,
    requiresKey: false,
  };
  return {
    ...base,
    providers: [
      base.providers[0]!,
      { ...base.providers[1]!, enabled: true, requiresKey: false, maxSilenceMs: 60_000 },
      alt,
    ],
  };
}

interface Harness {
  server: MdsServer;
  base: string;
  tick(providerId: string, symbol: string, price: number, ts?: number): void;
  tickWithoutBook(providerId: string, symbol: string, price: number): void;
  assigned(providerId: string): string[];
  setClock(ms: number): void;
  stopTicking(providerId: string): void;
}

const live: Harness[] = [];

afterEach(() => {
  for (const h of live.splice(0)) h.server.close();
});

async function boot(options: {
  registry?: Registry;
  registryPath?: string;
  origin?: 'file' | 'builtin-default' | 'error';
  error?: string;
  adminToken?: string | undefined;
  staleAfterMs?: number | null;
  keys?: Map<string, string>;
  catalogSource?: string;
  catalog?: CatalogInstrument[];
  allowRoutingIdentityChange?: boolean;
  platform?: MdsServerDeps['platform'];
}): Promise<Harness> {
  let clock = 1_800_000_000_000;
  const emitters = new Map<string, (q: Quote) => void>();
  const assignments = new Map<string, string[]>();
  const lastTick = new Map<string, number>();

  const path = options.registryPath ?? join(mkdtempSync(join(tmpdir(), 'mds-srv-')), 'providers.json');
  const registry = options.registry ?? twoSourceRegistry();
  const origin = options.origin ?? 'file';

  const server = createMdsServer({
    catalog: options.catalog ?? CATALOG,
    catalogSource: options.catalogSource ?? 'binance-exchange-info',
    loaded:
      origin === 'error'
        ? { origin: 'error', registry: null, error: options.error ?? 'JSON: сломан', path }
        : { origin, registry, path },
    staleAfterMs: options.staleAfterMs === undefined ? STALE_AFTER : options.staleAfterMs,
    adminToken: 'adminToken' in options ? options.adminToken : TOKEN,
    ...('allowRoutingIdentityChange' in options
      ? { allowRoutingIdentityChange: options.allowRoutingIdentityChange }
      : {}),
    keys: options.keys ?? new Map(),
    now: () => clock,
    routingRecheckMs: 1_000_000,
    platform: options.platform ?? {
      initial: { list: null, source: 'catalog-fallback', confirmedAt: null },
      sync: null,
    },
    providerFactory: (entry, _key, onQuote): RunningProvider | null => {
      emitters.set(entry.id, onQuote);
      lastTick.set(entry.id, clock);
      return {
        id: entry.id,
        adapter: entry.adapter,
        get lastTickAt() {
          return lastTick.get(entry.id) ?? 0;
        },
        setInstruments: (list) => assignments.set(entry.id, list.map((i) => i.symbol)),
        stop: () => {
          emitters.delete(entry.id);
          assignments.delete(entry.id);
        },
      };
    },
  });

  await new Promise<void>((resolve) => server.httpServer.listen(0, '127.0.0.1', resolve));
  const { port } = server.httpServer.address() as AddressInfo;

  const harness: Harness = {
    server,
    base: `http://127.0.0.1:${port}`,
    tick(providerId, symbol, price, ts) {
      const emit = emitters.get(providerId);
      if (!emit) throw new Error(`источник ${providerId} не запущен — тик подавать некому`);
      lastTick.set(providerId, clock);
      const entry = CATALOG.find((i) => i.symbol === symbol && i.provider === providerId)!;
      emit({
        symbol,
        name: entry.name,
        category: entry.category,
        price,
        digits: entry.digits,
        changePercent: 0,
        bid: price - 0.3,
        ask: price + 0.7,
        ts: ts ?? clock,
        source: providerId,
      });
    },
    tickWithoutBook(providerId, symbol, price) {
      const emit = emitters.get(providerId);
      if (!emit) throw new Error(`источник ${providerId} не запущен — тик подавать некому`);
      lastTick.set(providerId, clock);
      const entry = CATALOG.find((i) => i.symbol === symbol && i.provider === providerId)!;
      emit({
        symbol,
        name: entry.name,
        category: entry.category,
        price,
        digits: entry.digits,
        changePercent: 0,
        bid: null,
        ask: null,
        ts: clock,
        source: providerId,
      });
    },
    assigned: (providerId) => assignments.get(providerId) ?? [],
    setClock: (ms) => {
      clock = ms;
    },
    stopTicking: (providerId) => lastTick.set(providerId, 0),
  };
  live.push(harness);
  return harness;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Body = any;

async function asJson(res: Response): Promise<Body> {
  return res.json();
}

function admin(h: Harness, init: RequestInit & { token?: string | null } = {}) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const token = init.token === undefined ? TOKEN : init.token;
  if (token !== null) headers['X-MDS-Admin-Token'] = token;
  return fetch(`${h.base}/v1/admin/providers`, { ...init, headers });
}

describe('служебная ручка · кто имеет право её звать', () => {
  it('секрет не задан → 503 «ручка выключена», а НЕ открытая ручка', async () => {
    const h = await boot({ adminToken: undefined });
    const res = await admin(h, { token: null });
    expect(res.status).toBe(503);
    expect((await asJson(res)).error).toBe('control-plane-disabled');
  });

  it('секрет короткий → тоже 503: видимость защиты защитой не считается', async () => {
    const h = await boot({ adminToken: 'korotko' });
    expect((await admin(h, { token: 'korotko' })).status).toBe(503);
  });

  it('секрет не-ASCII → 503 «непередаваем в заголовке», а не вечный 401', async () => {
    const h = await boot({ adminToken: 'секрет-достаточной-длины-для-ручки' });
    const res = await fetch(`${h.base}/v1/admin/providers`);
    expect(res.status).toBe(503);
    expect((await asJson(res)).detail).toContain('ASCII');
  });

  it('«ручка выключена» и «вас не пустили» — разные коды, их чинят по-разному', async () => {
    const off = await boot({ adminToken: undefined });
    const on = await boot({});
    expect((await admin(off, { token: null })).status).toBe(503);
    expect((await admin(on, { token: null })).status).toBe(401);
  });

  it('нет заголовка → 401 no-token, чужой секрет → 401 bad-token', async () => {
    const h = await boot({});
    expect((await asJson(await admin(h, { token: null }))).error).toBe('no-token');
    expect((await asJson(await admin(h, { token: 'ne-tot-sekret-dlinoyu-podlinnee' }))).error).toBe(
      'bad-token',
    );
  });

  it('detail остался пояснением для человека, а не вторым машинным именем', async () => {
    const h = await boot({});
    const body = await asJson(await admin(h, { token: null }));
    expect(body.detail).toContain('x-mds-admin-token');
    expect((ADMIN_CODES as readonly string[]).includes(body.detail)).toBe(false);
  });

  it('из браузера не дотянуться: preflight отбит и CORS-заголовка на ручке нет', async () => {
    const h = await boot({});
    const options = await fetch(`${h.base}/v1/admin/providers`, { method: 'OPTIONS' });
    expect(options.status).toBe(405);
    const get = await admin(h);
    expect(get.headers.get('access-control-allow-origin')).toBeNull();
    const health = await fetch(`${h.base}/health`);
    expect(health.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('правильный секрет → реестр и перечень доступных адаптеров', async () => {
    const h = await boot({});
    const body = await asJson(await admin(h));
    expect(body.registry.providers).toHaveLength(3);
    expect(body.adapters).toEqual(['binance', 'twelvedata', 'modulev2']);
    expect(body.origin).toBe('file');
  });

  it('ключи наружу не отдаются — только факт наличия', async () => {
    const h = await boot({ keys: new Map([['twelvedata', 'очень-секретный-ключ']]) });
    const raw = await (await admin(h)).text();
    expect(raw).not.toContain('очень-секретный-ключ');
    expect(JSON.parse(raw).keys).toContainEqual({ providerId: 'twelvedata', required: false, present: true });
  });
});

describe('служебная ручка · приём изменения', () => {
  async function put(h: Harness, body: unknown, token?: string | null) {
    return admin(h, { method: 'PUT', body: JSON.stringify(body), ...(token === undefined ? {} : { token }) });
  }

  it('версия не совпала → 409, правка чужой версии не затирает текущую', async () => {
    const h = await boot({});
    const res = await put(h, { ...twoSourceRegistry(), version: 99 });
    expect(res.status).toBe(409);
    expect((await asJson(res)).error).toBe('version-conflict');
    expect(h.server.registry()?.version).toBe(0);
  });

  it('версии нет вовсе → 400: без неё правка затирает чужую молча', async () => {
    const h = await boot({});
    const { version: _drop, ...noVersion } = twoSourceRegistry();
    expect((await put(h, noVersion)).status).toBe(400);
  });

  it('незнакомое поле → 400, а не молча отброшенная настройка', async () => {
    const h = await boot({});
    const res = await put(h, { ...twoSourceRegistry(), опечатка: true });
    expect(res.status).toBe(400);
    expect((await asJson(res)).error).toBe('invalid-registry');
  });

  it('принятая правка поднимает версию и ложится на диск', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mds-persist-'));
    const path = join(dir, 'providers.json');
    const h = await boot({ registryPath: path });
    const next = twoSourceRegistry();
    next.providers = next.providers.map((p) => (p.id === 'binance' ? { ...p, enabled: false } : p));
    const res = await put(h, next);
    expect(res.status).toBe(200);
    const body = await asJson(res);
    expect(body.registry.version).toBe(1);
    expect(body.persisted).toBe(true);
    expect(JSON.parse(readFileSync(path, 'utf8')).version).toBe(1);
    expect(loadRegistry(path).registry?.providers.find((p) => p.id === 'binance')?.enabled).toBe(false);
  });

  it('изменение попадает в журнал с «с чего на что», отказ — тоже', async () => {
    const h = await boot({});
    const next = twoSourceRegistry();
    next.providers = next.providers.map((p) => (p.id === 'binance' ? { ...p, enabled: false } : p));
    await put(h, { ...next, updatedBy: 'админка CMS' });
    await put(h, { ...next, version: 77 });
    const entries = h.server.audit.list();
    expect(entries).toHaveLength(2);
    expect(entries[0]?.outcome).toBe('applied');
    expect(entries[0]?.actor).toBe('админка CMS');
    expect(entries[0]?.changes.join(' ')).toContain('binance: enabled true → false');
    expect(entries[1]?.outcome).toBe('rejected:version-conflict');
  });

  it('правка меняет личность ведущего → 409 routing-identity-change, реестр не тронут', async () => {
    const h = await boot({});
    const next = twoSourceRegistry();
    next.providers = next.providers.map((p) => (p.id === 'metals-alt' ? { ...p, priority: 5 } : p));
    const res = await put(h, next);
    expect(res.status).toBe(409);
    const body = await asJson(res);
    expect(body.error).toBe('routing-identity-change');
    expect(h.server.registry()?.version).toBe(0);
    expect(h.server.routing()?.routes.get('XAUUSD')?.leader?.providerId).toBe('twelvedata');
  });

  it('отказ называет символ и ОБЕ личности, а не только то, что «нельзя»', () => {
    const next = twoSourceRegistry();
    next.providers = next.providers.map((p) => (p.id === 'metals-alt' ? { ...p, priority: 5 } : p));
    const outcome = applyRegistryUpdate(
      twoSourceRegistry(),
      { ...next, version: 0 },
      { now: new Date(0), actor: 'тест' },
      { catalog: CATALOG, allowIdentityChange: false },
    );
    expect(outcome.ok).toBe(false);
    const detail = outcome.ok ? '' : outcome.detail;
    expect(detail).toContain('XAUUSD');
    expect(detail).toContain('twelvedata');
    expect(detail).toContain('metals-alt');
    expect(detail).toContain('ЖИВОМУ каталогу');
  });

  it('УМОЛЧАНИЕ — ЗАПРЕЩЕНО: поле не передано вовсе, запрет всё равно работает', async () => {
    const h = await boot({});
    expect('allowRoutingIdentityChange' in {}).toBe(false);
    const next = twoSourceRegistry();
    next.providers = next.providers.map((p) => (p.id === 'metals-alt' ? { ...p, priority: 5 } : p));
    const res = await put(h, next);
    expect(res.status).toBe(409);
    expect((await asJson(res)).error).toBe('routing-identity-change');
  });

  it('переключатель снят → та же правка проходит: запрет не вечный, а ожидание', async () => {
    const h = await boot({ allowRoutingIdentityChange: true });
    const next = twoSourceRegistry();
    next.providers = next.providers.map((p) => (p.id === 'metals-alt' ? { ...p, priority: 5 } : p));
    expect((await put(h, next)).status).toBe(200);
    expect(h.server.routing()?.routes.get('XAUUSD')?.leader?.providerId).toBe('metals-alt');
  });

  it('МОЛЧИТ НА ЗАКОННОМ: выключение источника — конец ряда, а не подмена', async () => {
    const h = await boot({});
    const next = twoSourceRegistry();
    next.providers = next.providers.map((p) => (p.id === 'binance' ? { ...p, enabled: false } : p));
    expect((await put(h, next)).status).toBe(200);
  });

  it('МОЛЧИТ НА ЗАКОННОМ: включение источника — новый ряд, а не подмена', async () => {
    const off = twoSourceRegistry();
    off.providers = off.providers.map((p) => (p.id === 'binance' ? { ...p, enabled: false } : p));
    const h = await boot({ registry: off });
    expect((await put(h, { ...twoSourceRegistry(), version: 0 })).status).toBe(200);
  });

  it('МОЛЧИТ НА ЗАКОННОМ: приоритет изменён, но победитель прежний', async () => {
    const h = await boot({});
    const next = twoSourceRegistry();
    next.providers = next.providers.map((p) => (p.id === 'metals-alt' ? { ...p, priority: 29 } : p));
    expect((await put(h, next)).status).toBe(200);
    expect(h.server.routing()?.routes.get('XAUUSD')?.leader?.providerId).toBe('twelvedata');
  });

  it('реестр не прочитан → правку не принимаем вслепую (503), а не пишем поверх', async () => {
    const h = await boot({ origin: 'error' });
    const res = await put(h, twoSourceRegistry());
    expect(res.status).toBe(503);
    expect((await asJson(res)).error).toBe('registry-unreadable');
  });
});

describe('лучшие цены на проводе · сквозь весь сервис (MDS-12)', () => {
  it('bid и ask доезжают до /v1/quotes, а не теряются между хабом и ручкой', async () => {
    const h = await boot({});
    h.tick('binance', 'BTCUSD', 70_000);
    const body = await asJson(await fetch(`${h.base}/v1/quotes?symbols=BTCUSD`));
    expect(body.items[0]?.bid).toBe(69_999.7);
    expect(body.items[0]?.ask).toBe(70_000.7);
  });

  it('пустые лучшие цены ПРИСУТСТВУЮТ в теле со значением null, а не исчезают', async () => {
    const h = await boot({});
    h.tickWithoutBook('twelvedata', 'XAUUSD', 2_400);
    const body = await asJson(await fetch(`${h.base}/v1/quotes?symbols=XAUUSD`));
    expect(body.items[0]?.price).toBe(2_400);
    expect(body.items[0]).toHaveProperty('bid', null);
    expect(body.items[0]).toHaveProperty('ask', null);
  });
});

describe('ручка · подмена инструмента под постоянным именем (Р-356)', () => {
  const COLLIDING: CatalogInstrument[] = [
    instrument('BTCUSD', 'binance'),
    instrument('EURUSD', 'binance', 'crypto'),
    instrument('EURUSD', 'twelvedata', 'forex'),
  ];

  const onlyBinance = (): Registry => {
    const r = builtinRegistry();
    return { ...r, providers: r.providers.map((p) => ({ ...p, requiresKey: false })) };
  };

  it('перестановка precedence отклонена кодом symbol-instrument-change', async () => {
    const h = await boot({ catalog: COLLIDING, registry: onlyBinance() });
    const before = await asJson(await fetch(`${h.base}/v1/quotes?symbols=EURUSD`));
    expect(before.unavailable).toEqual([{ symbol: 'EURUSD', reason: 'source-disabled' }]);

    const next = onlyBinance();
    next.categoryPrecedence = ['crypto', 'forex', 'metals', 'indices', 'stocks', 'energy'];
    const res = await admin(h, { method: 'PUT', body: JSON.stringify(next) });
    expect(res.status).toBe(409);
    const body = await asJson(res);
    expect(body.error).toBe('symbol-instrument-change');
    expect(body.detail).toContain('EURUSD');
    expect(body.detail).toContain('forex');
    expect(body.detail).toContain('crypto');

    const after = await asJson(await fetch(`${h.base}/v1/quotes?symbols=EURUSD`));
    expect(after.unavailable).toEqual([{ symbol: 'EURUSD', reason: 'source-disabled' }]);
    expect(h.server.registry()?.version).toBe(0);
  });

  it('переключатель снят → та же правка проходит: запрет ожидание, а не вечность', async () => {
    const h = await boot({
      catalog: COLLIDING,
      registry: onlyBinance(),
      allowRoutingIdentityChange: true,
    });
    const next = onlyBinance();
    next.categoryPrecedence = ['crypto', 'forex', 'metals', 'indices', 'stocks', 'energy'];
    expect((await admin(h, { method: 'PUT', body: JSON.stringify(next) })).status).toBe(200);
  });

  it('МОЛЧИТ НА ЗАКОННОМ: выключение источника при той же вселенной', async () => {
    const h = await boot({ catalog: COLLIDING, registry: onlyBinance() });
    const next = onlyBinance();
    next.providers = next.providers.map((p) => (p.id === 'binance' ? { ...p, enabled: false } : p));
    expect((await admin(h, { method: 'PUT', body: JSON.stringify(next) })).status).toBe(200);
  });
});

describe('переключение провайдера · что происходит с ценой под сделками', () => {
  it('источник выключили → его цена исчезает НЕМЕДЛЕННО, а не доживает до порога', async () => {
    const h = await boot({});
    h.tick('binance', 'BTCUSD', 70_000);
    const before = await asJson(await fetch(`${h.base}/v1/quotes?symbols=BTCUSD`));
    expect(before.items[0]?.price).toBe(70_000);
    expect(before.items[0]?.source).toBe('binance');

    const next = twoSourceRegistry();
    next.providers = next.providers.map((p) => (p.id === 'binance' ? { ...p, enabled: false } : p));
    const applied = await asJson(await admin(h, { method: 'PUT', body: JSON.stringify(next) }));
    expect(applied.applied.invalidated).toBe(1);

    const after = await asJson(await fetch(`${h.base}/v1/quotes?symbols=BTCUSD`));
    expect(after.items).toEqual([]);
    expect(after.unavailable).toEqual([{ symbol: 'BTCUSD', reason: 'source-disabled' }]);
  });

  it('смена ведущего источника стирает цену прежнего, а не продолжает ею ряд', async () => {
    const h = await boot({ allowRoutingIdentityChange: true });
    h.tick('twelvedata', 'XAUUSD', 2_400);
    expect((await asJson(await fetch(`${h.base}/v1/quotes?symbols=XAUUSD`))).items[0]?.source).toBe(
      'twelvedata',
    );

    const next = twoSourceRegistry();
    next.providers = next.providers.map((p) =>
      p.id === 'metals-alt' ? { ...p, priority: 5 } : p,
    );
    await admin(h, { method: 'PUT', body: JSON.stringify(next) });

    const after = await asJson(await fetch(`${h.base}/v1/quotes?symbols=XAUUSD`));
    expect(after.items).toEqual([]);
    expect(after.unavailable).toEqual([{ symbol: 'XAUUSD', reason: 'source-silent' }]);
    expect(h.assigned('metals-alt')).toEqual(['XAUUSD']);
    expect(h.assigned('twelvedata')).toEqual([]);
  });

  it('тик от источника, который символ не ведёт, в снапшот не проходит', async () => {
    const h = await boot({});
    h.tick('twelvedata', 'XAUUSD', 2_400);
    h.tick('metals-alt', 'XAUUSD', 2_999);
    const body = await asJson(await fetch(`${h.base}/v1/quotes?symbols=XAUUSD`));
    expect(body.items[0]?.price).toBe(2_400);
    expect(body.items[0]?.source).toBe('twelvedata');
    expect(h.server.shadowedTicks()).toBe(1);
  });

  it('поллер молчит часами и это НЕ failover: его молчание объявлено штатным', async () => {
    const reg = twoSourceRegistry();
    reg.providers = reg.providers.map((p) => (p.id === 'twelvedata' ? { ...p, maxSilenceMs: null } : p));
    const h = await boot({ registry: reg });
    h.tick('twelvedata', 'XAUUSD', 2_400);
    h.stopTicking('twelvedata');
    h.setClock(1_800_000_000_000 + 6 * 3_600_000);
    expect(h.server.recheck()).toBeNull();
    expect(h.server.routing()?.routes.get('XAUUSD')?.leader?.providerId).toBe('twelvedata');
  });

  it('выключенный источник остановлен, а не продолжает слать в пустоту', async () => {
    const h = await boot({});
    const next = twoSourceRegistry();
    next.providers = next.providers.map((p) => (p.id === 'binance' ? { ...p, enabled: false } : p));
    const res = await asJson(await admin(h, { method: 'PUT', body: JSON.stringify(next) }));
    expect(res.applied.stopped).toEqual(['binance']);
    expect(() => h.tick('binance', 'BTCUSD', 1)).toThrow(/не запущен/);
  });

  it('молчание ведущего дольше его порога → failover на запасного, цена прежнего забыта', async () => {
    const h = await boot({});
    h.tick('twelvedata', 'XAUUSD', 2_400);
    h.stopTicking('twelvedata');
    h.setClock(1_800_000_000_000 + 120_000);

    const effect = h.server.recheck();
    expect(effect?.changed).toEqual([{ symbol: 'XAUUSD', from: 'twelvedata', to: 'metals-alt' }]);
    expect(h.assigned('metals-alt')).toEqual(['XAUUSD']);
    const body = await asJson(await fetch(`${h.base}/v1/quotes?symbols=XAUUSD`));
    expect(body.items).toEqual([]);

    h.tick('metals-alt', 'XAUUSD', 2_412);
    const after = await asJson(await fetch(`${h.base}/v1/quotes?symbols=XAUUSD`));
    expect(after.items[0]).toMatchObject({ price: 2_412, source: 'metals-alt' });
  });
});

describe('состояния, которые нельзя путать, видны снаружи', () => {
  it('реестр не прочитан: /health 503, инструменты 503, котировки с причиной', async () => {
    const h = await boot({ origin: 'error', error: 'JSON: сломан на 3 строке' });
    const health = await fetch(`${h.base}/health`);
    expect(health.status).toBe(503);
    expect((await asJson(health)).reason).toContain('не прочитан');

    const instruments = await fetch(`${h.base}/v1/instruments`);
    expect(instruments.status).toBe(503);
    const body = await asJson(instruments);
    expect(body.items).toEqual([]);
    expect(body.error).toBe('registry-unreadable');

    const quotes = await asJson(await fetch(`${h.base}/v1/quotes?symbols=BTCUSD`));
    expect(quotes.unavailable).toEqual([{ symbol: 'BTCUSD', reason: 'registry-unreadable' }]);
  });

  it('реестр не прочитан: обе ручки говорят про охват ОДИНАКОВО (QA-05)', async () => {
    const h = await boot({ origin: 'error', error: 'JSON: сломан на 3 строке' });

    const health = await asJson(await fetch(`${h.base}/health`));
    const instruments = await asJson(await fetch(`${h.base}/v1/instruments`));

    expect(health.registry.routed).toBeNull();
    expect(health.registry.checked).toBeNull();
    expect(instruments.coverage).toBeNull();
    expect(health.registry.routed === null).toBe(instruments.coverage === null);
  });

  it('реестр прочитан: обе ручки дают НАСТОЯЩИЕ числа, а не null (QA-05)', async () => {
    const h = await boot({});
    const health = await asJson(await fetch(`${h.base}/health`));
    const instruments = await asJson(await fetch(`${h.base}/v1/instruments`));
    expect(typeof health.registry.checked).toBe('number');
    expect(health.registry.checked).toBeGreaterThan(0);
    expect(instruments.coverage?.checked).toBe(health.registry.checked);
    expect(instruments.coverage?.routed).toBe(health.registry.routed);
  });

  it('реестр не прочитан → источники не запущены вовсе', async () => {
    const h = await boot({ origin: 'error' });
    expect(() => h.tick('binance', 'BTCUSD', 1)).toThrow(/не запущен/);
  });

  it('пустой реестр отличим от нечитаемого: 200 с пустым списком и причиной', async () => {
    const h = await boot({ registry: { ...builtinRegistry(), providers: [] } });
    const instruments = await asJson(await fetch(`${h.base}/v1/instruments`));
    expect(instruments.items).toEqual([]);
    expect(instruments.coverage.checked).toBe(2);
    expect(instruments.coverage.routed).toBe(0);
    const health = await asJson(await fetch(`${h.base}/health`));
    expect(health.reason).toContain('пуст');
  });

  it('запасной каталог называет себя запасным в самом ответе, а не в соседнем', async () => {
    const h = await boot({ catalogSource: 'static-fallback' });
    const body = await asJson(await fetch(`${h.base}/v1/instruments`));
    expect(body.catalogSource).toBe('static-fallback');
    expect(body.isFallbackCatalog).toBe(true);
  });

  it('живой каталог себя запасным не называет', async () => {
    const h = await boot({});
    const body = await asJson(await fetch(`${h.base}/v1/instruments`));
    expect(body.isFallbackCatalog).toBe(false);
  });

  it('включённый источник без ключа не запускается и назван в /health отдельно', async () => {
    const reg = twoSourceRegistry();
    reg.providers = reg.providers.map((p) => (p.id === 'twelvedata' ? { ...p, requiresKey: true } : p));
    const h = await boot({ registry: reg, keys: new Map() });
    const health = await asJson(await fetch(`${h.base}/health`));
    expect(health.status).toBe('degraded');
    expect(health.reason).toContain('без ключа');
    expect(health.registry.missingKeys).toEqual(['twelvedata']);
    expect(h.assigned('metals-alt')).toEqual(['XAUUSD']);
  });

  it('встроенное умолчание называет себя умолчанием в /health и в ручке', async () => {
    const h = await boot({ origin: 'builtin-default', registry: builtinRegistry() });
    expect((await asJson(await fetch(`${h.base}/health`))).registry.origin).toBe('builtin-default');
    expect((await asJson(await admin(h))).origin).toBe('builtin-default');
  });

  it('/v1/instruments показывает фактического ведущего, а не строку каталога', async () => {
    const h = await boot({});
    const items: { symbol: string; provider: string }[] = (
      await asJson(await fetch(`${h.base}/v1/instruments`))
    ).items;
    expect(items.find((i) => i.symbol === 'XAUUSD')?.provider).toBe('twelvedata');
    expect(items).toHaveLength(2);
  });
});
