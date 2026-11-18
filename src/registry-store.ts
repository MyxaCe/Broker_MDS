import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { builtinRegistry, registrySchema, type Registry } from './registry.js';

export type RegistryOrigin = 'builtin-default' | 'file' | 'error';

export interface LoadedRegistry {
  origin: RegistryOrigin;
  registry: Registry | null;
  error?: string;
  path: string;
}

export function loadRegistry(path: string): LoadedRegistry {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return { origin: 'builtin-default', registry: builtinRegistry(), path };
    }
    return { origin: 'error', registry: null, error: `${code ?? 'IO'}: ${(error as Error).message}`, path };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { origin: 'error', registry: null, error: `JSON: ${(error as Error).message}`, path };
  }

  const result = registrySchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .slice(0, 5)
      .map((i) => `${i.path.join('.') || '(корень)'}: ${i.message}`)
      .join('; ');
    return { origin: 'error', registry: null, error: `схема: ${issues}`, path };
  }

  return { origin: 'file', registry: result.data, path };
}

export function saveRegistry(path: string, registry: Registry): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');
  renameSync(tmp, path);
}
