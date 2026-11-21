import { createHmac, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';

export const PLATFORM_MODES = ['trade', 'closeOnly'] as const;
export type PlatformMode = (typeof PLATFORM_MODES)[number];

export const PLATFORM_SOURCES = ['cms', 'file', 'catalog-fallback'] as const;
export type PlatformSource = (typeof PLATFORM_SOURCES)[number];

const entrySchema = z.object({
  symbol: z
    .string()
    .trim()
    .min(1)
    .max(32)
    .transform((s) => s.toUpperCase()),
  mode: z.enum(PLATFORM_MODES),
});

export const platformListSchema = z.object({
  version: z.number().int().nonnegative(),
  updatedAt: z.string().nullable().optional(),
  instruments: z.array(entrySchema),
});

export interface PlatformEntry {
  symbol: string;
  mode: PlatformMode;
}

export interface PlatformList {
  version: number;
  updatedAt: string | null;
  instruments: PlatformEntry[];
}

export type ParsedPlatformList = { ok: true; list: PlatformList } | { ok: false; error: string };

export function parsePlatformList(body: unknown): ParsedPlatformList {
  const result = platformListSchema.safeParse(body);
  if (!result.success) {
    const issues = result.error.issues
      .slice(0, 5)
      .map((i) => `${i.path.join('.') || '(корень)'}: ${i.message}`)
      .join('; ');
    return { ok: false, error: `схема: ${issues}` };
  }
  const seen = new Set<string>();
  const instruments: PlatformEntry[] = [];
  for (const entry of result.data.instruments) {
    if (seen.has(entry.symbol)) continue;
    seen.add(entry.symbol);
    instruments.push({ symbol: entry.symbol, mode: entry.mode });
  }
  if (instruments.length === 0) {
    return { ok: false, error: `пустой список инструментов (version ${result.data.version}) — не применяется` };
  }
  return {
    ok: true,
    list: { version: result.data.version, updatedAt: result.data.updatedAt ?? null, instruments },
  };
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface CmsEndpoint {
  apiUrl: string;
  apiKey: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

export function platformListUrl(apiUrl: string): string {
  return `${apiUrl.replace(/\/+$/, '')}/cms/platform/instruments`;
}

export async function fetchPlatformList(endpoint: CmsEndpoint): Promise<ParsedPlatformList> {
  const fetchImpl = endpoint.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await fetchImpl(platformListUrl(endpoint.apiUrl), {
      headers: { 'X-API-Key': endpoint.apiKey, Accept: 'application/json' },
      signal: AbortSignal.timeout(endpoint.timeoutMs ?? 5_000),
    });
  } catch (error) {
    return { ok: false, error: `сеть: ${(error as Error).message}` };
  }
  if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
  let body: unknown;
  try {
    body = await res.json();
  } catch (error) {
    return { ok: false, error: `JSON: ${(error as Error).message}` };
  }
  return parsePlatformList(body);
}

export type LoadedPlatformFile =
  | { state: 'absent' }
  | { state: 'ok'; list: PlatformList; savedAt: number }
  | { state: 'error'; error: string };

export function loadPlatformFile(path: string): LoadedPlatformFile {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { state: 'absent' };
    return { state: 'error', error: `${code ?? 'IO'}: ${(error as Error).message}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { state: 'error', error: `JSON: ${(error as Error).message}` };
  }
  const wrapper = parsed as { savedAt?: unknown; list?: unknown } | null;
  const list = parsePlatformList(wrapper?.list);
  if (!list.ok) return { state: 'error', error: list.error };
  const savedAt = typeof wrapper?.savedAt === 'string' ? Date.parse(wrapper.savedAt) : Number.NaN;
  return { state: 'ok', list: list.list, savedAt: Number.isFinite(savedAt) ? savedAt : 0 };
}

export function savePlatformFile(path: string, list: PlatformList, savedAt: number): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify({ savedAt: new Date(savedAt).toISOString(), list }, null, 2)}\n`, 'utf8');
  renameSync(tmp, path);
}

export function signBody(rawBody: string | Buffer, secret: string): string {
  return `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
}

export function verifySignature(rawBody: string | Buffer, header: string | undefined, secret: string): boolean {
  if (!header || !header.startsWith('sha256=')) return false;
  const given = header.slice('sha256='.length);
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  if (given.length !== expected.length || !/^[0-9a-f]+$/i.test(given)) return false;
  return timingSafeEqual(Buffer.from(given, 'hex'), Buffer.from(expected, 'hex'));
}

export interface PlatformInitial {
  list: PlatformList | null;
  source: PlatformSource;
  confirmedAt: number | null;
}

export interface StartupResolution extends PlatformInitial {
  log: { level: 'info' | 'warn'; message: string }[];
}

export async function resolveStartupPlatform(options: {
  cms: CmsEndpoint | null;
  filePath: string;
  now?: () => number;
}): Promise<StartupResolution> {
  const now = options.now ?? Date.now;
  const log: StartupResolution['log'] = [];
  if (options.cms) {
    const fetched = await fetchPlatformList(options.cms);
    if (fetched.ok) {
      const at = now();
      try {
        savePlatformFile(options.filePath, fetched.list, at);
      } catch (error) {
        log.push({
          level: 'warn',
          message: `[mds] инструменты платформы не записаны в ${options.filePath}: ${(error as Error).message}`,
        });
      }
      log.push({
        level: 'info',
        message: `[mds] инструменты платформы из CMS: v${fetched.list.version}, ${fetched.list.instruments.length} символов`,
      });
      return { list: fetched.list, source: 'cms', confirmedAt: at, log };
    }
    log.push({ level: 'warn', message: `[mds] CMS не отдала инструменты платформы на старте: ${fetched.error}` });
  } else {
    log.push({
      level: 'warn',
      message: '[mds] CMS_API_URL или CMS_API_KEY не заданы — список инструментов платформы из CMS не опрашивается',
    });
  }
  const file = loadPlatformFile(options.filePath);
  if (file.state === 'ok') {
    log.push({
      level: 'warn',
      message:
        `[mds] инструменты платформы из сохранённого файла ${options.filePath}: v${file.list.version}, ` +
        `${file.list.instruments.length} символов, сохранён ${new Date(file.savedAt).toISOString()}`,
    });
    return { list: file.list, source: 'file', confirmedAt: file.savedAt, log };
  }
  if (file.state === 'error') {
    log.push({ level: 'warn', message: `[mds] файл инструментов платформы не прочитан: ${file.error}` });
  }
  log.push({
    level: 'warn',
    message:
      '[mds] ВНИМАНИЕ: инструментов платформы нет ни в CMS, ни в файле — MDS подписывается на ВЕСЬ каталог. ' +
      'Это прежнее поведение и полный тариф поставщика; задайте список в CMS («Инструменты платформы»).',
  });
  return { list: null, source: 'catalog-fallback', confirmedAt: null, log };
}
