import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.FAKE_V2_PORT ?? 18766);
const KEY = process.env.FAKE_V2_KEY ?? 'fake-v2-key';
const TICK_MS = Number(process.env.FAKE_V2_TICK_MS ?? 200);
const PING_MS = Number(process.env.FAKE_V2_PING_MS ?? 1000);

export const FAKE_V2_OPEN = { symbol: 'EURUSD', b: '1.10000', a: '1.10010', price: 1.10005, prevClose: '1.09000', changePercent: 0.92 };
export const FAKE_V2_CLOSED = { symbol: 'XAUUSD', b: '2650.10', a: '2650.50', price: 2650.3 };

const DAY = 86_400_000;
const closedAt = Date.now() - 2 * DAY;
const nextOpen = Date.now() + DAY;

const SESSION = {
  timezone: 'America/New_York',
  weekly: [{ open: 'sun 17:00', close: 'fri 17:00' }],
  holidays: [],
};

const instruments = [
  { symbol: 'EURUSD', name: 'Euro / US Dollar', category: 'forex', base: 'EUR', quote: 'USD', priceDecimals: 5, tickSize: '0.00001', qtyDecimals: 2, qtyStep: '0.01', minQty: '0.01', contractSize: '100000', hasDepth: false, hasTrades: false, has1s: false, session: SESSION, status: 'open' },
  { symbol: 'XAUUSD', name: 'Gold / US Dollar', category: 'metals', base: 'XAU', quote: 'USD', priceDecimals: 2, tickSize: '0.01', qtyDecimals: 2, qtyStep: '0.01', minQty: '0.01', contractSize: '100', hasDepth: false, hasTrades: false, has1s: false, session: SESSION, status: 'closed' },
];

const state = new Map([
  ['EURUSD', () => ({ s: 'EURUSD', b: FAKE_V2_OPEN.b, a: FAKE_V2_OPEN.a, t: Date.now(), status: 'open' })],
  ['XAUUSD', () => ({ s: 'XAUUSD', b: FAKE_V2_CLOSED.b, a: FAKE_V2_CLOSED.a, t: closedAt, status: 'closed', nextOpen })],
]);

const prefix = `/${KEY}`;
let streamed = 0;

const http = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://fake');
  const reply = (status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (!url.pathname.startsWith(`${prefix}/v2/`)) return reply(404, { error: 'not-found' });
  const path = url.pathname.slice(prefix.length);
  if (path === '/v2/health') return reply(200, { status: 'ok', provider: 'fake', streamed, maxStreams: 500 });
  if (path === '/v2/instruments') return reply(200, { instruments });
  if (path === '/v2/quotes') {
    const symbols = (url.searchParams.get('symbols') ?? '').split(',');
    return reply(200, { quotes: symbols.filter((s) => state.has(s)).map((s) => state.get(s)()) });
  }
  if (path === '/v2/candles') {
    const symbol = url.searchParams.get('symbol');
    if (symbol === 'EURUSD') {
      return reply(200, [
        [Date.now() - 2 * DAY, '1.08000', '1.09500', '1.07900', FAKE_V2_OPEN.prevClose, null],
        [Date.now() - DAY, FAKE_V2_OPEN.prevClose, '1.10100', '1.08900', '1.10005', null],
      ]);
    }
    return reply(200, []);
  }
  return reply(404, { error: 'not-found' });
});

const wss = new WebSocketServer({ noServer: true });
http.on('upgrade', (req, socket, head) => {
  if (req.url !== `${prefix}/v2/stream`) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws));
});

wss.on('connection', (socket) => {
  const subscribed = new Set();
  socket.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    for (const s of msg.symbols ?? []) {
      if (msg.op === 'subscribe') subscribed.add(s);
      if (msg.op === 'unsubscribe') subscribed.delete(s);
    }
    streamed = subscribed.size;
    socket.send(JSON.stringify({ type: 'ack', id: msg.id ?? null }));
  });
  const ticks = setInterval(() => {
    if (socket.readyState !== socket.OPEN) return;
    if (subscribed.has('EURUSD')) {
      socket.send(JSON.stringify({ type: 'quote', s: 'EURUSD', b: FAKE_V2_OPEN.b, a: FAKE_V2_OPEN.a, t: Date.now() }));
    }
  }, TICK_MS);
  const pings = setInterval(() => {
    if (socket.readyState !== socket.OPEN) return;
    socket.send(JSON.stringify({ type: 'ping', t: Date.now() }));
    if (subscribed.has('XAUUSD')) {
      socket.send(JSON.stringify({ type: 'status', s: 'XAUUSD', status: 'closed', reason: 'weekend', nextOpen, t: Date.now() }));
    }
  }, PING_MS);
  socket.on('close', () => {
    clearInterval(ticks);
    clearInterval(pings);
  });
});

http.listen(PORT, '127.0.0.1', () => {
  console.info(`[fake-module-v2] http://127.0.0.1:${PORT}/<ключ> (REST /v2/*, WS /v2/stream)`);
});
