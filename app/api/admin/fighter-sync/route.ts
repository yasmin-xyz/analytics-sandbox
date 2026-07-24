import { NextResponse } from "next/server";
import { createHash, timingSafeEqual } from "crypto";
import { fetchCurrentUfcEvent } from "../../../lib/ufcEvent";
import { peekFighterMetrics, peekFighterHistory, syncFighter } from "../../../lib/fighterSync";
import { resetCitoCallCount, getCitoCallCount } from "../../../lib/citoProvider";
import { supabaseAdmin } from "../../../lib/supabaseAdmin";
import { checkRateLimit, getClientIp, rateLimitResponse } from "../../../lib/rateLimit";

// Manual preload workflow: run this whenever ESPN publishes/changes the next
// event, so ordinary page views never wait on Cito. Not a recurring cron —
// intentionally a manually-triggered, secret-protected endpoint (see #7 of
// the request that created this file).
//
// Vercel execution time headroom for a cold run across a full card.
export const maxDuration = 300;

const RATE_LIMIT_WINDOW_SECONDS = 60 * 60;
const RATE_LIMIT_MAX_REQUESTS = 10;

const LOCK_NAME = "fighter-sync";
// A little over maxDuration, so a lock from a run that crashed without
// releasing it self-expires instead of blocking every future run forever.
const LOCK_MAX_AGE_SECONDS = 360;

// Fixed-length digest comparison so a mismatched secret length can't be
// inferred from a thrown-vs-not-thrown difference, and timingSafeEqual
// compares equal-size buffers either way.
function timingSafeCompare(a: string, b: string): boolean {
  const hashA = createHash("sha256").update(a).digest();
  const hashB = createHash("sha256").update(b).digest();
  return timingSafeEqual(hashA, hashB);
}

function isAuthorized(request: Request): boolean {
  const configuredSecret = process.env.FIGHTER_SYNC_SECRET;

  if (!configuredSecret) {
    console.error("[admin/fighter-sync] FIGHTER_SYNC_SECRET is not configured — refusing all requests");
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
    console.error("[admin/fighter-sync] lock check failed, proceeding without it:", error.message);
    return true;
  }

  return !!data;
}

async function releaseLock() {
  const { error } = await supabaseAdmin.rpc("release_sync_lock", { p_lock_name: LOCK_NAME });
  if (error) {
    console.error("[admin/fighter-sync] lock release failed:", error.message);
  }
}

export async function POST(request: Request) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { allowed, retryAfterSeconds } = await checkRateLimit(
    `fighter-sync:${getClientIp(request)}`,
    RATE_LIMIT_WINDOW_SECONDS,
    RATE_LIMIT_MAX_REQUESTS
  );

  if (!allowed) {
    return rateLimitResponse(retryAfterSeconds);
  }

  if (!(await acquireLock())) {
    return NextResponse.json({ error: "A sync is already in progress" }, { status: 409 });
  }

  // Optional explicit fighter list — for backfilling a specific (usually
  // already-concluded) card whose fighters fetchCurrentUfcEvent() no
  // longer returns. `force` skips the cache-freshness check below, since
  // a fighter's metrics/history row from days ago isn't "stale" by the
  // normal 30-day window even though a real fight happened in that time.
  let explicitNames: string[] | null = null;
  let force = false;
  try {
    const body = await request.json();
    if (Array.isArray(body?.fighterNames) && body.fighterNames.every((n: unknown) => typeof n === "string")) {
      explicitNames = body.fighterNames;
      force = body.force === true;
    }
  } catch {
    // No/invalid JSON body — fall through to the current-event behavior.
  }

  try {
    let eventNameForLog = "manual fighter list";
    let uniqueNames: string[];

    if (explicitNames) {
      uniqueNames = [...new Set(explicitNames)];
    } else {
      const event = await fetchCurrentUfcEvent();

      if (!event) {
        return NextResponse.json({ error: "No current UFC event found" }, { status: 404 });
      }

      const names = new Set<string>();
      for (const fight of event.fights) {
        if (fight.fighterA) names.add(fight.fighterA);
        if (fight.fighterB) names.add(fight.fighterB);
      }

      uniqueNames = [...names];
      eventNameForLog = event.eventName;
    }

    console.log(
      `[admin/fighter-sync] event "${eventNameForLog}" — ${uniqueNames.length} unique fighters found${force ? " (force)" : ""}`
    );

    resetCitoCallCount();

    let cacheHits = 0;
    let fightersSynced = 0;
    let failures = 0;
    const results: {
      name: string;
      status: "cache_hit" | "synced" | "failed";
      metricsStatus: string;
      historyStatus: string;
    }[] = [];

    const startedAt = Date.now();

    for (const name of uniqueNames) {
      const metricsPeek = await peekFighterMetrics(name);
      const historyPeek = await peekFighterHistory(metricsPeek.providerSlug);

      const bothFresh =
        !force &&
        metricsPeek.status === "cached" &&
        !metricsPeek.needsRefresh &&
        historyPeek.status === "cached" &&
        !historyPeek.needsRefresh;

      if (bothFresh) {
        cacheHits += 1;
        console.log(`[admin/fighter-sync] cache hit, skipping: "${name}"`);
        results.push({ name, status: "cache_hit", metricsStatus: "cached", historyStatus: "cached" });
        continue;
      }

      console.log(`[admin/fighter-sync] syncing: "${name}"`);

      try {
        const synced = await syncFighter(name);

        if (synced.metrics.cacheStatus === "unavailable") {
          failures += 1;
          results.push({
            name,
            status: "failed",
            metricsStatus: synced.metrics.cacheStatus,
            historyStatus: synced.history.cacheStatus,
          });
        } else {
          fightersSynced += 1;
          results.push({
            name,
            status: "synced",
            metricsStatus: synced.metrics.cacheStatus,
            historyStatus: synced.history.cacheStatus,
          });
        }
      } catch (error) {
        failures += 1;
        console.error(
          `[admin/fighter-sync] sync threw for "${name}":`,
          error instanceof Error ? error.message : error
        );
        results.push({ name, status: "failed", metricsStatus: "error", historyStatus: "error" });
      }
    }

    const durationMs = Date.now() - startedAt;
    const citoCallsMade = getCitoCallCount();

    console.log(
      `[admin/fighter-sync] done in ${durationMs}ms — total=${uniqueNames.length} cacheHits=${cacheHits} synced=${fightersSynced} failures=${failures} citoCalls=${citoCallsMade}`
    );

    return NextResponse.json({
      eventName: eventNameForLog,
      totalFighters: uniqueNames.length,
      cacheHits,
      fightersSynced,
      failures,
      citoCallsMade,
      durationMs,
      results,
    });
  } catch (error) {
    console.error(
      "[admin/fighter-sync] request error:",
      error instanceof Error ? error.message : error
    );

    return NextResponse.json({ error: "Fighter sync failed" }, { status: 500 });
  } finally {
    await releaseLock();
  }
}
