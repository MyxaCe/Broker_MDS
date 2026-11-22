import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ICONS_DIR = join(process.cwd(), 'public', 'icons');

const cache = new Map<string, Buffer>();
try {
  for (const file of readdirSync(ICONS_DIR)) {
    if (file.endsWith('.svg')) {
      cache.set(file.slice(0, -4), readFileSync(join(ICONS_DIR, file)));
    }
  }
} catch {
  console.warn('[mds] public/icons отсутствует — инструменты без иконок');
}

export function iconPathFor(symbol: string): string | null {
  return cache.has(symbol) ? `/icons/${symbol}.svg` : null;
}

export function iconSvg(symbol: string): Buffer | null {
  return cache.get(symbol) ?? null;
}
