import { dirname, join } from 'node:path';

export function positiveIntOrNull(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === '') return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) return null;
  return value;
}

export const config = {
  port: Number(process.env.PORT ?? 3003),
  batchMs: Number(process.env.BATCH_MS ?? 250),
  binanceWsUrl: process.env.BINANCE_WS_URL ?? 'wss://stream.binance.com:9443',
  binanceApiUrl: process.env.BINANCE_API_URL ?? 'https://api.binance.com',

  staleAfterMs: positiveIntOrNull(process.env.QUOTE_STALE_AFTER_MS),

  providerSilenceMs: Number(process.env.PROVIDER_SILENCE_MS ?? 30_000),

  registryPath: process.env.MDS_REGISTRY_PATH ?? './data/providers.json',

  adminToken: process.env.MDS_ADMIN_TOKEN,

  routingRecheckMs: Number(process.env.MDS_ROUTING_RECHECK_MS ?? 5_000),

  allowRoutingIdentityChange:
    (process.env.MDS_ALLOW_ROUTING_IDENTITY_CHANGE ?? '').trim() === 'true',

  cms: {
    apiUrl: (process.env.CMS_API_URL ?? '').trim(),
    apiKey: (process.env.CMS_API_KEY ?? '').trim(),
    pollMs: positiveIntOrNull(process.env.CMS_POLL_MS) ?? 30_000,
    webhookSecret: (process.env.CMS_WEBHOOK_SECRET ?? '').trim(),
  },

  platformInstrumentsPath:
    process.env.MDS_PLATFORM_INSTRUMENTS_PATH ??
    join(dirname(process.env.MDS_REGISTRY_PATH ?? './data/providers.json'), 'platform-instruments.json'),

  marketV2: {
    apiUrl: (process.env.MARKET_V2_API_URL ?? '').trim(),
    wsUrl: (process.env.MARKET_V2_WS_URL ?? '').trim(),
    silenceMs: positiveIntOrNull(process.env.MARKET_V2_SILENCE_MS) ?? 45_000,
    catalogRefreshMs: positiveIntOrNull(process.env.MARKET_V2_CATALOG_REFRESH_MS) ?? 86_400_000,
    catalogRetryMs: positiveIntOrNull(process.env.MARKET_V2_CATALOG_RETRY_MS) ?? 300_000,
    changeRefreshMs: positiveIntOrNull(process.env.MARKET_V2_CHANGE_REFRESH_MS) ?? 3_600_000,
    healthPollMs: positiveIntOrNull(process.env.MARKET_V2_HEALTH_POLL_MS) ?? 60_000,
  },

  twelveData: {
    apiKey: process.env.TWELVEDATA_API_KEY ?? '',
    apiUrl: process.env.TWELVEDATA_API_URL ?? 'https://api.twelvedata.com',
    creditsPerMin: Number(process.env.TWELVEDATA_CREDITS_PER_MIN ?? 8),
    creditsPerDay: Number(process.env.TWELVEDATA_CREDITS_PER_DAY ?? 800),
  },
};
