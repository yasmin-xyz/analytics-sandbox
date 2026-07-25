import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { buildExpertChatContext, type ExpertChatFighterContext } from "../../lib/expertChatContext";
import { namesMatchExactly } from "../../lib/fighterName";
import {
  ValidationError,
  readJsonBody,
  assertPlainObject,
  assertKnownKeys,
  assertRequiredString,
  assertFiniteNumber,
  withTimeout,
} from "../../lib/httpValidation";
import { checkRateLimit, getClientIp, rateLimitResponse } from "../../lib/rateLimit";

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// Separate budget from predict:* — a chat session naturally has more
// back-and-forth turns than one-shot prediction generation, and the two
// shouldn't compete for the same allowance. Starting points, tune from
// real traffic once deployed.
const SHORT_WINDOW_SECONDS = 10 * 60;
const SHORT_WINDOW_LIMIT = 15;
const DAILY_WINDOW_SECONDS = 24 * 60 * 60;
const DAILY_WINDOW_LIMIT = 40;

const MAX_BODY_BYTES = 20_000;
// A question that triggers web_search can legitimately run multiple
// search-then-reason round trips. A timeout here is now surfaced to the
// user as a friendly in-character message (see the catch block below)
// rather than a broken-looking error, so a generous ceiling costs a slow
// reply, not a bad one.
const PROVIDER_TIMEOUT_MS = 60_000;
const TIMEOUT_ERROR_MESSAGE = "Provider call timed out";
const TIMEOUT_REPLY =
  "That question was a bit too complex for me to dig up quickly — mind trying something simpler, or asking about one thing at a time?";
const MAX_MESSAGE_LENGTH = 1000;
const MAX_HISTORY_TURNS = 20;

// A structured tag rather than free-text parsing — asking the model to name
// a fight in prose and regex-matching that would be fragile (punctuation,
// "vs" vs "versus", reordered names). The tag's contents still get
// validated against the real card below before ever reaching the client —
// the model naming a fight here is a suggestion, not a fact.
const SUGGEST_FIGHT_TAG = "[[SUGGEST_FIGHT:";
const SUGGEST_FIGHT_TAG_CLOSE = "]]";
const SUGGEST_FIGHT_PATTERN = /\[\[SUGGEST_FIGHT:\s*(.+?)\s*vs\.?\s*(.+?)\s*\]\]/i;

const TOP_LEVEL_FIELDS = [
  "message",
  "conversationHistory",
  "selectedFighterA",
  "selectedFighterB",
  "marketOddsA",
  "marketOddsB",
  "marketProbA",
  "marketProbB",
];

type ChatTurn = { role: "user" | "assistant"; content: string };

function validateConversationHistory(value: unknown): ChatTurn[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new ValidationError("conversationHistory must be an array");
  }
  if (value.length > MAX_HISTORY_TURNS) {
    throw new ValidationError(`conversationHistory exceeds max length of ${MAX_HISTORY_TURNS}`);
  }

  return value.map((turn, i) => {
    const obj = assertPlainObject(turn, `conversationHistory[${i}]`);
    assertKnownKeys(obj, ["role", "content"], `conversationHistory[${i}]`);
    if (obj.role !== "user" && obj.role !== "assistant") {
      throw new ValidationError(`conversationHistory[${i}].role must be "user" or "assistant"`);
    }
    const content = assertRequiredString(obj.content, `conversationHistory[${i}].content`, MAX_MESSAGE_LENGTH);
    return { role: obj.role, content };
  });
}

function validateOptionalName(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  return assertRequiredString(value, field, 150);
}

function validateOptionalNumber(
  value: unknown,
  field: string,
  bounds: { min: number; max: number }
): number | null {
  if (value === undefined || value === null) return null;
  return assertFiniteNumber(value, field, bounds);
}

function validateChatBody(raw: unknown) {
  const body = assertPlainObject(raw, "Request body");
  assertKnownKeys(body, TOP_LEVEL_FIELDS, "Request body");

  const message = assertRequiredString(body.message, "message", MAX_MESSAGE_LENGTH);
  const conversationHistory = validateConversationHistory(body.conversationHistory);
  const selectedFighterA = validateOptionalName(body.selectedFighterA, "selectedFighterA");
  const selectedFighterB = validateOptionalName(body.selectedFighterB, "selectedFighterB");
  // American odds have no fixed range, but ±100,000 is far beyond anything
  // real while still catching garbage input.
  const marketOddsA = validateOptionalNumber(body.marketOddsA, "marketOddsA", { min: -100_000, max: 100_000 });
  const marketOddsB = validateOptionalNumber(body.marketOddsB, "marketOddsB", { min: -100_000, max: 100_000 });
  const marketProbA = validateOptionalNumber(body.marketProbA, "marketProbA", { min: 0, max: 100 });
  const marketProbB = validateOptionalNumber(body.marketProbB, "marketProbB", { min: 0, max: 100 });

  return {
    message,
    conversationHistory,
    selectedFighterA,
    selectedFighterB,
    marketOddsA,
    marketOddsB,
    marketProbA,
    marketProbB,
  };
}

function formatFighterBlock(label: string, fighter: ExpertChatFighterContext): string {
  const lines = [`${label}: ${fighter.name}`];

  if (fighter.metrics) {
    const m = fighter.metrics;
    lines.push(
      `  Career stats — SLpM: ${m.slpm ?? "unknown"}, Strike Accuracy: ${m.strAcc ?? "unknown"}, ` +
        `SApM: ${m.sapm ?? "unknown"}, Strike Defense: ${m.strDef ?? "unknown"}, ` +
        `TD Avg: ${m.tdAvg ?? "unknown"}, TD Accuracy: ${m.tdAcc ?? "unknown"}, ` +
        `TD Defense: ${m.tdDef ?? "unknown"}, Sub Avg: ${m.subAvg ?? "unknown"}`
    );
  } else {
    lines.push("  Career stats: not available");
  }

  if (fighter.history.length > 0) {
    lines.push("  Recent fights:");
    for (const fight of fighter.history.slice(0, 5)) {
      lines.push(
        `    - vs ${fight.opponent ?? "unknown"}: ${fight.result ?? "unknown"} by ${fight.method ?? "unknown"}` +
          (fight.round ? `, round ${fight.round}` : "") +
          (fight.event ? ` (${fight.event}${fight.date ? `, ${fight.date}` : ""})` : "")
      );
    }
  } else {
    lines.push("  Recent fights: not available");
  }

  return lines.join("\n");
}

function formatAmericanOdds(odds: number): string {
  return odds > 0 ? `+${odds}` : `${odds}`;
}

function formatMarketBlock(
  context: NonNullable<Awaited<ReturnType<typeof buildExpertChatContext>>>,
  marketOddsA: number | null,
  marketOddsB: number | null,
  marketProbA: number | null,
  marketProbB: number | null
): string {
  if (!context.selectedFight || marketOddsA === null || marketOddsB === null) return "";

  const nameA = context.selectedFight.fighterA.name;
  const nameB = context.selectedFight.fighterB.name;
  const probPart =
    marketProbA !== null && marketProbB !== null ? ` (${marketProbA}% / ${marketProbB}% implied)` : "";

  return (
    `\n\nCurrent market odds (median across major sportsbooks): ${nameA} ${formatAmericanOdds(marketOddsA)}, ` +
    `${nameB} ${formatAmericanOdds(marketOddsB)}${probPart}.`
  );
}

function buildSystemPrompt(
  context: Awaited<ReturnType<typeof buildExpertChatContext>>,
  marketOddsA: number | null,
  marketOddsB: number | null,
  marketProbA: number | null,
  marketProbB: number | null
): string {
  if (!context) {
    return (
      "You are the 'Ask the Expert' assistant on Pick'em Labs, a UFC fight analysis site. " +
      "The current event card could not be loaded right now, so you have no site data to draw from. " +
      "Use the web_search tool to answer UFC-related questions. If you can't find a reliable answer, say so " +
      "plainly instead of guessing."
    );
  }

  const cardList = context.cardFights
    .map((f) => `- ${f.fighterA} vs. ${f.fighterB} (${f.weightClass})`)
    .join("\n");

  const marketBlock = formatMarketBlock(context, marketOddsA, marketOddsB, marketProbA, marketProbB);

  const selectedBlock = context.selectedFight
    ? `\n\nThe user is currently looking at this fight in detail:\n\n` +
      `${formatFighterBlock("Fighter A", context.selectedFight.fighterA)}\n\n` +
      `${formatFighterBlock("Fighter B", context.selectedFight.fighterB)}${marketBlock}`
    : "";

  return (
    `You are the 'Ask the Expert' assistant on Pick'em Labs, a UFC fight analysis site. ` +
    `Answer questions about the current event: ${context.eventName} (${context.eventDate}).\n\n` +
    `Full card:\n${cardList}${selectedBlock}\n\n` +
    `Instructions:\n` +
    `- The data above is already verified by this site — just answer naturally from it, the way a knowledgeable ` +
    `friend would. Don't preface every answer with "based on the data" or similar — that gets repetitive.\n` +
    `- If a question needs something not covered above (e.g. exact strike counts from a past fight, very recent ` +
    `news), use the web_search tool. When you do, mention it briefly in the answer (e.g. "a quick search shows…") ` +
    `so it's clear that part came from outside this site — but don't belabor it.\n` +
    `- If a question asks for detailed per-fight stats (e.g. strike counts) across MULTIPLE past fights at once, ` +
    `don't search for all of them in one turn — each one is a separate lookup and doing them sequentially is too ` +
    `slow. Search for and answer just the most recent one, then say you can look up the others too if they want ` +
    `them. Never leave the user waiting through several searches for one reply.\n` +
    `- If the user asks about a fighter who's on the full card above but NOT one of the two fighters detailed ` +
    `in the selected fight, you don't have their stats/history loaded — say so plainly rather than guessing, and ` +
    `end your reply on its own line with exactly: ${SUGGEST_FIGHT_TAG}Fighter Name vs. Opponent Name${SUGGEST_FIGHT_TAG_CLOSE} ` +
    `using the exact fight from the "Full card" list they belong to (their opponent, not just any other fighter). ` +
    `Never emit this tag for a fighter who isn't actually on the full card list.\n` +
    `- If neither the data above nor a search turns up a reliable answer, say so plainly. Never fabricate a stat, ` +
    `result, or date.\n` +
    `- If you quote a snippet from a search result, keep it short and always close the quotation mark — never ` +
    `trail off mid-quote. When in doubt, paraphrase instead of quoting directly.\n` +
    `- Keep answers SHORT — 2-4 sentences for most questions. Lead with the direct answer first. Don't add ` +
    `background, caveats, or "for context…" asides unless the user actually asks for more detail or the question ` +
    `genuinely needs it. This is a chat, not a report.`
  );
}

type SuggestedFight = { fighterA: string; fighterB: string } | null;

// Strips the tag from the visible reply regardless of whether it validates,
// so a hallucinated or malformed tag never leaks into the user-facing text.
// The suggestion itself is only returned if it matches a real fight on the
// card — the model naming one here is never trusted blindly.
function extractSuggestedFight(
  reply: string,
  cardFights: { fighterA: string; fighterB: string }[]
): { reply: string; suggestedFight: SuggestedFight } {
  const match = reply.match(SUGGEST_FIGHT_PATTERN);
  if (!match) return { reply, suggestedFight: null };

  const cleanedReply = reply.replace(SUGGEST_FIGHT_PATTERN, "").trim();
  const [, nameA, nameB] = match;

  const found = cardFights.find(
    (fight) =>
      (namesMatchExactly(fight.fighterA, nameA) && namesMatchExactly(fight.fighterB, nameB)) ||
      (namesMatchExactly(fight.fighterA, nameB) && namesMatchExactly(fight.fighterB, nameA))
  );

  return {
    reply: cleanedReply,
    suggestedFight: found ? { fighterA: found.fighterA, fighterB: found.fighterB } : null,
  };
}

export async function POST(request: Request) {
  try {
    const raw = await readJsonBody(request, MAX_BODY_BYTES);
    const {
      message,
      conversationHistory,
      selectedFighterA,
      selectedFighterB,
      marketOddsA,
      marketOddsB,
      marketProbA,
      marketProbB,
    } = validateChatBody(raw);

    const clientIp = getClientIp(request);
    const [shortLimit, dailyLimit] = await Promise.all([
      checkRateLimit(`chat:short:${clientIp}`, SHORT_WINDOW_SECONDS, SHORT_WINDOW_LIMIT),
      checkRateLimit(`chat:daily:${clientIp}`, DAILY_WINDOW_SECONDS, DAILY_WINDOW_LIMIT),
    ]);

    const bindingLimit = !shortLimit.allowed ? shortLimit : !dailyLimit.allowed ? dailyLimit : null;
    if (bindingLimit) {
      return rateLimitResponse(bindingLimit.retryAfterSeconds);
    }

    const context = await buildExpertChatContext(selectedFighterA, selectedFighterB);
    const system = buildSystemPrompt(context, marketOddsA, marketOddsB, marketProbA, marketProbB);

    const response = await withTimeout(
      anthropic.messages.create({
        model: "claude-sonnet-5",
        max_tokens: 1024,
        system,
        tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 3 }],
        messages: [
          ...conversationHistory.map((turn) => ({ role: turn.role, content: turn.content })),
          { role: "user" as const, content: message },
        ],
      }),
      PROVIDER_TIMEOUT_MS
    );

    if (response.stop_reason === "refusal") {
      return NextResponse.json({
        reply: "I can't help with that question — try rephrasing it or asking something else about the card.",
        usedSearch: false,
      });
    }

    let reply = "";
    let usedSearch = false;
    for (const block of response.content) {
      if (block.type === "text") {
        reply += block.text;
      } else if (block.type === "server_tool_use" && block.name === "web_search") {
        usedSearch = true;
      }
    }

    let suggestedFight: SuggestedFight = null;
    if (context) {
      ({ reply, suggestedFight } = extractSuggestedFight(reply, context.cardFights));
    }

    if (!reply.trim()) {
      reply = "I wasn't able to put together an answer for that — try asking a different way.";
    }

    return NextResponse.json({ reply, usedSearch, suggestedFight });
  } catch (error) {
    if (error instanceof ValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof Error && error.message === TIMEOUT_ERROR_MESSAGE) {
      // Answered in-character, as a normal (if apologetic) assistant reply
      // rather than a red error banner — the question didn't break the
      // chat, it just took too long, and the user shouldn't have to
      // guess which of those happened.
      return NextResponse.json({ reply: TIMEOUT_REPLY, usedSearch: false, suggestedFight: null });
    }
    console.error("[expert-chat] request failed:", error);
    return NextResponse.json({ error: "Failed to generate a response" }, { status: 500 });
  }
}
