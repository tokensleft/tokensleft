import { readFileSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { configPath, writeFileAtomic } from './fsx.js';
import { fetchJson } from './http.js';

export const LITELLM_PRICING_URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
export const MODELS_DEV_PRICING_URL = 'https://models.dev/api.json';
export const PRICING_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const CACHE_PATH = configPath('model-pricing.json');
const FETCH_TIMEOUT_MS = 5_000;
const SNAPSHOT_VERSION = 1;
const MAX_PRICE_PER_MILLION = 1_000_000;
const MAX_REMOTE_MODELS = 10_000;
const DEFAULT_LONG_CONTEXT_THRESHOLD = 200_000;
const OPENAI_LONG_CONTEXT_THRESHOLD = 272_000;
const SONNET_5_PROMO_END = Date.parse('2026-09-01T00:00:00Z');
const MODELS_DEV_PROVIDERS = new Set(['anthropic', 'openai', 'google', 'moonshotai', 'zai']);
const LITELLM_CANONICAL_MODEL = /^(?:claude-|gpt-|codex-|o\d(?:-|$)|gemini-|kimi-|moonshot-|glm-)/i;
const PROVIDER_PREFIX = /^(?:openai|anthropic|google|gemini|moonshotai|moonshot|kimi-code|zai|z-ai|zhipuai)\/+/i;
const MODEL_ALIASES = new Map([
  ['claude-opus-4', 'claude-opus-4-20250514'],
  ['claude-sonnet-4', 'claude-sonnet-4-20250514'],
  ['gpt-5-codex-mini', 'gpt-5-mini'],
  ['gpt-5.1-mini', 'gpt-5.1-codex-mini'],
  ['gpt-5.1-nano', 'gpt-5-nano'],
]);
const SUPPLEMENT_FIELDS = [
  'cacheRead',
  'cacheWrite',
  'inputAbove',
  'outputAbove',
  'cacheReadAbove',
  'cacheWriteAbove',
  'threshold',
  'tierMode',
  'context',
];

const EMBEDDED_SNAPSHOT = JSON.parse(readFileSync(
  new URL('./model-pricing.snapshot.json', import.meta.url),
  'utf8',
));

function finitePrice(value) {
  const price = Number(value);
  return Number.isFinite(price) && price >= 0 && price <= MAX_PRICE_PER_MILLION
    ? price
    : null;
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function scaledPrice(value, multiplier) {
  return Math.round(value * multiplier * 1e12) / 1e12;
}

function optionalField(target, key, value) {
  if (value !== null && value !== undefined) {
    target[key] = value;
  }
}

function safeModelKey(model) {
  return typeof model === 'string'
    && model.length > 0
    && model.length <= 300
    && !['__proto__', 'prototype', 'constructor'].includes(model);
}

function normalizeEntry(raw, fallbackSource = '') {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }

  const input = finitePrice(raw.input);
  const output = finitePrice(raw.output);

  if (input === null || output === null) {
    return null;
  }

  const entry = { input, output };

  for (const key of ['cacheRead', 'cacheWrite', 'inputAbove', 'outputAbove', 'cacheReadAbove', 'cacheWriteAbove']) {
    optionalField(entry, key, finitePrice(raw[key]));
  }

  optionalField(entry, 'threshold', positiveInteger(raw.threshold));
  optionalField(entry, 'context', positiveInteger(raw.context));

  if (raw.tierMode === 'whole' || raw.tierMode === 'marginal') {
    entry.tierMode = raw.tierMode;
  }

  entry.source = typeof raw.source === 'string' && raw.source
    ? raw.source
    : fallbackSource;
  return entry;
}

function normalizeEntries(raw, fallbackSource = '') {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }

  const entries = {};

  for (const [model, value] of Object.entries(raw).slice(0, MAX_REMOTE_MODELS)) {
    if (!safeModelKey(model)) {
      continue;
    }

    const entry = normalizeEntry(value, fallbackSource);

    if (entry) {
      entries[model] = entry;
    }
  }

  return Object.keys(entries).length > 0 ? entries : null;
}

function perMillion(value) {
  const perToken = finitePrice(value);

  if (perToken === null) {
    return null;
  }

  return finitePrice(Math.round(perToken * 1_000_000 * 1e12) / 1e12);
}

export function parseLiteLlmPricing(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {};
  }

  const entries = {};

  for (const [model, value] of Object.entries(raw).slice(0, MAX_REMOTE_MODELS)) {
    if (!safeModelKey(model) || !LITELLM_CANONICAL_MODEL.test(model) || !value || typeof value !== 'object') {
      continue;
    }

    const input = perMillion(value.input_cost_per_token);
    const output = perMillion(value.output_cost_per_token);

    if (input === null || output === null) {
      continue;
    }

    const entry = { input, output, source: 'LiteLLM' };
    optionalField(entry, 'cacheRead', perMillion(value.cache_read_input_token_cost));
    optionalField(entry, 'cacheWrite', perMillion(value.cache_creation_input_token_cost));
    optionalField(entry, 'inputAbove', perMillion(value.input_cost_per_token_above_200k_tokens));
    optionalField(entry, 'outputAbove', perMillion(value.output_cost_per_token_above_200k_tokens));
    optionalField(entry, 'cacheReadAbove', perMillion(value.cache_read_input_token_cost_above_200k_tokens));
    optionalField(entry, 'cacheWriteAbove', perMillion(value.cache_creation_input_token_cost_above_200k_tokens));
    optionalField(entry, 'context', positiveInteger(value.max_input_tokens));

    if (entry.inputAbove !== undefined
      || entry.outputAbove !== undefined
      || entry.cacheReadAbove !== undefined
      || entry.cacheWriteAbove !== undefined) {
      entry.threshold = DEFAULT_LONG_CONTEXT_THRESHOLD;
      entry.tierMode = 'marginal';
    }

    entries[model] = entry;
  }

  return entries;
}

function modelsDevTier(cost, model) {
  const tiers = Array.isArray(cost?.tiers) ? cost.tiers : [];
  const tier = tiers
    .filter((candidate) => candidate?.tier?.type === 'context' && positiveInteger(candidate.tier.size))
    .sort((left, right) => left.tier.size - right.tier.size)[0];
  const fallback = cost?.context_over_200k;
  const source = tier || (fallback && typeof fallback === 'object' ? fallback : null);

  if (!source) {
    return null;
  }

  const threshold = tier
    ? positiveInteger(tier.tier.size)
    : /^gpt-5\.[4-9]/i.test(model)
      ? OPENAI_LONG_CONTEXT_THRESHOLD
      : DEFAULT_LONG_CONTEXT_THRESHOLD;
  const result = { threshold, tierMode: 'whole' };
  optionalField(result, 'inputAbove', finitePrice(source.input));
  optionalField(result, 'outputAbove', finitePrice(source.output));
  optionalField(result, 'cacheReadAbove', finitePrice(source.cache_read));
  optionalField(result, 'cacheWriteAbove', finitePrice(source.cache_write));
  return result;
}

export function parseModelsDevPricing(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {};
  }

  const entries = {};

  for (const providerId of MODELS_DEV_PROVIDERS) {
    const models = raw[providerId]?.models;

    if (!models || typeof models !== 'object' || Array.isArray(models)) {
      continue;
    }

    for (const [modelKey, model] of Object.entries(models).slice(0, MAX_REMOTE_MODELS)) {
      const id = typeof model?.id === 'string' && model.id ? model.id : modelKey;
      const input = finitePrice(model?.cost?.input);
      const output = finitePrice(model?.cost?.output);

      if (!safeModelKey(id) || input === null || output === null) {
        continue;
      }

      const entry = { input, output, source: 'models.dev' };
      optionalField(entry, 'cacheRead', finitePrice(model.cost.cache_read));
      optionalField(entry, 'cacheWrite', finitePrice(model.cost.cache_write));
      optionalField(entry, 'context', positiveInteger(model?.limit?.context));
      Object.assign(entry, modelsDevTier(model.cost, id) || {});
      entries[id] = entry;
    }
  }

  return entries;
}

function combinedSource(primary, supplement) {
  const sources = new Set(
    `${primary || ''}+${supplement || ''}`
      .split('+')
      .map((source) => source.trim())
      .filter(Boolean),
  );
  return [...sources].join('+');
}

export function mergePricingEntries(primary = {}, incoming = {}, { overwrite = false } = {}) {
  const merged = { ...primary };

  for (const [model, raw] of Object.entries(incoming)) {
    const entry = normalizeEntry(raw);

    if (!entry) {
      continue;
    }

    const current = merged[model];

    if (!current) {
      merged[model] = entry;
      continue;
    }

    if (overwrite) {
      merged[model] = {
        ...current,
        ...entry,
        source: entry.source || current.source,
      };
      continue;
    }

    const supplemented = { ...current };
    let changed = false;

    for (const field of SUPPLEMENT_FIELDS) {
      if (supplemented[field] === undefined && entry[field] !== undefined) {
        supplemented[field] = entry[field];
        changed = true;
      }
    }

    if (changed) {
      supplemented.source = combinedSource(current.source, entry.source);
    }

    merged[model] = supplemented;
  }

  return merged;
}

function pricingSnapshotEntries(snapshot) {
  if (snapshot?.version !== SNAPSHOT_VERSION) {
    return null;
  }

  return normalizeEntries(snapshot.entries);
}

const snapshotEntries = pricingSnapshotEntries(EMBEDDED_SNAPSHOT);

if (!snapshotEntries) {
  throw new Error('embedded model pricing snapshot is invalid');
}

const embeddedEntries = mergePricingEntries(snapshotEntries, {
  // Retain the private Claude Code model covered by the previous local table.
  'claude-mythos-5': {
    input: 10,
    output: 50,
    cacheRead: 1,
    cacheWrite: 12.5,
    context: 1_000_000,
    source: 'TokensLeft fallback',
  },
});

function normalizedModelName(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^\[[^\]]+\]\s*/, '')
    .replace(/^models\//, '');
}

function modelCandidates(model) {
  const raw = normalizedModelName(model);

  if (!raw) {
    return [];
  }

  const candidates = new Set([raw]);
  let providerless = raw;

  while (PROVIDER_PREFIX.test(providerless)) {
    providerless = providerless.replace(PROVIDER_PREFIX, '');
    candidates.add(providerless);
  }

  if (/^k\d/i.test(providerless)) {
    candidates.add(`kimi-${providerless}`);
  }

  if (providerless === 'gpt-5.3-spark') {
    candidates.add('gpt-5.3-codex-spark');
  }

  for (const candidate of [...candidates]) {
    candidates.add(candidate.replace(/-\d{8}(?:-v\d(?::\d)?)?$/i, ''));
    candidates.add(candidate.replace(/-20\d{2}-\d{2}-\d{2}$/i, ''));
    candidates.add(candidate.replace(/@(?:default|\d{8})$/i, ''));
  }

  for (const candidate of [...candidates]) {
    const alias = MODEL_ALIASES.get(candidate);

    if (alias) {
      candidates.add(alias);
    }
  }

  return [...candidates].filter(Boolean);
}

export function createPricingResolver(entries) {
  const exact = new Map();

  for (const [model, pricing] of Object.entries(entries || {})) {
    exact.set(normalizedModelName(model), { key: normalizedModelName(model), pricing });
  }

  return (model) => {
    const candidates = modelCandidates(model);

    for (const candidate of candidates) {
      const found = exact.get(candidate);

      if (found) {
        return found;
      }
    }

    let best = null;

    for (const candidate of candidates) {
      for (const [key, found] of exact) {
        if ((candidate.startsWith(`${key}-`) || candidate.startsWith(`${key}@`))
          && (!best || key.length > best.key.length)) {
          best = found;
        }
      }
    }

    return best;
  };
}

let activeEntries = embeddedEntries;
let activeResolver = createPricingResolver(activeEntries);
const EMBEDDED_METADATA = {
  source: 'embedded',
  updatedAt: EMBEDDED_SNAPSHOT.generatedAt || null,
  sources: EMBEDDED_SNAPSHOT.sources || {},
};
let pricingMetadata = EMBEDDED_METADATA;

function setActivePricing(entries, metadata) {
  activeEntries = entries;
  activeResolver = createPricingResolver(entries);
  pricingMetadata = metadata;
}

function officialPricing(modelKey, pricing, now) {
  if (!/^claude-sonnet-5(?:$|-)/i.test(modelKey)) {
    return pricing;
  }

  const promotional = now < SONNET_5_PROMO_END;
  const input = promotional ? 2 : 3;
  const output = promotional ? 10 : 15;
  return {
    ...pricing,
    input,
    output,
    cacheRead: scaledPrice(input, 0.1),
    cacheWrite: scaledPrice(input, 1.25),
    source: combinedSource(pricing.source, 'Anthropic'),
  };
}

export function findModelPricing(model, { entries, now = Date.now() } = {}) {
  const found = entries
    ? createPricingResolver(entries)(model)
    : activeResolver(model);

  return found ? officialPricing(found.key, found.pricing, now) : null;
}

function tokenCount(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function tieredCost(tokens, base, above, threshold, mode, longContext) {
  if (tokens <= 0) {
    return 0;
  }

  if (above === undefined || !threshold) {
    return tokens * base;
  }

  if (mode === 'whole') {
    return tokens * (longContext ? above : base);
  }

  if (tokens > threshold) {
    return threshold * base + (tokens - threshold) * above;
  }

  return tokens * base;
}

export function calculateModelCost(model, usage, options = {}) {
  const pricing = findModelPricing(model, options);

  if (!pricing) {
    return null;
  }

  const input = tokenCount(usage?.input);
  const output = tokenCount(usage?.output);
  const cacheRead = tokenCount(usage?.cacheRead);
  const cacheWrite = tokenCount(usage?.cacheWrite);
  const cacheWrite5m = tokenCount(usage?.cacheWrite5m);
  const cacheWrite1h = tokenCount(usage?.cacheWrite1h);
  const totalInput = tokenCount(usage?.totalInput) || input + cacheRead + cacheWrite + cacheWrite5m + cacheWrite1h;
  const threshold = positiveInteger(pricing.threshold);
  const tierMode = pricing.tierMode || 'marginal';
  const longContext = Boolean(threshold && totalInput > threshold);
  // Match ccusage/LiteLLM when a source omits explicit cache rates.
  const cacheReadPrice = pricing.cacheRead ?? scaledPrice(pricing.input, 0.1);
  const cacheWritePrice = pricing.cacheWrite ?? scaledPrice(pricing.input, 1.25);
  const cacheWrite1hPrice = scaledPrice(pricing.input, 2);
  const cacheReadAbove = pricing.cacheReadAbove
    ?? (pricing.inputAbove !== undefined ? scaledPrice(pricing.inputAbove, 0.1) : undefined);
  const cacheWriteAbove = pricing.cacheWriteAbove
    ?? (pricing.inputAbove !== undefined ? scaledPrice(pricing.inputAbove, 1.25) : undefined);
  const cacheWrite1hAbove = pricing.inputAbove !== undefined
    ? scaledPrice(pricing.inputAbove, 2)
    : undefined;
  const total = tieredCost(input, pricing.input, pricing.inputAbove, threshold, tierMode, longContext)
    + tieredCost(output, pricing.output, pricing.outputAbove, threshold, tierMode, longContext)
    + tieredCost(cacheRead, cacheReadPrice, cacheReadAbove, threshold, tierMode, longContext)
    + tieredCost(cacheWrite + cacheWrite5m, cacheWritePrice, cacheWriteAbove, threshold, tierMode, longContext)
    + tieredCost(cacheWrite1h, cacheWrite1hPrice, cacheWrite1hAbove, threshold, tierMode, longContext);

  return total / 1_000_000;
}

function offlinePricing(env) {
  return /^(?:1|true|yes)$/i.test(env?.TOKENSLEFT_PRICING_OFFLINE || '');
}

function cacheTtl(env) {
  const hours = Number(env?.TOKENSLEFT_PRICING_TTL_HOURS);
  return Number.isFinite(hours) && hours > 0
    ? Math.min(hours, 24 * 30) * 60 * 60 * 1000
    : PRICING_CACHE_TTL_MS;
}

function snapshotTime(snapshot) {
  const timestamp = Date.parse(snapshot?.updatedAt || snapshot?.generatedAt || '');
  return Number.isFinite(timestamp) ? timestamp : 0;
}

export async function initializeModelPricing({
  env = process.env,
  now = Date.now(),
  cachePath = CACHE_PATH,
  fetchJsonFn = fetchJson,
  readFileFn = readFile,
  writeFileFn = writeFileAtomic,
  mkdirFn = mkdir,
  minimumEntries = 10,
} = {}) {
  let entries = embeddedEntries;
  let cachedSnapshot = null;
  let cacheLoaded = false;
  setActivePricing(entries, EMBEDDED_METADATA);

  try {
    cachedSnapshot = JSON.parse(await readFileFn(cachePath, 'utf8'));
    const cachedEntries = pricingSnapshotEntries(cachedSnapshot);

    if (cachedEntries && Object.keys(cachedEntries).length >= minimumEntries) {
      cacheLoaded = true;
      entries = mergePricingEntries(entries, cachedEntries, { overwrite: true });
      setActivePricing(entries, {
        source: 'cache',
        updatedAt: cachedSnapshot.updatedAt || null,
        sources: cachedSnapshot.sources || {},
      });
    }
  } catch {
    // A missing or damaged cache never makes local usage unavailable.
  }

  const cacheAge = cacheLoaded ? now - snapshotTime(cachedSnapshot) : Infinity;

  if (offlinePricing(env) || (cacheAge >= 0 && cacheAge < cacheTtl(env))) {
    return getPricingMetadata();
  }

  const [litellmResult, modelsDevResult] = await Promise.allSettled([
    Promise.resolve().then(() => fetchJsonFn(LITELLM_PRICING_URL, { timeoutMs: FETCH_TIMEOUT_MS })),
    Promise.resolve().then(() => fetchJsonFn(MODELS_DEV_PRICING_URL, { timeoutMs: FETCH_TIMEOUT_MS })),
  ]);
  const liveLiteLlm = litellmResult.status === 'fulfilled'
    ? parseLiteLlmPricing(litellmResult.value)
    : {};
  const liveModelsDev = modelsDevResult.status === 'fulfilled'
    ? parseModelsDevPricing(modelsDevResult.value)
    : {};
  const liteLlmValid = Object.keys(liveLiteLlm).length >= minimumEntries;
  const modelsDevValid = Object.keys(liveModelsDev).length >= minimumEntries;

  if (!liteLlmValid && !modelsDevValid) {
    return getPricingMetadata();
  }

  const liveEntries = liteLlmValid && modelsDevValid
    ? mergePricingEntries(liveLiteLlm, liveModelsDev)
    : liteLlmValid
      ? liveLiteLlm
      : liveModelsDev;
  entries = mergePricingEntries(entries, liveEntries, { overwrite: true });

  const updatedAt = new Date(now).toISOString();
  const sources = {
    litellm: liteLlmValid ? LITELLM_PRICING_URL : 'last-known-good',
    modelsDev: modelsDevValid ? MODELS_DEV_PRICING_URL : 'last-known-good',
  };
  setActivePricing(entries, { source: 'live', updatedAt, sources });

  try {
    await mkdirFn(dirname(cachePath), { recursive: true });
    await writeFileFn(cachePath, `${JSON.stringify({
      version: SNAPSHOT_VERSION,
      updatedAt,
      sources,
      entries,
    }, null, 2)}\n`, { mode: 0o600, preserveMode: true });
  } catch {
    // The in-memory refresh is still useful when the cache is not writable.
  }

  return getPricingMetadata();
}

export function getPricingMetadata() {
  return {
    ...pricingMetadata,
    sources: { ...pricingMetadata.sources },
    models: Object.keys(activeEntries).length,
  };
}
