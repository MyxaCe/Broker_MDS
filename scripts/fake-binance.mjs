import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.FAKE_BINANCE_PORT ?? 18765);
const TICK_MS = Number(process.env.FAKE_BINANCE_TICK_MS ?? 200);
const SILENT = process.env.FAKE_BINANCE_SILENT === '1';
const GARBAGE = process.env.FAKE_BINANCE_GARBAGE === '1';

const SYMBOLS = [
  { symbol: 'BTCUSDT', baseAsset: 'BTC', tickSize: '0.01000000' },
  { symbol: 'ETHUSDT', baseAsset: 'ETH', tickSize: '0.01000000' },
  { symbol: 'FAKEUSDT', baseAsset: 'FAKE', tickSize: '0.01000000' },
  { symbol: 'NOBOOKUSDT', baseAsset: 'NOBOOK', tickSize: '0.01000000' },
];

const SERIES = {
  BTCUSDT: [
    { c: '12345.67', P: '1.25', b: '12345.60', a: '12345.74' },
    { c: '12300.00', P: '-0.80', b: '12299.93', a: '12300.07' },
    { c: '12400.50', P: '0.40', b: '12400.43', a: '12400.57' },
    { c: '12280.25', P: '-1.33', b: '12280.18', a: '12280.32' },
  ],
  ETHUSDT: [
    { c: '2345.50', P: '-2.10', b: '2345.47', a: '2345.53' },
    { c: '2360.75', P: '0.65' },
    { c: '2330.25', P: '-1.00', b: '2330.22', a: '2330.28' },
    { c: '2375.00', P: '1.87', b: '2374.97', a: '2375.03' },
  ],
  FAKEUSDT: [{ c: '777.77', P: '0.11', b: '777.70', a: '777.84' }],
  NOBOOKUSDT: [
    { c: '555.11', P: '0.42' },
    { c: '554.80', P: '-0.31' },
  ],
};

export const FAKE_MARKER = {
  symbol: 'FAKEUSD',
  price: 777.77,
  changePercent: 0.11,
  bid: 777.7,
  ask: 777.84,
};

export const FAKE_NOBOOK_MARKER = { symbol: 'NOBOOKUSD' };

const exchangeInfo = {
  timezone: 'UTC',
  symbols: SYMBOLS.map((s) => ({
    symbol: s.symbol,
    baseAsset: s.baseAsset,
    quoteAsset: 'USDT',
    status: 'TRADING',
    isSpotTradingAllowed: true,
    filters: [{ filterType: 'PRICE_FILTER', tickSize: s.tickSize }],
  })),
};

const http = createServer((req, res) => {
  if ((req.url ?? '').startsWith('/api/v3/exchangeInfo')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(exchangeInfo));
    return;
  }
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'поддельный апстрим такой ручки не знает' }));
});

const wss = new WebSocketServer({ server: http, path: '/ws' });

wss.on('connection', (socket) => {
  const streams = new Set();
  let step = 0;

  socket.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (msg.method === 'SUBSCRIBE') for (const p of msg.params ?? []) streams.add(p);
    if (msg.method === 'UNSUBSCRIBE') for (const p of msg.params ?? []) streams.delete(p);
    socket.send(JSON.stringify({ result: null, id: msg.id ?? null }));
  });

  if (SILENT) {
    console.info('[fake-binance] режим тишины: соединение принято, кадров не будет');
    return;
  }

  const timer = setInterval(() => {
    if (socket.readyState !== socket.OPEN) return;
    if (GARBAGE) socket.send('это не json');
    for (const stream of streams) {
      const pair = stream.split('@')[0]?.toUpperCase();
      const series = SERIES[pair];
      if (!series) continue;
      const point = series[step % series.length];
      socket.send(
        JSON.stringify({
          e: '24hrTicker',
          E: Date.now(),
          s: pair,
          c: point.c,
          P: point.P,
          ...(point.b === undefined ? {} : { b: point.b }),
          ...(point.a === undefined ? {} : { a: point.a }),
        }),
      );
    }
    step += 1;
  }, TICK_MS);
  timer.unref?.();
  socket.on('close', () => clearInterval(timer));
});

http.listen(PORT, '127.0.0.1', () => {
  console.info(
    `[fake-binance] ПОДДЕЛЬНЫЙ апстрим на 127.0.0.1:${PORT} — ` +
      `exchangeInfo (${SYMBOLS.length} пар, среди них метка FAKEUSDT) и WS /ws. ` +
      'Цены фиксированные и рынком не являются.',
  );
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    wss.close();
    http.close(() => process.exit(0));
  });
}
