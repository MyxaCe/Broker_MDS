import WebSocket from 'ws';
import type { CatalogInstrument, InstrumentSession, Quote, Segment } from '../types.js';

export type MarketStatus = 'open' | 'closed' | 'halted';

export interface MarketStatusEvent {
  symbol: string;
  status: MarketStatus;
  reason: string | null;
  nextOpen: number | null;
  t: number;
}

export const MODULE_V2_CATEGORIES = ['forex', 'metals', 'indices', 'stocks', 'energy'] as const;
type V2Category = (typeof MODULE_V2_CATEGORIES)[number];

const SUBSCRIBE_CHUNK = 100;
const SNAPSHOT_CHUNK = 50;
const CANDLE_CONCURRENCY = 4;
const CLOSED_REFRESH_MIN_MS = 5_000;

export function trimSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

export function streamUrlFor(apiUrl: string, wsUrl?: string): string {
  const base = trimSlash(wsUrl && wsUrl !== '' ? wsUrl : apiUrl.replace(/^http/i, 'ws'));
  return base.endsWith('/v2/stream') ? base : `${base}/v2/stream`;
}

export function maskUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}/***`;
  } catch {
    return '***';
  }
}

export function redact(text: string, urls: string[]): string {
  let out = text;
  for (const url of urls) {
    if (!url) continue;
    let path = '';
    try {
      path = new URL(url).pathname.replace(/\/+$/, '');
    } catch {
      continue;
    }
    if (path.length <= 1) continue;
    out = out.split(path).join('/***');
    const encoded = encodeURI(path);
    if (encoded !== path) out = out.split(encoded).join('/***');
  }
  return out;
}

function errorText(error: unknown, urls: string[]): string {
  const base = error instanceof Error ? error.message : String(error);
  const cause = error instanceof Error && error.cause instanceof Error ? `: ${error.cause.message}` : '';
  return redact(`${base}${cause}`, urls);
}

function decimal(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== 'string' || !/^-?\d+(\.\d+)?$/.test(raw)) return null;
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) ? value : null;
}

function positiveDecimal(raw: unknown): number | null {
  const value = decimal(raw);
  return value !== null && value > 0 ? value : null;
}

function epochMs(raw: unknown): number | null {
  return typeof raw === 'number' && Number.isInteger(raw) && raw > 0 ? raw : null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const FOREX_MAJORS = new Set(['EURUSD', 'GBPUSD', 'USDJPY', 'USDCHF', 'AUDUSD', 'USDCAD', 'NZDUSD']);
const MAJOR_CURRENCIES = new Set(['USD', 'EUR', 'GBP', 'JPY', 'CHF', 'AUD', 'CAD', 'NZD']);

export function forexSegment(symbol: string, base?: string, quote?: string): Segment {
  if (FOREX_MAJORS.has(symbol)) return 'major';
  const b = base ?? symbol.slice(0, 3);
  const q = quote ?? symbol.slice(3, 6);
  return MAJOR_CURRENCIES.has(b) && MAJOR_CURRENCIES.has(q) ? 'minor' : 'exotic';
}

const SEGMENTS: readonly Segment[] = ['europe', 'asia', 'america', 'rf', 'major', 'minor', 'exotic'];

const COUNTRY_REGION: Record<string, Segment> = {
  US: 'america',
  USA: 'america',
  CA: 'america',
  BR: 'america',
  MX: 'america',
  RU: 'rf',
  DE: 'europe',
  GB: 'europe',
  UK: 'europe',
  FR: 'europe',
  NL: 'europe',
  CH: 'europe',
  IT: 'europe',
  ES: 'europe',
  SE: 'europe',
  NO: 'europe',
  DK: 'europe',
  FI: 'europe',
  BE: 'europe',
  IE: 'europe',
  AT: 'europe',
  PT: 'europe',
  PL: 'europe',
  JP: 'asia',
  CN: 'asia',
  HK: 'asia',
  KR: 'asia',
  IN: 'asia',
  SG: 'asia',
  TW: 'asia',
};

const EXCHANGE_REGION: Record<string, Segment> = {
  NASDAQ: 'america',
  NYSE: 'america',
  AMEX: 'america',
  ARCA: 'america',
  BATS: 'america',
  CBOE: 'america',
  TSX: 'america',
  MOEX: 'rf',
  XETRA: 'europe',
  FWB: 'europe',
  LSE: 'europe',
  EURONEXT: 'europe',
  SIX: 'europe',
  BME: 'europe',
  MIL: 'europe',
  OMX: 'europe',
  TSE: 'asia',
  JPX: 'asia',
  HKEX: 'asia',
  SSE: 'asia',
  SZSE: 'asia',
  KRX: 'asia',
  NSE: 'asia',
  BSE: 'asia',
  SGX: 'asia',
};

export function regionSegment(raw: Record<string, unknown>): Segment | null {
  const declared = typeof raw.segment === 'string' ? raw.segment.toLowerCase() : null;
  if (declared && (SEGMENTS as readonly string[]).includes(declared)) return declared as Segment;
  const country = typeof raw.country === 'string' ? COUNTRY_REGION[raw.country.toUpperCase()] : undefined;
  if (country) return country;
  const exchange = typeof raw.exchange === 'string' ? EXCHANGE_REGION[raw.exchange.toUpperCase()] : undefined;
  return exchange ?? null;
}

function parseSession(raw: unknown): InstrumentSession | null {
  if (!isObject(raw) || typeof raw.timezone !== 'string' || !Array.isArray(raw.weekly)) return null;
  const weekly = raw.weekly
    .filter(isObject)
    .filter((w) => typeof w.open === 'string' && typeof w.close === 'string')
    .map((w) => ({ open: w.open as string, close: w.close as string }));
  const holidays = Array.isArray(raw.holidays)
    ? raw.holidays.filter((h): h is string => typeof h === 'string')
    : [];
  return { timezone: raw.timezone, weekly, holidays };
}

const SYMBOL_RE = /^[A-Z0-9][A-Z0-9._-]{0,19}$/;

export function catalogFromV2(
  body: unknown,
  sourceId: string,
): { instruments: CatalogInstrument[]; rejected: string[] } {
  const list = isObject(body) && Array.isArray(body.instruments) ? body.instruments : Array.isArray(body) ? body : null;
  if (!list) return { instruments: [], rejected: ['(ответ без instruments[])'] };
  const instruments: CatalogInstrument[] = [];
  const rejected: string[] = [];
  const seen = new Set<string>();
  for (const raw of list) {
    if (!isObject(raw) || typeof raw.symbol !== 'string' || !SYMBOL_RE.test(raw.symbol)) {
      rejected.push(isObject(raw) ? String(raw.symbol) : String(raw));
      continue;
    }
    const symbol = raw.symbol;
    const category = raw.category;
    if (typeof category !== 'string' || !(MODULE_V2_CATEGORIES as readonly string[]).includes(category)) {
      if (category !== 'crypto') rejected.push(symbol);
      continue;
    }
    const digits = raw.priceDecimals;
    if (typeof digits !== 'number' || !Number.isInteger(digits) || digits < 0 || digits > 10) {
      rejected.push(symbol);
      continue;
    }
    if (seen.has(symbol)) {
      rejected.push(symbol);
      continue;
    }
    seen.add(symbol);
    const cat = category as V2Category;
    const base = typeof raw.base === 'string' ? raw.base : undefined;
    const quote = typeof raw.quote === 'string' ? raw.quote : undefined;
    const segment: Segment | null =
      cat === 'forex' ? forexSegment(symbol, base, quote) : cat === 'stocks' || cat === 'indices' ? regionSegment(raw) : null;
    const instrument: CatalogInstrument = {
      symbol,
      name: typeof raw.name === 'string' && raw.name.trim() !== '' ? raw.name : symbol,
      category: cat,
      segment,
      digits,
      provider: sourceId,
      providerSymbol: symbol,
    };
    if (typeof raw.tickSize === 'string') instrument.tickSize = raw.tickSize;
    if (typeof raw.qtyDecimals === 'number' && Number.isInteger(raw.qtyDecimals)) instrument.qtyDecimals = raw.qtyDecimals;
    if (typeof raw.qtyStep === 'string') instrument.qtyStep = raw.qtyStep;
    if (typeof raw.minQty === 'string') instrument.minQty = raw.minQty;
    if (typeof raw.contractSize === 'string') instrument.contractSize = raw.contractSize;
    const session = parseSession(raw.session);
    if (session) instrument.session = session;
    instruments.push(instrument);
  }
  return { instruments, rejected };
}

type FetchLike = typeof fetch;

async function getJson(url: string, fetchImpl: FetchLike, timeoutMs = 15_000): Promise<unknown> {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export interface ModuleV2CatalogView {
  configured: boolean;
  endpoint: string | null;
  instruments: number;
  byCategory: Record<string, number>;
  rejected: number;
  fetchedAt: string | null;
  ageMs: number | null;
  lastAttemptAt: string | null;
  lastError: string | null;
}

export class ModuleV2Catalog {
  instruments: CatalogInstrument[] = [];
  fetchedAt: number | null = null;
  lastAttemptAt: number | null = null;
  lastError: string | null = null;
  rejected = 0;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;

  constructor(
    private readonly options: { apiUrl: string; sourceId: string; fetchImpl?: FetchLike; now?: () => number },
  ) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
  }

  get configured(): boolean {
    return this.options.apiUrl !== '';
  }

  async refresh(): Promise<{ ok: boolean; changed: boolean }> {
    if (!this.configured) return { ok: false, changed: false };
    this.lastAttemptAt = this.now();
    try {
      const body = await getJson(`${trimSlash(this.options.apiUrl)}/v2/instruments`, this.fetchImpl);
      const { instruments, rejected } = catalogFromV2(body, this.options.sourceId);
      if (instruments.length === 0) throw new Error('каталог v2 пуст или не по формату');
      const changed = JSON.stringify(instruments) !== JSON.stringify(this.instruments);
      this.instruments = instruments;
      this.rejected = rejected.length;
      this.fetchedAt = this.now();
      if (this.lastError !== null) console.info(`[${this.options.sourceId}] каталог v2 снова доступен`);
      this.lastError = null;
      if (rejected.length > 0) {
        console.warn(
          `[${this.options.sourceId}] каталог v2: ${rejected.length} строк не по формату пропущены: ${rejected.slice(0, 10).join(', ')}`,
        );
      }
      return { ok: true, changed };
    } catch (error) {
      const text = errorText(error, [this.options.apiUrl]);
      if (this.lastError !== text) {
        console.warn(
          `[${this.options.sourceId}] каталог v2 (${maskUrl(this.options.apiUrl)}) не получен: ${text}` +
            (this.fetchedAt === null ? ' — инструментов v2 нет' : ' — работаем по прежнему каталогу'),
        );
      }
      this.lastError = text;
      return { ok: false, changed: false };
    }
  }

  view(): ModuleV2CatalogView {
    const at = this.now();
    const byCategory: Record<string, number> = {};
    for (const i of this.instruments) byCategory[i.category] = (byCategory[i.category] ?? 0) + 1;
    return {
      configured: this.configured,
      endpoint: this.configured ? maskUrl(this.options.apiUrl) : null,
      instruments: this.instruments.length,
      byCategory,
      rejected: this.rejected,
      fetchedAt: this.fetchedAt === null ? null : new Date(this.fetchedAt).toISOString(),
      ageMs: this.fetchedAt === null ? null : at - this.fetchedAt,
      lastAttemptAt: this.lastAttemptAt === null ? null : new Date(this.lastAttemptAt).toISOString(),
      lastError: this.lastError,
    };
  }
}

export function normalizeV2Quote(
  raw: Record<string, unknown>,
  instrument: CatalogInstrument,
  sourceId: string,
  prevClose: number | null,
): Quote | null {
  const bid = positiveDecimal(raw.b);
  const ask = positiveDecimal(raw.a);
  const t = epochMs(raw.t);
  if (bid === null || ask === null || t === null || bid > ask) return null;
  const price = Number(((bid + ask) / 2).toFixed(instrument.digits));
  const changePercent =
    prevClose !== null && prevClose > 0 ? Number((((price - prevClose) / prevClose) * 100).toFixed(2)) : null;
  return {
    symbol: instrument.symbol,
    name: instrument.name,
    category: instrument.category,
    price,
    digits: instrument.digits,
    changePercent,
    bid,
    ask,
    ts: t,
    source: sourceId,
  };
}

export function prevCloseFromCandles(body: unknown): number | null {
  if (!Array.isArray(body) || body.length < 2) return null;
  const row = body[body.length - 2];
  if (!Array.isArray(row)) return null;
  return positiveDecimal(row[4]);
}

function parseStatus(raw: unknown): MarketStatus | null {
  return raw === 'open' || raw === 'closed' || raw === 'halted' ? raw : null;
}

export interface ModuleV2ProviderOptions {
  id: string;
  apiUrl: string;
  wsUrl?: string;
  silenceMs: number;
  changeRefreshMs: number;
  healthPollMs: number;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  fetchImpl?: FetchLike;
  now?: () => number;
}

export interface ModuleV2Upstream {
  status: string | null;
  provider: string | null;
  streamed: number | null;
  maxStreams: number | null;
  checkedAt: string | null;
  error: string | null;
}

export class ModuleV2Provider {
  readonly id: string;
  lastTickAt = 0;
  lastQuoteAt = 0;
  reconnects = 0;
  silenceReconnects = 0;
  droppedQuotes = 0;
  connected = false;
  private ws: WebSocket | null = null;
  private attempts = 0;
  private closedByUs = false;
  private instruments: CatalogInstrument[] = [];
  private bySymbol = new Map<string, CatalogInstrument>();
  private subscribed = new Set<string>();
  private readonly statuses = new Map<string, MarketStatusEvent>();
  private readonly prevClose = new Map<string, { value: number | null; at: number }>();
  private readonly lastRaw = new Map<string, { b: unknown; a: unknown; t: number }>();
  private lastSignalAt = 0;
  private lastClosedRefreshAt = 0;
  private nextId = 1;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private timers: ReturnType<typeof setInterval>[] = [];
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private upstream: ModuleV2Upstream | null = null;
  private lastWsError: string | null = null;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;
  private readonly streamUrl: string;
  private readonly secrets: string[];

  constructor(
    private readonly onQuote: (q: Quote) => void,
    private readonly onStatus: (s: MarketStatusEvent) => void,
    private readonly options: ModuleV2ProviderOptions,
  ) {
    this.id = options.id;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    this.streamUrl = options.apiUrl === '' ? '' : streamUrlFor(options.apiUrl, options.wsUrl);
    this.secrets = [options.apiUrl, options.wsUrl ?? '', this.streamUrl];
  }

  get configured(): boolean {
    return this.options.apiUrl !== '';
  }

  private get api(): string {
    return trimSlash(this.options.apiUrl);
  }

  setInstruments(instruments: CatalogInstrument[]): void {
    this.instruments = instruments;
    this.bySymbol = new Map(instruments.map((i) => [i.providerSymbol, i]));
    for (const key of [...this.statuses.keys()]) if (!this.bySymbol.has(key)) this.statuses.delete(key);
    for (const key of [...this.prevClose.keys()]) if (!this.bySymbol.has(key)) this.prevClose.delete(key);
    for (const key of [...this.lastRaw.keys()]) if (!this.bySymbol.has(key)) this.lastRaw.delete(key);
    const ws = this.ws;
    if (ws && ws.readyState === WebSocket.OPEN) this.applyDelta(ws);
  }

  subscribedSymbols(): string[] {
    return [...this.subscribed];
  }

  private applyDelta(ws: WebSocket): void {
    const wanted = new Set(this.bySymbol.keys());
    const toAdd = [...wanted].filter((s) => !this.subscribed.has(s));
    const toDrop = [...this.subscribed].filter((s) => !wanted.has(s));
    if (toAdd.length === 0 && toDrop.length === 0) return;
    this.send(ws, 'unsubscribe', toDrop);
    this.send(ws, 'subscribe', toAdd);
    this.subscribed = wanted;
    console.info(`[${this.id}] подписка v2: +${toAdd.length} / −${toDrop.length}, итого ${wanted.size}`);
    if (toAdd.length > 0) {
      void this.snapshot(toAdd);
      void this.loadChanges(toAdd);
    }
  }

  private send(ws: WebSocket, op: 'subscribe' | 'unsubscribe', symbols: string[]): void {
    for (let n = 0; n < symbols.length; n += SUBSCRIBE_CHUNK) {
      ws.send(JSON.stringify({ op, symbols: symbols.slice(n, n + SUBSCRIBE_CHUNK), id: this.nextId++ }));
    }
  }

  connect(): void {
    if (!this.configured || this.closedByUs) return;
    if (this.timers.length === 0) this.startTimers();
    this.stopWatchdog();
    const ws = new WebSocket(this.streamUrl);
    this.ws = ws;

    ws.on('open', () => {
      if (this.ws !== ws) return;
      this.attempts = 0;
      this.connected = true;
      this.lastWsError = null;
      this.lastSignalAt = this.now();
      this.startWatchdog(ws);
      const symbols = [...this.bySymbol.keys()];
      this.send(ws, 'subscribe', symbols);
      this.subscribed = new Set(symbols);
      console.info(`[${this.id}] поток v2 подключён: подписка на ${symbols.length}`);
      void this.snapshot(symbols);
      void this.loadChanges(symbols);
    });

    ws.on('message', (raw) => {
      if (this.ws !== ws) return;
      let msg: unknown;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (!isObject(msg)) return;
      switch (msg.type) {
        case 'quote':
          this.alive();
          this.handleQuote(msg, false);
          break;
        case 'status':
          this.alive();
          this.handleStatus(msg);
          break;
        case 'ping':
          this.alive();
          break;
        case 'error':
          console.warn(`[${this.id}] модуль v2 сообщил об ошибке: ${redact(String(msg.code), this.secrets)}`);
          break;
        default:
          break;
      }
    });

    const scheduleRetry = () => {
      if (this.ws !== ws) return;
      this.connected = false;
      this.subscribed.clear();
      this.stopWatchdog();
      if (this.closedByUs) return;
      const base = this.options.reconnectBaseMs ?? 1_000;
      const max = this.options.reconnectMaxMs ?? 30_000;
      const delay = Math.min(base * 2 ** this.attempts, max);
      this.attempts += 1;
      this.reconnects += 1;
      console.warn(`[${this.id}] переподключение к потоку v2 через ${delay} мс (попытка ${this.attempts})`);
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        this.connect();
      }, delay);
      this.retryTimer.unref?.();
    };

    ws.on('close', scheduleRetry);
    ws.on('error', (error) => {
      const text = errorText(error, this.secrets);
      if (this.lastWsError !== text) console.warn(`[${this.id}] ошибка потока v2: ${text}`);
      this.lastWsError = text;
      ws.terminate();
    });
  }

  private alive(): void {
    const at = this.now();
    this.lastSignalAt = at;
    this.lastTickAt = at;
    if (at - this.lastClosedRefreshAt < CLOSED_REFRESH_MIN_MS) return;
    this.lastClosedRefreshAt = at;
    for (const state of this.statuses.values()) {
      if (state.status !== 'open') this.onStatus({ ...state });
    }
  }

  private handleQuote(msg: Record<string, unknown>, fromSnapshot: boolean): void {
    const key = typeof msg.s === 'string' ? msg.s : '';
    const instrument = this.bySymbol.get(key);
    if (!instrument) return;
    const t = epochMs(msg.t);
    const previous = this.lastRaw.get(key);
    if (t !== null && previous && t < previous.t) return;
    const quote = normalizeV2Quote(msg, instrument, this.id, this.prevClose.get(key)?.value ?? null);
    if (!quote) {
      this.droppedQuotes += 1;
      return;
    }
    this.lastRaw.set(key, { b: msg.b, a: msg.a, t: quote.ts });
    if (!fromSnapshot) {
      this.lastQuoteAt = this.now();
      const state = this.statuses.get(key);
      if (state && state.status !== 'open') {
        const opened: MarketStatusEvent = { symbol: instrument.symbol, status: 'open', reason: null, nextOpen: null, t: quote.ts };
        this.statuses.set(key, opened);
        this.onStatus(opened);
      }
    }
    this.onQuote(quote);
  }

  private handleStatus(msg: Record<string, unknown>): void {
    const key = typeof msg.s === 'string' ? msg.s : '';
    const instrument = this.bySymbol.get(key);
    const status = parseStatus(msg.status);
    if (!instrument || !status) return;
    const event: MarketStatusEvent = {
      symbol: instrument.symbol,
      status,
      reason: typeof msg.reason === 'string' ? msg.reason : null,
      nextOpen: status === 'open' ? null : epochMs(msg.nextOpen),
      t: epochMs(msg.t) ?? this.now(),
    };
    this.statuses.set(key, event);
    this.onStatus(event);
  }

  async snapshot(symbols: string[]): Promise<void> {
    for (let n = 0; n < symbols.length; n += SNAPSHOT_CHUNK) {
      const chunk = symbols.slice(n, n + SNAPSHOT_CHUNK);
      try {
        const body = await getJson(
          `${this.api}/v2/quotes?symbols=${chunk.map(encodeURIComponent).join(',')}`,
          this.fetchImpl,
        );
        const list = isObject(body) && Array.isArray(body.quotes) ? body.quotes : Array.isArray(body) ? body : [];
        for (const item of list) {
          if (!isObject(item) || typeof item.s !== 'string' || !this.bySymbol.has(item.s)) continue;
          const status = parseStatus(item.status);
          if (status) {
            const known = this.statuses.get(item.s);
            if (!known || status !== 'open' || known.status !== 'open') {
              this.handleStatus({ s: item.s, status, reason: item.reason, nextOpen: item.nextOpen, t: item.t });
            }
          }
          if (item.b !== undefined || item.a !== undefined) this.handleQuote(item, true);
        }
      } catch (error) {
        console.warn(`[${this.id}] снимок /v2/quotes не получен: ${errorText(error, this.secrets)}`);
      }
    }
  }

  async loadChanges(symbols: string[], force = false): Promise<void> {
    const at = this.now();
    const queue = symbols.filter((s) => {
      const cached = this.prevClose.get(s);
      return force || !cached || at - cached.at >= this.options.changeRefreshMs;
    });
    const worker = async () => {
      for (let symbol = queue.shift(); symbol !== undefined; symbol = queue.shift()) {
        if (!this.bySymbol.has(symbol)) continue;
        try {
          const body = await getJson(
            `${this.api}/v2/candles?symbol=${encodeURIComponent(symbol)}&interval=1d&limit=2`,
            this.fetchImpl,
          );
          this.prevClose.set(symbol, { value: prevCloseFromCandles(body), at: this.now() });
          this.reemit(symbol);
        } catch (error) {
          console.warn(`[${this.id}] дневные свечи ${symbol} не получены: ${errorText(error, this.secrets)}`);
        }
      }
    };
    await Promise.all(Array.from({ length: CANDLE_CONCURRENCY }, worker));
  }

  private reemit(key: string): void {
    const raw = this.lastRaw.get(key);
    const instrument = this.bySymbol.get(key);
    if (!raw || !instrument) return;
    const quote = normalizeV2Quote(raw, instrument, this.id, this.prevClose.get(key)?.value ?? null);
    if (quote) this.onQuote(quote);
  }

  async pollHealth(): Promise<void> {
    try {
      const body = await getJson(`${this.api}/v2/health`, this.fetchImpl, 10_000);
      const b = isObject(body) ? body : {};
      this.upstream = {
        status: typeof b.status === 'string' ? b.status : null,
        provider: typeof b.provider === 'string' ? b.provider : null,
        streamed: typeof b.streamed === 'number' ? b.streamed : null,
        maxStreams: typeof b.maxStreams === 'number' ? b.maxStreams : null,
        checkedAt: new Date(this.now()).toISOString(),
        error: null,
      };
    } catch (error) {
      this.upstream = {
        ...(this.upstream ?? { status: null, provider: null, streamed: null, maxStreams: null }),
        checkedAt: new Date(this.now()).toISOString(),
        error: errorText(error, this.secrets),
      };
    }
  }

  private startTimers(): void {
    void this.pollHealth();
    const health = setInterval(() => void this.pollHealth(), this.options.healthPollMs);
    health.unref?.();
    const changes = setInterval(
      () => void this.loadChanges([...this.bySymbol.keys()]),
      this.options.changeRefreshMs,
    );
    changes.unref?.();
    this.timers.push(health, changes);
  }

  private stopWatchdog(): void {
    if (this.watchdog) {
      clearInterval(this.watchdog);
      this.watchdog = null;
    }
  }

  private startWatchdog(ws: WebSocket): void {
    this.stopWatchdog();
    const tick = Math.max(50, Math.floor(this.options.silenceMs / 3));
    this.watchdog = setInterval(() => {
      if (this.ws !== ws) return;
      const silentFor = this.now() - this.lastSignalAt;
      if (silentFor <= this.options.silenceMs) return;
      this.silenceReconnects += 1;
      this.stopWatchdog();
      console.warn(
        `[${this.id}] тишина потока v2 ${silentFor} мс > ${this.options.silenceMs} мс (нет quote/status/ping) — переподключение`,
      );
      ws.terminate();
    }, tick);
    this.watchdog.unref?.();
  }

  marketCounts(): { open: number; closed: number; halted: number; unknown: number; nextOpen: number | null } {
    let open = 0;
    let closed = 0;
    let halted = 0;
    let nextOpen: number | null = null;
    for (const key of this.bySymbol.keys()) {
      const state = this.statuses.get(key);
      if (!state) continue;
      if (state.status === 'open') open += 1;
      else {
        if (state.status === 'closed') closed += 1;
        else halted += 1;
        if (state.nextOpen !== null) nextOpen = nextOpen === null ? state.nextOpen : Math.min(nextOpen, state.nextOpen);
      }
    }
    return { open, closed, halted, unknown: this.bySymbol.size - open - closed - halted, nextOpen };
  }

  details(): Record<string, unknown> {
    const at = this.now();
    const markets = this.marketCounts();
    let known = 0;
    for (const key of this.bySymbol.keys()) if ((this.prevClose.get(key)?.value ?? null) !== null) known += 1;
    return {
      adapter: 'modulev2',
      configured: this.configured,
      endpoint: this.configured ? maskUrl(this.options.apiUrl) : null,
      connected: this.connected,
      lastSignalAgeMs: this.lastTickAt === 0 ? null : at - this.lastTickAt,
      lastQuoteAgeMs: this.lastQuoteAt === 0 ? null : at - this.lastQuoteAt,
      silenceMs: this.options.silenceMs,
      reconnects: this.reconnects,
      silenceReconnects: this.silenceReconnects,
      lastError: this.lastWsError,
      assigned: this.bySymbol.size,
      subscribed: this.subscribed.size,
      droppedQuotes: this.droppedQuotes,
      markets: { ...markets, nextOpen: markets.nextOpen === null ? null : new Date(markets.nextOpen).toISOString() },
      changePercent: { known, unknown: this.bySymbol.size - known },
      upstream: this.upstream,
    };
  }

  stop(): void {
    this.closedByUs = true;
    this.connected = false;
    this.subscribed.clear();
    this.stopWatchdog();
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const ws = this.ws;
    this.ws = null;
    ws?.terminate();
  }
}
