import 'dotenv/config';

import { CATALOG, fetchBinanceSpotUniverse } from './catalog.js';
import { config } from './config.js';
import { loadRegistry } from './registry-store.js';
import { createMdsServer } from './server.js';
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

const catalog = [...cryptoUniverse, ...CATALOG.filter((i) => i.provider === 'twelvedata')];

const loaded = loadRegistry(config.registryPath);
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

const server = createMdsServer({
  catalog,
  catalogSource,
  loaded,
  staleAfterMs: config.staleAfterMs,
  adminToken: config.adminToken,
  allowRoutingIdentityChange: config.allowRoutingIdentityChange,
  keys,
});

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
      `маршрутизировано ${routed}, реестр ${loaded.origin} v${loaded.registry?.version ?? '—'}`,
  );
});
