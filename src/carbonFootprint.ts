import * as fs from 'fs/promises';
import * as path from 'path';

interface CoefficientEntry {
  value: number;
  confidence: string;
  source?: string;
  note?: string;
}

interface CoefficientsFile {
  source_url: string;
  unit: string;
  models: Record<string, CoefficientEntry>;
  fallback: CoefficientEntry;
}

export interface CarbonModelEstimate {
  model: string;
  sentTokens: number;
  savedTokens: number;
  sentGrams: number;
  avoidedGrams: number;
  matchedCoefficientModel: string;
  confidence: string;
}

export interface CarbonEstimate {
  totalSentGrams: number;
  totalAvoidedGrams: number;
  perModel: CarbonModelEstimate[];
  sourceUrl: string;
}

let coefficientsPromise: Promise<CoefficientsFile> | undefined;

// See esbuild.js's copyCarbonCoefficients() — bundled CJS output's __dirname resolves to dist/
// at runtime, same reasoning as rtkDb.ts's sql-wasm.wasm lookup.
function loadCoefficients(): Promise<CoefficientsFile> {
  if (!coefficientsPromise) {
    coefficientsPromise = fs
      .readFile(path.join(__dirname, 'carbon-coefficients.json'), 'utf8')
      .then((raw) => JSON.parse(raw) as CoefficientsFile);
  }
  return coefficientsPromise;
}

/**
 * carbon-llm.com's catalog only covers the Claude 3/4 generations, not whatever's currently
 * live (e.g. `claude-sonnet-5`) — map by tier (opus/sonnet/haiku) to the newest cataloged entry
 * for that tier, explicitly downgraded to "estimated" confidence rather than claimed as a match.
 */
function matchCoefficient(
  model: string,
  coeffs: CoefficientsFile
): CoefficientEntry & { matchedModel: string } {
  const exact = coeffs.models[model];
  if (exact) return { ...exact, matchedModel: model };

  const lower = model.toLowerCase();
  const tierFallback = lower.includes('opus')
    ? 'claude-4-opus'
    : lower.includes('haiku')
      ? 'claude-3-haiku'
      : lower.includes('sonnet')
        ? 'claude-4-sonnet'
        : undefined;
  const tierEntry = tierFallback ? coeffs.models[tierFallback] : undefined;
  if (tierEntry) {
    return { ...tierEntry, confidence: 'estimated', matchedModel: tierFallback as string };
  }

  return { ...coeffs.fallback, matchedModel: 'fallback' };
}

interface HeadroomByModelEntry {
  tokens_saved?: number;
  total_input_tokens?: number;
}

/**
 * Combines Headroom's own per-model token stats (from `/stats`' `persistent_savings.by_model` —
 * the only layer that knows which model handled a request; RTK's schema has no model column at
 * all) with carbon-llm.com's published per-1k-token coefficients. Indicative only: neither
 * Anthropic nor Headroom publish an official per-token carbon figure.
 */
export async function computeCarbonEstimate(
  byModel: Record<string, HeadroomByModelEntry> | undefined
): Promise<CarbonEstimate | undefined> {
  if (!byModel || Object.keys(byModel).length === 0) return undefined;
  const coeffs = await loadCoefficients();

  let totalSentGrams = 0;
  let totalAvoidedGrams = 0;
  const perModel: CarbonModelEstimate[] = [];

  for (const [model, entry] of Object.entries(byModel)) {
    const sentTokens = entry.total_input_tokens ?? 0;
    const savedTokens = entry.tokens_saved ?? 0;
    const coeff = matchCoefficient(model, coeffs);
    const sentGrams = (sentTokens / 1000) * coeff.value;
    const avoidedGrams = (savedTokens / 1000) * coeff.value;
    totalSentGrams += sentGrams;
    totalAvoidedGrams += avoidedGrams;
    perModel.push({
      model,
      sentTokens,
      savedTokens,
      sentGrams,
      avoidedGrams,
      matchedCoefficientModel: coeff.matchedModel,
      confidence: coeff.confidence,
    });
  }

  perModel.sort((a, b) => b.sentGrams - a.sentGrams);
  return { totalSentGrams, totalAvoidedGrams, perModel, sourceUrl: coeffs.source_url };
}
