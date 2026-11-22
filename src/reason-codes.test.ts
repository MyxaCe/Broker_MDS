import { describe, expect, it } from 'vitest';
import { UNAVAILABLE_REASONS } from './api.js';
import { ROUTE_REASONS } from './registry.js';
import { ADMIN_CODES } from './admin.js';

const KEBAB = /^[a-z]+(-[a-z]+)*$/;

const CONTRACT_SYMBOL_AXIS = [
  'registry-unreadable',
  'no-source',
  'source-disabled',
  'source-silent',
  'stale',
  'not-in-catalog',
  'threshold-unset',
  'market-closed',
  'market-halted',
];

const CONSUMER_CHANNEL_AXIS = ['not-configured', 'network', 'http-error', 'malformed', 'empty'];

const CONTRACT_ADMIN_AXIS = [
  'control-plane-disabled',
  'no-token',
  'bad-token',
  'registry-unreadable',
  'bad-body',
  'version-required',
  'version-conflict',
  'invalid-registry',
  'method-not-allowed',
  'not-found',
  'routing-identity-change',
  'symbol-instrument-change',
];

describe('Словари машинных причин · стиль и состав (Р-087, §4г)', () => {
  it('ось символа совпадает с §4г по составу — ни лишних имён, ни забытых', () => {
    expect([...UNAVAILABLE_REASONS].sort()).toEqual([...CONTRACT_SYMBOL_AXIS].sort());
  });

  it('ось служебной ручки совпадает с §4г по составу — ни лишних имён, ни забытых', () => {
    expect([...ADMIN_CODES].sort()).toEqual([...CONTRACT_ADMIN_AXIS].sort());
  });

  it('ось символа — kebab-case во всех именах', () => {
    const wrong = UNAVAILABLE_REASONS.filter((code) => !KEBAB.test(code));
    expect(wrong).toEqual([]);
  });

  it('причины маршрутизации — kebab-case: они уходят наружу в coverage.byReason', () => {
    const wrong = ROUTE_REASONS.filter((code) => !KEBAB.test(code));
    expect(wrong).toEqual([]);
  });

  it('коды служебной ручки — kebab-case во всех именах', () => {
    const wrong = ADMIN_CODES.filter((code) => !KEBAB.test(code));
    expect(wrong).toEqual([]);
  });

  it('ось символа и ось канала не пересекаются: одно состояние — одно имя', () => {
    const overlap = UNAVAILABLE_REASONS.filter((code) =>
      (CONSUMER_CHANNEL_AXIS as string[]).includes(code),
    );
    expect(overlap).toEqual([]);
  });

  it('общие имена двух наших осей значат одно и то же, а не разное', () => {
    const shared = ROUTE_REASONS.filter((code) =>
      (UNAVAILABLE_REASONS as readonly string[]).includes(code),
    );
    expect([...shared].sort()).toEqual(['no-source', 'source-disabled']);
  });
});
