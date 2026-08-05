import { NextResponse } from "next/server";
import { supabaseAdmin } from "../../lib/supabaseAdmin";
import {
  ValidationError,
  SpamDetected,
  readJsonBody,
  assertPlainObject,
  assertKnownKeys,
  assertRequiredString,
  assertHoneypotEmpty,
} from "../../lib/httpValidation";
import { checkRateLimit, getClientIp, rateLimitResponse } from "../../lib/rateLimit";

const MAX_BODY_BYTES = 10_000;
const MAX_MESSAGE_LENGTH = 2_000;
const MAX_NAME_LENGTH = 150;
const MAX_EMAIL_LENGTH = 254;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// A visitor legitimately has more to say here than in the notify-signup
// form, but still isn't submitting dozens of times.
const SHORT_WINDOW_SECONDS = 10 * 60;
const SHORT_WINDOW_LIMIT = 5;
const DAILY_WINDOW_SECONDS = 24 * 60 * 60;
const DAILY_WINDOW_LIMIT = 15;

const CATEGORIES = ["Bug report", "Feature request", "General feedback"];

// A crude but cheap link-spam heuristic — genuine bug reports/feature
// requests essentially never contain multiple URLs.
const MAX_LINKS_IN_MESSAGE = 2;

const TOP_LEVEL_FIELDS = ["name", "email", "category", "message", "website"];

function countLinks(text: string): number {
  return (text.match(/https?:\/\//gi) || []).length;
}

function validateBody(raw: unknown) {
  const body = assertPlainObject(raw, "Request body");
  assertKnownKeys(body, TOP_LEVEL_FIELDS, "Request body");

  assertHoneypotEmpty(body.website);

  const name =
    body.name === undefined || body.name === null || body.name === ""
      ? null
      : assertRequiredString(body.name, "name", MAX_NAME_LENGTH);

  let email: string | null = null;
  if (body.email !== undefined && body.email !== null && body.email !== "") {
    email = assertRequiredString(body.email, "email", MAX_EMAIL_LENGTH);
    if (!EMAIL_PATTERN.test(email)) {
      throw new ValidationError("email must be a valid email address");
    }
  }

  const category = assertRequiredString(body.category, "category", 50);
  if (!CATEGORIES.includes(category)) {
    throw new ValidationError(`category must be one of: ${CATEGORIES.join(", ")}`);
  }

  const message = assertRequiredString(body.message, "message", MAX_MESSAGE_LENGTH);
  if (countLinks(message) > MAX_LINKS_IN_MESSAGE) {
    throw new SpamDetected("message contains too many links");
  }

  return { name, email, category, message };
}

export async function POST(request: Request) {
  try {
    const raw = await readJsonBody(request, MAX_BODY_BYTES);
    const { name, email, category, message } = validateBody(raw);

    const clientIp = getClientIp(request);
    const [shortLimit, dailyLimit] = await Promise.all([
      checkRateLimit(`feedback:short:${clientIp}`, SHORT_WINDOW_SECONDS, SHORT_WINDOW_LIMIT),
      checkRateLimit(`feedback:daily:${clientIp}`, DAILY_WINDOW_SECONDS, DAILY_WINDOW_LIMIT),
    ]);

    const bindingLimit = !shortLimit.allowed ? shortLimit : !dailyLimit.allowed ? dailyLimit : null;
    if (bindingLimit) {
      return rateLimitResponse(bindingLimit.retryAfterSeconds);
    }

    const { error } = await supabaseAdmin.from("feedback_submissions").insert({
      name,
      email,
      category,
      message,
      client_ip: clientIp,
    });

    if (error) {
      console.error("[feedback] insert failed:", error.message);
      return NextResponse.json({ error: "Failed to save feedback" }, { status: 500 });
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof SpamDetected) {
      // Same response real feedback gets — a spammer shouldn't be able to
      // tell their message was silently dropped rather than accepted.
      return NextResponse.json({ ok: true });
    }
    if (error instanceof ValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.error("[feedback] request failed:", error);
    return NextResponse.json({ error: "Failed to save feedback" }, { status: 500 });
  }
}
