import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { io as ioClient, type Socket } from 'socket.io-client';
import { afterEach, describe, expect, it } from 'vitest';
import { config } from './config.js';
import { QuoteHub } from './hub.js';
import type { Quote } from './types.js';

const NOW = 1_800_000_000_000;

function quote(symbol: string, ageMs: number, price = 100): Quote {
  return {
    symbol,
    name: symbol,
    category: 'crypto',
    price,
    digits: 2,
    changePercent: 1.5,
    bid: price - 0.3,
    ask: price + 0.7,
    ts: NOW - ageMs,
    source: 'binance',
  };
}

const servers: HttpServer[] = [];
const sockets: Socket[] = [];

function makeHub(options?: { staleAfterMs?: number | null; now?: () => number }) {
  const server = createServer();
  servers.push(server);
  const hub = new QuoteHub(server, {
    now: () => NOW,
    ...options,
  });
  return { hub, server };
}

afterEach(() => {
  for (const s of sockets.splice(0)) s.close();
  for (const s of servers.splice(0)) s.close();
});

describe('QuoteHub · протухшая котировка не отдаётся вовсе (B-003)', () => {
  it('свежая отдаётся, протухшая исчезает из items и названа в staleSymbols', () => {
    const { hub } = makeHub({ staleAfterMs: 10_000 });
    hub.push(quote('BTCUSD', 1_000, 70_000));
    hub.push(quote('ETHUSD', 130_000, 2_000));

    const snap = hub.snapshot(['BTCUSD', 'ETHUSD']);
    expect(snap.items.map((q) => q.symbol)).toEqual(['BTCUSD']);
    expect(snap.staleSymbols).toEqual(['ETHUSD']);
    expect(snap.checked).toBe(2);
  });

  it('протухшая не подменяется ни нулём, ни старым значением — её нет', () => {
    const { hub } = makeHub({ staleAfterMs: 10_000 });
    hub.push(quote('ETHUSD', 130_000, 2_000));

    const snap = hub.snapshot(['ETHUSD']);
    expect(snap.items).toEqual([]);
    expect(snap.items.some((q) => q.symbol === 'ETHUSD')).toBe(false);
  });

  it('граница порога: возраст ровно порог — свежо, порог + 1 мс — протухло', () => {
    const { hub } = makeHub({ staleAfterMs: 10_000 });
    hub.push(quote('BTCUSD', 10_000));
    hub.push(quote('ETHUSD', 10_001));

    const snap = hub.snapshot(['BTCUSD', 'ETHUSD']);
    expect(snap.items.map((q) => q.symbol)).toEqual(['BTCUSD']);
    expect(snap.staleSymbols).toEqual(['ETHUSD']);
  });

  it('снапшот без списка символов фильтруется так же, как с ним', () => {
    const { hub } = makeHub({ staleAfterMs: 10_000 });
    hub.push(quote('BTCUSD', 1_000));
    hub.push(quote('ETHUSD', 130_000));

    const snap = hub.snapshot();
    expect(snap.items.map((q) => q.symbol)).toEqual(['BTCUSD']);
    expect(snap.staleSymbols).toEqual(['ETHUSD']);
  });
});

describe('QuoteHub · пустой список протухших ≠ «всё свежо»', () => {
  it('порога нет → котировок нет вовсе, staleSymbols === null (не считали)', () => {
    const { hub } = makeHub({ staleAfterMs: null });
    hub.push(quote('BTCUSD', 1_000));

    const snap = hub.snapshot(['BTCUSD']);
    expect(snap.items).toEqual([]);
    expect(snap.staleSymbols).toBeNull();
    expect(snap.checked).toBe(1);
  });

  it('порог есть, протухших нет → staleSymbols === [] (считали и не нашли)', () => {
    const { hub } = makeHub({ staleAfterMs: 10_000 });
    hub.push(quote('BTCUSD', 1_000));

    const snap = hub.snapshot(['BTCUSD']);
    expect(snap.staleSymbols).toEqual([]);
    expect(snap.staleSymbols).not.toBeNull();
    expect(snap.checked).toBe(1);
  });

  it('охват отличает «протухших нет» от «проверять было нечего»', () => {
    const { hub } = makeHub({ staleAfterMs: 10_000 });
    const snap = hub.snapshot(['BTCUSD']);
    expect(snap.staleSymbols).toEqual([]);
    expect(snap.checked).toBe(0);
  });
});

describe('QuoteHub · до первого тика провайдера', () => {
  it('отдаёт пустоту, а не зашитые базовые цены', () => {
    const { hub } = makeHub({ staleAfterMs: 10_000 });
    const snap = hub.snapshot();
    expect(snap.items).toEqual([]);
    expect(snap.checked).toBe(0);
    expect(hub.ages()).toEqual([]);
  });
});

describe('QuoteHub · восстановление состояния после рестарта', () => {
  it('новый хаб пуст и наполняется только от провайдера', () => {
    const first = makeHub({ staleAfterMs: 10_000 }).hub;
    first.push(quote('BTCUSD', 0, 70_000));
    expect(first.snapshot(['BTCUSD']).items).toHaveLength(1);

    const second = makeHub({ staleAfterMs: 10_000 }).hub;
    expect(second.snapshot(['BTCUSD']).items).toEqual([]);
    expect(second.snapshot().checked).toBe(0);

    second.push(quote('BTCUSD', 0, 71_000));
    expect(second.snapshot(['BTCUSD']).items[0]?.price).toBe(71_000);
  });
});

describe('QuoteHub · умолчание порога берётся из конфига, а не выдумывается', () => {
  it('без опций хаб наследует config.staleAfterMs (в тестах он не задан)', () => {
    expect(config.staleAfterMs).toBeNull();
    const server = createServer();
    servers.push(server);
    const hub = new QuoteHub(server);
    hub.push(quote('BTCUSD', 0));
    const snap = hub.snapshot(['BTCUSD']);
    expect(snap.items).toEqual([]);
    expect(snap.staleSymbols).toBeNull();
  });
});

function listen(server: HttpServer): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
  });
}

function connect(port: number): Promise<Socket> {
  const socket = ioClient(`http://127.0.0.1:${port}`, { transports: ['websocket'] });
  sockets.push(socket);
  return new Promise((resolve) => socket.on('connect', () => resolve(socket)));
}

function nextBatch(socket: Socket, ms: number): Promise<Quote[] | 'silence'> {
  return Promise.race<Quote[] | 'silence'>([
    new Promise((resolve) => socket.once('quotes:batch', (b: Quote[]) => resolve(b))),
    new Promise((resolve) => setTimeout(() => resolve('silence'), ms)),
  ]);
}

describe('QuoteHub · снапшот на subscribe (путь сайта)', () => {
  it('протухшего в снапшоте на subscribe нет — именно он рисовал старую цену', async () => {
    const { hub, server } = makeHub({ staleAfterMs: 10_000 });
    hub.push(quote('BTCUSD', 1_000, 70_000));
    hub.push(quote('ETHUSD', 130_000, 2_000));

    const socket = await connect(await listen(server));
    socket.emit('subscribe', ['BTCUSD', 'ETHUSD']);

    const batch = await nextBatch(socket, 2_000);
    expect(batch).not.toBe('silence');
    expect((batch as Quote[]).map((q) => q.symbol)).toEqual(['BTCUSD']);
  });

  it('весь снапшот протух → на subscribe уходит тишина, а не старые цены', async () => {
    const { hub, server } = makeHub({ staleAfterMs: 10_000 });
    hub.push(quote('BTCUSD', 130_000, 70_000));

    const socket = await connect(await listen(server));
    socket.emit('subscribe', ['BTCUSD']);

    expect(await nextBatch(socket, 1_500)).toBe('silence');
  });
});

describe('QuoteHub · живой батч', () => {
  it('свежий тик доходит до подписчика', async () => {
    const { hub, server } = makeHub({ staleAfterMs: 10_000 });
    const socket = await connect(await listen(server));
    socket.emit('subscribe', ['BTCUSD']);
    await new Promise((r) => setTimeout(r, 100));

    hub.push(quote('BTCUSD', 0, 70_000));
    const batch = await nextBatch(socket, 2_000);
    expect(batch).not.toBe('silence');
    expect((batch as Quote[])[0]?.price).toBe(70_000);
  });

  it('лучшие цены доезжают до сокета, а не теряются по дороге (MDS-12)', async () => {
    const { hub, server } = makeHub({ staleAfterMs: 10_000 });
    const socket = await connect(await listen(server));
    socket.emit('subscribe', ['BTCUSD']);
    await new Promise((r) => setTimeout(r, 100));

    hub.push(quote('BTCUSD', 0, 70_000));
    const batch = await nextBatch(socket, 2_000);
    expect(batch).not.toBe('silence');
    const got = (batch as Quote[])[0];
    expect(got?.bid).toBe(69_999.7);
    expect(got?.ask).toBe(70_000.7);
  });

  it('пустые лучшие цены доезжают ПУСТЫМИ, а не исчезают из тела', async () => {
    const { hub, server } = makeHub({ staleAfterMs: 10_000 });
    const socket = await connect(await listen(server));
    socket.emit('subscribe', ['XAUUSD']);
    await new Promise((r) => setTimeout(r, 100));

    hub.push({ ...quote('XAUUSD', 0, 2_400), bid: null, ask: null });
    const batch = await nextBatch(socket, 2_000);
    expect(batch).not.toBe('silence');
    const got = (batch as Quote[])[0] as Quote;
    expect(got.bid).toBeNull();
    expect(got.ask).toBeNull();
    expect('bid' in got).toBe(true);
    expect('ask' in got).toBe(true);
  });

  it('протухший тик не доходит: фильтр стоит и на пути батча', async () => {
    const { hub, server } = makeHub({ staleAfterMs: 10_000 });
    const socket = await connect(await listen(server));
    socket.emit('subscribe', ['BTCUSD']);
    await new Promise((r) => setTimeout(r, 100));

    hub.push(quote('BTCUSD', 130_000, 70_000));
    expect(await nextBatch(socket, 1_500)).toBe('silence');
  });
});
