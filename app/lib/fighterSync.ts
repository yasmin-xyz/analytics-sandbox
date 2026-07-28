import "server-only";
import { normalizeFighterName } from "./fighterName";
import {
  searchCitoFighter,
  fetchCitoFighterFights,
  type CitoFighterStats,
} from "./citoProvider";
import { searchSherdogFighter, fetchSherdogFightHistory } from "./sherdogProvider";
import {
  getCachedMetrics,
  upsertMetrics,
  getCachedHistory,
  upsertHistoryRows,
  isFresh,
  isFreshHours,
  isFreshSeconds,
  NOT_FOUND_FRESHNESS_HOURS,
  ERROR_BACKOFF_SECONDS,
  type FighterMetricsRow,
  type FighterHistoryRow,
} from "./fighterMetricsRepo";

// A cached "not found" row uses its own, much shorter freshness window
// than a real synced result (see NOT_FOUND_FRESHNESS_HOURS) — Cito can add
// a fighter to its system within hours of them being confirmed for a
// card, so trusting a stale "not found" answer for 30 days like real data
// left several fighters permanently stuck with no metrics, no history,
// and no Sherdog fallback (which needs a real Cito slug to key its rows
// under) until the marker was manually cleared.
//
// A "cito-error" row gets an even shorter window (see ERROR_BACKOFF_SECONDS)
// — a transient failure (rate limit, network blip) shouldn't be trusted
// for hours, but it does need SOME backoff, or a client polling every few
// seconds re-triggers a Cito call immediately on every single poll,
// which never gives a rate-limit window room to actually clear.
function isMetricsRowFresh(row: { source: string | null; last_synced_at: string | null }): boolean {
  if (row.source === "cito-not-found") {
    return isFreshHours(row.last_synced_at, NOT_FOUND_FRESHNESS_HOURS);
  }
  if (row.source === "cito-error") {
    return isFreshSeconds(row.last_synced_at, ERROR_BACKOFF_SECONDS);
  }
  return isFresh(row.last_synced_at);
}

function slugifyOpponentName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");
}

export type MappedMetrics = {
  slpm: string | null;
  strAcc: string | null;
  sapm: string | null;
  strDef: string | null;
  tdAvg: string | null;
  tdAcc: string | null;
  tdDef: string | null;
  subAvg: string | null;
};

const REQUIRED_METRIC_KEYS: (keyof MappedMetrics)[] = [
  "slpm",
  "strAcc",
  "sapm",
  "strDef",
  "tdAvg",
  "tdAcc",
  "tdDef",
  "subAvg",
];

function toPercent(value: string | null | undefined): string | null {
  if (value == null) return null;
  const num = parseFloat(value);
  if (Number.isNaN(num)) return null;
  return `${Math.round(num * 100)}%`;
}

function mapCitoStats(stats: CitoFighterStats): MappedMetrics {
  return {
    slpm: stats.sigStrikesLandedPerMin ?? null,
    strAcc: toPercent(stats.strikingAccuracy),
    sapm: stats.sigStrikesAbsorbedPerMin ?? null,
    strDef: toPercent(stats.sigStrikeDefense),
    tdAvg: stats.takedownAvgPer15Min ?? null,
    tdAcc: toPercent(stats.takedownAccuracy),
    tdDef: toPercent(stats.takedownDefense),
    subAvg: stats.submissionAvgPer15Min ?? null,
  };
}

function rowToMapped(row: FighterMetricsRow): MappedMetrics {
  return {
    slpm: row.slpm,
    strAcc: row.str_acc,
    sapm: row.sapm,
    strDef: row.str_def,
    tdAvg: row.td_avg,
    tdAcc: row.td_acc,
    tdDef: row.td_def,
    subAvg: row.sub_avg,
  };
}

export type MetricsPeekResult = {
  normalizedName: string;
  providerSlug: string | null;
  status: "cached" | "missing" | "known_unavailable";
  needsRefresh: boolean;
  metrics: MappedMetrics | null;
  octagonDebut: string | null;
};

// Supabase-only read, no Cito calls. Used by the read-first fighter-metrics
// route so a request never blocks on the throttled provider.
export async function peekFighterMetrics(fighterName: string): Promise<MetricsPeekResult> {
  const normalizedName = normalizeFighterName(fighterName);
  const cached = await getCachedMetrics(normalizedName);

  if (!cached) {
    return { normalizedName, providerSlug: null, status: "missing", needsRefresh: true, metrics: null, octagonDebut: null };
  }

  // A cito-error row is treated the same as a confirmed not-found here —
  // "known_unavailable" plus needsRefresh (governed by isMetricsRowFresh's
  // short ERROR_BACKOFF_SECONDS window for this source) is exactly the
  // semantics the caller needs: report unavailable without immediately
  // re-triggering a sync, but retry soon rather than falling through to
  // the "cached" branch below, which would otherwise treat this all-null
  // placeholder row as real, fresh-for-30-days data.
  if (cached.source === "cito-not-found" || cached.source === "cito-error") {
    return {
      normalizedName,
      providerSlug: null,
      status: "known_unavailable",
      needsRefresh: !isMetricsRowFresh(cached),
      metrics: null,
      octagonDebut: null,
    };
  }

  return {
    normalizedName,
    providerSlug: cached.provider_slug,
    status: "cached",
    needsRefresh: !isFresh(cached.last_synced_at),
    metrics: rowToMapped(cached),
    octagonDebut: cached.octagon_debut ?? null,
  };
}

export type HistoryPeekResult = {
  status: "cached" | "missing";
  needsRefresh: boolean;
  history: HistoryEntry[];
};

// Supabase-only read, no Cito calls.
export async function peekFighterHistory(providerSlug: string | null): Promise<HistoryPeekResult> {
  if (!providerSlug) {
    return { status: "missing", needsRefresh: false, history: [] };
  }

  const cachedRows = await getCachedHistory(providerSlug);

  if (!cachedRows || cachedRows.length === 0) {
    return { status: "missing", needsRefresh: true, history: [] };
  }

  const newestUpdatedAt = cachedRows.reduce(
    (max, r) => (r.updated_at > max ? r.updated_at : max),
    cachedRows[0].updated_at
  );

  return {
    status: "cached",
    needsRefresh: !isFresh(newestUpdatedAt),
    history: cachedRows.map(rowToHistoryEntry),
  };
}

export type MetricsCacheStatus = "hit" | "miss_refreshed" | "stale_fallback" | "unavailable";

export type MetricsSyncResult = {
  normalizedName: string;
  cacheStatus: MetricsCacheStatus;
  providerSlug: string | null;
  metrics: MappedMetrics | null;
  octagonDebut: string | null;
};

export async function syncFighterMetrics(fighterName: string): Promise<MetricsSyncResult> {
  const normalizedName = normalizeFighterName(fighterName);
  const cached = await getCachedMetrics(normalizedName);

  if (cached && isMetricsRowFresh(cached)) {
    console.log(`[fighterSync] cache hit (metrics): "${fighterName}"`);
    return {
      normalizedName,
      cacheStatus: "hit",
      providerSlug: cached.provider_slug,
      metrics: rowToMapped(cached),
      octagonDebut: cached.octagon_debut ?? null,
    };
  }

  console.log(`[fighterSync] cache miss (metrics): "${fighterName}" — querying Cito`);
  const searchResult = await searchCitoFighter(fighterName);

  if (searchResult.status !== "matched") {
    console.warn(
      `[fighterSync] provider match failure (${searchResult.status}): "${fighterName}"`
    );

    // Only a real previously-synced row is worth falling back to here — a
    // "not found" or "error" marker has no actual data behind it, so
    // falling back to it would just return the same stale marker forever
    // without ever refreshing last_synced_at, permanently defeating the
    // shorter freshness windows below (every future request would see it
    // as stale and re-trigger a background sync, forever).
    if (cached && cached.source !== "cito-not-found" && cached.source !== "cito-error") {
      console.warn(`[fighterSync] falling back to stale cached metrics: "${fighterName}"`);
      return {
        normalizedName,
        cacheStatus: "stale_fallback",
        providerSlug: cached.provider_slug,
        metrics: rowToMapped(cached),
        octagonDebut: cached.octagon_debut ?? null,
      };
    }

    // not_found/ambiguous are deterministic outcomes — the search actually
    // completed and Cito simply doesn't have this fighter. Record that so
    // every subsequent poll/page-view doesn't re-burn a Cito call hoping
    // for a different answer; the freshness window gives it another try
    // later in case Cito adds the fighter.
    //
    // A transient "error" (network blip, rate limit) gets its own marker
    // too, just with a much shorter window (ERROR_BACKOFF_SECONDS) — it
    // still needs to self-correct fast, but leaving it completely
    // unrecorded (the previous behavior) meant a client polling every few
    // seconds could re-trigger a Cito call on every single poll with zero
    // backoff, which is exactly what turns a transient rate limit into a
    // sustained one: the retries never give the window room to clear.
    if (
      searchResult.status === "not_found" ||
      searchResult.status === "ambiguous" ||
      searchResult.status === "error"
    ) {
      const now = new Date().toISOString();
      const placeholderRow: FighterMetricsRow = {
        fighter_name: fighterName,
        normalized_name: normalizedName,
        provider_slug: null,
        source: searchResult.status === "error" ? "cito-error" : "cito-not-found",
        source_url: null,
        slpm: null,
        str_acc: null,
        sapm: null,
        str_def: null,
        td_avg: null,
        td_acc: null,
        td_def: null,
        sub_avg: null,
        source_updated_at: null,
        last_synced_at: now,
        updated_at: now,
      };

      const saved = await upsertMetrics(placeholderRow);
      if (!saved) {
        console.error(`[fighterSync] Supabase save failure (${placeholderRow.source} marker): "${fighterName}"`);
      }
    }

    return { normalizedName, cacheStatus: "unavailable", providerSlug: null, metrics: null, octagonDebut: null };
  }

  const fighter = searchResult.fighter;

  if (!fighter.stats) {
    console.error(`[fighterSync] provider response missing stats field: "${fighterName}"`);

    if (cached) {
      return {
        normalizedName,
        cacheStatus: "stale_fallback",
        providerSlug: cached.provider_slug,
        metrics: rowToMapped(cached),
        octagonDebut: cached.octagon_debut ?? null,
      };
    }

    return {
      normalizedName,
      cacheStatus: "unavailable",
      providerSlug: fighter.slug,
      metrics: null,
      octagonDebut: fighter.octagonDebut,
    };
  }

  const mapped = mapCitoStats(fighter.stats);
  const missingKeys = REQUIRED_METRIC_KEYS.filter((key) => mapped[key] == null);

  if (missingKeys.length > 0) {
    console.warn(
      `[fighterSync] provider response missing required fields (${missingKeys.join(", ")}): "${fighterName}"`
    );
  }

  const now = new Date().toISOString();

  const row: FighterMetricsRow = {
    fighter_name: fighterName,
    normalized_name: normalizedName,
    provider_slug: fighter.slug,
    source: "cito",
    source_url: fighter.stats.sourceUrl,
    slpm: mapped.slpm,
    str_acc: mapped.strAcc,
    sapm: mapped.sapm,
    str_def: mapped.strDef,
    td_avg: mapped.tdAvg,
    td_acc: mapped.tdAcc,
    td_def: mapped.tdDef,
    sub_avg: mapped.subAvg,
    source_updated_at: fighter.stats.lastSyncedAt,
    last_synced_at: now,
    updated_at: now,
    octagon_debut: fighter.octagonDebut,
  };

  const saved = await upsertMetrics(row);
  if (!saved) {
    console.error(`[fighterSync] Supabase save failure (metrics): "${fighterName}"`);
  }

  return {
    normalizedName,
    cacheStatus: "miss_refreshed",
    providerSlug: fighter.slug,
    metrics: mapped,
    octagonDebut: fighter.octagonDebut,
  };
}

export type HistoryEntry = {
  opponent: string | null;
  opponentSlug: string | null;
  result: string | null;
  event: string | null;
  date: string | null;
  location: string | null;
  method: string | null;
  round: number | null;
  time: string | null;
};

export type HistoryCacheStatus =
  | "hit"
  | "miss_refreshed"
  | "stale_fallback"
  | "unavailable"
  | "no_slug";

export type HistorySyncResult = {
  providerSlug: string | null;
  cacheStatus: HistoryCacheStatus;
  history: HistoryEntry[];
};

// Cito and Sherdog phrase the same outcome differently — Cito mixes
// abbreviations ("U-DEC") with its own spelled-out form ("Decision -
// Unanimous"), even across two entries for the same fighter, while
// Sherdog spells it out with a different punctuation style ("Decision
// (Unanimous)"). A fighter whose "Recent Fight History" mixes Cito and
// Sherdog rows would otherwise show inconsistent phrasing fight-to-fight
// for what is, to a reader, the identical outcome type.
const METHOD_ABBREVIATIONS: Record<string, string> = {
  "u-dec": "Decision (Unanimous)",
  "s-dec": "Decision (Split)",
  "m-dec": "Decision (Majority)",
  "sub": "Submission",
  "dq": "Disqualification",
  "cnc": "No Contest",
  "nc": "No Contest",
};

function normalizeMethod(method: string | null): string | null {
  if (!method) return method;
  const key = method.trim().toLowerCase();

  if (METHOD_ABBREVIATIONS[key]) return METHOD_ABBREVIATIONS[key];
  if (key.includes("unanimous")) return "Decision (Unanimous)";
  if (key.includes("split")) return "Decision (Split)";
  if (key.includes("majority")) return "Decision (Majority)";
  if (key === "decision") return "Decision";

  // KO/TKO, submission-with-technique, etc. — already consistent in
  // shape between providers, so passed through as-is.
  return method;
}

function rowToHistoryEntry(row: FighterHistoryRow): HistoryEntry {
  return {
    opponent: row.opponent_name,
    opponentSlug: row.opponent_slug,
    result: row.result,
    event: row.event_name,
    date: row.event_date,
    location: row.location,
    method: normalizeMethod(row.method),
    round: row.round,
    time: row.fight_time,
  };
}

async function fetchSherdogHistoryFallback(
  fighterName: string,
  citoSlug: string,
  now: string
): Promise<FighterHistoryRow[]> {
  const searchResult = await searchSherdogFighter(fighterName);

  if (searchResult.status !== "matched") {
    console.log(`[fighterSync] Sherdog fallback: ${searchResult.status} for "${fighterName}"`);
    return [];
  }

  const historyResult = await fetchSherdogFightHistory(searchResult.profileUrl);

  if (historyResult.status !== "ok") {
    console.warn(`[fighterSync] Sherdog fallback error for "${fighterName}": ${historyResult.error}`);
    return [];
  }

  if (historyResult.fights.length === 0) {
    return [];
  }

  console.log(`[fighterSync] Sherdog fallback found ${historyResult.fights.length} fight(s): "${fighterName}"`);

  return historyResult.fights
    .filter((fight) => fight.opponent)
    .map((fight) => ({
      // Stored under Cito's slug (not Sherdog's own) so this fighter's
      // history stays keyed the same way everywhere else in the app reads
      // it — only the `source` tag records where the data actually came
      // from.
      fighter_slug: citoSlug,
      fighter_name: fighterName,
      opponent_slug: slugifyOpponentName(fight.opponent as string),
      opponent_name: fight.opponent,
      result: fight.result,
      event_name: fight.event,
      event_date: fight.eventDate,
      location: null,
      method: fight.method,
      round: fight.round,
      fight_time: fight.time,
      source: "sherdog",
      updated_at: now,
    }));
}

export async function syncFighterHistory(
  fighterName: string,
  providerSlug: string | null
): Promise<HistorySyncResult> {
  if (!providerSlug) {
    console.warn(`[fighterSync] no provider slug available for history: "${fighterName}"`);
    return { providerSlug: null, cacheStatus: "no_slug", history: [] };
  }

  const cachedRows = await getCachedHistory(providerSlug);
  const newestUpdatedAt =
    cachedRows && cachedRows.length > 0
      ? cachedRows.reduce((max, r) => (r.updated_at > max ? r.updated_at : max), cachedRows[0].updated_at)
      : null;

  if (cachedRows && cachedRows.length > 0 && isFresh(newestUpdatedAt)) {
    console.log(`[fighterSync] cache hit (history): "${fighterName}"`);
    return { providerSlug, cacheStatus: "hit", history: cachedRows.map(rowToHistoryEntry) };
  }

  console.log(`[fighterSync] cache miss (history): "${fighterName}" — querying Cito`);
  const fightsResult = await fetchCitoFighterFights(providerSlug);

  if (fightsResult.status !== "ok") {
    console.error(`[fighterSync] provider error (history): "${fighterName}": ${fightsResult.error}`);

    if (cachedRows && cachedRows.length > 0) {
      console.warn(`[fighterSync] falling back to stale cached history: "${fighterName}"`);
      return { providerSlug, cacheStatus: "stale_fallback", history: cachedRows.map(rowToHistoryEntry) };
    }

    return { providerSlug, cacheStatus: "unavailable", history: [] };
  }

  const now = new Date().toISOString();

  let rows: FighterHistoryRow[] = fightsResult.fights.map((fight) => ({
    fighter_slug: providerSlug,
    fighter_name: fighterName,
    opponent_slug: fight.opponent?.slug ?? null,
    opponent_name: fight.opponent?.name ?? null,
    result: fight.outcome,
    event_name: fight.event?.title ?? null,
    event_date: fight.event?.eventDate ?? null,
    location: fight.event?.locationText ?? null,
    method: fight.bout?.method ?? null,
    round: fight.bout?.resultRound ?? null,
    fight_time: fight.bout?.resultTime ?? null,
    source: "cito",
    updated_at: now,
  }));

  // Cito's fight-history coverage is Octagon-only, so a fighter early in
  // their UFC run can have only 0 or 1 RESOLVED fights here — the one entry
  // Cito always returns is often just the upcoming/unresolved bout itself
  // (result: null), not a real completed fight. Drop that before counting:
  // rows.length alone would never reflect "not enough real fights", since
  // that scheduled-bout entry means the array is never actually empty.
  // Sherdog covers regional/pre-UFC promotions Cito never will, so it's
  // used to TOP UP (not replace) real Cito rows up to a minimum of 3 —
  // enough for "Recent Fight History" to read as more than a single line
  // for a fighter early in their UFC tenure, without ever discarding a
  // real Cito-sourced result.
  const MIN_HISTORY_ROWS = 3;
  const resolvedCitoRows = rows.filter((row) => !!row.result);

  // Cito occasionally returns two source records for the exact same
  // real-world fight, differing only in event-name punctuation, location
  // text, or method formatting (see dedupeRedundantFights in
  // fighterMetricsRepo.ts, which collapses these on read) — counting
  // resolvedCitoRows.length directly would double-count one real fight as
  // two, under-requesting how many Sherdog rows are actually needed.
  const distinctResolvedFights = new Set(
    resolvedCitoRows.map((row) => `${row.opponent_slug}|${row.round}|${row.fight_time}`)
  ).size;

  if (distinctResolvedFights < MIN_HISTORY_ROWS) {
    console.log(
      `[fighterSync] only ${distinctResolvedFights} distinct resolved Cito fight(s) — topping up with Sherdog: "${fighterName}"`
    );
    const sherdogRows = await fetchSherdogHistoryFallback(fighterName, providerSlug, now);

    // Sherdog and Cito can both carry the same real-world fight — skip any
    // Sherdog row whose opponent Cito's resolved rows already cover, so a
    // fighter never sees the same bout listed twice.
    const citoOpponents = new Set(
      resolvedCitoRows.map((row) => (row.opponent_name || "").toLowerCase().trim())
    );
    const supplementalRows = sherdogRows.filter(
      (row) => !citoOpponents.has((row.opponent_name || "").toLowerCase().trim())
    );

    const needed = MIN_HISTORY_ROWS - distinctResolvedFights;
    rows = [...resolvedCitoRows, ...supplementalRows.slice(0, needed)];
  } else {
    rows = resolvedCitoRows;
  }

  const saved = await upsertHistoryRows(rows);
  if (!saved) {
    console.error(`[fighterSync] Supabase save failure (history): "${fighterName}"`);
  }

  return {
    providerSlug,
    cacheStatus: "miss_refreshed",
    history: rows.map(rowToHistoryEntry),
  };
}

export type FighterSyncResult = {
  fighterName: string;
  metrics: MetricsSyncResult;
  history: HistorySyncResult;
};

// Coalesces concurrent calls for the same fighter (e.g. two overlapping
// /api/fighter-metrics requests both scheduling a background sync via
// after()) so only one real sync — and one set of Cito calls — runs at a
// time per fighter, per server instance.
const inFlightSyncs = new Map<string, Promise<FighterSyncResult>>();

export async function syncFighter(fighterName: string): Promise<FighterSyncResult> {
  const key = normalizeFighterName(fighterName);

  const existing = inFlightSyncs.get(key);
  if (existing) {
    console.log(`[fighterSync] sync already in flight, joining existing run: "${fighterName}"`);
    return existing;
  }

  const runPromise = (async () => {
    console.log(`[fighterSync] background sync started: "${fighterName}"`);
    const metrics = await syncFighterMetrics(fighterName);
    const history = await syncFighterHistory(fighterName, metrics.providerSlug);
    return { fighterName, metrics, history };
  })();

  inFlightSyncs.set(key, runPromise);

  try {
    return await runPromise;
  } finally {
    inFlightSyncs.delete(key);
  }
}
