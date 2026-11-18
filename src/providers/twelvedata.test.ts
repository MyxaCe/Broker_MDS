import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  chunkSizeFor,
  normalizeTwelveQuote,
  pollIntervalMs,
  TwelveDataProvider,
  type TwelveDataConfig,
} from './twelvedata.js';
import { normalizeTick } from './binance.js';
import type { CatalogInstrument, Quote } from '../types.js';

function instrument(symbol: string, providerSymbol: string): CatalogInstrument {
  return {
    symbol,
    name: symbol,
    category: 'forex',
    segment: 'major',
    digits: 5,
    provider: 'twelvedata',
    providerSymbol,
  };
}

const EURUSD = instrument('EURUSD', 'EUR/USD');
const GBPUSD = instrument('GBPUSD', 'GBP/USD');
const BTCUSD: CatalogInstrument = {
  symbol: 'BTCUSD',
  name: 'Bitcoin',
  category: 'crypto',
  segment: null,
  digits: 0,
  provider: 'binance',
  providerSymbol: 'btcusdt',
};

const CFG: TwelveDataConfig = {
  id: 'twelvedata',
  apiKey: 'test-key',
  apiUrl: 'https://example.invalid',
  creditsPerMin: 8,
  creditsPerDay: 800,
};

const started: TwelveDataProvider[] = [];
afterEach(() => {
  for (const p of started.splice(0)) p.stop();
  vi.unstubAllGlobals();
});

function withResponses(...bodies: unknown[]) {
  const calls: string[] = [];
  let n = 0;
  vi.stubGlobal('fetch', async (url: string) => {
    calls.push(url);
    const body = bodies[Math.min(n, bodies.length - 1)];
    n += 1;
    return { ok: true, json: async () => body } as Response;
  });
  return calls;
}

function provider(cfg: Partial<TwelveDataConfig> = {}, instruments = [EURUSD, GBPUSD]) {
  const quotes: Quote[] = [];
  const p = new TwelveDataProvider((q) => quotes.push(q), { ...CFG, ...cfg });
  p.setInstruments(instruments);
  started.push(p);
  return { p, quotes };
}

describe('бюджет кредитов считается из тарифа, а не из того, что выдаёт код', () => {
  it('free-ключ: 800/день, резерв 10% → 720 кредитов, чанк 8 → 16 минут', () => {
    expect(chunkSizeFor({ creditsPerMin: 8 })).toBe(8);
    expect(pollIntervalMs({ creditsPerMin: 8, creditsPerDay: 800 })).toBe(960_000);
  });

  it('любой разумный порог свежести делает free-тариф протухшим по построению', () => {
    expect(pollIntervalMs({ creditsPerMin: 8, creditsPerDay: 800 })).toBeGreaterThan(60_000);
  });

  it('PRO-ключ ускоряет поллер сам, без правки кода', () => {
    const pro = pollIntervalMs({ creditsPerMin: 60, creditsPerDay: 100_000 });
    expect(pro).toBeLessThan(pollIntervalMs({ creditsPerMin: 8, creditsPerDay: 800 }));
    expect(pro).toBeGreaterThanOrEqual(60_000);
  });

  it('чанк не больше минутного лимита: одним запросом в него не упираемся', () => {
    expect(chunkSizeFor({ creditsPerMin: 1 })).toBe(1);
    expect(chunkSizeFor({ creditsPerMin: 0 })).toBe(1);
  });
});

describe('ответы провайдера', () => {
  it('нормальный батч доходит до потребителя с провенансом', async () => {
    withResponses({
      'EUR/USD': { close: '1.08543', percent_change: '-0.25', timestamp: 1784990000 },
      'GBP/USD': { close: '1.27', percent_change: '0.1', timestamp: 1784990000 },
    });
    const { p, quotes } = provider();
    await p.pollOnce();
    expect(quotes.map((q) => q.symbol)).toEqual(['EURUSD', 'GBPUSD']);
    expect(quotes[0]).toMatchObject({ price: 1.08543, source: 'twelvedata', ts: 1784990000000 });
  });

  it('символ, отвергнутый тарифом, уходит в чёрный список и исчезает из вселенной', async () => {
    withResponses({
      'EUR/USD': { close: '1.08', percent_change: '0', timestamp: 1784990000 },
      'GBP/USD': { code: 403, message: 'not in your plan' },
    });
    const { p, quotes } = provider();
    await p.pollOnce();
    expect(quotes.map((q) => q.symbol)).toEqual(['EURUSD']);
    expect(p.rejectedSymbols).toEqual(['GBPUSD']);
  });

  it('top-level 429 не двигает чанк и не выдумывает котировок', async () => {
    withResponses({ code: 429, message: 'limit' });
    const { p, quotes } = provider();
    await p.pollOnce();
    expect(quotes).toEqual([]);
    expect(p.status).toBe('reconnecting');
  });

  it('отказ сети не превращается в цену: котировок нет, статус назван', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('ECONNREFUSED');
    });
    const { p, quotes } = provider();
    await p.pollOnce();
    expect(quotes).toEqual([]);
    expect(p.status).toBe('reconnecting');
    expect(p.lastTickAt).toBe(0);
  });

  it('без ключа или без инструментов опрос не начинается вовсе', async () => {
    const calls = withResponses({});
    const { p } = provider({ apiKey: '' });
    p.connect();
    const { p: empty } = provider({}, []);
    empty.connect();
    expect(calls).toEqual([]);
  });
});

describe('normalizeTwelveQuote · успешный разбор ≠ пригодное значение', () => {
  it('строка "NaN" не становится ценой', () => {
    expect(normalizeTwelveQuote({ close: 'NaN' }, EURUSD, 'twelvedata')).toBeNull();
  });

  it('отсутствующая цена — отказ, а не ноль', () => {
    expect(normalizeTwelveQuote({}, EURUSD, 'twelvedata')).toBeNull();
  });

  it('отсутствующий percent_change — отказ, а не ноль (QA-05)', () => {
    expect(
      normalizeTwelveQuote({ close: '1.1', timestamp: 1784990000 }, EURUSD, 'twelvedata'),
    ).toBeNull();
  });

  it('соседний адаптер про ту же величину отвечает так же', () => {
    const bySymbol = new Map([[ 'btcusdt', BTCUSD ]]);
    expect(
      normalizeTick({ e: '24hrTicker', E: 1784990000000, s: 'BTCUSDT', c: '64034.52', P: 'нечисло' }, bySymbol, 'binance'),
    ).toBeNull();
    expect(
      normalizeTwelveQuote({ close: '1.1', percent_change: 'нечисло', timestamp: 1784990000 }, EURUSD, 'twelvedata'),
    ).toBeNull();
  });

  it('без timestamp — отказ: выдуманный момент не протухает никогда (QA-05)', () => {
    expect(normalizeTwelveQuote({ close: '1.1', percent_change: '0.5' }, EURUSD, 'twelvedata')).toBeNull();
    expect(
      normalizeTwelveQuote({ close: '1.1', percent_change: '0.5', timestamp: 0 }, EURUSD, 'twelvedata'),
    ).toBeNull();
  });

  it('пригодная запись проходит целиком и момент берётся от источника', () => {
    const quote = normalizeTwelveQuote(
      { close: '1.08543', percent_change: '-0.25', timestamp: 1784990000 },
      EURUSD,
      'twelvedata',
    );
    expect(quote?.price).toBe(1.08543);
    expect(quote?.changePercent).toBe(-0.25);
    expect(quote?.ts).toBe(1784990000000);
  });
});
