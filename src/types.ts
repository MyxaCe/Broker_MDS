export interface Quote {
  symbol: string;
  name: string;
  category: 'forex' | 'metals' | 'crypto' | 'indices' | 'stocks' | 'energy';
  price: number;
  digits: number;
  changePercent: number | null;
  bid: number | null;
  ask: number | null;
  ts: number;
  source: string;
  market?: MarketFlag;
}

export interface MarketFlag {
  status: 'closed' | 'halted';
  reason: string | null;
  nextOpen: number | null;
}

export interface InstrumentSession {
  timezone: string;
  weekly: { open: string; close: string }[];
  holidays: string[];
}

export type Segment = 'europe' | 'asia' | 'america' | 'rf' | 'major' | 'minor' | 'exotic';

export interface CatalogInstrument {
  symbol: string;
  name: string;
  category: Quote['category'];
  segment: Segment | null;
  digits: number;
  provider: string;
  providerSymbol: string;
  tickSize?: string;
  qtyDecimals?: number;
  qtyStep?: string;
  minQty?: string;
  contractSize?: string;
  session?: InstrumentSession;
}
