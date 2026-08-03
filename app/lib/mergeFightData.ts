const NAME_SUFFIXES = new Set(["jr", "sr", "ii", "iii", "iv", "v"]);

// Matching normalization used only here, to line up ESPN fight-card
// entries with Odds API entries — deliberately separate from
// app/lib/fighterName.ts, whose normalizeFighterName() output backs
// Supabase/Cito cache keys and must not change shape.
//
// Handles (safely, without fuzzy/similarity matching that could join two
// different fighters):
//  - accents: "é" -> "e" instead of being silently dropped
//  - hyphens/apostrophes: "-" -> " " so "Jean-Paul" and "Jean Paul" match
//  - suffixes: "Levi Rodrigues Jr." vs "Levi Rodrigues" now match
function normalizeForOddsMatch(name: string): string {
  const cleaned = name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[-']/g, " ")
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  const parts = cleaned.split(" ");
  if (parts.length > 1 && NAME_SUFFIXES.has(parts[parts.length - 1])) {
    return parts.slice(0, -1).join(" ");
  }
  return cleaned;
}

// Last word of the normalized name — surnames are far more stable across
// providers than given names. Every mismatch seen in production so far
// (a missing/extra middle name, a nickname vs. formal given name like
// "Steve"/"Stephen" or "Ramazan"/"Ramazonbek", a transliteration split
// like "Seokhyeon"/"Seok Hyun") has left the surname untouched.
//
// A multi-word surname (e.g. "del Valle") is sometimes concatenated into
// one word by another provider ("DelValle") — return that joined form as
// a second candidate so either spelling matches. Only attempted at 3+
// parts, since with exactly 2 (given name + surname) the last word is
// already the whole surname and there's nothing to join.
function surnameCandidates(normalizedName: string): string[] {
  const parts = normalizedName.split(" ");
  const last = parts[parts.length - 1] || "";
  const candidates = [last];
  if (parts.length > 2) {
    candidates.push(parts.slice(-2).join(""));
  }
  return candidates;
}

// The-odds-api returns bookmakers in whatever order it feels like, which
// shifted once Kalshi/Polymarket/etc. were added (see oddsProvider.ts).
// Rather than inventing a full "most popular" ranking, this just swaps
// two specific pairs to their requested positions — whatever order the
// rest of the list happens to be in is left untouched.
const BOOKMAKER_SWAPS: [string, string][] = [
  ["betonlineag", "kalshi"],
  ["betus", "betmgm"],
];

function reorderBookmakers(bookmakers: any[]): any[] {
  const arr = [...bookmakers];

  for (const [a, b] of BOOKMAKER_SWAPS) {
    const indexA = arr.findIndex((bm) => bm.key === a);
    const indexB = arr.findIndex((bm) => bm.key === b);

    if (indexA !== -1 && indexB !== -1) {
      [arr[indexA], arr[indexB]] = [arr[indexB], arr[indexA]];
    }
  }

  return arr;
}

export function mergeFightData(
    espnFights: any[],
    oddsFights: any[]
  ) {
    return espnFights.map((fight) => {
      const normA = normalizeForOddsMatch(fight.fighterA);
      const normB = normalizeForOddsMatch(fight.fighterB);

      let oddsMatch = oddsFights.find((oddsFight) => {
        const names = [
          normalizeForOddsMatch(oddsFight.home_team),
          normalizeForOddsMatch(oddsFight.away_team),
        ];

        return names.includes(normA) && names.includes(normB);
      });

      let matchTier: "exact" | "surname" | "none" = oddsMatch ? "exact" : "none";

      // Fall back to matching on the surname of BOTH fighters together,
      // not just one name in isolation — requiring the whole pair to
      // agree is what keeps this safe. A single surname is common enough
      // (multiple "Silva"s on one card, for instance) that matching it
      // alone could pair the wrong two fighters; requiring their
      // opponent's surname to also match as a pair makes a false
      // positive across a real fight card essentially impossible. If
      // more than one odds entry satisfies the pair, treat it as
      // unresolved rather than guess.
      if (!oddsMatch) {
        const surnamesA = surnameCandidates(normA);
        const surnamesB = surnameCandidates(normB);

        const candidates = oddsFights.filter((oddsFight) => {
          const homeSurnames = surnameCandidates(normalizeForOddsMatch(oddsFight.home_team));
          const awaySurnames = surnameCandidates(normalizeForOddsMatch(oddsFight.away_team));

          const hasA = surnamesA.some((s) => homeSurnames.includes(s) || awaySurnames.includes(s));
          const hasB = surnamesB.some((s) => homeSurnames.includes(s) || awaySurnames.includes(s));

          return hasA && hasB;
        });

        if (candidates.length === 1) {
          oddsMatch = candidates[0];
          matchTier = "surname";
        }
      }

      if (process.env.NODE_ENV !== "production") {
        if (matchTier === "surname") {
          console.warn(
            `[mergeFightData] matched "${fight.fighterA}" vs "${fight.fighterB}" to odds "${oddsMatch.home_team}" vs "${oddsMatch.away_team}" by surname only (given names differ)`
          );
        } else if (matchTier === "none") {
          console.warn(
            `[mergeFightData] no odds match for "${fight.fighterA}" vs "${fight.fighterB}" (normalized: "${normA}" / "${normB}")`
          );
        }
      }

      // Callers look up each side's price by name (outcomes.find(o => o.name
      // === fighterA)). That's an exact-string comparison against the ODDS
      // API's own name for that fighter — fine when matchTier is "exact",
      // but a surname-tier match means the given names differ (e.g. ESPN's
      // "Steve Erceg" vs the odds API's "Stephen Erceg"), so that lookup
      // would silently find nothing and every price would render as "—".
      // Resolving the correspondence once here (by surname, which is what
      // established the match in the first place) means callers never have
      // to re-derive it via an exact-name comparison that only works for
      // one of the two match tiers.
      let fighterAOutcomeName: string | null = null;
      let fighterBOutcomeName: string | null = null;

      if (oddsMatch) {
        const surnamesA = surnameCandidates(normA);
        const homeSurnames = surnameCandidates(normalizeForOddsMatch(oddsMatch.home_team));

        if (surnamesA.some((s) => homeSurnames.includes(s))) {
          fighterAOutcomeName = oddsMatch.home_team;
          fighterBOutcomeName = oddsMatch.away_team;
        } else {
          fighterAOutcomeName = oddsMatch.away_team;
          fighterBOutcomeName = oddsMatch.home_team;
        }
      }

      return {
        ...fight,
        odds: oddsMatch
          ? {
              ...oddsMatch,
              bookmakers: reorderBookmakers(oddsMatch.bookmakers || []),
              fighterAOutcomeName,
              fighterBOutcomeName,
            }
          : null,
      };
    });
  }
