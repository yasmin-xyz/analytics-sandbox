import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
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

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const google = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
});

const supabase = supabaseAdmin;

// Conservative starting point for the highest-cost route in the app (each
// uncached request fans out to three paid LLM providers). Cached fight_key
// reads never reach this check. Tune from real traffic once deployed.
const SHORT_WINDOW_SECONDS = 10 * 60;
const SHORT_WINDOW_LIMIT = 5;
const DAILY_WINDOW_SECONDS = 24 * 60 * 60;
const DAILY_WINDOW_LIMIT = 20;

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

  return {
    fighterA,
    fighterB,
    oddsA,
    oddsB,
    eventName,
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
const PREDICTION_VERSION = "v6-outcome-name-fix";

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

function buildPrompt({
  fighterA,
  fighterB,
  oddsA,
  oddsB,
  fighterAStats,
  fighterBStats,
  fighterAMetrics,
  fighterBMetrics,
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

Consider:
- advanced performance metrics
- styles and matchup dynamics
- reach and physical advantages
- age and experience
- finishing ability
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

    if (totalSuccessfulModels === 0) {
      consensusWinner = fighterA;
      agreeingModels = [];
      consensusConfidence = 50;
      modelAgreement = "No models available";
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
    }

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

    return NextResponse.json(finalPrediction);
  } catch (error) {
    console.error("Prediction API error:", error);

    return NextResponse.json(
      { error: "Failed to generate prediction" },
      { status: 500 }
    );
  }
}
