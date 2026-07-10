/**
 * Web research planning/ranking tests — offline, no provider calls required.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  aggregateSearchResults,
  duckDuckGoDateCode,
  getDomainKey,
  normalizeSearchQueries,
  resolveSearchRecency,
  selectDiverseResults,
} from '../lib/web/WebResearch.js';

test('normalizeSearchQueries deduplicates queries case-insensitively and enforces the cap', () => {
  assert.deepStrictEqual(
    normalizeSearchQueries('  Current   NIST standards ', [
      'current nist standards',
      'site:nist.gov post quantum standards',
      'NIST standards July 2026',
      'ignored fourth query',
    ]),
    [
      'Current NIST standards',
      'site:nist.gov post quantum standards',
      'NIST standards July 2026',
    ],
  );
});

test('resolveSearchRecency honors explicit windows and infers changing queries', () => {
  assert.strictEqual(resolveSearchRecency('year', ['anything']), 'year');
  assert.strictEqual(resolveSearchRecency('auto', ['weather in Toronto today']), 'day');
  assert.strictEqual(resolveSearchRecency('auto', ['latest framework release']), 'month');
  assert.strictEqual(resolveSearchRecency('auto', ['history of cryptography']), 'none');
  assert.strictEqual(duckDuckGoDateCode('week'), 'w');
  assert.strictEqual(duckDuckGoDateCode('none'), null);
});

test('aggregateSearchResults deduplicates tracking URLs and records corroborating queries', () => {
  const results = aggregateSearchResults([
    {
      query: 'example research',
      results: [
        { title: 'Example', url: 'https://example.com/report?utm_source=test', snippet: 'one' },
      ],
    },
    {
      query: 'example research official',
      results: [
        { title: 'Example report', url: 'https://www.example.com/report/', snippet: 'two' },
      ],
    },
  ]);

  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].sourceId, 'S1');
  assert.strictEqual(results[0].queryMatches, 2);
  assert.deepStrictEqual(results[0].sourceQueries, ['example research', 'example research official']);
});

test('aggregateSearchResults boosts official sources and limits domain concentration', () => {
  const results = aggregateSearchResults([
    {
      query: 'post quantum standards',
      results: [
        { title: 'Blog one', url: 'https://blog.example.com/one', snippet: '' },
        { title: 'Blog two', url: 'https://example.com/two', snippet: '' },
        { title: 'NIST standard', url: 'https://www.nist.gov/pqc', snippet: '' },
        { title: 'Blog three', url: 'https://shop.example.com/three', snippet: '' },
      ],
    },
  ], 8);

  assert.strictEqual(results[0].sourceType, 'official');
  assert.ok(results.filter((result) => getDomainKey(result.url) === 'example.com').length <= 2);
  assert.deepStrictEqual(results.map((result) => result.sourceId), ['S1', 'S2', 'S3']);
});

test('selectDiverseResults prefers different registrable domains before duplicates', () => {
  const selected = selectDiverseResults([
    { sourceId: 'S1', url: 'https://docs.example.com/a' },
    { sourceId: 'S2', url: 'https://blog.example.com/b' },
    { sourceId: 'S3', url: 'https://nist.gov/c' },
    { sourceId: 'S4', url: 'https://ietf.org/d' },
  ], 3);

  assert.deepStrictEqual(selected.map((result) => result.sourceId), ['S1', 'S3', 'S4']);
});
