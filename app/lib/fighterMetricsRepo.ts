import { supabaseAdmin } from "./supabaseAdmin";

export const FRESHNESS_DAYS = 30;

// A "not found" answer needs to self-correct far faster than a real
// synced result — Cito can add a fighter to its system within hours of
// them being confirmed for a card. Trusting "not found" for the same 30
// days as real data left several fighters (and everything gated on their
// Cito slug — history, the Sherdog fallback) stuck showing nothing for
// weeks after Cito actually had them.
export const NOT_FOUND_FRESHNESS_HOURS = 6;

// A transient provider error (network blip, rate limit) needs an even
// shorter window than "not found" — long enough that a client polling
// every few seconds can't re-trigger a Cito call before the previous
// one's rate-limit window has a chance to clear, short enough that a
// real transient blip still self-corrects almost immediately. Without
// this, a sustained rate limit and the frontend's own retry-on-poll
// behavior feed each other: poll -> retry -> still rate-limited -> still
// "syncing" -> poll again, immediately, forever, which is exactly what
// prevented the limit from ever actually clearing (see the Rakić/
// Błachowicz incident this was added for).
export const ERROR_BACKOFF_SECONDS = 90;

export function isFresh(timestamp: string | null | undefined, days = FRESHNESS_DAYS): boolean {
  if (!timestamp) return false;
  const age = Date.now() - new Date(timestamp).getTime();
  return age < days * 24 * 60 * 60 * 1000;
}

export function isFreshHours(timestamp: string | null | undefined, hours: number): boolean {
  if (!timestamp) return false;
  const age = Date.now() - new Date(timestamp).getTime();
  return age < hours * 60 * 60 * 1000;
}

export function isFreshSeconds(timestamp: string | null | undefined, seconds: number): boolean {
  if (!timestamp) return false;
  const age = Date.now() - new Date(timestamp).getTime();
  return age < seconds * 1000;
}

export type FighterMetricsRow = {
  fighter_name: string;
  normalized_name: string;
  provider_slug: string | null;
  source: string | null;
  source_url: string | null;
  slpm: string | null;
  str_acc: string | null;
  sapm: string | null;
  str_def: string | null;
  td_avg: string | null;
  td_acc: string | null;
  td_def: string | null;
  sub_avg: string | null;
  source_updated_at: string | null;
  last_synced_at: string | null;
  updated_at: string;
  octagon_debut?: string | null;
};

export async function getCachedMetrics(normalizedName: string) {
  const { data, error } = await supabaseAdmin
    .from("fighter_metrics")
    .select("*")
    .eq("normalized_name", normalizedName)
    .maybeSingle();

  if (error) {
    console.error(`[fighterMetricsRepo] read failure for ${normalizedName}:`, error.message);
    return null;
  }

  return data as (FighterMetricsRow & { id: number }) | null;
}

export async function upsertMetrics(row: FighterMetricsRow) {
  const { error } = await supabaseAdmin
    .from("fighter_metrics")
    .upsert(row, { onConflict: "normalized_name" });

  if (error) {
    console.error(`[fighterMetricsRepo] save failure for ${row.normalized_name}:`, error.message);
    return false;
  }

  console.log(`[fighterMetricsRepo] Supabase upsert completed (metrics): "${row.fighter_name}"`);
  return true;
}

export type FighterHistoryRow = {
  fighter_slug: string;
  fighter_name: string;
  opponent_slug: string | null;
  opponent_name: string | null;
  result: string | null;
  event_name: string | null;
  event_date: string | null;
  location: string | null;
  method: string | null;
  round: number | null;
  fight_time: string | null;
  source: string;
  updated_at: string;
};

// Cito's history feed occasionally contains two source records for the
// exact same real-world fight, differing in event-name completeness,
// event-date precision (off by a day, or — observed in production — off
// by a full year), and even method formatting (e.g. "U-DEC" vs.
// "Decision - Unanimous" for the same fight) enough that
// dedupeHistoryRows' exact-match key below doesn't catch them, so both
// get stored as separate rows. Round + finish time are the one pair of
// fields both duplicate variants agree on in every case seen so far —
// method is left out of the key because its formatting isn't consistent
// between duplicates, and opponent + round + time landing on the exact
// same second is not something two genuinely different fights against
// the same opponent would coincidentally share. Applied on read rather
// than fixed up in the DB so it needs no migration and stays correct
// even if a future sync reintroduces the same kind of near-duplicate.
function dedupeRedundantFights<T extends FighterHistoryRow>(rows: T[]): T[] {
  const byFight = new Map<string, T>();

  for (const row of rows) {
    const key = `${row.opponent_slug}|${row.round}|${row.fight_time}`;
    const existing = byFight.get(key);

    if (!existing) {
      byFight.set(key, row);
      continue;
    }

    // Prefer whichever row has the more specific event name (e.g. "UFC
    // 313: Pereira vs. Ankalaev" over a bare "UFC 313"); if those are
    // about equally descriptive, keep the earlier date.
    const existingLen = existing.event_name?.length ?? 0;
    const rowLen = row.event_name?.length ?? 0;

    if (rowLen > existingLen) {
      byFight.set(key, row);
    } else if (
      rowLen === existingLen &&
      row.event_date &&
      existing.event_date &&
      row.event_date < existing.event_date
    ) {
      byFight.set(key, row);
    }
  }

  return [...byFight.values()].sort((a, b) =>
    (b.event_date || "").localeCompare(a.event_date || "")
  );
}

export async function getCachedHistory(fighterSlug: string) {
  const { data, error } = await supabaseAdmin
    .from("fighter_history")
    .select("*")
    .eq("fighter_slug", fighterSlug)
    .order("event_date", { ascending: false });

  if (error) {
    console.error(`[fighterMetricsRepo] history read failure for ${fighterSlug}:`, error.message);
    return null;
  }

  return dedupeRedundantFights(data as (FighterHistoryRow & { id: number; updated_at: string })[]);
}

// Postgres' ON CONFLICT DO UPDATE cannot touch the same conflict target
// twice within one statement. Cito's fight-history responses occasionally
// contain two entries that map to the same (fighter_slug, opponent_slug,
// event_date, event_name) key — without de-duping first, the whole batch
// upsert fails with "ON CONFLICT DO UPDATE command cannot affect row a
// second time" and nothing gets saved.
function dedupeHistoryRows(rows: FighterHistoryRow[]): FighterHistoryRow[] {
  const seen = new Map<string, FighterHistoryRow>();

  for (const row of rows) {
    const key = `${row.fighter_slug}|${row.opponent_slug}|${row.event_date}|${row.event_name}`;
    seen.set(key, row);
  }

  return [...seen.values()];
}

export async function upsertHistoryRows(rows: FighterHistoryRow[]) {
  if (rows.length === 0) return true;

  const deduped = dedupeHistoryRows(rows);

  if (deduped.length !== rows.length) {
    console.warn(
      `[fighterMetricsRepo] deduped ${rows.length - deduped.length} duplicate history row(s) for "${rows[0].fighter_slug}" before upsert`
    );
  }

  const { error } = await supabaseAdmin
    .from("fighter_history")
    .upsert(deduped, { onConflict: "fighter_slug,opponent_slug,event_date,event_name" });

  if (error) {
    console.error(
      `[fighterMetricsRepo] history save failure for ${rows[0].fighter_slug}:`,
      error.message
    );
    return false;
  }

  console.log(
    `[fighterMetricsRepo] Supabase upsert completed (history): "${rows[0].fighter_name}" — ${deduped.length} row(s)`
  );
  return true;
}
