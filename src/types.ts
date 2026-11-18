export interface Quote {
  symbol: string;
  name: string;
  category: 'forex' | 'metals' | 'crypto' | 'indices' | 'stocks' | 'energy';
  price: number;
  digits: number;
  changePercent: number;
  bid: number | null;
  ask: number | null;
  ts: number;
  source: string;
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
}
