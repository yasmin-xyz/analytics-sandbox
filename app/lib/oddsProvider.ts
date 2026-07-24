import "server-only";
import axios from "axios";

// Pure "talk to the-odds-api.com" concern — no caching, no fallback
// logic. Every call here is a real, billed provider request; callers
// (app/lib/oddsCache.ts) are responsible for not calling this any more
// often than necessary.

const ODDS_API_URL =
  "https://api.the-odds-api.com/v4/sports/mma_mixed_martial_arts/odds";

export interface OddsProviderQuota {
  remaining: number | null;
  used: number | null;
  last: number | null;
}

export interface OddsProviderResult {
  odds: any[];
  fetchedAt: string;
  quota: OddsProviderQuota;
}

function parseHeaderInt(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const n = parseInt(value, 10);
  return Number.isNaN(n) ? null : n;
}

export async function fetchOddsFromProvider(): Promise<OddsProviderResult> {
  const response = await axios.get(ODDS_API_URL, {
    params: {
      apiKey: process.env.ODDS_API_KEY,
      // "us_ex" is the-odds-api's exchange/prediction-market bucket —
      // adds Kalshi, Polymarket, Novig, and ProphetX. bet365 was checked
      // (across us, us2, uk, us_ex, eu, au) and simply isn't offered by
      // this provider for MMA in any region, so there's no region param
      // that would surface it.
      regions: "us,us_ex",
      markets: "h2h",
      oddsFormat: "american",
    },
  });

  const quota: OddsProviderQuota = {
    remaining: parseHeaderInt(response.headers["x-requests-remaining"]),
    used: parseHeaderInt(response.headers["x-requests-used"]),
    last: parseHeaderInt(response.headers["x-requests-last"]),
  };

  // Dev-only — these numbers are never sent to the client (see
  // app/api/odds/route.ts, which only forwards odds/fetchedAt/stale).
  if (process.env.NODE_ENV !== "production") {
    console.log(
      `[oddsProvider] live request made — ${response.data.length} events returned, ` +
        `quota used=${quota.used ?? "?"} remaining=${quota.remaining ?? "?"} last=${quota.last ?? "?"}`
    );
    if (quota.remaining !== null && quota.remaining < 25) {
      console.warn(
        `[oddsProvider] WARNING: only ${quota.remaining} Odds API requests remaining this period`
      );
    }
  }

  return {
    odds: response.data,
    // The moment this specific provider response was actually retrieved —
    // never render time — so "last updated" stays trustworthy even once
    // this result is being served from cache to later requests.
    fetchedAt: new Date().toISOString(),
    quota,
  };
}
