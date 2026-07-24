"use client";

import { useEffect, useRef, useState } from "react";
import { mergeFightData } from "./lib/mergeFightData";
import { namesMatchExactly } from "./lib/fighterName";
import InfoTooltip from "./components/InfoTooltip";
import ConfidenceMeter from "./components/ConfidenceMeter";
import Countdown from "./components/Countdown";
import FightSelect from "./components/FightSelect";
import { useRevealOnScroll } from "./lib/useRevealOnScroll";

function fightName(fight: any) {
  return `${fight.home_team} vs. ${fight.away_team}`;
}

function getNextEventFights(fights: any[]) {
  if (!fights.length) return [];
  
  // Find the earliest upcoming fight date
  const now = new Date();
  const upcoming = fights
    .filter((f) => new Date(f.commence_time) > now)
    .sort((a, b) => new Date(a.commence_time).getTime() - new Date(b.commence_time).getTime());
  
  if (!upcoming.length) return [];
  
  // Get the date of the first upcoming fight
  const firstDate = new Date(upcoming[0].commence_time);
  
  // Group all fights within 24 hours of the first fight — same event
  const eventStart = new Date(firstDate);
  eventStart.setHours(0, 0, 0, 0);
  const eventEnd = new Date(eventStart);
  eventEnd.setDate(eventEnd.getDate() + 2); // 48hr window covers UTC date shifts
  
  return upcoming.filter((f) => {
    const fightDate = new Date(f.commence_time);
    return fightDate >= eventStart && fightDate <= eventEnd;
  });
}

function rawImpliedProbability(americanOdds: number | null | undefined): number | null {
  if (!americanOdds) return null;
  if (americanOdds < 0) return -americanOdds / (-americanOdds + 100);
  return 100 / (americanOdds + 100);
}

// Raw implied probabilities from opposite sides of the same market always
// sum to more than 100% (the bookmaker's vig). Normalize so both sides sum
// to exactly 100%, keeping full precision internally and rounding only for
// display.
function normalizedImpliedProbabilities(
  oddsA: number | null | undefined,
  oddsB: number | null | undefined
): { a: number | null; b: number | null } {
  const rawA = rawImpliedProbability(oddsA);
  const rawB = rawImpliedProbability(oddsB);

  if (rawA === null || rawB === null) return { a: null, b: null };

  const sum = rawA + rawB;
  if (sum <= 0) return { a: null, b: null };

  return {
    a: Math.round((rawA / sum) * 100),
    b: Math.round((rawB / sum) * 100),
  };
}

function medianOf(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

// bookmakers[0] is an arbitrary, display-order-dependent pick (and shifts
// whenever reorderBookmakers() swaps display positions around) — the
// median price across every book actually quoting this fight is a far more
// honest "market odds" than whichever one happens to sort first.
function medianMarketOdds(
  bookmakers: any[] | null | undefined,
  fighterAOutcomeName: string | null | undefined,
  fighterBOutcomeName: string | null | undefined
): { oddsA: number | null; oddsB: number | null } {
  const pricesA: number[] = [];
  const pricesB: number[] = [];

  for (const bookmaker of bookmakers || []) {
    const outcomes = bookmaker?.markets?.[0]?.outcomes || [];
    const priceA = outcomes.find((o: any) => o.name === fighterAOutcomeName)?.price;
    const priceB = outcomes.find((o: any) => o.name === fighterBOutcomeName)?.price;
    if (typeof priceA === "number") pricesA.push(priceA);
    if (typeof priceB === "number") pricesB.push(priceB);
  }

  return { oddsA: medianOf(pricesA), oddsB: medianOf(pricesB) };
}

type MarketGapTier =
  | "Market-aligned"
  | "Slight contrarian lean"
  | "Contrarian pick"
  | "High-risk contrarian pick"
  | "Mixed model signal";

// Tiered by how much of an underdog the consensus winner is per the
// (normalized) market — not by the raw size of the confidence/market gap,
// since a large gap on a market favorite isn't "contrarian" at all.
// Below this, "AI more/less confident than the market" isn't a meaningful
// signal — it reads as noise, not edge. Colors are reserved for gaps
// large enough to actually mean something; a small gap renders neutral
// instead of red/green so it doesn't look like a verdict on the pick.
const MARKET_GAP_SIGNIFICANCE_THRESHOLD = 10;

function marketGapTier(
  consensusWinnerMarketProbability: number | null,
  modelAgreement: string | undefined
): MarketGapTier | null {
  if (consensusWinnerMarketProbability === null) return null;
  if (modelAgreement === "Split") return "Mixed model signal";

  if (consensusWinnerMarketProbability >= 50) return "Market-aligned";
  if (consensusWinnerMarketProbability >= 35) return "Slight contrarian lean";
  if (consensusWinnerMarketProbability >= 20) return "Contrarian pick";
  return "High-risk contrarian pick";
}
function formatAmericanOdds(odds: number | null | undefined) {
  if (odds === null || odds === undefined) return "—";
  return odds > 0 ? `+${odds}` : `${odds}`;
}
function metricNumber(value: string | number | undefined) {
  if (value === undefined || value === null || value === "—") return 0;
  return Number(String(value).replace("%", "")) || 0;
}

function metricWidth(value: string | number | undefined, max: number) {
  const num = metricNumber(value);
  if (!num) return 0;
  return Math.min(Math.round((num / max) * 100), 100);
}
// ESPN represents "we don't have this" a few different ways depending on
// the field — missing entirely (undefined), or a literal "--" placeholder
// (seen on stance) — normalize all of them to null so the UI can show one
// consistent, honest "Unknown" state instead of a bare dash that reads as
// a rendering glitch.
function formatBioValue(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const str = String(value).trim();
  if (!str || /^-+$/.test(str)) return null;
  return str;
}

// Cito's octagonDebut is the date of a fighter's first UFC bout. If it
// falls within a day or two of the card being viewed, that IS this fight —
// a much more reliable "UFC debut" signal than an empty history list,
// since Cito's fight-history coverage can itself be incomplete for a real
// veteran (a false "debut" label would be actively misleading, not just
// an absent nice-to-have).
function isUpcomingDebut(octagonDebut: string | null, fightDate: string | null | undefined): boolean {
  if (!octagonDebut || !fightDate) return false;
  const debutTime = new Date(octagonDebut).getTime();
  const fightTime = new Date(fightDate).getTime();
  if (Number.isNaN(debutTime) || Number.isNaN(fightTime)) return false;
  return Math.abs(debutTime - fightTime) <= 2 * 24 * 60 * 60 * 1000;
}

// Distinct from the loading skeleton (a shimmering circle, meaning "still
// fetching") — this is the terminal state for a fighter ESPN simply has no
// headshot on file for, so it shouldn't look like an image that's still on
// its way in. A generic silhouette (as social apps use for accounts with no
// profile photo) reads as "no photo available" rather than "broken/loading".
function FighterHeadshotPlaceholder({ className = "" }: { className?: string }) {
  return (
    <div className={`fighter-headshot fighter-headshot-placeholder ${className}`} aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
        <circle cx="12" cy="8" r="4" />
        <path d="M4 20c0-4.4 3.6-8 8-8s8 3.6 8 8H4z" />
      </svg>
    </div>
  );
}

function confidenceTier(value: number): "Low" | "Moderate" | "Strong" | "High" {
  if (value < 55) return "Low";
  if (value < 70) return "Moderate";
  if (value < 80) return "Strong";
  return "High";
}

function formatPredictedRound(
  method: string | undefined,
  round: string | number | undefined
) {
  if (!method) return "—";

  if (method.toLowerCase().includes("decision")) {
    return "To go the distance";
  }

  return round || "—";
}

const NAME_SUFFIXES = new Set(["jr.", "jr", "sr.", "sr", "ii", "iii", "iv", "v"]);

function shortName(fullName: string | undefined, fallback = "Fighter") {
  if (!fullName) return fallback;

  const parts = fullName.trim().split(/\s+/);
  if (parts.length === 0) return fallback;

  let last = parts[parts.length - 1];
  if (parts.length > 1 && NAME_SUFFIXES.has(last.toLowerCase())) {
    last = parts[parts.length - 2];
  }

  return last;
}

// Cito's `result` field isn't limited to "win"/"loss" — draws and no
// contests are real MMA outcomes, not just missing data. Treating
// anything non-"win" as a loss (the previous logic) silently mislabels
// them.
function historyResultBadge(result: string | null | undefined): { label: string; className: string } {
  const normalized = (result || "").trim().toLowerCase();
  if (normalized === "win") return { label: "W", className: "result-w" };
  if (normalized === "draw") return { label: "D", className: "result-d" };
  if (normalized === "nc" || normalized === "no contest" || normalized === "no-contest") {
    return { label: "NC", className: "result-nc" };
  }
  return { label: "L", className: "result-l" };
}

// `nowMs` is passed in (rather than read via Date.now() inline) so the
// display string only changes when the caller's ticking clock advances,
// not on every unrelated render — the underlying `fetchedAtIso` is the
// actual source of truth and never resets on its own.
function formatOddsTimestamp(
  fetchedAtIso: string | null,
  nowMs: number,
  stale: boolean
): string | null {
  if (!fetchedAtIso) return null;
  const fetchedMs = new Date(fetchedAtIso).getTime();
  if (isNaN(fetchedMs)) return null;

  const diffMinutes = Math.floor((nowMs - fetchedMs) / 60000);
  const diffHours = Math.floor(diffMinutes / 60);

  let relative: string;
  if (diffMinutes < 1) {
    relative = "just now";
  } else if (diffMinutes < 60) {
    relative = `${diffMinutes} minute${diffMinutes === 1 ? "" : "s"} ago`;
  } else if (diffHours < 24) {
    relative = `${diffHours} hour${diffHours === 1 ? "" : "s"} ago`;
  } else {
    const date = new Date(fetchedMs);
    const dateStr = date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
    const timeStr = date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
    relative = `on ${dateStr} at ${timeStr}`;
  }

  // When serving a last-known-good fallback (the live provider request
  // failed), say so explicitly rather than letting a normal-looking
  // "Last updated" caption imply everything is current.
  if (stale) {
    return `Odds last updated ${relative} • Live updates temporarily unavailable`;
  }

  return diffHours < 24 ? `Last updated ${relative}` : `Odds updated ${relative}`;
}

export default function Home() {
  const [odds, setOdds] = useState<any[]>([]);
  const [loadingOdds, setLoadingOdds] = useState(true);
  const [oddsFetchedAt, setOddsFetchedAt] = useState<string | null>(null);
  // true once we've gotten a response confirming the odds provider is
  // reachable at all this session — starts true (assume best) so we
  // don't flash a "provider unavailable" message before the first
  // request has even resolved.
  const [oddsProviderAvailable, setOddsProviderAvailable] = useState(true);
  const [oddsStale, setOddsStale] = useState(false);
  // Ticks once a minute purely so the "Last updated X ago" copy stays
  // accurate over a long-lived page session — never triggers a re-fetch.
  const [now, setNow] = useState(() => Date.now());
  const [selectedFight, setSelectedFight] = useState<any>(null);
  // Purely cosmetic — briefly dims the matchup-dependent cards whenever the
  // selected fight's identity changes, so the old fight's content never
  // flashes straight into the new one mid-update. Runs on a fixed timer
  // independent of how long the underlying data actually takes to arrive
  // (each card's own skeleton/loading state still governs that), so cached
  // fights aren't held back and rapid switching just resets this one timer
  // instead of queuing anything.
  const [contentDim, setContentDim] = useState(false);
  const [fighterAStats, setFighterAStats] = useState<any>(null);
const [fighterBStats, setFighterBStats] = useState<any>(null);
  const [rankings, setRankings] = useState<Record<string, { champion: string | null; ranks: { rank: number; name: string }[] }>>({});
  const [ufcEvent, setUfcEvent] = useState<any>(null);
const [mergedFights, setMergedFights] = useState<any[]>([]);
  const [eventVenue, setEventVenue] = useState<string>("");
  const [eventLocation, setEventLocation] = useState<string>("");
  const [prediction, setPrediction] = useState<any>(null);
  const [loadingPrediction, setLoadingPrediction] = useState(false);
  const [predictionError, setPredictionError] = useState(false);
  const [activeTab, setActiveTab] = useState("main");

  const [fighterAMetrics, setFighterAMetrics] = useState<any>({});
  const [fighterBMetrics, setFighterBMetrics] = useState<any>({});
  const [metricsStatus, setMetricsStatus] = useState<"idle" | "loading" | "polling" | "ready" | "timeout" | "error">("idle");
  const [fighterAMetricsState, setFighterAMetricsState] = useState<string>("");
  const [fighterBMetricsState, setFighterBMetricsState] = useState<string>("");

  // Cito's own record of each fighter's first UFC bout date — compared
  // against the selected fight's date to flag an upcoming UFC debut.
  const [fighterAOctagonDebut, setFighterAOctagonDebut] = useState<string | null>(null);
  const [fighterBOctagonDebut, setFighterBOctagonDebut] = useState<string | null>(null);

  const [fighterAHistory, setFighterAHistory] = useState<any[]>([]);
  const [fighterBHistory, setFighterBHistory] = useState<any[]>([]);
  const [historyStatus, setHistoryStatus] = useState<"idle" | "loading" | "polling" | "ready" | "timeout" | "error">("idle");
  const [fighterAHistoryState, setFighterAHistoryState] = useState<string>("");
  const [fighterBHistoryState, setFighterBHistoryState] = useState<string>("");
  const [historyToggle, setHistoryToggle] = useState<"A" | "B">("A");

  const requestIdRef = useRef(0);
  const metricsRequestIdRef = useRef(0);
  const metricsPollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fighterStatsRequestIdRef = useRef(0);
  const assetReadyIdRef = useRef(0);

  // Scroll-triggered reveal for the Fighter Metrics bars and the
  // Prediction Summary confidence rail — each plays once its own card
  // scrolls into view, and replays whenever the selected fight changes
  // (immediately, if the card is already on screen when that happens).
  const { ref: statsCardRef, visible: statsBarsVisible } =
    useRevealOnScroll<HTMLDivElement>(selectedFight?.id ?? null);
  const { ref: predictionCardRef, visible: confidenceVisible } =
    useRevealOnScroll<HTMLDivElement>(selectedFight?.id ?? null);

  // Called only with data resolved for THIS exact fight, passed explicitly —
  // never reads fighterAStats/fighterBStats/fighterAMetrics/fighterBMetrics
  // from component state, since those can lag behind the currently selected
  // fight while their own effects are still loading.
  async function fetchPrediction(
    fight: any,
    fighterAStatsArg: any,
    fighterBStatsArg: any,
    fighterAMetricsArg: any,
    fighterBMetricsArg: any,
    fighterAHistoryArg: any[],
    fighterBHistoryArg: any[],
    requestId: number
  ) {
    if (!fight) return;
    if (requestId !== requestIdRef.current) return;

    const { oddsA: medianOddsA, oddsB: medianOddsB } = medianMarketOdds(
      fight.odds?.bookmakers,
      fight.odds?.fighterAOutcomeName,
      fight.odds?.fighterBOutcomeName
    );

    try {
      const res = await fetch("/api/predict", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fighterA: fight.fighterA,
          fighterB: fight.fighterB,
          oddsA: medianOddsA || 0,
          oddsB: medianOddsB || 0,
          eventName: ufcEvent?.eventName || null,

          fighterAStats: fighterAStatsArg,
          fighterBStats: fighterBStatsArg,

          fighterAMetrics: fighterAMetricsArg,
          fighterBMetrics: fighterBMetricsArg,

          // Picked down to exactly what the server's validator allows —
          // the raw history objects may carry extra fields it doesn't
          // know about.
          fighterAHistory: (fighterAHistoryArg || []).slice(0, 5).map((f: any) => ({
            opponent: f.opponent, result: f.result, method: f.method, round: f.round, time: f.time, event: f.event, date: f.date,
          })),
          fighterBHistory: (fighterBHistoryArg || []).slice(0, 5).map((f: any) => ({
            opponent: f.opponent, result: f.result, method: f.method, round: f.round, time: f.time, event: f.event, date: f.date,
          })),

          // Explicit source tags so the server can verify these metrics
          // objects actually belong to the fighters named above, instead
          // of trusting the client's bundling.
          fighterAMetricsSource: fight.fighterA,
          fighterBMetricsSource: fight.fighterB,
        }),
      });

      if (!res.ok) {
        const errorBody = await res.json().catch(() => null);
        throw new Error(errorBody?.error || `Request failed (${res.status})`);
      }

      const data = await res.json();

      if (requestId !== requestIdRef.current) {
        return;
      }

      if (!data || (!data.claude && !data.gpt && !data.gemini)) {
        throw new Error("Prediction response was empty");
      }

      setPrediction(data);
    } catch (error) {
      console.error("Failed to fetch prediction:", error);

      if (requestId === requestIdRef.current) {
        setPredictionError(true);
      }
    } finally {
      if (requestId === requestIdRef.current) {
        setLoadingPrediction(false);
      }
    }
  }

  // Single coordinated data-loading operation for a fight selection: fetch
  // both ESPN profiles and both Cito/Supabase metric records for the exact
  // fighters in `fight`, validate the ESPN data against the requested
  // names, then hand everything to fetchPrediction as explicit arguments.
  // The prediction request never starts until this has resolved.
  async function loadPredictionData(fight: any) {
    if (!fight?.fighterA || !fight?.fighterB) return;

    const requestId = ++requestIdRef.current;

    setLoadingPrediction(true);
    setPrediction(null);
    setPredictionError(false);

    try {
      const [statsAResult, statsBResult, metricsResult] = await Promise.allSettled([
        fight.fighterAId
          ? fetch(`/api/fighter-stats?id=${fight.fighterAId}`).then((r) => (r.ok ? r.json() : null))
          : Promise.resolve(null),
        fight.fighterBId
          ? fetch(`/api/fighter-stats?id=${fight.fighterBId}`).then((r) => (r.ok ? r.json() : null))
          : Promise.resolve(null),
        fetch("/api/fighter-metrics", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ names: [fight.fighterA, fight.fighterB] }),
        }).then((r) => (r.ok ? r.json() : null)),
      ]);

      if (requestId !== requestIdRef.current) return;

      const rawStatsA = statsAResult.status === "fulfilled" ? statsAResult.value : null;
      const rawStatsB = statsBResult.status === "fulfilled" ? statsBResult.value : null;
      const metricsData = metricsResult.status === "fulfilled" ? metricsResult.value : null;

      // ESPN bio data is supplementary — if it doesn't belong to the
      // requested fighter, drop it rather than risk feeding it in under
      // the wrong name. Cito/Supabase metrics are already correctly keyed
      // by name in the response itself, so no separate check is needed.
      const statsA = rawStatsA?.name && namesMatchExactly(rawStatsA.name, fight.fighterA) ? rawStatsA : null;
      const statsB = rawStatsB?.name && namesMatchExactly(rawStatsB.name, fight.fighterB) ? rawStatsB : null;

      if (rawStatsA && !statsA) {
        console.warn(`ESPN stats name mismatch: expected "${fight.fighterA}", got "${rawStatsA?.name}"`);
      }
      if (rawStatsB && !statsB) {
        console.warn(`ESPN stats name mismatch: expected "${fight.fighterB}", got "${rawStatsB?.name}"`);
      }

      const metricsA = metricsData?.metrics?.[fight.fighterA] || {};
      const metricsB = metricsData?.metrics?.[fight.fighterB] || {};
      const historyA = metricsData?.history?.[fight.fighterA] || [];
      const historyB = metricsData?.history?.[fight.fighterB] || [];

      await fetchPrediction(fight, statsA, statsB, metricsA, metricsB, historyA, historyB, requestId);
    } catch (error) {
      console.error("Failed to load prediction inputs:", error);

      if (requestId === requestIdRef.current) {
        setPredictionError(true);
        setLoadingPrediction(false);
      }
    }
  }

  // Single entry point for every fight-selection call site, so the
  // coordinated data-load + prediction pipeline always runs the same way.
  function selectFight(fight: any) {
    setSelectedFight(fight);
    loadPredictionData(fight);
  }

  // The browser restores the previous scroll position on reload by
  // default, which made the page look like it never loaded at the top.
  // Force it to always start at the top instead.
  useEffect(() => {
    if ("scrollRestoration" in window.history) {
      window.history.scrollRestoration = "manual";
    }
    window.scrollTo(0, 0);
  }, []);

  useEffect(() => {
    async function fetchOdds() {
      try {
        const oddsRes = await fetch("/api/odds");
        const oddsPayload = await oddsRes.json();
        const oddsData = oddsPayload.odds || [];

        const eventRes = await fetch("/api/ufc-event");
        const eventData = await eventRes.json();

        const merged = mergeFightData(eventData.fights, oddsData);

        setOdds(oddsData);
        setOddsFetchedAt(oddsPayload?.fetchedAt || null);
        setOddsStale(!!oddsPayload?.stale);
        setOddsProviderAvailable(oddsPayload?.providerAvailable !== false);
        setUfcEvent(eventData);
        setMergedFights(merged);

        try {
          const espnRes = await fetch(
            "https://site.api.espn.com/apis/site/v2/sports/mma/ufc/scoreboard"
          );
          const espnData = await espnRes.json();
          const nextEvent = espnData?.events?.[0];
          if (nextEvent) {
            const venue = nextEvent?.competitions?.[0]?.venue;
            if (venue) {
              setEventVenue(venue.fullName || "");
              const city = venue.address?.city || "";
              const state = venue.address?.state || "";
              setEventLocation(`${city}${state ? `, ${state}` : ""}`);
            }
          }
        } catch {
          // venue data is optional, fail silently
        }

        const mainCardFights = merged.slice(-5).reverse();
const defaultFight = mainCardFights[0] || merged[0];

selectFight(defaultFight);
      } catch (error) {
        console.error("Failed to load odds:", error);
      } finally {
        setLoadingOdds(false);
      }
    }
    fetchOdds();
  }, []);

  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 60000);
    return () => clearInterval(interval);
  }, []);

  const ASSET_READY_TIMEOUT_MS = 2500;

  // Coordinates the matchup crossfade with actual asset readiness instead
  // of a fixed timer: dims immediately when the fight identity changes,
  // then waits for fresh Tale-of-the-Tape stats (loadFighters resets these
  // to null when it starts a new fetch, so this effect re-fires once, then
  // again when the real data lands) and for both headshot images to
  // finish loading before revealing the new content. A stale-guard id and
  // a timeout keep rapid switching or a broken image from blocking it.
  useEffect(() => {
    if (!selectedFight) return;

    const readyId = ++assetReadyIdRef.current;
    setContentDim(true);

    if (!fighterAStats || !fighterBStats) {
      // Waiting on loadFighters — this effect re-runs once those land.
      return;
    }

    const headshotUrls = [fighterAStats.headshot, fighterBStats.headshot].filter(
      (url): url is string => typeof url === "string" && url.length > 0
    );

    if (headshotUrls.length === 0) {
      setContentDim(false);
      return;
    }

    let loadedCount = 0;
    function markLoaded() {
      loadedCount += 1;
      if (loadedCount >= headshotUrls.length && readyId === assetReadyIdRef.current) {
        setContentDim(false);
      }
    }

    const images = headshotUrls.map((src) => {
      const img = new Image();
      img.src = src;

      // decode() resolves only once the image is fully decoded and ready
      // to paint — onload alone can fire before decoding finishes on
      // larger images, which is what let a headshot still visibly "pop
      // in" a moment after the fade had already revealed the card.
      if (typeof img.decode === "function") {
        img.decode().then(markLoaded, markLoaded);
      } else {
        img.onload = markLoaded;
        img.onerror = markLoaded; // a broken headshot shouldn't block the reveal
      }

      return img;
    });

    const timeoutTimer = setTimeout(() => {
      if (readyId === assetReadyIdRef.current) setContentDim(false);
    }, ASSET_READY_TIMEOUT_MS);

    return () => {
      clearTimeout(timeoutTimer);
      images.forEach((img) => {
        img.onload = null;
        img.onerror = null;
      });
    };
  }, [selectedFight?.id, fighterAStats, fighterBStats]);

  useEffect(() => {
    if (!selectedFight?.fighterAId || !selectedFight?.fighterBId) return;

    const requestId = ++fighterStatsRequestIdRef.current;

    // Clear immediately rather than leaving the previous fight's stats in
    // place until the new ones arrive — otherwise the old headshot stays
    // mounted (and visible) for however long this fetch takes.
    setFighterAStats(null);
    setFighterBStats(null);

    async function loadFighters() {
      try {
        const [fighterARes, fighterBRes] = await Promise.all([
          fetch(`/api/fighter-stats?id=${selectedFight.fighterAId}`),
          fetch(`/api/fighter-stats?id=${selectedFight.fighterBId}`)
        ]);

        const fighterA = await fighterARes.json();
        const fighterB = await fighterBRes.json();

        if (requestId !== fighterStatsRequestIdRef.current) return;

        setFighterAStats(fighterA);
        setFighterBStats(fighterB);
      } catch (err) {
        console.error("Failed loading fighter stats", err);
      }
    }

    loadFighters();
  }, [selectedFight]);

  // Divisional rankings don't depend on which fight is selected, so this
  // fetches once — the (server-cached) payload covers every division and
  // every fight the user might pick.
  useEffect(() => {
    async function loadRankings() {
      try {
        const res = await fetch("/api/rankings");
        const data = res.ok ? await res.json() : null;
        setRankings(data?.rankings || {});
      } catch (err) {
        console.error("Failed loading rankings", err);
      }
    }

    loadRankings();
  }, []);

  // Matches a fighter's display name against ufc.com's rankings for
  // their division by name (like the Cito/Sherdog lookups elsewhere in
  // this file) rather than a shared id — ufc.com doesn't expose one.
  function getFighterRank(weightClass: string | undefined, fighterName: string | undefined) {
    if (!weightClass || !fighterName) return null;

    const division = rankings[weightClass];
    if (!division) return null;

    if (division.champion && namesMatchExactly(division.champion, fighterName)) {
      return { rank: 1, isChampion: true };
    }

    const entry = division.ranks.find((r) => namesMatchExactly(r.name, fighterName));
    return entry ? { rank: entry.rank, isChampion: false } : null;
  }

  const METRICS_POLL_INTERVAL_MS = 2000;
  const METRICS_POLL_MAX_MS = 30000;

  async function fetchFighterMetricsAndHistory(
    fight: any,
    requestId: number,
    startedAt: number,
    isPoll: boolean
  ) {
    if (requestId !== metricsRequestIdRef.current) return;

    try {
      const res = await fetch("/api/fighter-metrics", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          names: [fight.fighterA, fight.fighterB],
        }),
      });

      if (!res.ok) throw new Error(`Request failed (${res.status})`);

      const data = await res.json();

      if (requestId !== metricsRequestIdRef.current) return;

      const aMetricsState = data.metricsStatus?.[fight.fighterA] || "";
      const bMetricsState = data.metricsStatus?.[fight.fighterB] || "";
      const aHistoryState = data.historyStatus?.[fight.fighterA] || "";
      const bHistoryState = data.historyStatus?.[fight.fighterB] || "";

      setFighterAMetrics(data.metrics?.[fight.fighterA] || {});
      setFighterBMetrics(data.metrics?.[fight.fighterB] || {});
      setFighterAMetricsState(aMetricsState);
      setFighterBMetricsState(bMetricsState);
      setFighterAOctagonDebut(data.octagonDebut?.[fight.fighterA] || null);
      setFighterBOctagonDebut(data.octagonDebut?.[fight.fighterB] || null);

      setFighterAHistory(data.history?.[fight.fighterA] || []);
      setFighterBHistory(data.history?.[fight.fighterB] || []);
      setFighterAHistoryState(aHistoryState);
      setFighterBHistoryState(bHistoryState);

      const metricsStillSyncing = aMetricsState === "syncing" || bMetricsState === "syncing";
      const historyStillSyncing = aHistoryState === "syncing" || bHistoryState === "syncing";
      const elapsed = Date.now() - startedAt;
      const timedOut = elapsed >= METRICS_POLL_MAX_MS;

      setMetricsStatus(metricsStillSyncing ? (timedOut ? "timeout" : "polling") : "ready");
      setHistoryStatus(historyStillSyncing ? (timedOut ? "timeout" : "polling") : "ready");

      if ((metricsStillSyncing || historyStillSyncing) && !timedOut) {
        metricsPollTimerRef.current = setTimeout(() => {
          fetchFighterMetricsAndHistory(fight, requestId, startedAt, true);
        }, METRICS_POLL_INTERVAL_MS);
      }
    } catch (error) {
      console.error("Failed loading fighter metrics/history", error);

      if (requestId !== metricsRequestIdRef.current) return;

      if (!isPoll) {
        setFighterAMetrics({});
        setFighterBMetrics({});
        setFighterAMetricsState("");
        setFighterBMetricsState("");
        setFighterAOctagonDebut(null);
        setFighterBOctagonDebut(null);
        setMetricsStatus("error");

        setFighterAHistory([]);
        setFighterBHistory([]);
        setFighterAHistoryState("");
        setFighterBHistoryState("");
        setHistoryStatus("error");
        return;
      }

      // A poll attempt failing transiently shouldn't wipe out data we
      // already have — just try again if we're still inside the window.
      const elapsed = Date.now() - startedAt;
      if (elapsed < METRICS_POLL_MAX_MS) {
        metricsPollTimerRef.current = setTimeout(() => {
          fetchFighterMetricsAndHistory(fight, requestId, startedAt, true);
        }, METRICS_POLL_INTERVAL_MS);
      }
    }
  }

  function startMetricsHistoryFetch(fight: any) {
    if (!fight?.fighterA || !fight?.fighterB) return;

    const requestId = ++metricsRequestIdRef.current;
    const startedAt = Date.now();

    if (metricsPollTimerRef.current) {
      clearTimeout(metricsPollTimerRef.current);
      metricsPollTimerRef.current = null;
    }

    setMetricsStatus("loading");
    setHistoryStatus("loading");

    fetchFighterMetricsAndHistory(fight, requestId, startedAt, false);
  }

  useEffect(() => {
    if (!selectedFight?.fighterA || !selectedFight?.fighterB) return;

    setHistoryToggle("A");
    startMetricsHistoryFetch(selectedFight);

    return () => {
      if (metricsPollTimerRef.current) {
        clearTimeout(metricsPollTimerRef.current);
        metricsPollTimerRef.current = null;
      }
    };
  }, [selectedFight]);

  const ufc329Fights = [
    "Conor McGregor vs. Max Holloway",
  ];
  
  const ufc329Odds = odds.filter((fight) =>
    ufc329Fights.includes(`${fight.home_team} vs. ${fight.away_team}`) ||
    ufc329Fights.includes(`${fight.away_team} vs. ${fight.home_team}`)
  );

  const mainCardOdds = mergedFights;
  const mainCardFights = mergedFights.slice(-5).reverse();

  const prelimFights = mergedFights.slice(-9, -5).reverse();
  
  const earlyPrelimFights = mergedFights.slice(0, -9).reverse();
  
  const visibleFights =
    activeTab === "main"
      ? mainCardFights
      : activeTab === "prelims"
      ? prelimFights
      : earlyPrelimFights;

      function handleTabChange(tab: "main" | "prelims" | "early") {
        setActiveTab(tab);
      
        const nextFights =
          tab === "main"
            ? mainCardFights
            : tab === "prelims"
            ? prelimFights
            : earlyPrelimFights;
      
        const firstFight = nextFights[0];
      
        if (!firstFight) {
          setSelectedFight(null);
          setPrediction(null);
          return;
        }
      
        selectFight(firstFight);
      }

  const { oddsA: medianDisplayOddsA, oddsB: medianDisplayOddsB } = medianMarketOdds(
    selectedFight?.odds?.bookmakers,
    selectedFight?.odds?.fighterAOutcomeName,
    selectedFight?.odds?.fighterBOutcomeName
  );
  const { a: homeImplied, b: awayImplied } = normalizedImpliedProbabilities(medianDisplayOddsA, medianDisplayOddsB);

  // Which fighter did the consensus actually pick? Never assume fighterA —
  // compare against both names explicitly so the AI-market comparison
  // below always uses that same fighter's own market probability.
  const consensusWinnerName: string | undefined = prediction?.consensus?.winner;
  const consensusWinnerIsFighterA =
    !!consensusWinnerName && !!selectedFight?.fighterA && namesMatchExactly(consensusWinnerName, selectedFight.fighterA);
  const consensusWinnerIsFighterB =
    !!consensusWinnerName && !!selectedFight?.fighterB && namesMatchExactly(consensusWinnerName, selectedFight.fighterB);
  const consensusWinnerMarketProbability = consensusWinnerIsFighterA
    ? homeImplied
    : consensusWinnerIsFighterB
    ? awayImplied
    : null;

  const marketGap =
    prediction?.consensus?.confidence != null && consensusWinnerMarketProbability !== null
      ? prediction.consensus.confidence - consensusWinnerMarketProbability
      : null;

  const marketGapLabel = marketGapTier(consensusWinnerMarketProbability, prediction?.consensus?.modelAgreement);

  const isContrarianPick =
    marketGapLabel === "Contrarian pick" || marketGapLabel === "High-risk contrarian pick";

  const oddsTimestampLabel = formatOddsTimestamp(oddsFetchedAt, now, oddsStale);

  // Reserve the nickname line only when at least one side actually has
  // one — otherwise both fighters' records would sit lower than necessary
  // for no reason, with a blank line above them. When only one side has a
  // nickname, the other still renders an empty placeholder line so the two
  // records stay horizontally aligned with each other.
  const showNicknameRow = !!(fighterAStats?.nickname || fighterBStats?.nickname);

  // Only requires ONE side to have data, not both — a fighter Cito has
  // nothing on (e.g. a newer/lesser-known name) shouldn't hide the other
  // fighter's perfectly good numbers. Missing individual values are shown
  // per-row instead (see statRows below).
  const hasMetrics =
  metricsStatus === "ready" &&
  (!!fighterAMetrics?.slpm || !!fighterBMetrics?.slpm);
const statRows = [
  {
    name: "Significant Strikes / min",
    a: fighterAMetrics.slpm || null,
    b: fighterBMetrics.slpm || null,
    aWidth: metricWidth(fighterAMetrics.slpm, 8),
    bWidth: metricWidth(fighterBMetrics.slpm, 8),
    aAdv: metricNumber(fighterAMetrics.slpm) >= metricNumber(fighterBMetrics.slpm),
  },
  {
    name: "Strike Accuracy",
    a: fighterAMetrics.strAcc || null,
    b: fighterBMetrics.strAcc || null,
    aWidth: metricWidth(fighterAMetrics.strAcc, 100),
    bWidth: metricWidth(fighterBMetrics.strAcc, 100),
    aAdv: metricNumber(fighterAMetrics.strAcc) >= metricNumber(fighterBMetrics.strAcc),
  },
  {
    name: "Strikes Absorbed / min",
    a: fighterAMetrics.sapm || null,
    b: fighterBMetrics.sapm || null,
    aWidth: metricWidth(fighterAMetrics.sapm, 8),
    bWidth: metricWidth(fighterBMetrics.sapm, 8),
  
    // LOWER is better
    aAdv: metricNumber(fighterAMetrics.sapm) <= metricNumber(fighterBMetrics.sapm),
  },
  {
    name: "Strike Defense",
    a: fighterAMetrics.strDef || null,
    b: fighterBMetrics.strDef || null,
    aWidth: metricWidth(fighterAMetrics.strDef, 100),
    bWidth: metricWidth(fighterBMetrics.strDef, 100),
    aAdv: metricNumber(fighterAMetrics.strDef) >= metricNumber(fighterBMetrics.strDef),
  },
  {
    name: "Takedowns / 15min",
    a: fighterAMetrics.tdAvg || null,
    b: fighterBMetrics.tdAvg || null,
    aWidth: metricWidth(fighterAMetrics.tdAvg, 6),
    bWidth: metricWidth(fighterBMetrics.tdAvg, 6),
    aAdv: metricNumber(fighterAMetrics.tdAvg) >= metricNumber(fighterBMetrics.tdAvg),
  },
  {
    name: "Takedown Accuracy",
    a: fighterAMetrics.tdAcc || null,
    b: fighterBMetrics.tdAcc || null,
    aWidth: metricWidth(fighterAMetrics.tdAcc, 100),
    bWidth: metricWidth(fighterBMetrics.tdAcc, 100),
    aAdv: metricNumber(fighterAMetrics.tdAcc) >= metricNumber(fighterBMetrics.tdAcc),
  },
  {
    name: "Takedown Defense",
    a: fighterAMetrics.tdDef || null,
    b: fighterBMetrics.tdDef || null,
    aWidth: metricWidth(fighterAMetrics.tdDef, 100),
    bWidth: metricWidth(fighterBMetrics.tdDef, 100),
    aAdv: metricNumber(fighterAMetrics.tdDef) >= metricNumber(fighterBMetrics.tdDef),
  },
  {
    name: "Submission Attempts / 15min",
    a: fighterAMetrics.subAvg || null,
    b: fighterBMetrics.subAvg || null,
    aWidth: metricWidth(fighterAMetrics.subAvg, 3),
    bWidth: metricWidth(fighterBMetrics.subAvg, 3),
    aAdv: metricNumber(fighterAMetrics.subAvg) >= metricNumber(fighterBMetrics.subAvg),
  },
];

  const fighterARank = getFighterRank(selectedFight?.weightClass, selectedFight?.fighterA);
  const fighterBRank = getFighterRank(selectedFight?.weightClass, selectedFight?.fighterB);
  const showRankRow = !!(fighterARank || fighterBRank);

  return (
    <main>
     <nav className="nav reveal-nav">
  <div className="nav-logo">
    <img
      src="/android-chrome-192x192.png"
      alt="Pick'em Labs"
      className="nav-logo-img"
    />
    <div className="nav-logo-text">
      <div className="nav-logo-letters">
        <span className="nav-ltr" style={{ transform: "rotate(-2deg) translateY(1px)" }}>P</span>
        <span className="nav-ltr" style={{ transform: "rotate(1.5deg) translateY(-1px)" }}>I</span>
        <span className="nav-ltr" style={{ transform: "rotate(-1deg) translateY(1px)" }}>C</span>
        <span className="nav-ltr" style={{ transform: "rotate(2deg) translateY(-1px)" }}>K</span>
        <span className="nav-ltr" style={{ transform: "rotate(-1.5deg) translateY(0px)", margin: "0 1px" }}>'</span>
        <span className="nav-ltr" style={{ transform: "rotate(1deg) translateY(1px)" }}>E</span>
        <span className="nav-ltr" style={{ transform: "rotate(-2deg) translateY(-1px)" }}>M</span>
      </div>
      <span className="nav-logo-labs">LABS</span>
    </div>
  </div>
  <div className="nav-right">
    <InfoTooltip label="Pick'em Labs" width={320}>
      <div className="about-title">How Pick'em Labs works</div>
      <p className="about-intro">
        Pick'em Labs combines fighter statistics, sportsbook odds, recent fight history, and independent predictions from Claude, GPT-4, and Gemini.
      </p>
      <ol className="about-steps">
        <li className="about-step">
          <span className="about-step-num">1</span>
          <div>
            <div className="about-step-title">Compare the matchup</div>
            <div className="about-step-desc">Review fighter profiles, career metrics, recent history, and sportsbook odds.</div>
          </div>
        </li>
        <li className="about-step">
          <span className="about-step-num">2</span>
          <div>
            <div className="about-step-title">Run independent analysis</div>
            <div className="about-step-desc">Claude, GPT-4, and Gemini evaluate the matchup separately.</div>
          </div>
        </li>
        <li className="about-step">
          <span className="about-step-num">3</span>
          <div>
            <div className="about-step-title">Find agreement and disagreement</div>
            <div className="about-step-desc">See the consensus pick, average model confidence, and where the AI view differs from the market.</div>
          </div>
        </li>
      </ol>
      <div className="about-models">
        <span className="about-model"><span style={{background:"#CF9B60"}} className="about-dot"></span>Claude</span>
        <span className="about-model"><span style={{background:"#5DC98A"}} className="about-dot"></span>GPT-4</span>
        <span className="about-model"><span style={{background:"#5B9EE8"}} className="about-dot"></span>Gemini</span>
      </div>
      <div className="about-disclaimer">Informational analysis only. Outcomes are never guaranteed.</div>
    </InfoTooltip>
  </div>
</nav>

<div className={`event-bar reveal-event-bar ${ufcEvent?.completed ? "event-bar-concluded" : ""}`}>
  <div className="event-dot"></div>
  <span className="event-eyebrow">{ufcEvent?.completed ? "Event Concluded" : "Next Event"}</span>
  {ufcEvent ? (
    <>
      <span className="event-name event-fade-in">{ufcEvent.eventName}</span>
      <span className="event-date-line event-fade-in">
        <span className="event-date">
          {ufcEvent.completed ? (
            ufcEvent.nextEvent ? (
              <>
                Check back closer to {new Date(ufcEvent.nextEvent.date).toLocaleDateString("en-US", {
                  month: "long",
                  day: "numeric",
                })}{" "}for {ufcEvent.nextEvent.name}
              </>
            ) : (
              "Check back soon for the next event"
            )
          ) : (
            <>
              {ufcEvent.date
                ? new Date(ufcEvent.date).toLocaleDateString("en-US", {
                    month: "long",
                    day: "numeric",
                    year: "numeric",
                  })
                : ""}
              {eventVenue && ` · ${eventVenue}`}
              {eventLocation && ` · ${eventLocation}`}
            </>
          )}
        </span>
        {!ufcEvent.completed && (
          // The event's own start time, not the currently-selected fight's
          // (main-card bouts get a distinct, later time from ESPN than the
          // event's nominal start — this bar is about the event, and
          // shouldn't jump around as the fight dropdown changes).
          <Countdown targetDate={ufcEvent.date} className="event-countdown" />
        )}
      </span>
    </>
  ) : (
    <>
      <span className="event-skeleton-name skeleton-shimmer" aria-hidden="true" />
      <span className="event-skeleton-date skeleton-shimmer" aria-hidden="true" />
    </>
  )}
</div>

      <div className="hero">
        <span className="hero-kicker reveal-hero-kicker">Live Fight Intelligence</span>

        <h1 className="hero-headline">
          <span className="hero-headline-line hero-headline-line-1">Before you place</span>
          <br className="hero-break hero-break-mobile" />{" "}
          <span className="hero-headline-line hero-headline-line-1">a bet,</span>
          <br className="hero-break hero-break-desktop" />{" "}
          <span className="hero-headline-line hero-headline-line-2">see what</span>
          <br className="hero-break hero-break-mobile" />{" "}
          <span className="hero-headline-line hero-headline-line-2">
            <span className="hero-headline-accent">the models</span> think.
          </span>
        </h1>

        <p className="hero-lede reveal-hero-lede">
          Compare live sportsbook odds, official UFC fighter metrics, fighter history, and three independent AI model perspectives for every matchup.
        </p>

        <div className="hero-signal reveal-hero-signal">
          <span className="hero-signal-dots" aria-hidden="true">
            <span className="hero-signal-dot" style={{ background: "#CF9B60", animationDelay: "0s" }} />
            <span className="hero-signal-dot" style={{ background: "#5DC98A", animationDelay: "0.35s" }} />
            <span className="hero-signal-dot" style={{ background: "#5B9EE8", animationDelay: "0.7s" }} />
          </span>
          <div className="hero-signal-text">
            <span className="hero-signal-models">Claude · GPT-4 · Gemini</span>
            <span className="hero-signal-desc">Analyzing every matchup independently</span>
          </div>
        </div>
      </div>

      <div className="tabs reveal-tabs">
  <button
    type="button"
    className={`tab ${activeTab === "main" ? "active" : ""}`}
    onClick={() => handleTabChange("main")}
  >
    MAIN CARD
  </button>

  <button
    type="button"
    className={`tab ${activeTab === "prelims" ? "active" : ""}`}
    onClick={() => handleTabChange("prelims")}
  >
    PRELIMS
  </button>

  <button
    type="button"
    className={`tab ${activeTab === "early" ? "active" : ""}`}
    onClick={() => handleTabChange("early")}
  >
    EARLY PRELIMS
  </button>
</div>
<div className="fight-selector reveal-fight-selector">
  <div className="fight-selector-inner">
    <label htmlFor="fight-select">Select a matchup to analyze</label>

    <FightSelect
      fights={visibleFights}
      selectedId={selectedFight?.id}
      onSelect={selectFight}
    />
  </div>
</div>

      <div className="reveal-cards">
      <div className={`layout ${contentDim ? "layout-transitioning" : ""}`}>

        
        {/* CENTER — Analysis */}
        <div className="center">

          {/* Tale of the Tape */}
          <div className="card">
            <div className="card-header">
              <div className="card-title-group">
                <h2 className="card-label">Tale of the Tape</h2>
                <InfoTooltip label="Tale of the Tape">
                  Physical comparison of both fighters, including age, height, reach, stance, and professional record.
                </InfoTooltip>
              </div>
              <span className="weight-pill">{selectedFight?.weightClass || "MMA"}</span>
            </div>
            <div className="card-body card-body-flush">
              <div className="tot">
              <div className="fighter-a">
  {!fighterAStats ? (
    <div className="fighter-headshot skeleton-shimmer" aria-hidden="true" />
  ) : fighterAStats.headshot ? (
    <img src={fighterAStats.headshot} alt={selectedFight?.fighterA} className="fighter-headshot" />
  ) : (
    <FighterHeadshotPlaceholder />
  )}
  {showRankRow && (
    <div className={`fighter-rank ${fighterARank?.isChampion ? "fighter-rank-champ" : ""}`}>
      {fighterARank ? (fighterARank.isChampion ? "Champion" : `#${fighterARank.rank}`) : " "}
    </div>
  )}
  <div className="fighter-name">{selectedFight?.fighterA || "Loading..."}</div>
                {showNicknameRow && (
                  <div className="fighter-nickname">
                    {fighterAStats?.nickname ? `“${fighterAStats.nickname}”` : " "}
                  </div>
                )}
                  <div className="fighter-record-row">
                    {fighterAStats?.flag && (
                      <img src={fighterAStats.flag} alt="" className="fighter-flag" />
                    )}
                    <span className="fighter-record">{fighterAStats?.record || selectedFight?.recordA || "—"}</span>
                  </div>
                  {isUpcomingDebut(fighterAOctagonDebut, selectedFight?.date) && (
                    <InfoTooltip label="UFC Debut" width={200} trigger="UFC Debut" triggerClassName="fighter-debut-note">
                      This fighter is new to the UFC, so public data on them (stats, fight history) may be limited.
                    </InfoTooltip>
                  )}
                </div>
                <div className="vs-col">
                  <div className="vs-text">vs</div>
                </div>
                <div className="fighter-b">
  {!fighterBStats ? (
    <div className="fighter-headshot fighter-headshot-b skeleton-shimmer" aria-hidden="true" />
  ) : fighterBStats.headshot ? (
    <img src={fighterBStats.headshot} alt={selectedFight?.fighterB} className="fighter-headshot fighter-headshot-b" />
  ) : (
    <FighterHeadshotPlaceholder className="fighter-headshot-b" />
  )}
  {showRankRow && (
    <div className={`fighter-rank ${fighterBRank?.isChampion ? "fighter-rank-champ" : ""}`}>
      {fighterBRank ? (fighterBRank.isChampion ? "Champion" : `#${fighterBRank.rank}`) : " "}
    </div>
  )}
  <div className="fighter-name">{selectedFight?.fighterB || "Loading..."}</div>
                {showNicknameRow && (
                  <div className="fighter-nickname">
                    {fighterBStats?.nickname ? `“${fighterBStats.nickname}”` : "\u00A0"}
                  </div>
                )}
                  <div className="fighter-record-row fighter-record-row-b">
                    {fighterBStats?.flag && (
                      <img src={fighterBStats.flag} alt="" className="fighter-flag" />
                    )}
                    <span className="fighter-record">{fighterBStats?.record || selectedFight?.recordB || "—"}</span>
                  </div>
                  {isUpcomingDebut(fighterBOctagonDebut, selectedFight?.date) && (
                    <InfoTooltip label="UFC Debut" width={200} trigger="UFC Debut" triggerClassName="fighter-debut-note">
                      This fighter is new to the UFC, so public data on them (stats, fight history) may be limited.
                    </InfoTooltip>
                  )}
                </div>
              </div>

              <div className="tot-compare">
                {(() => {
                  const statsLoading = !fighterAStats || !fighterBStats;
                  return [
                    { label: "Age", a: fighterAStats?.age, b: fighterBStats?.age },
                    { label: "Height", a: fighterAStats?.height, b: fighterBStats?.height },
                    { label: "Reach", a: fighterAStats?.reach, b: fighterBStats?.reach },
                    { label: "Stance", a: fighterAStats?.stance, b: fighterBStats?.stance },
                    { label: "Style", a: fighterAStats?.style, b: fighterBStats?.style },
                  ].map((row) => {
                    const a = statsLoading ? null : formatBioValue(row.a);
                    const b = statsLoading ? null : formatBioValue(row.b);
                    const placeholder = statsLoading ? "Loading…" : "Unknown";
                    return (
                      <div key={row.label} className="tot-compare-row">
                        <span className={`tot-compare-val ${a ? "" : "tot-compare-val-unknown"}`}>
                          {a || placeholder}
                        </span>
                        <span className="tot-compare-label">{row.label}</span>
                        <span className={`tot-compare-val ${b ? "" : "tot-compare-val-unknown"}`}>
                          {b || placeholder}
                        </span>
                      </div>
                    );
                  });
                })()}
              </div>
            </div>
          </div>

          {/* Statistical Edge */}
          <div className="card" ref={statsCardRef}>
            <div className="card-header">
              <div className="card-title-group">
                <h2 className="card-label">Fighter Metrics</h2>
                <InfoTooltip label="Fighter Metrics">
                  Career striking and grappling statistics sourced from official UFC data to compare each fighter&apos;s historical performance.
                </InfoTooltip>
              </div>
              <div className="stat-legend">
                <span className="stat-legend-item">
                  <span className="stat-legend-swatch stat-legend-swatch-adv" />Advantage
                </span>
                <span className="stat-legend-item">
                  <span className="stat-legend-swatch stat-legend-swatch-dis" />Disadvantage
                </span>
              </div>
            </div>
            <div className="card-body" aria-live="polite">
  {metricsStatus === "loading" || metricsStatus === "polling" ? (
    <>
      <div className="stat-grid">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="skeleton-stat-row">
            <div className="skeleton-shimmer skeleton-val" />
            <div className="skeleton-center">
              <div className="skeleton-shimmer skeleton-label" />
              <div className="skeleton-shimmer skeleton-bar" />
            </div>
            <div className="skeleton-shimmer skeleton-val right" />
          </div>
        ))}
      </div>
      {metricsStatus === "polling" && (
        <div className="skeleton-caption">Updating fighter data…</div>
      )}
    </>
  ) : hasMetrics ? (
    <div className="stat-grid">
      {statRows.map((stat, i) => {
        // A row where one side has no Cito data at all isn't a real
        // "advantage" comparison — force neutral styling and hide that
        // side's bar rather than let a missing value (treated as 0)
        // default into looking like a real disadvantage.
        const noComparison = stat.a === null || stat.b === null;
        return (
        <div key={i} className="stat-row">
          <div className={`stat-val ${noComparison ? "" : stat.aAdv ? "stat-val-a" : "stat-val-b"} ${stat.a === null ? "stat-val-unknown" : ""}`} style={{ textAlign: "left" }}>
            {stat.a === null ? "Unknown" : stat.a}
          </div>

          <div className="stat-center">
            <div className="stat-name">{stat.name}</div>
            <div className="bar-track">
              <div className="bar-left">
                <div
                  className={`bar-fill-a ${!noComparison && !stat.aAdv ? "dis" : ""}`}
                  style={{
                    width: statsBarsVisible && stat.a !== null ? `${stat.aWidth}%` : "0%",
                    transitionDelay: `${i * 80}ms`,
                  }}
                ></div>
              </div>
              <div className="bar-right">
                <div
                  className={`bar-fill-b ${!noComparison && !stat.aAdv ? "adv" : ""}`}
                  style={{
                    width: statsBarsVisible && stat.b !== null ? `${stat.bWidth}%` : "0%",
                    transitionDelay: `${i * 80}ms`,
                  }}
                ></div>
              </div>
            </div>
          </div>

          <div className={`stat-val ${noComparison ? "" : !stat.aAdv ? "stat-val-a" : "stat-val-b"} ${stat.b === null ? "stat-val-unknown" : ""}`} style={{ textAlign: "right" }}>
            {stat.b === null ? "Unknown" : stat.b}
          </div>
        </div>
        );
      })}
    </div>
  ) : (
    <div className={`ai-loading ${metricsStatus === "timeout" || metricsStatus === "error" ? "ai-loading-error" : ""}`}>
      {metricsStatus === "timeout"
        ? "Still fetching stats for this matchup — this is taking longer than usual"
        : fighterAMetricsState === "syncing" || fighterBMetricsState === "syncing"
        ? "Fetching fresh stats for this matchup — check back in a moment"
        : "Advanced metrics not loaded for this matchup yet"}
      {metricsStatus === "timeout" && (
        <div>
          <button type="button" className="retry-btn" onClick={() => startMetricsHistoryFetch(selectedFight)}>
            Retry
          </button>
        </div>
      )}
    </div>
  )}
</div>
          </div>

         {/* AI Fight Breakdown */}
<div className="card" ref={predictionCardRef}>
  <div className="card-header">
    <div className="card-title-group">
      <h2 className="card-label">AI Matchup Breakdown</h2>
      <InfoTooltip label="AI Matchup Breakdown">
        A detailed explanation of each model&apos;s reasoning, including stylistic matchups, statistical advantages, and potential paths to victory.
      </InfoTooltip>
    </div>
    <span className="ai-models-label">Claude · GPT-4 · Gemini</span>
  </div>

  <div className="card-body" aria-live="polite">
    {loadingPrediction ? (
      <div className="skeleton-ai-breakdown">
        <div className="skeleton-ai-summary">
          <div className="skeleton-shimmer skeleton-ai-summary-label" />
          <div className="skeleton-ai-summary-row">
            <div className="skeleton-shimmer skeleton-ai-summary-val" />
            <div className="skeleton-shimmer skeleton-ai-summary-val" />
          </div>
        </div>
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="skeleton-ai-text-block">
            <div className="skeleton-shimmer skeleton-ai-text-label" />
            <div className="skeleton-shimmer skeleton-ai-text-line" />
            <div className="skeleton-shimmer skeleton-ai-text-line skeleton-ai-text-line-short" />
          </div>
        ))}
      </div>
    ) : predictionError ? (
      <div className="ai-loading ai-loading-error">
        Couldn't generate an AI breakdown for this matchup.
        <div>
          <button type="button" className="retry-btn" onClick={() => loadPredictionData(selectedFight)}>
            Retry
          </button>
        </div>
      </div>
    ) : prediction ? (
      <div className="ai-section">
        <div
          className="ai-block prediction-summary"
          style={{
            background: "linear-gradient(135deg, rgba(108,111,232,0.16), rgba(255,255,255,0.03))",
            border: "1px solid rgba(108,111,232,0.28)",
          }}
        >
          <div className="ai-block-label">Prediction Summary</div>

          <div className="prediction-headline">
            <div>
              <div className="cons-eyebrow">Winner</div>
              <div className="prediction-headline-val">
                {prediction.consensus?.winner || "—"}
              </div>
            </div>

            <div className="prediction-headline-right">
              <div className="cons-eyebrow">Confidence</div>
              <div className="prediction-headline-val">
                {prediction.consensus?.confidence || "—"}%
              </div>
              {typeof prediction.consensus?.confidence === "number" && (
                <>
                  <div className="confidence-tier-label">
                    {confidenceTier(prediction.consensus.confidence)} confidence
                  </div>
                  <ConfidenceMeter
                    value={prediction.consensus.confidence}
                    tierLabel={confidenceTier(prediction.consensus.confidence)}
                    play={confidenceVisible}
                  />
                </>
              )}
            </div>
          </div>

          <div className="prediction-details-grid">
          <div className="value-card prediction-method">
              <div className="cons-eyebrow">Method</div>
              <div className="pred-name">{prediction.claude?.method || "—"}</div>
            </div>

            <div className="value-card prediction-round">
              <div className="cons-eyebrow-row">
                <div className="cons-eyebrow">Round</div>
                <InfoTooltip label="Round" width={230}>
                  How far the models expect this fight to go — not a calibrated probability.
                </InfoTooltip>
              </div>
              <div className="pred-name">
  {formatPredictedRound(
    prediction?.claude?.method,
    prediction?.claude?.round
  )}
</div>
            </div>

            {prediction?.consensus?.overUnder && (
              <>
                <div className="value-card prediction-ou">
                  <div className="cons-eyebrow">Over 1.5 Rds</div>
                  <div className={`pred-name overunder-${prediction.consensus.overUnder.over1_5.label.toLowerCase()}`}>
                    {prediction.consensus.overUnder.over1_5.label}
                  </div>
                </div>

                <div className="value-card prediction-ou">
                  <div className="cons-eyebrow">Over 2.5 Rds</div>
                  <div className={`pred-name overunder-${prediction.consensus.overUnder.over2_5.label.toLowerCase()}`}>
                    {prediction.consensus.overUnder.over2_5.label}
                  </div>
                </div>
              </>
            )}

            <div className="value-card prediction-lean">
              <div className="cons-eyebrow">Betting Lean</div>
              <div className="pred-name">{prediction.claude?.bettingLean || "—"}</div>
            </div>
          </div>
        </div>

        <div className="ai-block">
          <div className="ai-block-label">Key Advantages — {prediction.claude?.predictedWinner}</div>
          <div className="ai-block-text">{prediction.claude?.keyAdvantages}</div>
        </div>

        <div className="ai-block">
          <div className="ai-block-label">Biggest Risk</div>
          <div className="ai-block-text">{prediction.claude?.biggestRisk}</div>
        </div>

        <div className="ai-block">
          <div className="ai-block-label">Likely Fight Script</div>
          <div className="ai-block-text">{prediction.claude?.fightScript}</div>
        </div>

        <div className="ai-block ai-block-wrong">
          <div className="ai-block-label ai-block-label-wrong">Why the AI could be wrong</div>
          <div className="wrong-list">
            {prediction.claude?.whyWrong?.map((reason: string, i: number) => (
              <div key={i} className="wrong-item">
                <span className="wrong-dot">–</span>
                <span>{reason}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    ) : (
      <div className="ai-loading">Select a fight to generate analysis</div>
    )}
  </div>
</div>
</div>
        {/* RIGHT — Odds */}
        <div className="right-col">
          <div className="card">
            <div className="card-header">
              <div className="card-title-group">
                <h2 className="card-label">Betting Market</h2>
                <InfoTooltip label="Betting Market">
                  Live odds from major sportsbooks. Implied probabilities are calculated from the latest available betting lines. Some preliminary bouts may not yet have posted lines.
                </InfoTooltip>
              </div>
            </div>
            <div className="card-body" aria-live="polite">
              <div className="odds-col-labels">
                <span className="odds-col-label">Bookmaker</span>
                <span className="odds-col-label">{shortName(selectedFight?.fighterA, "Fighter A")}</span>
                <span className="odds-col-label">{shortName(selectedFight?.fighterB, "Fighter B")}</span>
              </div>
              <div className="odds-scroll">
              {loadingOdds ? (
  Array.from({ length: 4 }).map((_, i) => (
    <div key={i} className="skeleton-odds-book">
      <div className="skeleton-shimmer skeleton-odds-name" />
      <div className="skeleton-shimmer skeleton-odds-pair" />
    </div>
  ))
) : selectedFight?.odds?.bookmakers?.length ? (
  selectedFight.odds.bookmakers.map((bookmaker: any, i: number) => {
    const outcomes = bookmaker.markets?.[0]?.outcomes || [];
    const homeOdds = outcomes.find((o: any) => o.name === selectedFight.odds?.fighterAOutcomeName);
    const awayOdds = outcomes.find((o: any) => o.name === selectedFight.odds?.fighterBOutcomeName);
    // Favorite/underdog by actual odds sign, not by column position.
    const homeIsFavorite = (homeOdds?.price ?? 0) < (awayOdds?.price ?? 0);

    return (
      <div key={i} className="odds-book">
        <span className="book-name">{bookmaker.title}</span>
        <span className={homeIsFavorite ? "odd-fav" : "odd-dog"}>{formatAmericanOdds(homeOdds?.price)}</span>
        <span className={homeIsFavorite ? "odd-dog" : "odd-fav"}>{formatAmericanOdds(awayOdds?.price)}</span>
      </div>
    );
  })
) : !oddsProviderAvailable && odds.length === 0 ? (
  <div className="ai-loading ai-loading-error">
    Live sportsbook odds are temporarily unavailable. Fighter metrics and AI predictions are unaffected.
  </div>
) : (
  <div className="ai-loading">Odds are temporarily unavailable — check back shortly</div>
)}
              </div>
              {oddsTimestampLabel && (
                <div
                  className="odds-footer"
                  title={oddsFetchedAt ? new Date(oddsFetchedAt).toLocaleString() : undefined}
                >
                  <span className="odds-footer-icon" aria-hidden="true" />
                  {oddsTimestampLabel}
                </div>
              )}
            </div>
          </div>

          {/* Multi-Model Consensus */}
<div className="card">
  <div className="card-header">
    <div className="card-title-group">
      <h2 className="card-label">Model Consensus</h2>
      <InfoTooltip label="Model Consensus">
        Claude, GPT-4, and Gemini analyze the matchup independently. Their predictions are combined to show the overall consensus and level of agreement.
      </InfoTooltip>
    </div>
  </div>

  <div className="card-body">
    {(() => {
      const models = [
        { key: "claude", model: "Claude", color: "#CF9B60", prediction: prediction?.claude },
        { key: "gpt", model: "GPT-4", color: "#5DC98A", prediction: prediction?.gpt },
        { key: "gemini", model: "Gemini", color: "#5B9EE8", prediction: prediction?.gemini },
      ];

      const consensusWinner = prediction?.consensus?.winner;
      // Server-computed — reflects the corrected aggregation (ties/failed
      // models handled there), so the UI never re-derives this differently.
      const agreeingModelKeys: string[] = prediction?.consensus?.agreeingModels || [];
      const totalSuccessfulModels: number =
        prediction?.consensus?.totalSuccessfulModels ?? models.filter((m) => m.prediction).length;
      const modelAgreementLabel: string = prediction?.consensus?.modelAgreement || "";

      return (
        <>
          <div className="consensus-result">
            <div>
              <div className="cons-eyebrow">Consensus pick</div>
              <div className="cons-pick">{consensusWinner || "Pending AI"}</div>
            </div>

            <div className="cons-pct-wrap">
              <div className="cons-pct">
                {prediction?.consensus?.confidence
                  ? `${prediction.consensus.confidence}%`
                  : "—"}
              </div>
              <div className="cons-pct-label">avg. confidence</div>
            </div>
          </div>

          <div
            className={`model-agreement ${
              modelAgreementLabel === "Unanimous" ? "model-agreement-full" : ""
            }`}
          >
            <span className="model-agreement-label">Model Agreement</span>
            <span className="model-agreement-val">
              {totalSuccessfulModels ? `${agreeingModelKeys.length} / ${totalSuccessfulModels}` : "Pending"}
            </span>
          </div>

          {models.map((m, i) => {
            const pick = m.prediction?.predictedWinner || "Pending";
            const agrees = agreeingModelKeys.includes(m.key);

            return (
              <div key={i} className="model-row">
                <div className="model-name">
                  <div className="model-dot" style={{ background: m.color }}></div>
                  {m.model}
                </div>

                <div className="model-right">
                  <div className="model-pick">
                    {m.prediction ? (agrees ? "✓ " : "✕ ") : ""}
                    {pick}
                  </div>
                  <div className="model-conf">
                    {m.prediction ? `${m.prediction.confidence}% confidence` : "— confidence"}
                  </div>
                </div>
              </div>
            );
          })}
        </>
      );
    })()}
  </div>
</div>

          {/* Value Analysis */}
          <div className="card">
            <div className="card-header">
              <div className="card-title-group">
                <h2 className="card-label">AI vs. Market</h2>
                <InfoTooltip label="AI vs. Market">
                  Compares the AI consensus with the betting market to highlight where the models agree—or disagree—with current sportsbook expectations.
                </InfoTooltip>
              </div>
            </div>
            <div className="card-body">
            <div className="value-analysis">
  <div className="value-section">
    <div className="value-section-title">Sportsbook Probability</div>

    <div className="value-analysis-row">
      <span className="value-fighter">
        {shortName(selectedFight?.fighterA, "Fighter A")}
      </span>
      <span className="value-percentage">
        {homeImplied ? `${homeImplied}%` : "—"}
      </span>
    </div>

    <div className="value-analysis-row">
      <span className="value-fighter">
        {shortName(selectedFight?.fighterB, "Fighter B")}
      </span>
      <span className="value-percentage">
        {awayImplied ? `${awayImplied}%` : "—"}
      </span>
    </div>
  </div>

  <div className="value-divider" />

  <div className="value-section">
    <div className="value-section-title-row">
      <div className="value-section-title">Average Model Confidence</div>
      <InfoTooltip label="Average Model Confidence">
        Confidence reflects how strongly the agreeing AI models support their prediction. It is not a calibrated probability of winning and should not be interpreted as one.
      </InfoTooltip>
    </div>

    <div className="value-ai-box">
      <div className="value-analysis-row value-ai-row">
        <span className="value-fighter">
          {prediction?.consensus?.winner || "Pending AI"}
        </span>
        <span className="value-percentage">
          {prediction?.consensus?.confidence
            ? `${prediction.consensus.confidence}%`
            : "—"}
        </span>
      </div>
      <div className="value-caption">
        Average of each model&apos;s self-reported confidence — not a calibrated win probability.
      </div>
    </div>
  </div>

  <div className="value-analysis-row value-edge-row">
    <div>
      <div className="value-section-title-row">
        <div className="value-section-title">AI–Market Gap</div>
        <InfoTooltip label="AI–Market Gap">
          AI confidence minus market-implied probability. Positive means the AI is more bullish than the market; negative means it is more cautious.
        </InfoTooltip>
      </div>
      <div className={`value-edge-label ${isContrarianPick ? "value-edge-label-contrarian" : ""}`}>
        {marketGapLabel || "Pending AI"}
      </div>
    </div>

    {marketGap !== null ? (
      <span
        className={
          Math.abs(marketGap) < MARKET_GAP_SIGNIFICANCE_THRESHOLD
            ? "edge-neutral"
            : marketGap > 0
            ? "edge-pos"
            : "edge-neg"
        }
      >
        {marketGap > 0 ? `+${marketGap}%` : `${marketGap}%`}
      </span>
    ) : (
      <span className="value-percentage">—</span>
    )}
  </div>

  {isContrarianPick && (
    <div className="contrarian-badge">
      <span className="contrarian-badge-icon">⚠</span>
      <span>
        <strong>{marketGapLabel}</strong> — the AI consensus disagrees with the betting market on this fight.
      </span>
    </div>
  )}
</div>
            </div>
          </div>

          {/* Fight History */}
          <div className="card">
            <div className="card-header">
              <div className="card-title-group">
                <h2 className="card-label">Recent Fight History</h2>
                <InfoTooltip label="Recent Fight History">
                  Each fighter&apos;s three most recent completed UFC bouts, including opponent, result, and method of victory or defeat.
                </InfoTooltip>
              </div>
            </div>
            <div className="card-body" aria-live="polite">
              <div className="fighter-toggle" role="group" aria-label="Show fight history for">
                <button
                  type="button"
                  className={`toggle-btn ${historyToggle === "A" ? "toggle-active" : ""}`}
                  aria-pressed={historyToggle === "A"}
                  onClick={() => setHistoryToggle("A")}
                >
                  {shortName(selectedFight?.fighterA, "Fighter A")}
                </button>
                <button
                  type="button"
                  className={`toggle-btn ${historyToggle === "B" ? "toggle-active" : ""}`}
                  aria-pressed={historyToggle === "B"}
                  onClick={() => setHistoryToggle("B")}
                >
                  {shortName(selectedFight?.fighterB, "Fighter B")}
                </button>
              </div>

              {historyStatus === "loading" || historyStatus === "polling" ? (
                <>
                  {Array.from({ length: 3 }).map((_, i) => (
                    <div key={i} className="skeleton-history-row">
                      <div className="skeleton-history-header">
                        <div className="skeleton-shimmer skeleton-history-opponent" />
                        <div className="skeleton-shimmer skeleton-history-badge" />
                      </div>
                      <div className="skeleton-shimmer skeleton-history-meta" />
                      <div className="skeleton-shimmer skeleton-history-result-line" />
                    </div>
                  ))}
                  {historyStatus === "polling" && (
                    <div className="skeleton-caption">Updating fighter data…</div>
                  )}
                </>
              ) : historyStatus === "error" ? (
                <div className="ai-loading ai-loading-error">Fight history unavailable</div>
              ) : historyStatus === "timeout" ? (
                <div className="ai-loading ai-loading-error">
                  Recent fight history is still being prepared.
                  <div>
                    <button type="button" className="retry-btn" onClick={() => startMetricsHistoryFetch(selectedFight)}>
                      Retry
                    </button>
                  </div>
                </div>
              ) : (() => {
                // Show the 3 most recent — keeps this card's height in line
                // with the rest of the right column instead of running well
                // past the center column.
                const activeHistory = (historyToggle === "A" ? fighterAHistory : fighterBHistory).slice(0, 3);
                const activeHistoryState = historyToggle === "A" ? fighterAHistoryState : fighterBHistoryState;

                if (activeHistory.length === 0) {
                  return (
                    <div className="ai-loading">
                      {activeHistoryState === "syncing"
                        ? "Fetching fight history — check back in a moment"
                        : "No fight history available"}
                    </div>
                  );
                }

                return activeHistory.map((fight: any, i: number) => {
                  const badge = historyResultBadge(fight.result);
                  return (
                  <div key={i} className="history-fight">
                    <div className="history-header">
                      <span className="history-opponent">{fight.opponent || "Unknown opponent"}</span>
                      <span className={`history-result ${badge.className}`}>
                        {badge.label}
                      </span>
                    </div>
                    <div className="history-meta">
                      {fight.event || "Unknown event"}
                      {fight.date ? ` · ${new Date(fight.date).toLocaleDateString()}` : ""}
                    </div>
                    <div className="history-result-line">
                      {fight.method || "—"}
                      {fight.round ? ` · Round ${fight.round}` : ""}
                      {fight.time ? ` · ${fight.time}` : ""}
                    </div>
                  </div>
                  );
                });
              })()}

              <div style={{ fontSize: "10px", color: "rgba(255,255,255,0.22)", textAlign: "center", marginTop: "12px" }}>
                Fighter stats via Cito API and Sherdog.
              </div>
            </div>
          </div>

        </div>

      </div>
      </div>
    </main>
  );
}