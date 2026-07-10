const DEFAULT_MAX_QUERIES = 3;
const DEFAULT_MAX_RESULTS = 8;
const MAX_QUERY_CHARS = 500;

const TRACKING_PARAMETERS = new Set([
  'fbclid',
  'gclid',
  'mc_cid',
  'mc_eid',
  'ref_src',
]);

const COMMON_SECOND_LEVEL_SUFFIXES = new Set([
  'ac.uk', 'co.uk', 'gov.uk', 'org.uk',
  'com.au', 'edu.au', 'gov.au', 'org.au',
  'co.ca', 'gc.ca',
  'co.jp', 'co.nz', 'co.za',
]);

const OFFICIAL_HOSTS = new Set([
  'canada.ca',
  'europa.eu',
  'ietf.org',
  'nist.gov',
  'un.org',
  'w3.org',
  'who.int',
]);

const ACADEMIC_HOSTS = new Set([
  'arxiv.org',
  'doi.org',
  'ncbi.nlm.nih.gov',
  'pubmed.ncbi.nlm.nih.gov',
]);

const REFERENCE_HOSTS = new Set([
  'britannica.com',
  'wikipedia.org',
]);

const COMMUNITY_HOSTS = new Set([
  'news.ycombinator.com',
  'quora.com',
  'reddit.com',
  'stackoverflow.com',
]);

function normalizeQuery(value) {
  if (typeof value !== 'string') return '';
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  if (normalized.length > MAX_QUERY_CHARS) {
    throw new Error(`Search queries must be ${MAX_QUERY_CHARS} characters or fewer.`);
  }
  return normalized;
}

export function normalizeSearchQueries(primaryQuery, additionalQueries = [], maxQueries = DEFAULT_MAX_QUERIES) {
  const extras = Array.isArray(additionalQueries)
    ? additionalQueries.slice(0, Math.max(maxQueries * 4, maxQueries))
    : [];
  const candidates = [primaryQuery, ...extras];
  const queries = [];
  const seen = new Set();

  for (const candidate of candidates) {
    const query = normalizeQuery(candidate);
    if (!query) continue;
    const key = query.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    queries.push(query);
    if (queries.length >= maxQueries) break;
  }

  return queries;
}

export function resolveSearchRecency(requestedRecency, queries = []) {
  const requested = typeof requestedRecency === 'string' ? requestedRecency.toLowerCase() : 'auto';
  if (['none', 'day', 'week', 'month', 'year'].includes(requested)) return requested;

  const queryText = queries.join(' ').toLowerCase();
  if (/\b(today|tonight|right now|breaking|live score|weather)\b/.test(queryText)) return 'day';
  if (/\b(this week|latest news|recent news)\b/.test(queryText)) return 'week';
  if (/\b(latest|current|recent|newest|price|schedule|release date)\b/.test(queryText)) return 'month';
  return 'none';
}

export function duckDuckGoDateCode(recency) {
  return ({ day: 'd', week: 'w', month: 'm', year: 'y' })[recency] || null;
}

function canonicalizeResultUrl(value) {
  const url = new URL(value);
  url.hash = '';
  url.hostname = url.hostname.toLowerCase();
  for (const key of [...url.searchParams.keys()]) {
    if (key.toLowerCase().startsWith('utm_') || TRACKING_PARAMETERS.has(key.toLowerCase())) {
      url.searchParams.delete(key);
    }
  }
  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, '');
  return url.href;
}

function canonicalResultKey(value) {
  const url = new URL(canonicalizeResultUrl(value));
  url.hostname = url.hostname.replace(/^www\./, '');
  return url.href;
}

export function getDomainKey(value) {
  const hostname = new URL(value).hostname.toLowerCase().replace(/^www\./, '');
  const labels = hostname.split('.').filter(Boolean);
  if (labels.length <= 2) return hostname;
  const lastTwo = labels.slice(-2).join('.');
  return COMMON_SECOND_LEVEL_SUFFIXES.has(lastTwo)
    ? labels.slice(-3).join('.')
    : lastTwo;
}

function hostnameMatches(hostname, candidate) {
  return hostname === candidate || hostname.endsWith(`.${candidate}`);
}

function extractTargetedHosts(queries) {
  const hosts = new Set();
  for (const query of queries) {
    const matches = String(query).matchAll(/\bsite:([a-z0-9.-]+)/gi);
    for (const match of matches) {
      const host = match[1].toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
      if (host) hosts.add(host);
    }
  }
  return hosts;
}

export function classifySource(urlValue, sourceQueries = []) {
  const hostname = new URL(urlValue).hostname.toLowerCase().replace(/^www\./, '');
  const targetedHosts = extractTargetedHosts(sourceQueries);

  if (
    hostname.endsWith('.gov') ||
    hostname.endsWith('.mil') ||
    hostname.endsWith('.gc.ca') ||
    hostname.endsWith('.gov.au') ||
    hostname.endsWith('.gov.uk') ||
    [...OFFICIAL_HOSTS].some((host) => hostnameMatches(hostname, host))
  ) return 'official';

  if (
    hostname.endsWith('.edu') ||
    hostname.endsWith('.ac.uk') ||
    [...ACADEMIC_HOSTS].some((host) => hostnameMatches(hostname, host))
  ) return 'academic';

  if ([...targetedHosts].some((host) => hostnameMatches(hostname, host))) return 'targeted';
  if ([...REFERENCE_HOSTS].some((host) => hostnameMatches(hostname, host))) return 'reference';
  if ([...COMMUNITY_HOSTS].some((host) => hostnameMatches(hostname, host))) return 'community';
  return 'general';
}

function sourceTypeBonus(sourceType) {
  return ({ official: 24, academic: 16, targeted: 12, reference: 4, community: -10 })[sourceType] || 0;
}

export function aggregateSearchResults(resultGroups, maxResults = DEFAULT_MAX_RESULTS) {
  const merged = new Map();

  for (const group of Array.isArray(resultGroups) ? resultGroups : []) {
    const query = normalizeQuery(group?.query);
    if (!query || !Array.isArray(group?.results)) continue;

    for (let rank = 0; rank < group.results.length; rank += 1) {
      const result = group.results[rank];
      if (!result || typeof result.url !== 'string') continue;

      let canonicalUrl;
      let canonicalKey;
      try {
        canonicalUrl = canonicalizeResultUrl(result.url);
        canonicalKey = canonicalResultKey(canonicalUrl);
      } catch {
        continue;
      }

      const existing = merged.get(canonicalKey);
      if (existing) {
        existing.bestRank = Math.min(existing.bestRank, rank);
        if (!existing.sourceQueries.includes(query)) existing.sourceQueries.push(query);
        if (!existing.snippet && result.snippet) existing.snippet = result.snippet;
        if (!existing.article && result.article) {
          existing.article = result.article;
          existing.articleSource = result.articleSource;
        }
        if (!existing.publishedAt && result.publishedAt) existing.publishedAt = result.publishedAt;
        continue;
      }

      merged.set(canonicalKey, {
        ...result,
        url: canonicalUrl,
        title: typeof result.title === 'string' && result.title.trim() ? result.title.trim() : canonicalUrl,
        snippet: typeof result.snippet === 'string' ? result.snippet.trim() : '',
        bestRank: rank,
        sourceQueries: [query],
      });
    }
  }

  const ranked = [...merged.values()].map((result) => {
    const sourceType = classifySource(result.url, result.sourceQueries);
    const queryMatches = result.sourceQueries.length;
    const rankScore = Math.max(0, 100 - (result.bestRank * 10)) +
      ((queryMatches - 1) * 24) +
      sourceTypeBonus(sourceType);
    return { ...result, sourceType, queryMatches, rankScore };
  }).sort((a, b) => b.rankScore - a.rankScore || a.bestRank - b.bestRank || a.url.localeCompare(b.url));

  const selected = [];
  const domainCounts = new Map();
  for (const result of ranked) {
    const domain = getDomainKey(result.url);
    const count = domainCounts.get(domain) || 0;
    if (count >= 2) continue;
    domainCounts.set(domain, count + 1);
    selected.push(result);
    if (selected.length >= maxResults) break;
  }

  return selected.map((result, index) => ({
    ...result,
    sourceId: `S${index + 1}`,
  }));
}

export function selectDiverseResults(results, limit = 4) {
  const selected = [];
  const deferred = [];
  const domains = new Set();

  for (const result of Array.isArray(results) ? results : []) {
    let domain;
    try {
      domain = getDomainKey(result.url);
    } catch {
      continue;
    }
    if (domains.has(domain)) {
      deferred.push(result);
      continue;
    }
    domains.add(domain);
    selected.push(result);
    if (selected.length >= limit) return selected;
  }

  for (const result of deferred) {
    selected.push(result);
    if (selected.length >= limit) break;
  }
  return selected;
}
