import { NextResponse } from "next/server";
import { Anthropic } from "@posthog/ai/anthropic";
import OpenAI from "openai";
import { GoogleGenAI } from "@google/genai";
import { normalizeFighterName } from "../../lib/fighterName";
import { supabaseAdmin } from "../../lib/supabaseAdmin";
import {
  ValidationError,
  readJsonBody,
  assertPlainObject,
  assertKnownKeys,
  assertRequiredString,
  assertFiniteNumber,
  assertLooseScalar,
  withTimeout,
} from "../../lib/httpValidation";
import { checkRateLimit, getClientIp, rateLimitResponse } from "../../lib/rateLimit";
import { getPostHogClient } from "../../lib/posthog-server";

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY ?? "",
  posthog: getPostHogClient(),
});

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const google = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
});

const supabase = supabaseAdmin;

// Highest-cost route in the app (each uncached request fans out to three
// paid LLM providers). Cached fight_key reads never reach this check, so
// this only bounds first-generation cost, not every page view — but the
// original 5/10-min limit was tuned too conservative: a single visitor
// browsing a normal ~19-fight card (main + prelims + early prelims) could
// blow through it in one sitting on nothing but legitimate clicks, well
// before hitting anything that looks like abuse. Loosened to give a real
// user room to browse a full card; still bounded well below what a script
// hammering the route would need to do real cost damage.
const SHORT_WINDOW_SECONDS = 10 * 60;
const SHORT_WINDOW_LIMIT = 15;
const DAILY_WINDOW_SECONDS = 24 * 60 * 60;
const DAILY_WINDOW_LIMIT = 40;

const MAX_BODY_BYTES = 20_000;
const PROVIDER_TIMEOUT_MS = 25_000;

const STATS_FIELDS = [
  "id",
  "name",
  "nickname",
  "headshot",
  "record",
  "height",
  "weight",
  "reach",
  "stance",
  "age",
  "style",
  "gym",
  "country",
  "flag",
];

const HISTORY_FIELDS = ["opponent", "result", "method", "round", "time", "event", "date"];
const MAX_HISTORY_ITEMS = 5;

const METRICS_FIELDS = [
  "slpm",
  "strAcc",
  "sapm",
  "strDef",
  "tdAvg",
  "tdAcc",
  "tdDef",
  "subAvg",
];

const TOP_LEVEL_FIELDS = [
  "fighterA",
  "fighterB",
  "oddsA",
  "oddsB",
  "eventName",
  "fighterAMetricsSource",
  "fighterBMetricsSource",
  "fighterAStats",
  "fighterBStats",
  "fighterAMetrics",
  "fighterBMetrics",
  "fighterAHistory",
  "fighterBHistory",
];

function validateStatsObject(value: unknown, label: string): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined;
  const obj = assertPlainObject(value, label);
  assertKnownKeys(obj, STATS_FIELDS, label);
  for (const field of STATS_FIELDS) {
    assertLooseScalar(obj[field], `${label}.${field}`, field === "headshot" || field === "flag" ? 500 : 300);
  }
  return obj;
}

function validateOptionalString(value: unknown, label: string, maxLength: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new ValidationError(`${label} must be a string`);
  if (value.length > maxLength) throw new ValidationError(`${label} exceeds max length of ${maxLength}`);
  return value;
}

// Only the most recent fights matter for "how does this fighter usually
// win/lose" — capped at MAX_HISTORY_ITEMS regardless of how many the
// client sends, both to bound prompt size and because older fights are
// weaker signal for current finishing tendency anyway.
function validateHistoryArray(value: unknown, label: string): Record<string, unknown>[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new ValidationError(`${label} must be an array`);

  return value.slice(0, MAX_HISTORY_ITEMS).map((item, i) => {
    const obj = assertPlainObject(item, `${label}[${i}]`);
    assertKnownKeys(obj, HISTORY_FIELDS, `${label}[${i}]`);
    for (const field of HISTORY_FIELDS) {
      assertLooseScalar(obj[field], `${label}[${i}].${field}`, 150);
    }
    return obj;
  });
}

function validateMetricsObject(value: unknown, label: string): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined;
  const obj = assertPlainObject(value, label);
  assertKnownKeys(obj, METRICS_FIELDS, label);
  for (const field of METRICS_FIELDS) {
    assertLooseScalar(obj[field], `${label}.${field}`, 50);
  }
  return obj;
}

// Strict runtime shape check for the untrusted request body before any of
// it reaches an LLM prompt or a provider call. Rejects unknown top-level
// and nested fields, oversized strings, and non-finite numbers — an
// attacker cannot inject arbitrary system-prompt text, huge payloads, or
// NaN/Infinity through this endpoint.
function validatePredictBody(raw: unknown) {
  const body = assertPlainObject(raw, "body");
  assertKnownKeys(body, TOP_LEVEL_FIELDS, "body");

  const fighterA = assertRequiredString(body.fighterA, "fighterA", 150);
  const fighterB = assertRequiredString(body.fighterB, "fighterB", 150);
  const oddsA = assertFiniteNumber(body.oddsA, "oddsA");
  const oddsB = assertFiniteNumber(body.oddsB, "oddsB");
  const fighterAMetricsSource = assertRequiredString(body.fighterAMetricsSource, "fighterAMetricsSource", 150);
  const fighterBMetricsSource = assertRequiredString(body.fighterBMetricsSource, "fighterBMetricsSource", 150);
  const eventName = validateOptionalString(body.eventName, "eventName", 200);

  const fighterAStats = validateStatsObject(body.fighterAStats, "fighterAStats");
  const fighterBStats = validateStatsObject(body.fighterBStats, "fighterBStats");
  const fighterAMetrics = validateMetricsObject(body.fighterAMetrics, "fighterAMetrics");
  const fighterBMetrics = validateMetricsObject(body.fighterBMetrics, "fighterBMetrics");
  const fighterAHistory = validateHistoryArray(body.fighterAHistory, "fighterAHistory");
  const fighterBHistory = validateHistoryArray(body.fighterBHistory, "fighterBHistory");

  return {
    fighterA,
    fighterB,
    oddsA,
    oddsB,
    eventName,
    fighterAHistory,
    fighterBHistory,
    fighterAMetricsSource,
    fighterBMetricsSource,
    fighterAStats,
    fighterBStats,
    fighterAMetrics,
    fighterBMetrics,
  };
}


// Bumped whenever the prompt, consensus logic, or data-flow changes in a way
// that makes previously-cached rows unreliable. v5 invalidated everything
// cached under the stale-closure metrics bug. v6 invalidates predictions
// generated with oddsA/oddsB silently falling back to 0/0 — any fight whose
// odds only matched by surname (given names differ between ESPN and the
// odds API, e.g. "Steve"/"Stephen") had its per-fighter price lookup fail
// before mergeFightData.ts started resolving the outcome name explicitly.
// v7 adds recent fight history to the prompt and predictedFinishRound/
// over-under consensus — old rows have neither. v8 switches oddsA/oddsB
// from bookmakers[0] (arbitrary, and display-order-dependent since
// mergeFightData.ts started reordering bookmakers) to a median price
// across all books — old rows may have been generated off a single
// outlier line. v9 fixes that median to run in probability space instead
// of raw American-odds space — in a near-pick'em fight where books split
// on who's favored, medianing raw odds numbers can straddle the invalid
// -100..+100 gap and land on a nonsense quote (e.g. -2, implying ~2%
// instead of ~50%).
// v10 adds consensus.method/round, resolved from a model that actually
// picked the consensus winner — the UI was previously always showing
// Claude's own method/round even when Claude dissented from the consensus
// pick, displaying a finish scenario for the fighter who didn't win the
// vote.
const PREDICTION_VERSION = "v10-consensus-method-round";

function createFightKey(fighterA: string, fighterB: string) {
  const matchup = [fighterA, fighterB].sort().join(" vs ");
  return `${matchup}::${PREDICTION_VERSION}`;
}

// Raw (un-normalized) implied probability as a 0-1 fraction. Two raw
// probabilities from opposite sides of the same market always sum to more
// than 1 (the bookmaker's vig) — see normalizedProbabilities() for the
// de-vigged version used anywhere we display or compare probabilities.
function rawImpliedProbability(odds: number | null | undefined): number | null {
  if (!odds) return null;
  if (odds < 0) return -odds / (-odds + 100);
  return 100 / (odds + 100);
}

function cleanJson(text: string) {
  return text.replace(/```json\n?|\n?```/g, "").trim();
}

const VALID_FINISH_ROUNDS = new Set(["1", "2", "3", "4", "5", "Decision"]);

// A model can return "Round 2", "R2", "2nd", etc. despite the prompt's
// instruction — coerce common variants rather than silently defaulting
// them all to "Decision", which would quietly bias every over/under
// consensus toward "goes the distance".
function normalizeFinishRound(value: unknown): string {
  if (typeof value !== "string") return "Decision";

  const trimmed = value.trim();
  if (VALID_FINISH_ROUNDS.has(trimmed)) return trimmed;

  const digitMatch = trimmed.match(/[1-5]/);
  if (digitMatch && /decision/i.test(trimmed) === false) return digitMatch[0];

  return "Decision";
}

function normalizePrediction(analysis: any, fighterA: string, fighterB: string, oddsA: number, oddsB: number) {
  const impliedA = rawImpliedProbability(oddsA);
  const impliedB = rawImpliedProbability(oddsB);

  const fallbackWinner =
    impliedA === null && impliedB === null
      ? fighterA
      : impliedA === null
      ? fighterB
      : impliedB === null
      ? fighterA
      : impliedA >= impliedB
      ? fighterA
      : fighterB;

  return {
    ...analysis,
    predictedWinner:
      analysis.predictedWinner ||
      analysis.winner ||
      analysis.predicted_winner ||
      analysis.pick ||
      fallbackWinner,
    confidence: analysis.confidence || 50,
    predictedFinishRound: normalizeFinishRound(analysis.predictedFinishRound),
  };
}

// Requires fighterAMetricsSource/fighterBMetricsSource — the exact fighter
// name the client used to fetch each metrics object — so we can catch a
// stale/mismatched payload before it ever reaches an LLM. See the
// stale-closure race bug this replaced.
function validateFighterData(body: any): string[] {
  const errors: string[] = [];
  const { fighterA, fighterB, fighterAMetricsSource, fighterBMetricsSource, fighterAStats, fighterBStats } = body;

  if (!fighterA || typeof fighterA !== "string") errors.push("fighterA is required");
  if (!fighterB || typeof fighterB !== "string") errors.push("fighterB is required");
  if (errors.length > 0) return errors;

  const normA = normalizeFighterName(fighterA);
  const normB = normalizeFighterName(fighterB);

  if (!fighterAMetricsSource || normalizeFighterName(fighterAMetricsSource) !== normA) {
    errors.push(
      `fighterAMetrics source ("${fighterAMetricsSource || "missing"}") does not match fighterA ("${fighterA}")`
    );
  }

  if (!fighterBMetricsSource || normalizeFighterName(fighterBMetricsSource) !== normB) {
    errors.push(
      `fighterBMetrics source ("${fighterBMetricsSource || "missing"}") does not match fighterB ("${fighterB}")`
    );
  }

  if (fighterAStats?.name && normalizeFighterName(fighterAStats.name) !== normA) {
    errors.push(`fighterAStats belongs to "${fighterAStats.name}", not "${fighterA}"`);
  }

  if (fighterBStats?.name && normalizeFighterName(fighterBStats.name) !== normB) {
    errors.push(`fighterBStats belongs to "${fighterBStats.name}", not "${fighterB}"`);
  }

  return errors;
}

// Career-average metrics (SLpM, TD accuracy, etc.) say nothing about HOW
// a fighter's individual fights actually ended — a fighter with three
// straight first-round finishes and one with three decisions can share
// identical averages. This renders the actual per-fight record so the
// model can reason about real finishing tendency instead of guessing
// from age/record/style alone.
function formatHistoryForPrompt(history: Record<string, unknown>[] | undefined): string {
  if (!history || history.length === 0) return "  No recent fight history available.";

  return history
    .map((fight) => {
      const result = typeof fight.result === "string" ? fight.result.toUpperCase() : "?";
      const opponent = fight.opponent || "Unknown opponent";
      const method = fight.method || "Unknown method";
      const round = fight.round ? `, Round ${fight.round}` : "";
      return `  - ${result} vs ${opponent} — ${method}${round}`;
    })
    .join("\n");
}

function buildPrompt({
  fighterA,
  fighterB,
  oddsA,
  oddsB,
  fighterAStats,
  fighterBStats,
  fighterAMetrics,
  fighterBMetrics,
  fighterAHistory,
  fighterBHistory,
}: any) {
  const impliedA = rawImpliedProbability(oddsA);
  const impliedB = rawImpliedProbability(oddsB);
  const sum = (impliedA ?? 0) + (impliedB ?? 0);
  const normA = impliedA !== null && sum > 0 ? Math.round((impliedA / sum) * 100) : null;
  const normB = impliedB !== null && sum > 0 ? Math.round((impliedB / sum) * 100) : null;

  return `You are an expert UFC analyst.

Analyze this upcoming fight using BOTH the fighter information and the betting market.

Fight:
${fighterA} vs ${fighterB}

Betting Market:
- ${fighterA}: ${oddsA} (${normA !== null ? `${normA}% implied win probability` : "no market data"})
- ${fighterB}: ${oddsB} (${normB !== null ? `${normB}% implied win probability` : "no market data"})

Sportsbook markets aggregate a large amount of information — sharp betting activity, insider knowledge, matchup analysis — and are generally well-calibrated. Treat the market price as a meaningful, informative prior. Do not default to picking the favorite; form your own independent judgment from the data below. But if your judgment disagrees with the market, that disagreement must be earned, not incidental.

${fighterA}
- Record: ${fighterAStats?.record || "Unknown"}
- Age: ${fighterAStats?.age || "Unknown"}
- Height: ${fighterAStats?.height || "Unknown"}
- Reach: ${fighterAStats?.reach || "Unknown"}
- Stance: ${fighterAStats?.stance || "Unknown"}
- Style: ${fighterAStats?.style || "Unknown"}

${fighterB}
- Record: ${fighterBStats?.record || "Unknown"}
- Age: ${fighterBStats?.age || "Unknown"}
- Height: ${fighterBStats?.height || "Unknown"}
- Reach: ${fighterBStats?.reach || "Unknown"}
- Stance: ${fighterBStats?.stance || "Unknown"}
- Style: ${fighterBStats?.style || "Unknown"}

Advanced Performance Metrics:

${fighterA}
- SLpM: ${fighterAMetrics?.slpm || "Unknown"}
- Striking Accuracy: ${fighterAMetrics?.strAcc || "Unknown"}
- SApM: ${fighterAMetrics?.sapm || "Unknown"}
- Strike Defense: ${fighterAMetrics?.strDef || "Unknown"}
- TD Avg: ${fighterAMetrics?.tdAvg || "Unknown"}
- TD Accuracy: ${fighterAMetrics?.tdAcc || "Unknown"}
- TD Defense: ${fighterAMetrics?.tdDef || "Unknown"}
- Submission Avg: ${fighterAMetrics?.subAvg || "Unknown"}

${fighterB}
- SLpM: ${fighterBMetrics?.slpm || "Unknown"}
- Striking Accuracy: ${fighterBMetrics?.strAcc || "Unknown"}
- SApM: ${fighterBMetrics?.sapm || "Unknown"}
- Strike Defense: ${fighterBMetrics?.strDef || "Unknown"}
- TD Avg: ${fighterBMetrics?.tdAvg || "Unknown"}
- TD Accuracy: ${fighterBMetrics?.tdAcc || "Unknown"}
- TD Defense: ${fighterBMetrics?.tdDef || "Unknown"}
- Submission Avg: ${fighterBMetrics?.subAvg || "Unknown"}

Recent Fight History (most recent first — career averages above don't show
HOW a fighter's individual fights actually ended; use this for finishing
tendency):

${fighterA}
${formatHistoryForPrompt(fighterAHistory)}

${fighterB}
${formatHistoryForPrompt(fighterBHistory)}

Consider:
- advanced performance metrics
- styles and matchup dynamics
- reach and physical advantages
- age and experience
- finishing ability, using the recent fight history above as real evidence of it — not just the style label
- likely path to victory

If you pick the fighter the market considers a substantial underdog (implied win probability meaningfully below 50%), you must:
- identify the specific evidence above that supports the upset;
- explain concretely why that evidence outweighs the market's assessment;
- avoid assigning confidence above roughly 65 to a substantial-underdog pick unless the statistical case is unusually strong.

Return ONLY valid JSON in this format:

{
  "predictedWinner": "",
  "confidence": 72,
  "method": "",
  "round": "",
  "predictedFinishRound": "Your single best estimate of when this fight actually ends. Must be exactly one of: \\"1\\", \\"2\\", \\"3\\", \\"4\\", \\"5\\", or \\"Decision\\".",
  "bettingLean": "",
  "keyAdvantages": "2 sentences, maximum. The single most important statistical or stylistic advantage, stated plainly.",
  "biggestRisk": "1-2 sentences, maximum. The single biggest risk to this prediction.",
  "fightScript": "2 sentences, maximum. How the fight most likely unfolds and ends.",
  "whyWrong": [
    "One clear sentence — a specific, concrete reason the prediction could be wrong",
    "One clear sentence — a different specific, concrete reason the prediction could be wrong"
  ]
}

Be concise. Readers do not want to read long paragraphs — every sentence must earn its place. State the point directly with no throat-clearing or repetition across fields.`;
}

// "Over 2.5 rounds" implies "over 1.5 rounds" — a fight that goes to a
// decision (or ends in round 3+) necessarily also cleared round 1. This
// derives both from the single predictedFinishRound value rather than
// asking the model to judge each threshold independently, which could
// otherwise produce a self-contradictory pair (e.g. "unlikely over 1.5"
// but "likely over 2.5").
function clearsRoundThreshold(finishRound: string, roundsToClear: number): boolean {
  if (finishRound === "Decision") return true;
  return parseInt(finishRound, 10) > roundsToClear;
}

// Mirrors the winner-consensus pattern: majority vote across whichever
// models succeeded, "Uncertain" only on a genuine tie (only reachable
// when a model failed and the remaining two disagree).
function overUnderConsensus(
  modelResults: { name: string; prediction: any }[],
  roundsToClear: number
): { label: "Likely" | "Unlikely" | "Uncertain"; agreeingModels: string[] } {
  const over = modelResults.filter(({ prediction }) => clearsRoundThreshold(prediction.predictedFinishRound, roundsToClear));
  const under = modelResults.filter(({ prediction }) => !clearsRoundThreshold(prediction.predictedFinishRound, roundsToClear));

  if (over.length > under.length) {
    return { label: "Likely", agreeingModels: over.map((m) => m.name) };
  }
  if (under.length > over.length) {
    return { label: "Unlikely", agreeingModels: under.map((m) => m.name) };
  }
  return { label: "Uncertain", agreeingModels: [] };
}

export async function POST(request: Request) {
  try {
    let body;
    try {
      const raw = await readJsonBody(request, MAX_BODY_BYTES);
      body = validatePredictBody(raw);
    } catch (error) {
      if (error instanceof ValidationError) {
        return NextResponse.json({ error: error.message }, { status: 400 });
      }
      throw error;
    }

    const { fighterA, fighterB, oddsA, oddsB, eventName } = body;

    const validationErrors = validateFighterData(body);

    if (validationErrors.length > 0) {
      console.error(`[predict] data-integrity validation failed: ${validationErrors.join("; ")}`);

      return NextResponse.json(
        {
          error: "Fighter data mismatch detected — refusing to generate a prediction",
          details: validationErrors,
        },
        { status: 400 }
      );
    }

    const fightKey = createFightKey(fighterA, fighterB);

    const { data: cachedPrediction, error: cacheError } = await supabase
      .from("fight_predictions")
      .select("prediction")
      .eq("fight_key", fightKey)
      .maybeSingle();

    if (cacheError) {
      console.error("Supabase cache read error:", cacheError);
    }

    if (cachedPrediction?.prediction) {
      const cached = cachedPrediction.prediction;
      const isComplete = !!cached.claude && !!cached.gpt && !!cached.gemini;

      if (isComplete) {
        return NextResponse.json(cached);
      }

      console.warn(
        `Cached prediction for "${fightKey}" is missing a model result — regenerating instead of returning it`
      );
    }

    // Only cache misses reach the rate limiter — a cache hit never
    // triggers a paid provider call, so it shouldn't count against the
    // budget of a legitimate user re-viewing the same fight.
    const clientIp = getClientIp(request);

    const [shortLimit, dailyLimit] = await Promise.all([
      checkRateLimit(`predict:short:${clientIp}`, SHORT_WINDOW_SECONDS, SHORT_WINDOW_LIMIT),
      checkRateLimit(`predict:daily:${clientIp}`, DAILY_WINDOW_SECONDS, DAILY_WINDOW_LIMIT),
    ]);

    const bindingLimit = !shortLimit.allowed ? shortLimit : !dailyLimit.allowed ? dailyLimit : null;

    if (bindingLimit) {
      const posthog = getPostHogClient();
      posthog.capture({
        distinctId: clientIp,
        event: "server_prediction_rate_limited",
        properties: {
          fighter_a: fighterA,
          fighter_b: fighterB,
          retry_after_seconds: bindingLimit.retryAfterSeconds,
        },
      });
      await posthog.flush();
      return rateLimitResponse(bindingLimit.retryAfterSeconds);
    }

    const prompt = buildPrompt(body);

    const [claudeResult, gptResult, geminiResult] = await Promise.allSettled([
      withTimeout(
        anthropic.messages.create({
          model: "claude-sonnet-4-6",
          max_tokens: 1000,
          messages: [{ role: "user", content: prompt }],
        }),
        PROVIDER_TIMEOUT_MS
      ),

      withTimeout(
        openai.responses.create({
          model: "gpt-5.4-mini",
          input: prompt,
        }),
        PROVIDER_TIMEOUT_MS
      ),

      withTimeout(
        google.models.generateContent({
          model: "gemini-2.5-flash",
          contents: prompt,
          config: {
            responseMimeType: "application/json",
          },
        }),
        PROVIDER_TIMEOUT_MS
      ),
    ]);

    let claude = null;
    let gpt = null;
    let gemini = null;

    if (claudeResult.status === "fulfilled") {
      try {
        const content = claudeResult.value.content[0];

        if (content.type === "text") {
          claude = normalizePrediction(
            JSON.parse(cleanJson(content.text)),
            fighterA,
            fighterB,
            oddsA,
            oddsB
          );
        }
      } catch (error) {
        console.error("Claude JSON parse error:", error);
      }
    } else {
      console.error("Claude API error:", claudeResult.reason);
    }

    if (gptResult.status === "fulfilled") {
      try {
        gpt = normalizePrediction(
          JSON.parse(cleanJson(gptResult.value.output_text)),
          fighterA,
          fighterB,
          oddsA,
          oddsB
        );
      } catch (error) {
        console.error("GPT JSON parse error:", error);
      }
    } else {
      console.error("GPT API error:", gptResult.reason);
    }

    if (geminiResult.status === "fulfilled") {
      try {
        gemini = normalizePrediction(
          JSON.parse(cleanJson(geminiResult.value.text ?? "")),
          fighterA,
          fighterB,
          oddsA,
          oddsB
        );
      } catch (error) {
        console.error("Gemini JSON parse error:", geminiResult.value.text);
      }
    } else {
      console.error("Gemini API error:", geminiResult.reason);
    }

    // Consensus winner: majority vote across whichever models succeeded.
    // Consensus confidence: average ONLY the confidence scores from models
    // that actually picked the consensus winner — averaging a confidence
    // attached to the opposing fighter's pick previously inflated/distorted
    // this number.
    const modelResults = [
      { name: "claude", prediction: claude },
      { name: "gpt", prediction: gpt },
      { name: "gemini", prediction: gemini },
    ].filter((m): m is { name: string; prediction: any } => !!m.prediction);

    const totalSuccessfulModels = modelResults.length;

    let consensusWinner: string;
    let agreeingModels: string[];
    let consensusConfidence: number;
    let modelAgreement: string;
    let consensusMethod: string | undefined;
    let consensusRound: string | undefined;

    if (totalSuccessfulModels === 0) {
      consensusWinner = fighterA;
      agreeingModels = [];
      consensusConfidence = 50;
      modelAgreement = "No models available";
      consensusMethod = undefined;
      consensusRound = undefined;
    } else {
      const winnerCounts: Record<string, number> = {};
      for (const { prediction } of modelResults) {
        winnerCounts[prediction.predictedWinner] = (winnerCounts[prediction.predictedWinner] || 0) + 1;
      }

      const sortedWinners = Object.entries(winnerCounts).sort((a, b) => b[1] - a[1]);
      const topCount = sortedWinners[0][1];
      const tiedWinners = sortedWinners.filter(([, count]) => count === topCount);

      if (tiedWinners.length > 1) {
        // Genuine tie (only reachable when a model failed and the remaining
        // two disagree). Break it with Claude's pick if Claude is one of
        // the tied winners, otherwise take the first.
        const claudeWinner = claude?.predictedWinner;
        consensusWinner =
          claudeWinner && tiedWinners.some(([name]) => name === claudeWinner)
            ? claudeWinner
            : tiedWinners[0][0];
      } else {
        consensusWinner = sortedWinners[0][0];
      }

      const agreeing = modelResults.filter(({ prediction }) => prediction.predictedWinner === consensusWinner);
      agreeingModels = agreeing.map(({ name }) => name);

      consensusConfidence = Math.round(
        agreeing.reduce((sum, { prediction }) => sum + prediction.confidence, 0) / agreeing.length
      );

      modelAgreement =
        agreeingModels.length === totalSuccessfulModels
          ? "Unanimous"
          : tiedWinners.length > 1
          ? "Split"
          : "Majority";

      // Method/round must come from a model that actually picked the
      // consensus winner — a dissenting model's method/round describes ITS
      // pick, which may be a different fighter entirely. Prefer Claude's
      // when Claude agrees (matches prior display behavior for the common
      // case), otherwise fall back to whichever agreeing model comes first.
      const primaryAgreeingModel =
        agreeing.find(({ name }) => name === "claude") || agreeing[0];
      consensusMethod = primaryAgreeingModel.prediction.method;
      consensusRound = primaryAgreeingModel.prediction.round;
    }

    const overUnder =
      totalSuccessfulModels === 0
        ? {
            over1_5: { label: "Uncertain" as const, agreeingModels: [] },
            over2_5: { label: "Uncertain" as const, agreeingModels: [] },
          }
        : {
            over1_5: overUnderConsensus(modelResults, 1),
            over2_5: overUnderConsensus(modelResults, 2),
          };

    const finalPrediction = {
      claude,
      gpt,
      gemini,
      consensus: {
        winner: consensusWinner,
        confidence: consensusConfidence,
        agreeingModels,
        totalSuccessfulModels,
        modelAgreement,
        overUnder,
        method: consensusMethod,
        round: consensusRound,
      },
    };

    const { error: upsertError } = await supabase
      .from("fight_predictions")
      .upsert(
        {
          fight_key: fightKey,
          fighter_a: fighterA,
          fighter_b: fighterB,
          event_name: eventName,
          prediction: finalPrediction,
        },
        {
          onConflict: "fight_key",
        }
      );

    if (upsertError) {
      console.error("Supabase prediction save error:", upsertError);
    } else {
      console.log("Saved prediction to Supabase:", fightKey);
    }

    const posthog = getPostHogClient();
    posthog.capture({
      distinctId: clientIp,
      event: "server_prediction_generated",
      properties: {
        fighter_a: fighterA,
        fighter_b: fighterB,
        event_name: eventName,
        consensus_winner: finalPrediction.consensus.winner,
        confidence: finalPrediction.consensus.confidence,
        model_agreement: finalPrediction.consensus.modelAgreement,
        total_successful_models: finalPrediction.consensus.totalSuccessfulModels,
      },
    });
    await posthog.flush();

    return NextResponse.json(finalPrediction);
  } catch (error) {
    console.error("Prediction API error:", error);

    return NextResponse.json(
      { error: "Failed to generate prediction" },
      { status: 500 }
    );
  }
}
