import "server-only";
import { namesMatchExactly, stripDiacritics } from "./fighterName";

// Enforced by the server-only import above — it reads CITO_API_KEY from
// process.env and that must never reach the browser.
const CITO_API_KEY = process.env.CITO_API_KEY;
const CITO_BASE_URL = "https://api.citoapi.com/api/v1/ufc";

export function isCitoConfigured(): boolean {
  return !!CITO_API_KEY;
}

// Lets callers (the admin bulk-sync endpoint) report exactly how many real
// Cito requests a run made, rather than inferring it from cache statuses.
let citoCallCount = 0;

export function getCitoCallCount(): number {
  return citoCallCount;
}

export function resetCitoCallCount(): void {
  citoCallCount = 0;
}

export type CitoFighterStats = {
  fighterSlug: string;
  sigStrikesLandedPerMin: string;
  strikingAccuracy: string;
  sigStrikesAbsorbedPerMin: string;
  sigStrikeDefense: string;
  takedownAvgPer15Min: string;
  takedownAccuracy: string;
  takedownDefense: string;
  submissionAvgPer15Min: string;
  sourceUrl: string | null;
  lastSyncedAt: string | null;
};

export type CitoSearchFighter = {
  slug: string;
  name: string;
  stats: CitoFighterStats | null;
  // Date of the fighter's first UFC bout, per Cito/UFC.com. Used to detect
  // a UFC debut — comparing this against the fight-card date is a much
  // more reliable signal than "we have no history rows for them", since
  // Cito's own fight-history coverage can be incomplete for a real veteran.
  octagonDebut: string | null;
};

export type CitoFightHistoryEntry = {
  outcome: string | null;
  opponent: { slug: string | null; name: string | null };
  event: { title: string | null; eventDate: string | null; locationText: string | null };
  bout: { method: string | null; resultRound: number | null; resultTime: string | null };
};

// Free tier allows 10 requests/min. Space calls out so a bulk sync never
// bursts past that, regardless of how many callers share this module.
const MIN_INTERVAL_MS = 6500;
let lastRequestAt = 0;
let throttleChain: Promise<void> = Promise.resolve();

function throttle(): Promise<void> {
  const next = throttleChain.then(async () => {
    const wait = lastRequestAt + MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    lastRequestAt = Date.now();
  });
  throttleChain = next.catch(() => {});
  return next;
}

type CitoFetchResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number | null; error: string };

async function citoFetch<T>(path: string): Promise<CitoFetchResult<T>> {
  if (!CITO_API_KEY) {
    return { ok: false, status: null, error: "CITO_API_KEY is not configured" };
  }

  await throttle();

  try {
    citoCallCount += 1;
    console.log(`[citoProvider] Cito request started: ${path}`);

    // no-store is required here, not optional — this app's fetch caches
    // by default (see the same fix in ufcEvent.ts), and Cito's search
    // results are per-fighter live lookups: caching by URL means every
    // future request for the same fighter name replays whatever the
    // FIRST response was forever, including a transient error or a
    // search that came back empty right as Cito's own index caught up
    // after a plan upgrade — exactly what caused Rakić/Błachowicz to
    // read as permanently "not found" even once Cito itself was healthy.
    const res = await fetch(`${CITO_BASE_URL}${path}`, {
      headers: { "x-api-key": CITO_API_KEY },
      cache: "no-store",
    });

    if (!res.ok) {
      return { ok: false, status: res.status, error: `Cito request failed (${res.status})` };
    }

    const body = await res.json();
    return { ok: true, data: body.data as T };
  } catch (error) {
    return {
      ok: false,
      status: null,
      error: error instanceof Error ? error.message : "Unknown Cito request error",
    };
  }
}

export type FighterSearchResult =
  | { status: "matched"; fighter: CitoSearchFighter }
  | { status: "not_found" }
  | { status: "ambiguous"; candidateCount: number }
  | { status: "error"; error: string };

async function runCitoSearch(query: string): Promise<CitoFetchResult<{ fighters: CitoSearchFighter[] }>> {
  return citoFetch<{ fighters: CitoSearchFighter[] }>(`/search?q=${encodeURIComponent(query)}`);
}

// Cito's search can come back completely empty for a query whose spelling
// doesn't closely match what it has on file — and "closely" cuts both
// ways: querying plain-ASCII "Jan Blachowicz" finds nothing even though
// Cito has "Jan Błachowicz" on file (diacritic in THEIR data, not ours),
// while querying accented "Vlasto Čepo" finds nothing even though Cito
// has him as the plain-ASCII "Vlasto Cepo" (diacritic in OUR data, not
// theirs). Neither direction reliably fuzzy-matches, and it also seems
// stricter across a full multi-word query than a single surname token.
// So: try the full name, then the same with diacritics stripped, then
// just the surname, then the surname with diacritics stripped — in that
// order, stopping at the first query that turns up a match. Every
// variant still has to pass namesMatchExactly() against the real full
// name below, so a same-surname mismatch (wrong fighter entirely) can
// never slip through — trying more query spellings only ever succeeds by
// finding the fighter actually asked for.
function buildSearchQueries(fighterName: string): string[] {
  const queries = new Set<string>();
  queries.add(fighterName);

  const stripped = stripDiacritics(fighterName);
  if (stripped !== fighterName) queries.add(stripped);

  const words = fighterName.trim().split(/\s+/);
  if (words.length >= 2) {
    const surname = words[words.length - 1];
    queries.add(surname);

    const strippedSurname = stripDiacritics(surname);
    if (strippedSurname !== surname) queries.add(strippedSurname);
  }

  return [...queries];
}

export async function searchCitoFighter(fighterName: string): Promise<FighterSearchResult> {
  for (const query of buildSearchQueries(fighterName)) {
    const result = await runCitoSearch(query);

    // A transient failure (network blip, rate limit) applies to the
    // whole API, not to this one query string — trying the other query
    // variants right now wouldn't help and would just burn more of the
    // same limited quota for nothing. Bail out immediately; the caller's
    // short backoff window (see ERROR_BACKOFF_SECONDS) is what actually
    // needs to pass before trying again.
    if (!result.ok) {
      return { status: "error", error: result.error };
    }

    const candidates = (result.data.fighters || []).filter((f) =>
      namesMatchExactly(f.name, fighterName)
    );

    if (candidates.length === 1) return { status: "matched", fighter: candidates[0] };
    if (candidates.length > 1) return { status: "ambiguous", candidateCount: candidates.length };
  }

  return { status: "not_found" };
}

export type FightHistoryResult =
  | { status: "ok"; fights: CitoFightHistoryEntry[] }
  | { status: "error"; error: string };

export async function fetchCitoFighterFights(slug: string): Promise<FightHistoryResult> {
  const result = await citoFetch<CitoFightHistoryEntry[]>(
    `/fighters/${encodeURIComponent(slug)}/fights`
  );

  if (!result.ok) {
    return { status: "error", error: result.error };
  }

  return { status: "ok", fights: result.data };
}
