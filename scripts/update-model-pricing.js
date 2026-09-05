#!/usr/bin/env node

// Regenerates lib/model-pricing.snapshot.json from LiteLLM and models.dev.
//
//   npm run pricing:update
//   node scripts/update-model-pricing.js --litellm-revision <sha>
//   node scripts/update-model-pricing.js --litellm ./prices.json --models-dev ./api.json
//
// LiteLLM is read at one specific commit — the tip of `main` unless
// --litellm-revision pins it — and that revision is recorded in the snapshot,
// so the embedded prices stay reproducible while still moving forward on
// every run.
import { readFile, writeFile } from 'node:fs/promises';
import {
  mergePricingEntries,
  parseLiteLlmPricing,
  parseModelsDevPricing,
} from '../lib/model-pricing.js';

const LITELLM_REPO = 'BerriAI/litellm';
const LITELLM_BRANCH = 'main';
const LITELLM_FILE = 'model_prices_and_context_window.json';
const DEFAULT_MODELS_DEV_URL = 'https://models.dev/api.json';
const OUTPUT_URL = new URL('../lib/model-pricing.snapshot.json', import.meta.url);
const REQUEST_TIMEOUT_MS = 30_000;
const USAGE = 'usage: update-model-pricing [--litellm path-or-url] [--litellm-revision sha] [--models-dev path-or-url]';
const KNOWN_OPTIONS = new Set(['litellm', 'litellm-revision', 'models-dev']);

function options(argv) {
  const result = {};

  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];

    if (!key?.startsWith('--') || !KNOWN_OPTIONS.has(key.slice(2)) || !value) {
      throw new Error(USAGE);
    }

    result[key.slice(2)] = value;
  }

  return result;
}

async function fetchJson(url, headers = {}) {
  const response = await fetch(url, {
    headers: { 'User-Agent': 'tokensleft', ...headers },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`${url} returned HTTP ${response.status}`);
  }

  return response.json();
}

async function loadJson(location) {
  if (/^https?:\/\//i.test(location)) {
    return fetchJson(location);
  }

  return JSON.parse(await readFile(location, 'utf8'));
}

async function resolveLiteLlmRevision(pinned) {
  if (pinned) {
    if (!/^[0-9a-f]{7,40}$/i.test(pinned)) {
      throw new Error(`--litellm-revision expects a commit sha, got: ${pinned}`);
    }

    return pinned;
  }

  const commit = await fetchJson(
    `https://api.github.com/repos/${LITELLM_REPO}/commits/${LITELLM_BRANCH}`,
    { Accept: 'application/vnd.github+json' },
  );

  if (typeof commit?.sha !== 'string' || !/^[0-9a-f]{40}$/.test(commit.sha)) {
    throw new Error(`GitHub did not return a commit sha for ${LITELLM_REPO}@${LITELLM_BRANCH}`);
  }

  return commit.sha;
}

const args = options(process.argv.slice(2));
const litellmRevision = args.litellm ? null : await resolveLiteLlmRevision(args['litellm-revision']);
const litellmLocation = args.litellm
  || `https://raw.githubusercontent.com/${LITELLM_REPO}/${litellmRevision}/${LITELLM_FILE}`;
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
      revision: litellmRevision || 'local file',
      url: litellmLocation,
    },
    modelsDev: {
      url: modelsDevLocation,
    },
  },
  entries: sortedEntries,
};

await writeFile(OUTPUT_URL, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
console.log(`updated ${Object.keys(sortedEntries).length} model prices (LiteLLM ${litellmRevision ? litellmRevision.slice(0, 12) : 'local'})`);
