import { io } from 'socket.io-client';

const MDS = process.env.MDS_URL ?? 'http://localhost:3003';
const ADMIN_TOKEN = process.env.MDS_ADMIN_TOKEN ?? '';
const MODE = process.env.MDS_SMOKE_MODE ?? 'all';

if (!['contract', 'live', 'all'].includes(MODE)) {
  console.error(`MDS_SMOKE_MODE=${MODE} — знаю только contract, live, all`);
  process.exit(2);
}

const FAKE_MARKER = {
  symbol: 'FAKEUSD',
  price: 777.77,
  changePercent: 0.11,
  bid: 777.7,
  ask: 777.84,
};

const FAKE_NOBOOK_MARKER = { symbol: 'NOBOOKUSD' };

const RUNS = {
  contract: new Set(['contract', 'fake']),
  live: new Set(['live']),
  all: new Set(['contract', 'live']),
};
const active = RUNS[MODE];
const inScope = (tag) => active.has(tag);

let passed = 0;
let failed = 0;
const notExecuted = [];
const outOfScope = [];

const check = (tag, ok, label) => {
  if (!inScope(tag)) {
    outOfScope.push(label);
    return;
  }
  console.log(`${ok ? 'OK  ' : 'FAIL'}  ${label}`);
  if (ok) passed++;
  else failed++;
};

const unexecuted = (tag, label, why) => {
  if (!inScope(tag)) {
    outOfScope.push(label);
    return;
  }
  console.log(`SKIP  ${label} — ${why}: проверка НЕ ВЫПОЛНЕНА, результат неизвестен`);
  notExecuted.push(`${label} (${why})`);
};

let health;
for (let i = 0; i < 30; i++) {
  try {
    const res = await fetch(`${MDS}/health`);
    health = await res.json();
    if (health.providers?.some((p) => p.lastTickAt > 0)) break;
  } catch {}
  await new Promise((r) => setTimeout(r, 1000));
}

const binance = health?.providers?.find((p) => p.name === 'binance');

const catalogArrived = health?.catalog?.source === 'binance-exchange-info';
const everTicked = typeof binance?.lastTickAgeMs === 'number';
const sourceUnreachable = !catalogArrived && !everTicked;
const unreachableWhy =
  `служба не получила от источника ничего: каталог=${health?.catalog?.source ?? '(ответа нет)'}, ` +
  'тиков с запуска 0';

const checkLive = (ok, label) => {
  if (sourceUnreachable) unexecuted('live', label, unreachableWhy);
  else check('live', ok, label);
};

check(
  'contract',
  Array.isArray(health?.providers) &&
    typeof binance?.quoted === 'number' &&
    binance?.lastTickAgeMs !== undefined &&
    binance?.fresh !== undefined &&
    typeof health?.uptimeSec === 'number',
  `health: форма на месте (providers[], quoted/fresh/lastTickAgeMs у провайдера, uptimeSec=${health?.uptimeSec})`,
);

checkLive(
  (binance?.fresh ?? 0) > 0,
  `health: status=${health?.status}, binance свежих ${binance?.fresh}/${binance?.quoted}, ` +
    `возраст последнего тика ${binance?.lastTickAgeMs} мс`,
);

const reg = health?.registry;
check(
  'contract',
  ['file', 'builtin-default'].includes(reg?.origin) && reg?.routed > 0,
  `реестр: origin=${reg?.origin} v${reg?.version}, маршрутизировано ${reg?.routed} из ${reg?.checked} символов` +
    (reg?.origin === 'builtin-default' ? ' — ВСТРОЕННОЕ УМОЛЧАНИЕ, его никто не выбирал' : '') +
    (reg?.missingKeys?.length ? ` · без ключа: ${reg.missingKeys.join(',')}` : ''),
);

const inst = await (await fetch(`${MDS}/v1/instruments`)).json();
const provs = [...new Set(inst.items?.map((i) => i.provider) ?? [])];
check(
  'contract',
  inst.items?.length >= 3 &&
    typeof inst.catalogSource === 'string' &&
    typeof inst.isFallbackCatalog === 'boolean',
  `instruments: ${inst.items?.length} ведомых инструментов, источники=${provs.join('+')}, ` +
    `каталог=${inst.catalogSource}${inst.isFallbackCatalog ? ' (ЗАПАСНОЙ — число не равно живой вселенной)' : ''}`,
);

const plat = health?.platformInstruments;
check(
  'contract',
  ['cms', 'file', 'catalog-fallback'].includes(plat?.source) &&
    typeof plat?.applied === 'number' &&
    Array.isArray(plat?.notInCatalog) &&
    typeof plat?.cms?.configured === 'boolean' &&
    (plat.source === 'catalog-fallback'
      ? plat.ageMs === null && typeof health?.warning === 'string'
      : typeof plat.ageMs === 'number' && typeof plat.version === 'number'),
  `инструменты платформы: источник=${plat?.source} v${plat?.version}, в каталоге из списка ${plat?.applied}, ` +
    `возраст ${plat?.ageMs} мс` +
    (plat?.source === 'catalog-fallback' ? ' — ВЕСЬ КАТАЛОГ, предупреждение в /health' : ''),
);

const instAll = await (await fetch(`${MDS}/v1/instruments?all=1`)).json();
check(
  'contract',
  instAll.scope === 'catalog' &&
    inst.scope === 'platform' &&
    Array.isArray(instAll.items) &&
    instAll.items.length >= (inst.items?.length ?? Infinity) &&
    (inst.items ?? []).every((i) => instAll.items.some((a) => a.symbol === i.symbol)),
  `instruments?all=1: весь каталог ${instAll.items?.length} ⊇ платформа ${inst.items?.length}`,
);

const hookRes = await fetch(`${MDS}/v1/hooks/platform-instruments`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Signature': 'sha256=00' },
  body: '{}',
});
check(
  'contract',
  (hookRes.status === 401 || hookRes.status === 503) && hookRes.headers.get('access-control-allow-origin') === null,
  `вебхук инструментов платформы с чужой подписью: HTTP ${hookRes.status} (401 подпись / 503 выключен), без CORS`,
);

const snap = await (await fetch(`${MDS}/v1/quotes?symbols=BTCUSD,ETHUSD`)).json();
const btc = snap.items?.find((q) => q.symbol === 'BTCUSD');
checkLive(
  Boolean(btc && btc.price > 1000 && Number.isFinite(btc.changePercent) && btc.source),
  `REST снапшот: BTCUSD=${btc?.price} (${btc?.changePercent}%), источник=${btc?.source}`,
);

const fakeBody = await (await fetch(`${MDS}/v1/quotes?symbols=${FAKE_MARKER.symbol}`)).json();
const fakeQuote = fakeBody.items?.[0];
check(
  'fake',
  fakeQuote?.price === FAKE_MARKER.price && fakeQuote?.changePercent === FAKE_MARKER.changePercent,
  `апстрим ПОДДЕЛЬНЫЙ и опознан: ${FAKE_MARKER.symbol}=${fakeQuote?.price} ` +
    `(${fakeQuote?.changePercent}%) — у боевого Binance такого актива нет`,
);

check(
  'contract',
  fakeQuote?.bid === FAKE_MARKER.bid && fakeQuote?.ask === FAKE_MARKER.ask,
  `лучшие цены доехали из кадра в ответ: bid=${fakeQuote?.bid} ask=${fakeQuote?.ask}`,
);

const nbBody = await (await fetch(`${MDS}/v1/quotes?symbols=${FAKE_NOBOOK_MARKER.symbol}`)).json();
const nb = nbBody.items?.[0];
check(
  'contract',
  Boolean(nb) && nb.price > 0 && 'bid' in nb && 'ask' in nb && nb.bid === null && nb.ask === null,
  `цена без стакана — законный исход: ${FAKE_NOBOOK_MARKER.symbol}=${nb?.price}, ` +
    `bid=${JSON.stringify(nb?.bid)} ask=${JSON.stringify(nb?.ask)} (поля на месте, значения пусты)`,
);

const unknown = await (await fetch(`${MDS}/v1/quotes?symbols=NOSUCHSYM`)).json();
check(
  'contract',
  unknown.unavailable?.[0]?.reason === 'not-in-catalog',
  `причина недоступности названа: ${JSON.stringify(unknown.unavailable?.[0])}`,
);

const FAKE_V2_OPEN = { symbol: 'EURUSD', price: 1.10005, bid: 1.1, ask: 1.1001, changePercent: 0.92 };
const FAKE_V2_CLOSED = { symbol: 'XAUUSD', price: 2650.3 };

const v2Configured = health?.moduleV2?.catalog?.configured === true;
if (!v2Configured) {
  for (const label of [
    'модуль v2: каталог и поток в /health',
    'модуль v2: EURUSD — форекс модуля в каталоге MDS',
    'модуль v2: цена = (bid+ask)/2, изменение от вчерашнего закрытия',
    'модуль v2: закрытый рынок — последняя цена с флагом и причина market-closed',
  ]) {
    unexecuted('fake', label, 'MARKET_V2_API_URL не задан у проверяемого MDS');
  }
} else {
  let v2Quotes = null;
  for (let i = 0; i < 20; i++) {
    v2Quotes = await (await fetch(`${MDS}/v1/quotes?symbols=${FAKE_V2_OPEN.symbol},${FAKE_V2_CLOSED.symbol}`)).json();
    const open = v2Quotes.items?.find((q) => q.symbol === FAKE_V2_OPEN.symbol);
    if (open?.changePercent !== null && open !== undefined && v2Quotes.items?.some((q) => q.symbol === FAKE_V2_CLOSED.symbol)) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  const v2Health = (await (await fetch(`${MDS}/health`)).json()).moduleV2;
  const v2Source = v2Health?.sources?.modulev2;
  check(
    'fake',
    v2Health?.catalog?.instruments >= 2 &&
      typeof v2Health?.catalog?.ageMs === 'number' &&
      v2Source?.connected === true &&
      v2Source?.markets?.closed >= 1 &&
      typeof v2Source?.upstream?.maxStreams === 'number',
    `модуль v2: каталог и поток в /health (каталог ${v2Health?.catalog?.instruments}, ` +
      `поток ${v2Source?.connected ? 'подключён' : 'нет'}, закрытых рынков ${v2Source?.markets?.closed}, ` +
      `streamed ${v2Source?.upstream?.streamed}/${v2Source?.upstream?.maxStreams})`,
  );
  const eurRow = instAll.items?.find((i) => i.symbol === FAKE_V2_OPEN.symbol);
  check(
    'fake',
    eurRow?.category === 'forex' && eurRow?.provider === 'modulev2' && eurRow?.group === 'Валюта — Мажоры',
    `модуль v2: EURUSD — форекс модуля в каталоге MDS (${eurRow?.category}, ${eurRow?.provider}, «${eurRow?.group}»)`,
  );
  const openQ = v2Quotes?.items?.find((q) => q.symbol === FAKE_V2_OPEN.symbol);
  check(
    'fake',
    openQ?.price === FAKE_V2_OPEN.price &&
      openQ?.bid === FAKE_V2_OPEN.bid &&
      openQ?.ask === FAKE_V2_OPEN.ask &&
      openQ?.changePercent === FAKE_V2_OPEN.changePercent &&
      openQ?.source === 'modulev2' &&
      openQ?.market === undefined,
    `модуль v2: цена = (bid+ask)/2, изменение от вчерашнего закрытия: ${openQ?.price} ` +
      `(${openQ?.bid}/${openQ?.ask}, ${openQ?.changePercent}%), источник=${openQ?.source}`,
  );
  const closedQ = v2Quotes?.items?.find((q) => q.symbol === FAKE_V2_CLOSED.symbol);
  const closedWhy = v2Quotes?.unavailable?.find((u) => u.symbol === FAKE_V2_CLOSED.symbol);
  check(
    'fake',
    closedQ?.price === FAKE_V2_CLOSED.price &&
      closedQ?.market?.status === 'closed' &&
      Date.now() - closedQ.ts > (v2Quotes?.staleAfterMs ?? Infinity) &&
      closedWhy?.reason === 'market-closed' &&
      typeof closedWhy?.nextOpen === 'number',
    `модуль v2: закрытый рынок — последняя цена с флагом и причина market-closed: ` +
      `${FAKE_V2_CLOSED.symbol}=${closedQ?.price} market=${JSON.stringify(closedQ?.market)} ` +
      `unavailable=${JSON.stringify(closedWhy)}`,
  );
}

const noToken = await fetch(`${MDS}/v1/admin/providers`);
check(
  'contract',
  noToken.status === 401 || noToken.status === 503,
  `служебная ручка без секрета: HTTP ${noToken.status} (401 не пустили / 503 выключена)`,
);
check(
  'contract',
  noToken.headers.get('access-control-allow-origin') === null,
  'служебная ручка не отдаёт CORS-заголовок — из браузера не дотянуться',
);

if (ADMIN_TOKEN) {
  const withToken = await fetch(`${MDS}/v1/admin/providers`, {
    headers: { 'X-MDS-Admin-Token': ADMIN_TOKEN },
  });
  const body = withToken.ok ? await withToken.json() : null;
  check(
    'contract',
    withToken.status === 200 && Array.isArray(body?.registry?.providers),
    `служебная ручка с секретом: HTTP ${withToken.status}, источников ${body?.registry?.providers?.length}`,
  );
  check(
    'contract',
    !JSON.stringify(body ?? {}).includes(ADMIN_TOKEN),
    'ручка не отражает секрет в ответе',
  );
} else {
  unexecuted('contract', 'служебная ручка с секретом', 'MDS_ADMIN_TOKEN не задан');
  unexecuted('contract', 'ручка не отражает секрет в ответе', 'MDS_ADMIN_TOKEN не задан');
}

const socket = io(MDS, { transports: ['websocket'] });
const gotSnapshot = new Promise((resolve) => socket.once('quotes:batch', resolve));
await new Promise((resolve) => socket.on('connect', resolve));
socket.emit('subscribe', ['BTCUSD', 'ETHUSD']);
const snapshot = await Promise.race([gotSnapshot, new Promise((r) => setTimeout(() => r(null), 5000))]);
check(
  'contract',
  Array.isArray(snapshot) && snapshot.some((q) => q.symbol === 'BTCUSD'),
  `WS: снапшот на subscribe (${snapshot?.length} котировок)`,
);

if (inScope('live')) {
  if (sourceUnreachable) {
    unexecuted('live', 'WS: живой батч', unreachableWhy);
  } else {
    const liveBatch = await Promise.race([
      new Promise((resolve) => socket.once('quotes:batch', resolve)),
      new Promise((r) => setTimeout(() => r(null), 20000)),
    ]);
    checkLive(
      Array.isArray(liveBatch) && liveBatch.every((q) => ['BTCUSD', 'ETHUSD'].includes(q.symbol)),
      `WS: живой батч (${liveBatch?.map((q) => `${q.symbol}=${q.price}`).join(', ')})`,
    );
  }
} else {
  outOfScope.push('WS: живой батч');
}

socket.emit('unsubscribe', ['BTCUSD', 'ETHUSD']);
await new Promise((r) => setTimeout(r, 300));
const afterUnsub = await Promise.race([
  new Promise((resolve) => socket.once('quotes:batch', resolve)),
  new Promise((r) => setTimeout(() => r('silence'), 3000)),
]);
check('contract', afterUnsub === 'silence', 'WS: после unsubscribe — тишина');

socket.close();

console.log(`\n--- смоук, режим ${MODE} ---`);
if (sourceUnreachable && inScope('live')) {
  console.log(
    'ИСТОЧНИК НЕДОСТИЖИМ — живые проверки не выполнялись, их предмета нет. ' +
      'Это НЕ расхождение с биржей и НЕ успех: результат неизвестен. ' +
      `Признак: ${unreachableWhy}.`,
  );
}
if (notExecuted.length > 0) {
  console.log(`НЕ ВЫПОЛНЕНО ${notExecuted.length} — результат по ним НЕИЗВЕСТЕН:`);
  for (const label of notExecuted) console.log(` - ${label}`);
}
if (failed > 0) console.log(`РАСХОЖДЕНИЙ ${failed}`);
console.log(
  `Охват: проверок этого режима ${passed + failed + notExecuted.length} ` +
    `(прошло ${passed} · расхождений ${failed} · не выполнено ${notExecuted.length}); ` +
    `вынесено в соседний прогон ${outOfScope.length}`,
);
if (outOfScope.length > 0) {
  for (const label of outOfScope) console.log(` · не в этом режиме: ${label}`);
}

if (failed > 0) process.exit(1);
if (notExecuted.length > 0) process.exit(3);
console.log('ALL OK');
process.exit(0);
