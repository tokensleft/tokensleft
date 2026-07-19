#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import {
  mergePricingEntries,
  parseLiteLlmPricing,
  parseModelsDevPricing,
} from '../lib/model-pricing.js';

const LITELLM_REVISION = '49ca04d8c3ddea336237ce6f3082dbc26d19e944';
const DEFAULT_LITELLM_URL = `https://raw.githubusercontent.com/BerriAI/litellm/${LITELLM_REVISION}/model_prices_and_context_window.json`;
const DEFAULT_MODELS_DEV_URL = 'https://models.dev/api.json';
const OUTPUT_URL = new URL('../lib/model-pricing.snapshot.json', import.meta.url);

function options(argv) {
  const result = {};

  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];

    if (!key?.startsWith('--') || !value) {
      throw new Error('usage: update-model-pricing [--litellm path-or-url] [--models-dev path-or-url]');
    }

    result[key.slice(2)] = value;
  }

  return result;
}

async function loadJson(location) {
  if (/^https?:\/\//i.test(location)) {
    const response = await fetch(location, { signal: AbortSignal.timeout(30_000) });

    if (!response.ok) {
      throw new Error(`${location} returned HTTP ${response.status}`);
    }

    return response.json();
  }

  return JSON.parse(await readFile(location, 'utf8'));
}

const args = options(process.argv.slice(2));
const litellmLocation = args.litellm || DEFAULT_LITELLM_URL;
const modelsDevLocation = args['models-dev'] || DEFAULT_MODELS_DEV_URL;
const [litellm, modelsDev] = await Promise.all([
  loadJson(litellmLocation),
  loadJson(modelsDevLocation),
]);
const primary = parseLiteLlmPricing(litellm);
const entries = mergePricingEntries(primary, parseModelsDevPricing(modelsDev));
const sortedEntries = Object.fromEntries(
  Object.entries(entries).sort(([left], [right]) => left.localeCompare(right)),
);
const snapshot = {
  version: 1,
  generatedAt: new Date().toISOString(),
  sources: {
    litellm: {
      revision: LITELLM_REVISION,
      url: DEFAULT_LITELLM_URL,
    },
    modelsDev: {
      url: DEFAULT_MODELS_DEV_URL,
    },
  },
  entries: sortedEntries,
};

await writeFile(OUTPUT_URL, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
console.log(`updated ${Object.keys(sortedEntries).length} model prices`);
