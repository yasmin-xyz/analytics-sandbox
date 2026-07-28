import { unstable_cache } from "next/cache";

export type UfcEventFight = {
  id: string;
  date: string;
  weightClass: string;
  venue: string;
  fighterA: string;
  fighterB: string;
  recordA: string;
  recordB: string;
  fighterAId: string | undefined;
  fighterBId: string | undefined;
  fighterAFlag: string | undefined;
  fighterBFlag: string | undefined;
};

export type UfcEventNext = {
  name: string;
  date: string;
};

export type UfcEvent = {
  eventName: string;
  shortName: string;
  date: string;
  venue: string;
  // City/state split out separately from `venue` (the arena name) so the
  // event bar can render "T-Mobile Arena, Las Vegas, NV" instead of just
  // the arena name — undefined rather than "" when ESPN doesn't have an
  // address on file, so the UI can cleanly omit it instead of showing a
  // stray comma.
  venueCity: string | undefined;
  venueState: string | undefined;
  fights: UfcEventFight[];
  completed: boolean;
  // ESPN's own status.type.state ("pre" | "in" | "post") — a direct signal
  // rather than inferring "in progress" from the event's start time having
  // passed, which would be wrong for however long ESPN takes to flip
  // `completed` after the actual last fight ends.
  isLive: boolean;
  // The next scheduled event after this one, per ESPN's own forward
  // calendar — never hardcoded, since the schedule shifts. null if this
  // event isn't completed, or if it couldn't be found in the calendar
  // (e.g. it's the last one ESPN currently lists).
  nextEvent: UfcEventNext | null;
};

// ESPN's scoreboard "events[0]" keeps returning the just-concluded event
// for a while after it ends (status.type.completed flips true, but it
// doesn't roll over to the next event immediately) — this looks up the
// following entry in the league's own forward calendar, keyed by name,
// rather than guessing or hardcoding a date.
function findNextEvent(calendar: any[] | undefined, currentEventName: string): UfcEventNext | null {
  if (!Array.isArray(calendar)) return null;

  const idx = calendar.findIndex((entry) => entry?.label === currentEventName);
  if (idx === -1) return null;

  const next = calendar[idx + 1];
  if (!next?.label || !next?.startDate) return null;

  return { name: next.label, date: next.startDate };
}

// Shared by the public /api/ufc-event route and the admin fighter-sync
// endpoint, so both read the exact same ESPN parsing logic.
async function fetchCurrentUfcEventUncached(): Promise<UfcEvent | null> {
  const res = await fetch(
    "https://site.api.espn.com/apis/site/v2/sports/mma/ufc/scoreboard",
    { cache: "no-store" }
  );

  const data = await res.json();
  const event = data.events?.[0];

  if (!event) return null;

  const fights: UfcEventFight[] = (event.competitions || []).map((competition: any) => {
    const competitors = competition.competitors || [];

    return {
      id: competition.id,
      date: competition.date,
      weightClass: competition.type?.abbreviation || "MMA",
      venue: competition.venue?.fullName || event.venue?.fullName || "Venue TBD",

      fighterA: competitors[0]?.athlete?.displayName || "Fighter A",
      fighterB: competitors[1]?.athlete?.displayName || "Fighter B",

      recordA: competitors[0]?.records?.[0]?.summary || "—",
      recordB: competitors[1]?.records?.[0]?.summary || "—",

      fighterAId: competitors[0]?.id,
      fighterBId: competitors[1]?.id,

      fighterAFlag: competitors[0]?.flag?.href,
      fighterBFlag: competitors[1]?.flag?.href,
    };
  });

  const completed = event.status?.type?.completed === true;
  const isLive = event.status?.type?.state === "in";
  const nextEvent = completed
    ? findNextEvent(data.leagues?.[0]?.calendar, event.name)
    : null;

  const venueAddress = event.competitions?.[0]?.venue?.address || event.venue?.address;

  return {
    eventName: event.name,
    shortName: event.shortName,
    date: event.date,
    venue: event.competitions?.[0]?.venue?.fullName || "Venue TBD",
    venueCity: venueAddress?.city || undefined,
    venueState: venueAddress?.state || undefined,
    fights,
    completed,
    isLive,
    nextEvent,
  };
}

// ESPN's scoreboard is free/unauthenticated, so this cache exists for
// consistency and to avoid hammering it on every page load/refresh rather
// than for cost control — a much shorter window than the paid odds cache,
// since fight-card info (odds, weigh-in results) can change same-day.
const UFC_EVENT_REVALIDATE_SECONDS = 5 * 60;

export const fetchCurrentUfcEvent = unstable_cache(
  fetchCurrentUfcEventUncached,
  ["ufc-current-event"],
  { revalidate: UFC_EVENT_REVALIDATE_SECONDS }
);
