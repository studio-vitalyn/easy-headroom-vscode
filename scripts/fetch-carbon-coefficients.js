#!/usr/bin/env node
/**
 * Refreshes resources/carbon-coefficients.json from carbon-llm.com's published methodology
 * table. Run manually (`node scripts/fetch-carbon-coefficients.js`) when that page updates —
 * not part of the build, since it depends on a third-party network resource.
 *
 * carbon-llm.com's methodology page is a client-rendered app, but the coefficient table itself
 * is server-rendered as a plain HTML <table> (confirmed by fetching the page directly) — this
 * regex-parses that table rather than adding an HTML-parser dependency for one table.
 */
const fs = require('fs');
const path = require('path');

const METHODOLOGY_URL = 'https://carbon-llm.com/methodology';
const OUTPUT_PATH = path.join(__dirname, '..', 'resources', 'carbon-coefficients.json');

// Fallback for any model not in the scraped table — carbon-llm.com's own documented policy for
// unrecognized model slugs ("classe GPT-4"), so this isn't a number we invented.
const FALLBACK = {
  value: 0.3,
  confidence: 'estimated',
  note: "Generic unlisted-model coefficient (GPT-4 class), per carbon-llm.com's own fallback policy for unrecognized model slugs.",
};

function decodeEntities(s) {
  return s
    .replace(/&#x27;/g, "'")
    .replace(/&rsquo;/g, '’')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function stripTags(s) {
  return decodeEntities(s.replace(/<[^>]+>/g, '')).trim();
}

/** Shortened to the citation only (paper/report + year) — the full sentence-level methodology
 *  detail lives on carbon-llm.com/methodology itself, linked via `source_url` in the output. */
function shortenSource(source) {
  const citation = source.match(/^[^—]+/);
  return (citation ? citation[0] : source).trim();
}

function parseCoefficientTable(html) {
  const tables = [...html.matchAll(/<table[\s\S]*?<\/table>/g)];
  for (const match of tables) {
    const tableHtml = match[0];
    const rows = [...tableHtml.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)];
    const parsed = [];
    for (const row of rows) {
      const cells = [...row[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => stripTags(c[1]));
      if (cells.length !== 4) continue;
      const [model, coeff, confidence, source] = cells;
      if (!/^[a-z0-9.-]+$/i.test(model) || Number.isNaN(Number(coeff))) continue;
      parsed.push({ model, value: Number(coeff), confidence: confidence.toLowerCase(), source });
    }
    // The coefficient table is the one with >20 model rows — other <table>s on this page compare
    // integration methods and have unrelated structure.
    if (parsed.length > 20) return parsed;
  }
  return [];
}

async function main() {
  const res = await fetch(METHODOLOGY_URL, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`GET ${METHODOLOGY_URL} → HTTP ${res.status}`);
  const html = await res.text();

  const allRows = parseCoefficientTable(html);
  if (allRows.length === 0) {
    throw new Error('Could not find the coefficient table on the methodology page — page structure may have changed.');
  }

  const claudeRows = allRows.filter((r) => r.model.startsWith('claude-'));
  if (claudeRows.length === 0) {
    throw new Error('Found the coefficient table but no claude-* rows — page structure may have changed.');
  }

  const models = {};
  for (const row of claudeRows) {
    models[row.model] = { value: row.value, confidence: row.confidence, source: shortenSource(row.source) };
  }

  const output = {
    source_url: METHODOLOGY_URL,
    fetched_at: new Date().toISOString(),
    unit: 'g_co2e_per_1k_tokens',
    models,
    fallback: FALLBACK,
  };

  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2) + '\n');
  console.log(`Wrote ${Object.keys(models).length} Claude model coefficients to ${OUTPUT_PATH}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
