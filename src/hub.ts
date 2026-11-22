import type { Server as HttpServer } from 'node:http';
import { Server } from 'socket.io';
import { config } from './config.js';
import type { MarketFlag, Quote } from './types.js';

export interface SnapshotResult {
  items: Quote[];
  staleSymbols: string[] | null;
  checked: number;
  missing: string[];
}

export interface HubOptions {
  staleAfterMs: number | null;
  now: () => number;
}

export class QuoteHub {
  private readonly last = new Map<string, Quote>();
  private readonly market = new Map<string, MarketFlag & { at: number }>();
  private readonly io: Server;
  private readonly staleAfterMs: number | null;
  private readonly now: () => number;
  private readonly clients = new Map<string, { subscribed: Set<string>; dirty: Set<string> }>();

  constructor(httpServer: HttpServer, options?: Partial<HubOptions>) {
    this.staleAfterMs = options?.staleAfterMs !== undefined ? options.staleAfterMs : config.staleAfterMs;
    this.now = options?.now ?? Date.now;

    this.io = new Server(httpServer, {
      cors: { origin: '*', methods: ['GET', 'POST'] },
      transports: ['websocket', 'polling'],
    });

    this.io.on('connection', (socket) => {
      const state = { subscribed: new Set<string>(), dirty: new Set<string>() };
      this.clients.set(socket.id, state);

      socket.on('subscribe', (symbols: unknown) => {
        if (!Array.isArray(symbols)) return;
        const wanted: string[] = [];
        for (const s of symbols) {
          if (typeof s !== 'string' || s.length > 20) continue;
          state.subscribed.add(s);
          wanted.push(s);
        }
        const { items } = this.snapshot(wanted);
        if (items.length) socket.emit('quotes:batch', items);
      });

      socket.on('unsubscribe', (symbols: unknown) => {
        if (!Array.isArray(symbols)) return;
        for (const s of symbols) {
          state.subscribed.delete(String(s));
          state.dirty.delete(String(s));
        }
      });

      socket.on('disconnect', () => this.clients.delete(socket.id));
    });

    const flusher = setInterval(() => this.flush(), config.batchMs);
    flusher.unref?.();
  }

  push(quote: Quote) {
    this.last.set(quote.symbol, quote);
    this.markDirty(quote.symbol);
  }

  private pick(quote: Quote | undefined, at: number): Quote | null {
    if (!quote) return null;
    if (this.staleAfterMs === null) return null;
    const market = this.marketAt(quote.symbol, at);
    if (market) return { ...quote, market };
    if (at - quote.ts > this.staleAfterMs) return null;
    return quote;
  }

  private marketAt(symbol: string, at: number): MarketFlag | null {
    const state = this.market.get(symbol);
    if (!state || this.staleAfterMs === null) return null;
    if (at - state.at > this.staleAfterMs) return null;
    return { status: state.status, reason: state.reason, nextOpen: state.nextOpen };
  }

  setMarket(
    symbol: string,
    state: { status: 'open' | 'closed' | 'halted'; reason: string | null; nextOpen: number | null },
  ): void {
    const previous = this.market.get(symbol);
    if (state.status === 'open') {
      if (!previous) return;
      this.market.delete(symbol);
      this.markDirty(symbol);
      return;
    }
    const next = { status: state.status, reason: state.reason, nextOpen: state.nextOpen, at: this.now() };
    this.market.set(symbol, next);
    if (
      !previous ||
      previous.status !== next.status ||
      previous.reason !== next.reason ||
      previous.nextOpen !== next.nextOpen
    ) {
      this.markDirty(symbol);
    }
  }

  markets(symbols?: string[]): Map<string, MarketFlag> {
    const at = this.now();
    const out = new Map<string, MarketFlag>();
    for (const symbol of symbols ?? [...this.market.keys()]) {
      const flag = this.marketAt(symbol, at);
      if (flag) out.set(symbol, flag);
    }
    return out;
  }

  private markDirty(symbol: string): void {
    for (const state of this.clients.values()) {
      if (state.subscribed.has(symbol)) state.dirty.add(symbol);
    }
  }

  private flush() {
    const at = this.now();
    for (const [id, state] of this.clients) {
      if (state.dirty.size === 0) continue;
      const batch: Quote[] = [];
      for (const symbol of state.dirty) {
        const quote = this.pick(this.last.get(symbol), at);
        if (quote) batch.push(quote);
      }
      state.dirty.clear();
      if (batch.length) this.io.to(id).emit('quotes:batch', batch);
    }
  }

  snapshot(symbols?: string[]): SnapshotResult {
    const at = this.now();
    const asked = symbols && symbols.length > 0 ? symbols : null;
    const candidates = asked
      ? asked.map((s) => this.last.get(s)).filter((q): q is Quote => q !== undefined)
      : [...this.last.values()];
    const missing = asked ? asked.filter((s) => !this.last.has(s)) : [];

    const items: Quote[] = [];
    const staleSymbols: string[] = [];
    for (const quote of candidates) {
      const picked = this.pick(quote, at);
      if (picked) items.push(picked);
      else staleSymbols.push(quote.symbol);
    }

    return {
      items,
      staleSymbols: this.staleAfterMs === null ? null : staleSymbols,
      checked: candidates.length,
      missing,
    };
  }

  invalidate(symbols: Iterable<string>): number {
    let removed = 0;
    for (const symbol of symbols) {
      if (this.last.delete(symbol)) removed += 1;
      this.market.delete(symbol);
      for (const state of this.clients.values()) state.dirty.delete(symbol);
    }
    return removed;
  }

  has(symbol: string): boolean {
    return this.last.has(symbol);
  }

  ages(): { symbol: string; ageMs: number }[] {
    const at = this.now();
    return [...this.last.values()].map((q) => ({ symbol: q.symbol, ageMs: at - q.ts }));
  }

  get clientCount(): number {
    return this.clients.size;
  }
}
