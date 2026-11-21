import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { io as connectClient } from 'socket.io-client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer, type WebSocket as ServerSocket } from 'ws';
import { groupLabelFor } from './catalog.js';
import {
  catalogFromV2,
  maskUrl,
  ModuleV2Catalog,
  ModuleV2Provider,
  normalizeV2Quote,
  prevCloseFromCandles,
  streamUrlFor,
  type MarketStatusEvent,
} from './providers/modulev2.js';
import { builtinRegistry, type Registry } from './registry.js';
import { createMdsServer, type MdsServer, type RunningProvider } from './server.js';
import type { CatalogInstrument, Quote } from './types.js';

const KEY = 'sekretnyj-klyuch-0123456789';

interface V2Quote {
  b?: string;
  a?: string;
  t?: number;
  status: 'open' | 'closed' | 'halted';
  nextOpen?: number;
}

interface FakeV2 {
  api: string;
  instruments: Record<string, unknown>[];
  quotes: Map<string, V2Quote>;
  candles: Map<string, unknown[][]>;
  health: Record<string, unknown>;
  received: { op: string; symbols: string[]; id: number }[];
  connections: number;
  httpHits: string[];
  send(payload: unknown): void;
  dropAll(): void;
  close(): Promise<void>;
}

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
  vi.restoreAllMocks();
});

const SESSION = {
  timezone: 'America/New_York',
  weekly: [{ open: 'sun 17:00', close: 'fri 17:00' }],
  holidays: ['2026-12-25'],
};

function v2Instrument(
  symbol: string,
  category: string,
  priceDecimals: number,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    symbol,
    name: `${symbol} name`,
    category,
    priceDecimals,
    tickSize: (10 ** -priceDecimals).toFixed(priceDecimals),
    qtyDecimals: 2,
    qtyStep: '0.01',
    minQty: '0.01',
    contractSize: '100000',
    hasDepth: false,
    hasTrades: false,
    has1s: false,
    session: SESSION,
    status: 'open',
    ...extra,
  };
}

const V2_INSTRUMENTS = [
  v2Instrument('EURUSD', 'forex', 5, { base: 'EUR', quote: 'USD' }),
  v2Instrument('EURGBP', 'forex', 5, { base: 'EUR', quote: 'GBP' }),
  v2Instrument('USDTRY', 'forex', 4, { base: 'USD', quote: 'TRY' }),
  v2Instrument('XAUUSD', 'metals', 2),
  v2Instrument('UKOIL', 'energy', 2),
  v2Instrument('AAPL', 'stocks', 2, { exchange: 'NASDAQ' }),
  v2Instrument('ACME', 'stocks', 2),
];

async function fakeModuleV2(options: { ack?: boolean } = {}): Promise<FakeV2> {
  const sockets = new Set<ServerSocket>();
  const http: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://fake');
    fake.httpHits.push(url.pathname.replace(`/${KEY}`, '/{key}') + url.search);
    const reply = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (!url.pathname.startsWith(`/${KEY}/v2/`)) return reply(404, { error: 'not-found' });
    const path = url.pathname.slice(KEY.length + 1);
    if (path === '/v2/health') return reply(200, fake.health);
    if (path === '/v2/instruments') return reply(200, { instruments: fake.instruments });
    if (path === '/v2/quotes') {
      const symbols = (url.searchParams.get('symbols') ?? '').split(',').filter(Boolean);
      const quotes = symbols
        .filter((s) => fake.quotes.has(s))
        .map((s) => {
          const q = fake.quotes.get(s)!;
          return { s, ...(q.b ? { b: q.b } : {}), ...(q.a ? { a: q.a } : {}), ...(q.t ? { t: q.t } : {}), status: q.status, ...(q.nextOpen ? { nextOpen: q.nextOpen } : {}) };
        });
      return reply(200, { quotes });
    }
    if (path === '/v2/candles') {
      const symbol = url.searchParams.get('symbol') ?? '';
      return reply(200, fake.candles.get(symbol) ?? []);
    }
    return reply(404, { error: 'not-found' });
  });
  const wss = new WebSocketServer({ noServer: true });
  http.on('upgrade', (req, socket, head) => {
    if (req.url !== `/${KEY}/v2/stream`) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws));
  });
  wss.on('connection', (socket: ServerSocket) => {
    fake.connections += 1;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('message', (raw) => {
      const msg = JSON.parse(String(raw)) as { op: string; symbols: string[]; id: number };
      fake.received.push(msg);
      if (options.ack !== false) socket.send(JSON.stringify({ type: 'ack', id: msg.id }));
    });
  });
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  const port = (http.address() as AddressInfo).port;
  const fake: FakeV2 = {
    api: `http://127.0.0.1:${port}/${KEY}`,
    instruments: V2_INSTRUMENTS,
    quotes: new Map(),
    candles: new Map(),
    health: { status: 'ok', provider: 'twelvedata', streamed: 0, maxStreams: 500 },
    received: [],
    connections: 0,
    httpHits: [],
    send(payload) {
      for (const s of sockets) s.send(JSON.stringify(payload));
    },
    dropAll() {
      for (const s of sockets) s.terminate();
    },
    async close() {
      for (const s of sockets) s.terminate();
      await new Promise<void>((r) => wss.close(() => r()));
      await new Promise<void>((r) => http.close(() => r()));
    },
  };
  cleanups.push(() => fake.close());
  return fake;
}

async function until(predicate: () => boolean, timeoutMs = 4_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('условие не наступило');
    await new Promise((r) => setTimeout(r, 10));
  }
}

function subscribedNow(fake: FakeV2): Set<string> {
  const out = new Set<string>();
  for (const m of fake.received) {
    for (const s of m.symbols) {
      if (m.op === 'subscribe') out.add(s);
      else out.delete(s);
    }
  }
  return out;
}

function v2Catalog(): CatalogInstrument[] {
  return catalogFromV2({ instruments: V2_INSTRUMENTS }, 'modulev2').instruments;
}

function startProvider(
  fake: FakeV2,
  options: { silenceMs?: number; now?: () => number } = {},
): { provider: ModuleV2Provider; quotes: Quote[]; statuses: MarketStatusEvent[] } {
  const quotes: Quote[] = [];
  const statuses: MarketStatusEvent[] = [];
  const provider = new ModuleV2Provider((q) => quotes.push(q), (s) => statuses.push(s), {
    id: 'modulev2',
    apiUrl: fake.api,
    silenceMs: options.silenceMs ?? 60_000,
    changeRefreshMs: 3_600_000,
    healthPollMs: 3_600_000,
    reconnectBaseMs: 20,
    reconnectMaxMs: 50,
    ...(options.now ? { now: options.now } : {}),
  });
  cleanups.push(() => provider.stop());
  return { provider, quotes, statuses };
}

describe('modulev2 · каталог /v2/instruments', () => {
  it('строки каталога: точность, сессия, сегмент форекса по таблице мажоров, регион акций; крипто не берётся', () => {
    const { instruments, rejected } = catalogFromV2(
      {
        instruments: [
          ...V2_INSTRUMENTS,
          v2Instrument('BTCUSD', 'crypto', 2),
          { symbol: 'BAD', category: 'forex' },
          { symbol: 'lower', category: 'forex', priceDecimals: 5 },
        ],
      },
      'modulev2',
    );
    expect(instruments.map((i) => i.symbol)).toEqual(['EURUSD', 'EURGBP', 'USDTRY', 'XAUUSD', 'UKOIL', 'AAPL', 'ACME']);
    expect(rejected).toEqual(['BAD', 'lower']);
    const by = new Map(instruments.map((i) => [i.symbol, i]));
    expect(by.get('EURUSD')).toMatchObject({
      category: 'forex',
      segment: 'major',
      digits: 5,
      provider: 'modulev2',
      providerSymbol: 'EURUSD',
      tickSize: '0.00001',
      qtyDecimals: 2,
      session: SESSION,
    });
    expect(groupLabelFor(by.get('EURUSD')!)).toBe('Валюта — Мажоры');
    expect(groupLabelFor(by.get('EURGBP')!)).toBe('Валюта — Миноры');
    expect(groupLabelFor(by.get('USDTRY')!)).toBe('Валюта — Экзотика');
    expect(groupLabelFor(by.get('AAPL')!)).toBe('Акции — Америка');
    expect(groupLabelFor(by.get('ACME')!)).toBe('Акции');
    expect(groupLabelFor(by.get('XAUUSD')!)).toBe('Сырьё — металлы');
    expect(groupLabelFor(by.get('UKOIL')!)).toBe('Сырьё — энергетика');
  });

  it('каталог берётся с модуля; отказ не печатает ключ из пути и не стирает прежний каталог', async () => {
    const fake = await fakeModuleV2();
    const catalog = new ModuleV2Catalog({ apiUrl: fake.api, sourceId: 'modulev2' });
    expect(await catalog.refresh()).toEqual({ ok: true, changed: true });
    expect(catalog.instruments).toHaveLength(V2_INSTRUMENTS.length);
    expect(await catalog.refresh()).toEqual({ ok: true, changed: false });

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    fake.instruments = [];
    expect((await catalog.refresh()).ok).toBe(false);
    expect(catalog.instruments).toHaveLength(V2_INSTRUMENTS.length);
    const view = catalog.view();
    expect(view.byCategory).toEqual({ forex: 3, metals: 1, energy: 1, stocks: 2 });
    expect(view.lastError).not.toBeNull();
    const printed = JSON.stringify(view) + warn.mock.calls.flat().join(' ');
    expect(printed).not.toContain(KEY);
    expect(view.endpoint).toBe(maskUrl(fake.api));
    expect(maskUrl(fake.api)).not.toContain(KEY);
  });

  it('адрес потока выводится из адреса API, ключ в пути сохраняется', () => {
    expect(streamUrlFor('https://host.example/abc/')).toBe('wss://host.example/abc/v2/stream');
    expect(streamUrlFor('https://host.example/abc', 'wss://other/abc/v2/stream')).toBe('wss://other/abc/v2/stream');
    expect(streamUrlFor('http://127.0.0.1:1/k')).toBe('ws://127.0.0.1:1/k/v2/stream');
  });
});

describe('modulev2 · котировка', () => {
  const eurusd = v2Catalog().find((i) => i.symbol === 'EURUSD')!;

  it('price = (b+a)/2 с точностью priceDecimals, bid/ask как есть, ts = t', () => {
    const q = normalizeV2Quote({ s: 'EURUSD', b: '1.08410', a: '1.08416', t: 1795086260017 }, eurusd, 'modulev2', null);
    expect(q).toEqual({
      symbol: 'EURUSD',
      name: 'EURUSD name',
      category: 'forex',
      price: 1.08413,
      digits: 5,
      changePercent: null,
      bid: 1.0841,
      ask: 1.08416,
      ts: 1795086260017,
      source: 'modulev2',
    });
  });

  it('changePercent — от закрытия предыдущего дня, иначе null, а не ноль', () => {
    const q = normalizeV2Quote({ b: '1.08410', a: '1.08416', t: 1 }, eurusd, 'modulev2', 1.08);
    expect(q?.changePercent).toBe(0.38);
    expect(prevCloseFromCandles([[1, '1', '1', '1', '1.07500', '0'], [2, '1', '1', '1', '1.08', null]])).toBe(1.075);
    expect(prevCloseFromCandles([[2, '1', '1', '1', '1.08', null]])).toBeNull();
    expect(prevCloseFromCandles({ error: 'x' })).toBeNull();
  });

  it('без bid или ask, с перекрёстом, без момента — котировки нет', () => {
    expect(normalizeV2Quote({ b: '1.1', t: 1 }, eurusd, 'm', null)).toBeNull();
    expect(normalizeV2Quote({ b: '1.2', a: '1.1', t: 1 }, eurusd, 'm', null)).toBeNull();
    expect(normalizeV2Quote({ b: '1.1', a: '1.2' }, eurusd, 'm', null)).toBeNull();
    expect(normalizeV2Quote({ b: '0', a: '1.2', t: 1 }, eurusd, 'm', null)).toBeNull();
    expect(normalizeV2Quote({ b: '1e3', a: '1.2', t: 1 }, eurusd, 'm', null)).toBeNull();
  });
});

describe('modulev2 · поток /v2/stream', () => {
  it('подписка только на назначенное, смена — дельтой на том же соединении', async () => {
    const fake = await fakeModuleV2();
    const { provider } = startProvider(fake);
    const all = v2Catalog();
    provider.setInstruments(all.filter((i) => ['EURUSD', 'XAUUSD'].includes(i.symbol)));
    provider.connect();
    await until(() => fake.received.length >= 1);
    expect(fake.received[0]).toMatchObject({ op: 'subscribe', symbols: ['EURUSD', 'XAUUSD'] });

    provider.setInstruments(all.filter((i) => ['EURUSD', 'AAPL'].includes(i.symbol)));
    await until(() => fake.received.length >= 3);
    expect(fake.received.slice(1).map(({ op, symbols }) => ({ op, symbols }))).toEqual([
      { op: 'unsubscribe', symbols: ['XAUUSD'] },
      { op: 'subscribe', symbols: ['AAPL'] },
    ]);
    expect(new Set(fake.received.map((m) => m.id)).size).toBe(3);
    expect(fake.connections).toBe(1);
    expect(subscribedNow(fake)).toEqual(new Set(['EURUSD', 'AAPL']));
  });

  it('quote → котировка с mid; status closed → событие с nextOpen; символ вне назначенного игнорируется', async () => {
    const fake = await fakeModuleV2();
    const { provider, quotes, statuses } = startProvider(fake);
    provider.setInstruments(v2Catalog().filter((i) => i.symbol === 'EURUSD'));
    provider.connect();
    await until(() => fake.received.length >= 1);
    fake.send({ type: 'quote', s: 'XAUUSD', b: '2000.10', a: '2000.50', t: 5 });
    fake.send({ type: 'quote', s: 'EURUSD', b: '1.08410', a: '1.08416', t: 10 });
    fake.send({ type: 'status', s: 'EURUSD', status: 'closed', reason: 'weekend', nextOpen: 1795284000000, t: 11 });
    await until(() => statuses.length >= 1);
    expect(quotes.map((q) => [q.symbol, q.price, q.ts])).toEqual([['EURUSD', 1.08413, 10]]);
    expect(statuses[0]).toEqual({ symbol: 'EURUSD', status: 'closed', reason: 'weekend', nextOpen: 1795284000000, t: 11 });
    expect(provider.marketCounts()).toMatchObject({ closed: 1, open: 0 });

    fake.send({ type: 'quote', s: 'EURUSD', b: '1.08420', a: '1.08424', t: 20 });
    await until(() => statuses.length >= 2);
    expect(statuses[1]).toMatchObject({ symbol: 'EURUSD', status: 'open', nextOpen: null });
  });

  it('снимок /v2/quotes на подключении: закрытый рынок даёт статус и последнюю цену со старым t', async () => {
    const fake = await fakeModuleV2();
    fake.quotes.set('EURUSD', { b: '1.08410', a: '1.08416', t: 1000, status: 'closed', nextOpen: 999_999 });
    fake.candles.set('EURUSD', [[0, '1', '1', '1', '1.08000', '1'], [1, '1', '1', '1', '1.08413', '1']]);
    const { provider, quotes, statuses } = startProvider(fake);
    provider.setInstruments(v2Catalog().filter((i) => i.symbol === 'EURUSD'));
    provider.connect();
    await until(() => quotes.some((q) => q.changePercent !== null));
    expect(statuses[0]).toMatchObject({ symbol: 'EURUSD', status: 'closed', nextOpen: 999_999 });
    expect(quotes[0]).toMatchObject({ price: 1.08413, ts: 1000 });
    expect(quotes.at(-1)).toMatchObject({ price: 1.08413, ts: 1000, changePercent: 0.38 });
    expect(fake.httpHits.some((h) => h.startsWith('/{key}/v2/candles?symbol=EURUSD&interval=1d&limit=2'))).toBe(true);
  });

  it('ping и status продлевают жизнь: закрытый рынок без котировок не рвёт соединение', async () => {
    const fake = await fakeModuleV2();
    const { provider } = startProvider(fake, { silenceMs: 300 });
    provider.setInstruments(v2Catalog().filter((i) => i.symbol === 'EURUSD'));
    provider.connect();
    await until(() => fake.connections === 1 && fake.received.length >= 1);
    for (let i = 0; i < 10; i += 1) {
      fake.send(i % 2 ? { type: 'ping', t: i } : { type: 'status', s: 'EURUSD', status: 'closed', nextOpen: 5, t: i });
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(fake.connections).toBe(1);
    expect(provider.silenceReconnects).toBe(0);
  });

  it('ack и мусор жизнью не считаются: тишина → переподключение и повторная подписка на всё назначенное', async () => {
    const fake = await fakeModuleV2();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { provider } = startProvider(fake, { silenceMs: 200 });
    provider.setInstruments(v2Catalog().filter((i) => ['EURUSD', 'XAUUSD'].includes(i.symbol)));
    provider.connect();
    await until(() => fake.connections === 1);
    fake.send('мусор');
    await until(() => fake.connections >= 2, 3_000);
    await until(() => fake.received.filter((m) => m.op === 'subscribe').length >= 2);
    expect(provider.silenceReconnects).toBeGreaterThanOrEqual(1);
    expect(fake.received.filter((m) => m.op === 'subscribe').at(-1)?.symbols).toEqual(['EURUSD', 'XAUUSD']);
    expect(warn.mock.calls.flat().join(' ')).not.toContain(KEY);
  });

  it('обрыв со стороны модуля → переподключение с backoff и повторная подписка', async () => {
    const fake = await fakeModuleV2();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { provider } = startProvider(fake);
    provider.setInstruments(v2Catalog().filter((i) => i.symbol === 'AAPL'));
    provider.connect();
    await until(() => fake.received.length >= 1);
    fake.dropAll();
    await until(() => fake.connections >= 2 && fake.received.length >= 2);
    expect(fake.received[1]).toMatchObject({ op: 'subscribe', symbols: ['AAPL'] });
    expect(provider.reconnects).toBeGreaterThanOrEqual(1);
  });
});

const STALE = 60_000;

const CRYPTO_ROWS: CatalogInstrument[] = [
  { symbol: 'BTCUSD', name: 'Bitcoin', category: 'crypto', segment: null, digits: 2, provider: 'binance', providerSymbol: 'btcusdt' },
  { symbol: 'EURUSD', name: 'EUR', category: 'crypto', segment: null, digits: 4, provider: 'binance', providerSymbol: 'eurusdt' },
];
const TWELVE_ROWS: CatalogInstrument[] = [
  { symbol: 'XAUUSD', name: 'Золото', category: 'metals', segment: null, digits: 2, provider: 'twelvedata', providerSymbol: 'XAU/USD' },
];

interface V2Harness {
  server: MdsServer;
  base: string;
  fake: FakeV2;
  provider: () => ModuleV2Provider;
  binanceAssigned: () => string[];
  setClock(ms: number): void;
  clock(): number;
}

async function bootWithV2(options: { registry?: Registry; platform?: string[] } = {}): Promise<V2Harness> {
  const fake = await fakeModuleV2();
  let clock = 1_800_000_000_000;
  const now = () => clock;
  let provider: ModuleV2Provider | null = null;
  let binanceAssigned: string[] = [];
  const catalog = [...CRYPTO_ROWS, ...v2Catalog(), ...TWELVE_ROWS];
  const v2catalog = new ModuleV2Catalog({ apiUrl: fake.api, sourceId: 'modulev2', now });
  await v2catalog.refresh();
  const server = createMdsServer({
    catalog,
    catalogSource: 'binance-exchange-info',
    loaded: { origin: 'builtin-default', registry: options.registry ?? builtinRegistry(), path: join(tmpdir(), 'none.json') },
    staleAfterMs: STALE,
    adminToken: undefined,
    keys: new Map(),
    now,
    routingRecheckMs: 1_000_000,
    moduleV2Catalog: v2catalog,
    providerFactory: (entry, _key, onQuote, onStatus): RunningProvider | null => {
      if (entry.adapter === 'modulev2') {
        const p = new ModuleV2Provider(onQuote, onStatus, {
          id: entry.id,
          apiUrl: fake.api,
          silenceMs: 3_600_000,
          changeRefreshMs: 3_600_000,
          healthPollMs: 3_600_000,
          reconnectBaseMs: 20,
          now,
        });
        provider = p;
        p.connect();
        return {
          id: entry.id,
          adapter: entry.adapter,
          get lastTickAt() {
            return p.lastTickAt;
          },
          setInstruments: (l) => p.setInstruments(l),
          stop: () => p.stop(),
          details: () => p.details(),
        };
      }
      return {
        id: entry.id,
        adapter: entry.adapter,
        lastTickAt: clock,
        setInstruments: (l) => {
          if (entry.adapter === 'binance') binanceAssigned = l.map((i) => i.symbol);
        },
        stop: () => undefined,
      };
    },
    platform: {
      initial: options.platform
        ? {
            list: {
              version: 1,
              updatedAt: '2026-11-21T00:00:00Z',
              instruments: options.platform.map((symbol) => ({ symbol, mode: 'trade' as const })),
            },
            source: 'file',
            confirmedAt: clock,
          }
        : { list: null, source: 'catalog-fallback', confirmedAt: null },
      sync: null,
    },
  });
  await new Promise<void>((r) => server.httpServer.listen(0, '127.0.0.1', r));
  cleanups.push(() => server.close());
  return {
    server,
    base: `http://127.0.0.1:${(server.httpServer.address() as AddressInfo).port}`,
    fake,
    provider: () => provider!,
    binanceAssigned: () => binanceAssigned,
    setClock(ms) {
      clock = ms;
    },
    clock: () => clock,
  };
}

async function getJson(h: V2Harness, path: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${h.base}${path}`);
  return { status: res.status, body: await res.json() };
}

describe('modulev2 · маршрутизация и каталог MDS', () => {
  it('modulev2 ведёт форекс/металлы/акции/энергию выше twelvedata; EURUSD — форекс, крипто-пара скрыта коллизией', async () => {
    const h = await bootWithV2();
    const routes = h.server.routing()!.routes;
    expect(routes.get('EURUSD')).toMatchObject({ category: 'forex', reason: 'primary' });
    expect(routes.get('EURUSD')!.leader?.providerId).toBe('modulev2');
    expect(routes.get('EURUSD')!.hiddenByCollision).toEqual([{ providerId: 'binance', category: 'crypto' }]);
    expect(routes.get('XAUUSD')!.leader?.providerId).toBe('modulev2');
    expect(routes.get('XAUUSD')!.candidates.map((c) => c.providerId)).toEqual(['modulev2', 'twelvedata']);
    expect(routes.get('UKOIL')!.leader?.providerId).toBe('modulev2');
    expect(routes.get('BTCUSD')!.leader?.providerId).toBe('binance');
    expect(h.binanceAssigned()).toEqual(['BTCUSD']);
    await until(() => h.fake.received.length >= 1);
    expect(subscribedNow(h.fake)).toEqual(new Set(['EURUSD', 'EURGBP', 'USDTRY', 'XAUUSD', 'UKOIL', 'AAPL', 'ACME']));

    const all = (await getJson(h, '/v1/instruments?all=1')).body.items as Record<string, unknown>[];
    const eur = all.find((i) => i.symbol === 'EURUSD')!;
    expect(eur).toMatchObject({ category: 'forex', provider: 'modulev2', group: 'Валюта — Мажоры', digits: 5 });
    expect(eur.session).toEqual(SESSION);
    expect(all.find((i) => i.symbol === 'AAPL')).toMatchObject({ group: 'Акции — Америка' });
  });

  it('подписка у модуля — список платформы ∩ каталог ∩ категории источника', async () => {
    const h = await bootWithV2({ platform: ['BTCUSD', 'EURUSD', 'AAPL', 'NOSUCH'] });
    await until(() => h.fake.received.length >= 1);
    expect(subscribedNow(h.fake)).toEqual(new Set(['EURUSD', 'AAPL']));
    expect(h.binanceAssigned()).toEqual(['BTCUSD']);
  });

  it('modulev2 выключен в реестре → его символы ведёт следующий источник или никто', async () => {
    const reg = builtinRegistry();
    const h = await bootWithV2({
      registry: { ...reg, providers: reg.providers.map((p) => (p.adapter === 'modulev2' ? { ...p, enabled: false } : p)) },
    });
    const routes = h.server.routing()!.routes;
    expect(routes.get('EURUSD')!.reason).toBe('source-disabled');
    expect(routes.get('XAUUSD')!.reason).toBe('source-disabled');
    expect((await getJson(h, '/v1/quotes?symbols=EURUSD')).body.unavailable).toEqual([
      { symbol: 'EURUSD', reason: 'source-disabled' },
    ]);
  });

  it('обновление каталога v2 на ходу: новый символ подписывается дельтой', async () => {
    const h = await bootWithV2();
    await until(() => h.fake.received.length >= 1);
    const extra = catalogFromV2({ instruments: [v2Instrument('USDJPY', 'forex', 3)] }, 'modulev2').instruments;
    h.server.replaceCatalog([...CRYPTO_ROWS, ...v2Catalog(), ...extra, ...TWELVE_ROWS]);
    await until(() => subscribedNow(h.fake).has('USDJPY'));
    expect(h.fake.connections).toBe(1);
    expect(h.server.routing()!.routes.get('USDJPY')!.leader?.providerId).toBe('modulev2');
  });
});

describe('modulev2 · закрытый рынок', () => {
  it('status closed → цена остаётся и после порога свежести, с флагом; unavailable: market-closed с nextOpen', async () => {
    const h = await bootWithV2({ platform: ['EURUSD', 'XAUUSD'] });
    await until(() => h.fake.received.length >= 1);
    const t0 = h.clock();
    h.fake.send({ type: 'quote', s: 'EURUSD', b: '1.08410', a: '1.08416', t: t0 });
    await until(() => h.server.hub.has('EURUSD'));
    const open = await getJson(h, '/v1/quotes?symbols=EURUSD');
    expect(open.body.items[0]).toMatchObject({ symbol: 'EURUSD', price: 1.08413, bid: 1.0841, ask: 1.08416, source: 'modulev2' });
    expect(open.body.items[0].market).toBeUndefined();
    expect(open.body.unavailable).toEqual([]);

    const nextOpen = t0 + 2 * 86_400_000;
    h.fake.send({ type: 'status', s: 'EURUSD', status: 'closed', reason: 'weekend', nextOpen, t: t0 + 1 });
    await until(() => h.server.hub.markets().has('EURUSD'));

    h.setClock(t0 + 5 * STALE);
    h.fake.send({ type: 'ping', t: h.clock() });
    await until(() => h.provider().lastTickAt === h.clock());

    const closed = await getJson(h, '/v1/quotes?symbols=EURUSD,XAUUSD');
    expect(closed.body.items).toEqual([
      expect.objectContaining({
        symbol: 'EURUSD',
        price: 1.08413,
        ts: t0,
        market: { status: 'closed', reason: 'weekend', nextOpen },
      }),
    ]);
    expect(closed.body.staleSymbols).toEqual([]);
    expect(closed.body.unavailable).toEqual([
      { symbol: 'EURUSD', reason: 'market-closed', nextOpen },
      { symbol: 'XAUUSD', reason: 'source-silent' },
    ]);

    const client = connectClient(h.base, { transports: ['websocket'] });
    cleanups.push(() => void client.close());
    const batch = new Promise<Quote[]>((resolve) => client.once('quotes:batch', resolve));
    await new Promise<void>((resolve) => client.on('connect', () => resolve()));
    client.emit('subscribe', ['EURUSD']);
    const got = await batch;
    expect(got[0]).toMatchObject({ symbol: 'EURUSD', price: 1.08413, market: { status: 'closed', nextOpen } });
  });

  it('тишина модуля при закрытом рынке ≠ отказ: с ping источник жив, без сигналов — флаг истекает и цена честно stale', async () => {
    const h = await bootWithV2({ platform: ['EURUSD'] });
    await until(() => h.fake.received.length >= 1);
    const t0 = h.clock();
    h.fake.send({ type: 'quote', s: 'EURUSD', b: '1.08410', a: '1.08416', t: t0 });
    h.fake.send({ type: 'status', s: 'EURUSD', status: 'closed', nextOpen: t0 + 1e8, t: t0 });
    await until(() => h.server.hub.markets().has('EURUSD'));

    for (let step = 1; step <= 4; step += 1) {
      h.setClock(t0 + step * 30_000);
      h.fake.send({ type: 'ping', t: h.clock() });
      await until(() => h.provider().lastTickAt === h.clock());
    }
    expect(h.server.recheck()).toBeNull();
    const health = await getJson(h, '/health');
    expect(health.body.registry.providers.find((p: { id: string }) => p.id === 'modulev2')).toMatchObject({ silent: false });
    expect(h.server.routing()!.routes.get('EURUSD')!.reason).toBe('primary');
    expect((await getJson(h, '/v1/quotes?symbols=EURUSD')).body.unavailable[0].reason).toBe('market-closed');

    h.setClock(h.clock() + 2 * STALE);
    const dead = await getJson(h, '/v1/quotes?symbols=EURUSD');
    expect(dead.body.items).toEqual([]);
    expect(dead.body.unavailable).toEqual([{ symbol: 'EURUSD', reason: 'stale' }]);
    const after = await getJson(h, '/health');
    expect(after.body.registry.providers.find((p: { id: string }) => p.id === 'modulev2')).toMatchObject({ silent: true });
  });

  it('halted → market-halted; открытие рынка снимает флаг', async () => {
    const h = await bootWithV2({ platform: ['AAPL'] });
    await until(() => h.fake.received.length >= 1);
    const t0 = h.clock();
    h.fake.send({ type: 'quote', s: 'AAPL', b: '228.10', a: '228.14', t: t0 });
    h.fake.send({ type: 'status', s: 'AAPL', status: 'halted', reason: 'provider', t: t0 });
    await until(() => h.server.hub.markets().has('AAPL'));
    const halted = await getJson(h, '/v1/quotes?symbols=AAPL');
    expect(halted.body.unavailable).toEqual([{ symbol: 'AAPL', reason: 'market-halted', nextOpen: null }]);
    expect(halted.body.items[0]).toMatchObject({ price: 228.12, market: { status: 'halted', reason: 'provider', nextOpen: null } });

    h.fake.send({ type: 'quote', s: 'AAPL', b: '228.20', a: '228.24', t: t0 + 1 });
    await until(() => !h.server.hub.markets().has('AAPL'));
    const reopened = await getJson(h, '/v1/quotes?symbols=AAPL');
    expect(reopened.body.unavailable).toEqual([]);
    expect(reopened.body.items[0].market).toBeUndefined();
    expect(reopened.body.items[0].price).toBe(228.22);
  });

  it('статус от источника, который символ не ведёт, в хаб не проходит', async () => {
    const reg = builtinRegistry();
    const h = await bootWithV2({
      platform: ['XAUUSD'],
      registry: {
        ...reg,
        providers: reg.providers.map((p) =>
          p.adapter === 'twelvedata' ? { ...p, enabled: true, requiresKey: false, priority: 1 } : p,
        ),
      },
    });
    expect(h.server.routing()!.routes.get('XAUUSD')!.leader?.providerId).toBe('twelvedata');
    expect(h.fake.received).toEqual([]);
    h.provider().setInstruments(v2Catalog().filter((i) => i.symbol === 'XAUUSD'));
    await until(() => h.fake.received.length >= 1);
    h.fake.send({ type: 'status', s: 'XAUUSD', status: 'closed', nextOpen: 1, t: 1 });
    await until(() => h.provider().marketCounts().closed === 1);
    expect(h.server.hub.markets().size).toBe(0);
  });
});

describe('modulev2 · /health', () => {
  it('состояние модуля: каталог, поток, рынки, апстрим; ключа в ответе нет', async () => {
    const h = await bootWithV2({ platform: ['EURUSD', 'XAUUSD'] });
    h.fake.health = { status: 'ok', provider: 'twelvedata', streamed: 2, maxStreams: 500 };
    await until(() => h.fake.received.length >= 1);
    await h.provider().pollHealth();
    h.fake.send({ type: 'status', s: 'EURUSD', status: 'closed', nextOpen: h.clock() + 1000, t: 1 });
    h.fake.send({ type: 'status', s: 'XAUUSD', status: 'open', t: 1 });
    await until(() => h.provider().marketCounts().closed === 1 && h.provider().marketCounts().open === 1);
    const { body } = await getJson(h, '/health');
    expect(body.moduleV2.catalog).toMatchObject({ configured: true, instruments: 7, lastError: null });
    expect(body.moduleV2.catalog.ageMs).toBe(0);
    expect(body.moduleV2.enabledInRegistry).toEqual(['modulev2']);
    expect(body.moduleV2.sources.modulev2).toMatchObject({
      connected: true,
      assigned: 2,
      subscribed: 2,
      markets: { open: 1, closed: 1, halted: 0, unknown: 0 },
      upstream: { status: 'ok', provider: 'twelvedata', streamed: 2, maxStreams: 500 },
    });
    expect(JSON.stringify(body)).not.toContain(KEY);
  });
});
