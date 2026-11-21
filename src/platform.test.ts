import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  loadPlatformFile,
  parsePlatformList,
  platformListUrl,
  resolveStartupPlatform,
  savePlatformFile,
  signBody,
  verifySignature,
  type PlatformList,
} from './platform.js';

const LIST: PlatformList = {
  version: 12,
  updatedAt: '2026-11-21T10:00:00Z',
  instruments: [
    { symbol: 'BTCUSD', mode: 'trade' },
    { symbol: 'LTCUSD', mode: 'closeOnly' },
  ],
};

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'mds-platform-'));
}

const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()));
});

async function fakeCms(handler: (path: string, key: string | undefined) => { status: number; body: unknown }) {
  const server = createServer((req, res) => {
    const out = handler(req.url ?? '', req.headers['x-api-key'] as string | undefined);
    res.writeHead(out.status, { 'Content-Type': 'application/json' });
    res.end(typeof out.body === 'string' ? out.body : JSON.stringify(out.body));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
}

describe('инструменты платформы · разбор ответа CMS', () => {
  it('ответ по договору разбирается, символ приводится к верхнему регистру, повтор отброшен', () => {
    const parsed = parsePlatformList({
      version: 3,
      updatedAt: '2026-11-21T10:00:00Z',
      instruments: [
        { symbol: 'btcusd', mode: 'trade' },
        { symbol: 'BTCUSD', mode: 'closeOnly' },
        { symbol: 'EURUSD', mode: 'closeOnly' },
      ],
    });
    expect(parsed).toEqual({
      ok: true,
      list: {
        version: 3,
        updatedAt: '2026-11-21T10:00:00Z',
        instruments: [
          { symbol: 'BTCUSD', mode: 'trade' },
          { symbol: 'EURUSD', mode: 'closeOnly' },
        ],
      },
    });
  });

  it('незнакомый режим, нет версии, не массив → отказ, а не частичное применение', () => {
    expect(parsePlatformList({ version: 1, instruments: [{ symbol: 'BTCUSD', mode: 'off' }] }).ok).toBe(false);
    expect(parsePlatformList({ instruments: [] }).ok).toBe(false);
    expect(parsePlatformList({ version: 1, instruments: 'BTCUSD' }).ok).toBe(false);
    expect(parsePlatformList(null).ok).toBe(false);
  });

  it('пустой список не применяется: снять все цены разом CMS не может', () => {
    const parsed = parsePlatformList({ version: 5, updatedAt: null, instruments: [] });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain('пустой');
  });

  it('адрес ручки: CMS_API_URL + /cms/platform/instruments', () => {
    expect(platformListUrl('http://cms:3000/v1/')).toBe('http://cms:3000/v1/cms/platform/instruments');
  });
});

describe('инструменты платформы · файл-кэш', () => {
  it('запись атомарная и читается обратно с моментом сохранения', () => {
    const dir = tempDir();
    const path = join(dir, 'sub', 'platform-instruments.json');
    savePlatformFile(path, LIST, Date.parse('2026-11-21T11:00:00Z'));
    expect(readdirSync(join(dir, 'sub'))).toEqual(['platform-instruments.json']);
    expect(loadPlatformFile(path)).toEqual({ state: 'ok', list: LIST, savedAt: Date.parse('2026-11-21T11:00:00Z') });
  });

  it('файла нет → absent; битый файл → error с причиной', () => {
    const dir = tempDir();
    expect(loadPlatformFile(join(dir, 'nope.json'))).toEqual({ state: 'absent' });
    writeFileSync(join(dir, 'bad.json'), '{"list":', 'utf8');
    expect(loadPlatformFile(join(dir, 'bad.json')).state).toBe('error');
    mkdirSync(join(dir, 'dir.json'));
    expect(loadPlatformFile(join(dir, 'dir.json')).state).toBe('error');
  });
});

describe('инструменты платформы · порядок на старте: CMS → файл → весь каталог', () => {
  it('CMS отвечает → список из CMS, ключ в заголовке, файл перезаписан', async () => {
    let seenKey: string | undefined;
    let seenPath = '';
    const apiUrl = await fakeCms((path, key) => {
      seenPath = path;
      seenKey = key;
      return { status: 200, body: LIST };
    });
    const filePath = join(tempDir(), 'platform-instruments.json');
    savePlatformFile(filePath, { ...LIST, version: 99 }, 1);
    const result = await resolveStartupPlatform({ cms: { apiUrl, apiKey: 'k-1' }, filePath, now: () => 5_000 });
    expect(seenPath).toBe('/v1/cms/platform/instruments');
    expect(seenKey).toBe('k-1');
    expect(result.source).toBe('cms');
    expect(result.list?.version).toBe(12);
    expect(result.confirmedAt).toBe(5_000);
    expect(JSON.parse(readFileSync(filePath, 'utf8')).list.version).toBe(12);
  });

  it('CMS недоступна → сохранённый файл', async () => {
    const apiUrl = await fakeCms(() => ({ status: 502, body: {} }));
    const filePath = join(tempDir(), 'platform-instruments.json');
    savePlatformFile(filePath, LIST, 1_000);
    const result = await resolveStartupPlatform({ cms: { apiUrl, apiKey: 'k' }, filePath });
    expect(result.source).toBe('file');
    expect(result.list).toEqual(LIST);
    expect(result.confirmedAt).toBe(1_000);
    expect(result.log.some((l) => l.message.includes('HTTP 502'))).toBe(true);
  });

  it('CMS не настроена, файла нет → весь каталог и громкое предупреждение', async () => {
    const result = await resolveStartupPlatform({ cms: null, filePath: join(tempDir(), 'x.json') });
    expect(result).toMatchObject({ list: null, source: 'catalog-fallback', confirmedAt: null });
    expect(result.log.some((l) => l.level === 'warn' && l.message.includes('ВЕСЬ каталог'))).toBe(true);
  });

  it('CMS отдаёт не по договору → не CMS, а файл', async () => {
    const apiUrl = await fakeCms(() => ({ status: 200, body: { items: [] } }));
    const filePath = join(tempDir(), 'platform-instruments.json');
    savePlatformFile(filePath, LIST, 1_000);
    expect((await resolveStartupPlatform({ cms: { apiUrl, apiKey: 'k' }, filePath })).source).toBe('file');
  });
});

describe('инструменты платформы · подпись вебхука (как CMS → сайт)', () => {
  const body = JSON.stringify({ event_id: 'e1', occurred_at: '2026-11-21T10:00:00Z', tags: ['cms:platform-instruments'] });

  it('подпись sha256=<hex> HMAC тела проходит', () => {
    expect(verifySignature(body, signBody(body, 's3cret'), 's3cret')).toBe(true);
  });

  it('чужой секрет, другое тело, нет префикса, мусор → отказ', () => {
    expect(verifySignature(body, signBody(body, 'other'), 's3cret')).toBe(false);
    expect(verifySignature(`${body} `, signBody(body, 's3cret'), 's3cret')).toBe(false);
    expect(verifySignature(body, signBody(body, 's3cret').slice('sha256='.length), 's3cret')).toBe(false);
    expect(verifySignature(body, 'sha256=zz', 's3cret')).toBe(false);
    expect(verifySignature(body, undefined, 's3cret')).toBe(false);
  });
});
