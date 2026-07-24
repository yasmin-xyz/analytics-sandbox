import { NextResponse } from "next/server";
import { createHash, timingSafeEqual } from "crypto";
import { reconcilePendingPredictions } from "../../../lib/predictionReconciliation";
import { supabaseAdmin } from "../../../lib/supabaseAdmin";
import { checkRateLimit, getClientIp, rateLimitResponse } from "../../../lib/rateLimit";

// Manually-triggered, secret-protected — same posture as
// /api/admin/fighter-sync, and reuses its secret since both are
// maintenance actions behind the same trust boundary. Not a cron: Cito
// backfills real results on its own schedule, so this is meant to be
// re-run periodically (or right after this app's own fighter-history
// sync picks up a completed event) rather than on every request.

const RATE_LIMIT_WINDOW_SECONDS = 60 * 60;
const RATE_LIMIT_MAX_REQUESTS = 10;

const LOCK_NAME = "reconcile-predictions";
const LOCK_MAX_AGE_SECONDS = 120;

function timingSafeCompare(a: string, b: string): boolean {
  const hashA = createHash("sha256").update(a).digest();
  const hashB = createHash("sha256").update(b).digest();
  return timingSafeEqual(hashA, hashB);
}

function isAuthorized(request: Request): boolean {
  const configuredSecret = process.env.FIGHTER_SYNC_SECRET;

  if (!configuredSecret) {
    console.error("[admin/reconcile-predictions] FIGHTER_SYNC_SECRET is not configured — refusing all requests");
    return false;
  }

  const authHeader = request.headers.get("authorization") || "";
  const match = authHeader.match(/^Bearer (.+)$/);
  if (!match) return false;

  return timingSafeCompare(match[1], configuredSecret);
}

async function acquireLock(): Promise<boolean> {
  const { data, error } = await supabaseAdmin.rpc("acquire_sync_lock", {
    p_lock_name: LOCK_NAME,
    p_max_age_seconds: LOCK_MAX_AGE_SECONDS,
  });

  if (error) {
    console.error("[admin/reconcile-predictions] lock check failed, proceeding without it:", error.message);
    return true;
  }

  return !!data;
}

async function releaseLock() {
  const { error } = await supabaseAdmin.rpc("release_sync_lock", { p_lock_name: LOCK_NAME });
  if (error) {
    console.error("[admin/reconcile-predictions] lock release failed:", error.message);
  }
}

export async function POST(request: Request) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { allowed, retryAfterSeconds } = await checkRateLimit(
    `reconcile-predictions:${getClientIp(request)}`,
    RATE_LIMIT_WINDOW_SECONDS,
    RATE_LIMIT_MAX_REQUESTS
  );

  if (!allowed) {
    return rateLimitResponse(retryAfterSeconds);
  }

  if (!(await acquireLock())) {
    return NextResponse.json({ error: "A reconciliation run is already in progress" }, { status: 409 });
  }

  try {
    const summary = await reconcilePendingPredictions();
    return NextResponse.json(summary);
  } catch (error) {
    console.error(
      "[admin/reconcile-predictions] request error:",
      error instanceof Error ? error.message : error
    );

    return NextResponse.json({ error: "Reconciliation failed" }, { status: 500 });
  } finally {
    await releaseLock();
  }
}
