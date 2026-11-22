import 'dotenv/config';

import { CATALOG, fetchBinanceSpotUniverse } from './catalog.js';
import { config } from './config.js';
import { resolveStartupPlatform, type CmsEndpoint } from './platform.js';
import { loadRegistry } from './registry-store.js';
import { createMdsServer } from './server.js';
import { ModuleV2Catalog } from './providers/modulev2.js';
import type { ProviderEntry } from './registry.js';

let cryptoUniverse = await fetchBinanceSpotUniverse(config.binanceApiUrl);
let catalogSource = 'binance-exchange-info';
if (!cryptoUniverse) {
  cryptoUniverse = CATALOG.filter((i) => i.provider === 'binance');
  catalogSource = 'static-fallback';
  console.warn(
    `[mds] exchangeInfo недоступен — крипта из ЗАПАСНОГО каталога (${cryptoUniverse.length} инструментов). ` +
      'Это число не является размером живой вселенной.',
  );
} else {
  console.info(`[mds] Binance: ${cryptoUniverse.length} спот-пар к USDT`);
}

const loaded = loadRegistry(config.registryPath);

const moduleV2Id =
  loaded.registry?.providers.find((p) => p.adapter === 'modulev2')?.id ?? 'modulev2';
const moduleV2Catalog = new ModuleV2Catalog({ apiUrl: config.marketV2.apiUrl, sourceId: moduleV2Id });
if (moduleV2Catalog.configured) {
  const first = await moduleV2Catalog.refresh();
  if (first.ok) {
    console.info(`[mds] модуль v2: каталог ${moduleV2Catalog.instruments.length} инструментов`);
  }
} else {
  console.warn('[mds] MARKET_V2_API_URL не задан — источник modulev2 без каталога, инструментов v2 нет');
}

const twelveRows = CATALOG.filter((i) => i.provider === 'twelvedata');
const buildCatalog = () => [...cryptoUniverse, ...moduleV2Catalog.instruments, ...twelveRows];
const catalog = buildCatalog();
if (loaded.origin === 'builtin-default') {
  console.warn(
    `[mds] реестра провайдеров нет (${loaded.path}) — работаем по ВСТРОЕННОМУ УМОЛЧАНИЮ. ` +
      'Его никто не выбирал; файл на старте сознательно не создаётся, чтобы ' +
      '«никто не настраивал» не стало неотличимо от «настроили ровно так».',
  );
}

function keyFor(entry: ProviderEntry): string {
  const generic = process.env[`MDS_PROVIDER_KEY_${entry.id.toUpperCase().replace(/-/g, '_')}`];
  if (generic) return generic;
  if (entry.adapter === 'twelvedata') return config.twelveData.apiKey;
  return '';
}

const keys = new Map((loaded.registry?.providers ?? []).map((p) => [p.id, keyFor(p)]));

const cms: CmsEndpoint | null =
  config.cms.apiUrl !== '' && config.cms.apiKey !== ''
    ? { apiUrl: config.cms.apiUrl, apiKey: config.cms.apiKey }
    : null;
const startup = await resolveStartupPlatform({ cms, filePath: config.platformInstrumentsPath });
for (const line of startup.log) {
  if (line.level === 'warn') console.warn(line.message);
  else console.info(line.message);
}
if (cms && config.cms.webhookSecret === '') {
  console.warn('[mds] CMS_WEBHOOK_SECRET не задан — вебхук инструментов платформы выключен, остаётся опрос');
}

const server = createMdsServer({
  catalog,
  catalogSource,
  loaded,
  staleAfterMs: config.staleAfterMs,
  adminToken: config.adminToken,
  allowRoutingIdentityChange: config.allowRoutingIdentityChange,
  keys,
  moduleV2Catalog,
  platform: {
    initial: { list: startup.list, source: startup.source, confirmedAt: startup.confirmedAt },
    sync: {
      cms,
      filePath: config.platformInstrumentsPath,
      pollMs: config.cms.pollMs,
      webhookSecret: config.cms.webhookSecret,
    },
  },
});

if (moduleV2Catalog.configured) {
  const schedule = (delay: number) => {
    const timer = setTimeout(async () => {
      const result = await moduleV2Catalog.refresh();
      if (result.changed) server.replaceCatalog(buildCatalog());
      schedule(result.ok ? config.marketV2.catalogRefreshMs : config.marketV2.catalogRetryMs);
    }, delay);
    timer.unref?.();
  };
  schedule(moduleV2Catalog.fetchedAt === null ? config.marketV2.catalogRetryMs : config.marketV2.catalogRefreshMs);
}

if (config.staleAfterMs === null) {
  console.error(
    '[mds] QUOTE_STALE_AFTER_MS не задан. Порог свежести не имеет умолчания ' +
      '(КОНТРАКТЫ.md §5г): без него MDS не может отличить текущую цену от ' +
      'вчерашней и НЕ ОТДАЁТ КОТИРОВОК ВОВСЕ — /v1/quotes пуст, /health 503.',
  );
} else {
  console.info(`[mds] порог свежести котировки: ${config.staleAfterMs} мс`);
}

if (config.adminToken === undefined || config.adminToken === '') {
  console.warn(
    '[mds] MDS_ADMIN_TOKEN не задан — служебная ручка управления провайдерами ' +
      'ВЫКЛЮЧЕНА (503). Реестр читается из файла и меняется только правкой файла.',
  );
}

server.httpServer.listen(config.port, () => {
  const table = server.routing();
  const routed = table ? [...table.routes.values()].filter((r) => r.leader).length : 0;
  console.info(
    `[mds] listening on :${config.port} — каталог ${catalog.length} (${catalogSource}), ` +
      `маршрутизировано ${routed}, реестр ${loaded.origin} v${loaded.registry?.version ?? '—'}, ` +
      `инструменты платформы ${startup.source}${startup.list ? ` v${startup.list.version}` : ''}`,
  );
});
