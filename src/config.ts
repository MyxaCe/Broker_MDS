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

  twelveData: {
    apiKey: process.env.TWELVEDATA_API_KEY ?? '',
    apiUrl: process.env.TWELVEDATA_API_URL ?? 'https://api.twelvedata.com',
    creditsPerMin: Number(process.env.TWELVEDATA_CREDITS_PER_MIN ?? 8),
    creditsPerDay: Number(process.env.TWELVEDATA_CREDITS_PER_DAY ?? 800),
  },
};
