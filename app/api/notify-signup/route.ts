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

const MAX_BODY_BYTES = 2_000;
const MAX_EMAIL_LENGTH = 254; // RFC 5321 max mailbox length
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Separate, tighter budget than feedback:* — a real visitor only ever
// needs to submit this once per concluded event.
const SHORT_WINDOW_SECONDS = 10 * 60;
const SHORT_WINDOW_LIMIT = 5;
const DAILY_WINDOW_SECONDS = 24 * 60 * 60;
const DAILY_WINDOW_LIMIT = 10;

const TOP_LEVEL_FIELDS = ["email", "website"];

function validateBody(raw: unknown) {
  const body = assertPlainObject(raw, "Request body");
  assertKnownKeys(body, TOP_LEVEL_FIELDS, "Request body");

  // The honeypot ("website") is checked first and deliberately treated as
  // indistinguishable from success by the caller — see SpamDetected below.
  assertHoneypotEmpty(body.website);

  const email = assertRequiredString(body.email, "email", MAX_EMAIL_LENGTH);
  if (!EMAIL_PATTERN.test(email)) {
    throw new ValidationError("email must be a valid email address");
  }

  return { email };
}

export async function POST(request: Request) {
  try {
    const raw = await readJsonBody(request, MAX_BODY_BYTES);
    const { email } = validateBody(raw);

    const clientIp = getClientIp(request);
    const [shortLimit, dailyLimit] = await Promise.all([
      checkRateLimit(`notify:short:${clientIp}`, SHORT_WINDOW_SECONDS, SHORT_WINDOW_LIMIT),
      checkRateLimit(`notify:daily:${clientIp}`, DAILY_WINDOW_SECONDS, DAILY_WINDOW_LIMIT),
    ]);

    const bindingLimit = !shortLimit.allowed ? shortLimit : !dailyLimit.allowed ? dailyLimit : null;
    if (bindingLimit) {
      return rateLimitResponse(bindingLimit.retryAfterSeconds);
    }

    const { error } = await supabaseAdmin.from("event_notify_signups").insert({
      email,
      client_ip: clientIp,
    });

    // A duplicate signup (same email twice) isn't an error from the
    // caller's point of view — they're already on the list either way.
    if (error && error.code !== "23505") {
      console.error("[notify-signup] insert failed:", error.message);
      return NextResponse.json({ error: "Failed to save signup" }, { status: 500 });
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof SpamDetected) {
      // Same response a real signup gets — never signal to a bot which
      // check it tripped.
      return NextResponse.json({ ok: true });
    }
    if (error instanceof ValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.error("[notify-signup] request failed:", error);
    return NextResponse.json({ error: "Failed to save signup" }, { status: 500 });
  }
}
