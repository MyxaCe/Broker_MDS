import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer, type WebSocket as ServerSocket } from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import { BinanceProvider } from './providers/binance.js';
import { builtinRegistry } from './registry.js';
import { createMdsServer, type MdsServer, type MdsServerDeps, type RunningProvider } from './server.js';
import { signBody, type PlatformList } from './platform.js';
import type { CatalogInstrument, Quote } from './types.js';

const SECRET = 'webhook-secret-for-tests';

function crypto(symbol: string): CatalogInstrument {
  return {
    symbol,
    name: symbol,
    category: 'crypto',
    segment: null,
    digits: 2,
    provider: 'binance',
    providerSymbol: `${symbol.slice(0, -3).toLowerCase()}usdt`,
  };
}

const CATALOG: CatalogInstrument[] = ['BTCUSD', 'ETHUSD', 'SOLUSD', 'LTCUSD', 'XRPUSD'].map(crypto);

function list(version: number, symbols: string[], closeOnly: string[] = []): PlatformList {
  return {
    version,
    updatedAt: '2026-11-21T10:00:00Z',
    instruments: symbols.map((symbol) => ({ symbol, mode: closeOnly.includes(symbol) ? 'closeOnly' : 'trade' })),
  };
}

interface FakeCms {
  apiUrl: string;
  set(status: number, body: unknown): void;
  hits: number;
}

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function fakeCms(initial: unknown): Promise<FakeCms> {
  let status = 200;
  let body = initial;
  const fake: FakeCms = {
    apiUrl: '',
    set(s, b) {
      status = s;
      body = b;
    },
    hits: 0,
  };
  const server: Server = createServer((req, res) => {
    fake.hits += 1;
    if (req.url !== '/v1/cms/platform/instruments' || req.headers['x-api-key'] !== 'cms-key') {
      res.writeHead(401).end('{}');
      return;
    }
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  cleanups.push(() => new Promise<void>((r) => server.close(() => r())));
  fake.apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  return fake;
}

interface Harness {
  server: MdsServer;
  base: string;
  assigned(): string[];
  tick(symbol: string, price: number): void;
  filePath: string;
}

async function boot(options: {
  initial?: MdsServerDeps['platform']['initial'];
  cms?: FakeCms | null;
  webhookSecret?: string;
  providerFactory?: MdsServerDeps['providerFactory'];
}): Promise<Harness> {
  let assigned: string[] = [];
  let emit: ((q: Quote) => void) | null = null;
  const filePath = join(mkdtempSync(join(tmpdir(), 'mds-plat-')), 'platform-instruments.json');
  const server = createMdsServer({
    catalog: CATALOG,
    catalogSource: 'binance-exchange-info',
    loaded: { origin: 'builtin-default', registry: builtinRegistry(), path: join(tmpdir(), 'none.json') },
    staleAfterMs: 60_000,
    adminToken: undefined,
    keys: new Map(),
    routingRecheckMs: 1_000_000,
    providerFactory:
      options.providerFactory ??
      ((entry, _key, onQuote): RunningProvider => {
        emit = onQuote;
        return {
          id: entry.id,
          adapter: entry.adapter,
          lastTickAt: Date.now(),
          setInstruments: (l) => {
            assigned = l.map((i) => i.symbol);
          },
          stop: () => undefined,
        };
      }),
    platform: {
      initial: options.initial ?? { list: null, source: 'catalog-fallback', confirmedAt: null },
      sync: {
        cms: options.cms ? { apiUrl: options.cms.apiUrl, apiKey: 'cms-key' } : null,
        filePath,
        pollMs: 1_000_000,
        webhookSecret: options.webhookSecret ?? SECRET,
      },
    },
  });
  await new Promise<void>((r) => server.httpServer.listen(0, '127.0.0.1', r));
  cleanups.push(() => server.close());
  return {
    server,
    base: `http://127.0.0.1:${(server.httpServer.address() as AddressInfo).port}`,
    assigned: () => assigned,
    tick(symbol, price) {
      emit?.({
        symbol,
        name: symbol,
        category: 'crypto',
        price,
        digits: 2,
        changePercent: 0,
        bid: null,
        ask: null,
        ts: Date.now(),
        source: 'binance',
      });
    },
    filePath,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function get(h: Harness, path: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${h.base}${path}`);
  return { status: res.status, body: await res.json() };
}

async function until(predicate: () => boolean, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('условие не наступило за отведённое время');
}

describe('инструменты платформы · подписка только на выбранное', () => {
  it('без списка (весь каталог) провайдеру назначен весь каталог, /health предупреждает', async () => {
    const h = await boot({});
    expect(h.assigned().sort()).toEqual(CATALOG.map((i) => i.symbol).sort());
    h.tick('BTCUSD', 1);
    const { status, body } = await get(h, '/health');
    expect(status).toBe(200);
    expect(body.platformInstruments.source).toBe('catalog-fallback');
    expect(body.platformInstruments.applied).toBe(CATALOG.length);
    expect(body.warning).toContain('весь каталог');
  });

  it('список из файла на старте → назначено только пересечение со списком, вне каталога пропущено', async () => {
    const h = await boot({
      initial: { list: list(3, ['ETHUSD', 'NOPEUSD', 'BTCUSD']), source: 'file', confirmedAt: Date.now() - 2_000 },
    });
    expect(h.assigned().sort()).toEqual(['BTCUSD', 'ETHUSD']);
    const { body } = await get(h, '/health');
    expect(body.platformInstruments).toMatchObject({
      source: 'file',
      version: 3,
      selected: 3,
      applied: 2,
      notInCatalog: ['NOPEUSD'],
    });
    expect(body.platformInstruments.ageMs).toBeGreaterThanOrEqual(2_000);
    expect(body.warning).toBeUndefined();
  });

  it('closeOnly для MDS — как trade: цены идут', async () => {
    const h = await boot({
      initial: { list: list(1, ['BTCUSD', 'LTCUSD'], ['LTCUSD']), source: 'file', confirmedAt: Date.now() },
    });
    expect(h.assigned().sort()).toEqual(['BTCUSD', 'LTCUSD']);
    expect((await get(h, '/health')).body.platformInstruments.closeOnly).toBe(1);
  });
});

describe('инструменты платформы · опрос CMS и применение по version', () => {
  it('рост version → применено, файл записан; та же version → ничего не меняется', async () => {
    const cms = await fakeCms(list(5, ['BTCUSD']));
    const h = await boot({ cms, initial: { list: list(4, ['ETHUSD']), source: 'file', confirmedAt: 0 } });
    expect(h.assigned()).toEqual(['ETHUSD']);

    const first = await h.server.pollPlatform();
    expect(first).toMatchObject({ outcome: 'applied', version: 5, persisted: true });
    expect(h.assigned()).toEqual(['BTCUSD']);
    expect(JSON.parse(readFileSync(h.filePath, 'utf8')).list.version).toBe(5);

    cms.set(200, list(5, ['SOLUSD']));
    expect(await h.server.pollPlatform()).toEqual({ outcome: 'unchanged', version: 5 });
    expect(h.assigned()).toEqual(['BTCUSD']);
  });

  it('версия ниже текущей не применяется', async () => {
    const cms = await fakeCms(list(2, ['SOLUSD']));
    const h = await boot({ cms, initial: { list: list(7, ['BTCUSD']), source: 'file', confirmedAt: 0 } });
    expect(await h.server.pollPlatform()).toEqual({ outcome: 'older', version: 2, current: 7 });
    expect(h.assigned()).toEqual(['BTCUSD']);
  });

  it('та же version из CMS переводит источник с file на cms и обновляет возраст', async () => {
    const cms = await fakeCms(list(4, ['ETHUSD']));
    const h = await boot({ cms, initial: { list: list(4, ['ETHUSD']), source: 'file', confirmedAt: 0 } });
    await h.server.pollPlatform();
    const { body } = await get(h, '/health');
    expect(body.platformInstruments.source).toBe('cms');
    expect(body.platformInstruments.ageMs).toBeLessThan(60_000);
  });

  it('CMS недоступна во время работы → текущий список остаётся, ошибка видна в /health', async () => {
    const cms = await fakeCms(list(4, ['ETHUSD']));
    const h = await boot({ cms, initial: { list: list(4, ['ETHUSD']), source: 'cms', confirmedAt: Date.now() } });
    cms.set(503, { error: 'down' });
    expect(await h.server.pollPlatform()).toEqual({ outcome: 'error', error: 'HTTP 503' });
    expect(h.assigned()).toEqual(['ETHUSD']);
    h.tick('ETHUSD', 1);
    const { status, body } = await get(h, '/health');
    expect(status).toBe(200);
    expect(body.platformInstruments).toMatchObject({ source: 'cms', version: 4 });
    expect(body.platformInstruments.cms).toMatchObject({ configured: true, lastError: 'HTTP 503', webhook: true });
  });

  it('из «весь каталог» первый же ответ CMS сужает подписку, снятые цены забываются', async () => {
    const cms = await fakeCms(list(1, ['BTCUSD', 'ETHUSD']));
    const h = await boot({ cms });
    h.tick('SOLUSD', 150);
    expect((await get(h, '/v1/quotes?symbols=SOLUSD')).body.items).toHaveLength(1);

    await h.server.pollPlatform();
    expect(h.assigned().sort()).toEqual(['BTCUSD', 'ETHUSD']);
    const quotes = await get(h, '/v1/quotes?symbols=SOLUSD');
    expect(quotes.body.items).toEqual([]);
    expect(quotes.body.unavailable).toEqual([{ symbol: 'SOLUSD', reason: 'no-source' }]);
    const health = await get(h, '/health');
    expect(health.body.warning).toBeUndefined();
  });
});

describe('инструменты платформы · вебхук', () => {
  async function hook(h: Harness, body: string, signature: string | null) {
    return fetch(`${h.base}/v1/hooks/platform-instruments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(signature === null ? {} : { 'X-Signature': signature }) },
      body,
    });
  }
  const body = JSON.stringify({ event_id: 'e-1', occurred_at: '2026-11-21T10:00:00Z', tags: ['cms:platform-instruments'] });

  it('верная подпись → 202 и немедленный опрос', async () => {
    const cms = await fakeCms(list(9, ['XRPUSD']));
    const h = await boot({ cms, initial: { list: list(1, ['BTCUSD']), source: 'cms', confirmedAt: Date.now() } });
    const res = await hook(h, body, signBody(body, SECRET));
    expect(res.status).toBe(202);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    await until(() => h.assigned().includes('XRPUSD'));
    expect(h.server.platform().list?.version).toBe(9);
  });

  it('неверная подпись или её нет → 401, опроса нет', async () => {
    const cms = await fakeCms(list(9, ['XRPUSD']));
    const h = await boot({ cms, initial: { list: list(1, ['BTCUSD']), source: 'cms', confirmedAt: Date.now() } });
    expect((await hook(h, body, signBody(body, 'чужой'))).status).toBe(401);
    expect((await hook(h, body, null)).status).toBe(401);
    expect((await hook(h, `${body} `, signBody(body, SECRET))).status).toBe(401);
    await new Promise((r) => setTimeout(r, 50));
    expect(cms.hits).toBe(0);
    expect(h.assigned()).toEqual(['BTCUSD']);
  });

  it('секрет не задан → 503 webhook-disabled; GET → 405', async () => {
    const cms = await fakeCms(list(9, ['XRPUSD']));
    const h = await boot({ cms, webhookSecret: '' });
    const res = await hook(h, body, signBody(body, ''));
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toBe('webhook-disabled');
    expect((await fetch(`${h.base}/v1/hooks/platform-instruments`)).status).toBe(405);
  });
});

describe('инструменты платформы · /v1/instruments', () => {
  it('без all — только то, по чему идут цены, в порядке списка; all=1 — весь каталог', async () => {
    const h = await boot({
      initial: { list: list(2, ['SOLUSD', 'BTCUSD', 'NOPEUSD'], ['BTCUSD']), source: 'cms', confirmedAt: Date.now() },
    });
    const scoped = await get(h, '/v1/instruments');
    expect(scoped.status).toBe(200);
    expect(scoped.body.items.map((i: { symbol: string }) => i.symbol)).toEqual(['SOLUSD', 'BTCUSD']);
    expect(scoped.body.items[0]).toMatchObject({ provider: 'binance', icon: expect.any(String), group: expect.any(String) });
    expect(scoped.body.scope).toBe('platform');
    expect(scoped.body.platformInstruments).toEqual({ source: 'cms', version: 2 });

    const all = await get(h, '/v1/instruments?all=1');
    expect(all.status).toBe(200);
    expect(all.body.scope).toBe('catalog');
    expect(all.body.items.map((i: { symbol: string }) => i.symbol).sort()).toEqual(CATALOG.map((i) => i.symbol).sort());
    const bySymbol = new Map(all.body.items.map((i: { symbol: string; platform: string | null }) => [i.symbol, i]));
    expect(bySymbol.get('BTCUSD')).toMatchObject({ provider: 'binance', platform: 'closeOnly' });
    expect(bySymbol.get('SOLUSD')).toMatchObject({ platform: 'trade' });
    expect(bySymbol.get('XRPUSD')).toMatchObject({ provider: 'binance', platform: null });
  });

  it('/v1/quotes без symbols — только вселенная платформы', async () => {
    const h = await boot({ initial: { list: list(2, ['BTCUSD']), source: 'cms', confirmedAt: Date.now() } });
    const { body } = await get(h, '/v1/quotes');
    expect(body.unavailable.map((u: { symbol: string }) => u.symbol)).toEqual(['BTCUSD']);
  });
});

describe('инструменты платформы · дельта подписки на живом сокете Binance', () => {
  it('смена списка → UNSUBSCRIBE/SUBSCRIBE на том же соединении, без переподключения', async () => {
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise<void>((r) => wss.once('listening', r));
    const received: { method: string; params: string[] }[] = [];
    let connections = 0;
    const sockets = new Set<ServerSocket>();
    wss.on('connection', (socket) => {
      connections += 1;
      sockets.add(socket);
      socket.on('message', (raw) => {
        const parsed = JSON.parse(String(raw)) as { method: string; params: string[]; id: number };
        received.push({ method: parsed.method, params: parsed.params });
        socket.send(JSON.stringify({ result: null, id: parsed.id }));
      });
    });
    cleanups.push(
      () =>
        new Promise<void>((r) => {
          for (const s of sockets) s.terminate();
          wss.close(() => r());
        }),
    );
    const wsUrl = `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`;

    const cms = await fakeCms(list(2, ['BTCUSD', 'SOLUSD']));
    const h = await boot({
      cms,
      initial: { list: list(1, ['BTCUSD', 'ETHUSD']), source: 'file', confirmedAt: 0 },
      providerFactory: (entry, _key, onQuote) => {
        const provider = new BinanceProvider(onQuote, { id: entry.id, wsUrl, silenceMs: 60_000 });
        provider.connect();
        return {
          id: entry.id,
          adapter: entry.adapter,
          get lastTickAt() {
            return provider.lastTickAt;
          },
          setInstruments: (l) => provider.setInstruments(l),
          stop: () => provider.stop(),
        };
      },
    });

    await until(() => received.length >= 1);
    expect(received[0]).toEqual({ method: 'SUBSCRIBE', params: ['btcusdt@ticker', 'ethusdt@ticker'] });

    await h.server.pollPlatform();
    await until(() => received.length >= 3);
    expect(received.slice(1)).toEqual([
      { method: 'UNSUBSCRIBE', params: ['ethusdt@ticker'] },
      { method: 'SUBSCRIBE', params: ['solusdt@ticker'] },
    ]);
    expect(connections).toBe(1);
  });
});
