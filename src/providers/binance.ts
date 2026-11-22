import WebSocket from 'ws';
import { config } from '../config.js';
import type { CatalogInstrument, Quote } from '../types.js';

const MAX_STREAMS_PER_MSG = 100;
const SUBSCRIBE_STAGGER_MS = 300;

interface BinanceTicker {
  e: string;
  E: number;
  s: string;
  c: string;
  P: string;
  b?: string;
  a?: string;
}

function bestPrice(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const value = Number.parseFloat(raw);
  if (!Number.isFinite(value) || value <= 0) return null;
  return value;
}

export type ProviderStatus = 'connecting' | 'connected' | 'reconnecting';

export interface BinanceProviderOptions {
  wsUrl: string;
  silenceMs: number;
  id: string;
}

export function normalizeTick(
  data: BinanceTicker,
  bySymbol: Map<string, CatalogInstrument>,
  sourceId: string,
): Quote | null {
  const instrument = bySymbol.get(data.s.toLowerCase());
  if (!instrument) return null;
  const price = Number.parseFloat(data.c);
  const changePercent = Number.parseFloat(data.P);
  if (!Number.isFinite(price) || !Number.isFinite(changePercent)) return null;

  let bid = bestPrice(data.b);
  let ask = bestPrice(data.a);
  if (bid !== null && ask !== null && bid > ask) {
    bid = null;
    ask = null;
  }

  return {
    symbol: instrument.symbol,
    name: instrument.name,
    category: instrument.category,
    price,
    digits: instrument.digits,
    changePercent,
    bid,
    ask,
    ts: data.E,
    source: sourceId,
  };
}

export class BinanceProvider {
  private ws: WebSocket | null = null;
  private attempts = 0;
  private closedByUs = false;
  private instruments: CatalogInstrument[] = [];
  private bySymbol = new Map<string, CatalogInstrument>();
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private readonly wsUrl: string;
  private readonly silenceMs: number;
  readonly id: string;
  private subscribed = new Set<string>();
  private lastSignalAt = 0;
  status: ProviderStatus = 'connecting';
  lastTickAt = 0;
  silenceReconnects = 0;

  constructor(
    private readonly onQuote: (q: Quote) => void,
    options?: Partial<BinanceProviderOptions>,
  ) {
    this.wsUrl = options?.wsUrl ?? config.binanceWsUrl;
    this.silenceMs = options?.silenceMs ?? config.providerSilenceMs;
    this.id = options?.id ?? 'binance';
  }

  setInstruments(instruments: CatalogInstrument[]) {
    this.instruments = instruments;
    this.bySymbol = new Map(instruments.map((i) => [i.providerSymbol, i]));
    const ws = this.ws;
    if (ws && ws.readyState === WebSocket.OPEN) this.applyDelta(ws);
  }

  private applyDelta(ws: WebSocket) {
    const wanted = new Set(this.instruments.map((i) => i.providerSymbol));
    const toAdd = [...wanted].filter((s) => !this.subscribed.has(s));
    const toDrop = [...this.subscribed].filter((s) => !wanted.has(s));
    if (toAdd.length === 0 && toDrop.length === 0) return;
    this.send(ws, 'UNSUBSCRIBE', toDrop);
    this.send(ws, 'SUBSCRIBE', toAdd);
    this.subscribed = wanted;
    console.info(
      `[${this.id}] переназначение: +${toAdd.length} / −${toDrop.length} пар, итого ${wanted.size}`,
    );
  }

  private send(ws: WebSocket, method: 'SUBSCRIBE' | 'UNSUBSCRIBE', symbols: string[]) {
    const streams = symbols.map((s) => `${s}@ticker`);
    for (let n = 0, id = 1; n < streams.length; n += MAX_STREAMS_PER_MSG, id += 1) {
      const params = streams.slice(n, n + MAX_STREAMS_PER_MSG);
      const idx = n / MAX_STREAMS_PER_MSG;
      const t = setTimeout(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ method, params, id }));
      }, idx * SUBSCRIBE_STAGGER_MS);
      t.unref?.();
    }
  }

  private subscribe(ws: WebSocket) {
    if (this.instruments.length > 1024) {
      console.warn(
        `[binance] ${this.instruments.length} пар > лимит 1024/соединение — нужен шардинг по сокетам`,
      );
    }
    const symbols = this.instruments.map((i) => i.providerSymbol);
    this.send(ws, 'SUBSCRIBE', symbols);
    this.subscribed = new Set(symbols);
  }

  private stopWatchdog() {
    if (this.watchdog) {
      clearInterval(this.watchdog);
      this.watchdog = null;
    }
  }

  private startWatchdog(ws: WebSocket) {
    this.stopWatchdog();
    const tick = Math.max(200, Math.floor(this.silenceMs / 3));
    this.watchdog = setInterval(() => {
      if (this.ws !== ws) return;
      const silentFor = Date.now() - this.lastSignalAt;
      if (silentFor <= this.silenceMs) return;
      this.silenceReconnects += 1;
      this.stopWatchdog();
      this.status = 'reconnecting';
      console.warn(
        `[binance] тишина ${silentFor}мс > ${this.silenceMs}мс при открытом сокете — соединение считаем мёртвым (B-003)`,
      );
      ws.terminate();
    }, tick);
    this.watchdog.unref?.();
  }

  connect() {
    this.stopWatchdog();
    this.status = this.attempts === 0 ? 'connecting' : 'reconnecting';
    const ws = new WebSocket(`${this.wsUrl}/ws`);
    this.ws = ws;

    ws.on('open', () => {
      this.attempts = 0;
      this.status = 'connected';
      this.lastSignalAt = Date.now();
      this.startWatchdog(ws);
      this.subscribe(ws);
      console.info(`[binance] connected: подписка на ${this.instruments.length} пар @ticker`);
    });

    ws.on('message', (raw) => {
      try {
        const ticker = JSON.parse(String(raw)) as BinanceTicker;
        if (ticker.e !== '24hrTicker') return;
        const quote = normalizeTick(ticker, this.bySymbol, this.id);
        if (quote) {
          this.lastTickAt = Date.now();
          this.lastSignalAt = this.lastTickAt;
          this.onQuote(quote);
        }
      } catch {
      }
    });

    const scheduleRetry = () => {
      if (this.ws !== ws) return;
      this.subscribed.clear();
      this.stopWatchdog();
      if (this.closedByUs) return;
      this.status = 'reconnecting';
      const delay = Math.min(1_000 * 2 ** this.attempts, 30_000);
      this.attempts += 1;
      console.warn(`[binance] reconnect in ${delay}ms (attempt ${this.attempts})`);
      const t = setTimeout(() => this.connect(), delay);
      t.unref?.();
    };

    ws.on('close', scheduleRetry);
    ws.on('error', (error) => {
      console.warn('[binance] ws error:', (error as Error).message);
      ws.terminate();
    });
  }

  stop() {
    this.closedByUs = true;
    this.subscribed.clear();
    this.stopWatchdog();
    this.ws?.terminate();
    this.ws = null;
  }
}
