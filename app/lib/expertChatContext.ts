import "server-only";
import { fetchCurrentUfcEvent, type UfcEventFight } from "./ufcEvent";
import { peekFighterMetrics, peekFighterHistory, type MappedMetrics, type HistoryEntry } from "./fighterSync";
import { normalizeFighterName } from "./fighterName";

export type ExpertChatFighterContext = {
  name: string;
  metrics: MappedMetrics | null;
  history: HistoryEntry[];
};

export type ExpertChatContext = {
  eventName: string;
  eventDate: string;
  // The model has no built-in notion of "today" — without this, a past
  // event's date reads as ambiguous and it tends to guess "upcoming"
  // (see the isLive/completed fields below, which is the actual signal
  // it needs instead of guessing from the date string alone).
  completed: boolean;
  isLive: boolean;
  cardFights: { fighterA: string; fighterB: string; weightClass: string }[];
  // null when the client-claimed selected fighters don't match any fight on
  // the authoritative card (never trust the claim blindly — see route.ts).
  selectedFight: { fighterA: ExpertChatFighterContext; fighterB: ExpertChatFighterContext } | null;
};

async function buildFighterContext(name: string): Promise<ExpertChatFighterContext> {
  const metricsResult = await peekFighterMetrics(name);
  const historyResult = await peekFighterHistory(metricsResult.providerSlug);

  return {
    name,
    metrics: metricsResult.metrics,
    history: historyResult.history,
  };
}

function findMatchingFight(
  fights: UfcEventFight[],
  fighterA: string,
  fighterB: string
): UfcEventFight | null {
  const normA = normalizeFighterName(fighterA);
  const normB = normalizeFighterName(fighterB);

  return (
    fights.find((fight) => {
      const cardA = normalizeFighterName(fight.fighterA);
      const cardB = normalizeFighterName(fight.fighterB);
      return (cardA === normA && cardB === normB) || (cardA === normB && cardB === normA);
    }) || null
  );
}

// selectedFighterA/B are a CLAIM from the client, not a fact — this
// independently re-fetches the authoritative card and only builds grounded
// stats/history context if the claim actually matches a real fight on it.
// Otherwise the chat still gets the full card list, just without deep
// grounding for a fight that may not exist.
export async function buildExpertChatContext(
  selectedFighterA: string | null,
  selectedFighterB: string | null
): Promise<ExpertChatContext | null> {
  const event = await fetchCurrentUfcEvent();
  if (!event) return null;

  const cardFights = event.fights.map((fight) => ({
    fighterA: fight.fighterA,
    fighterB: fight.fighterB,
    weightClass: fight.weightClass,
  }));

  const matchedFight =
    selectedFighterA && selectedFighterB
      ? findMatchingFight(event.fights, selectedFighterA, selectedFighterB)
      : null;

  const selectedFight = matchedFight
    ? {
        fighterA: await buildFighterContext(matchedFight.fighterA),
        fighterB: await buildFighterContext(matchedFight.fighterB),
      }
    : null;

  return {
    eventName: event.eventName,
    eventDate: event.date,
    completed: event.completed,
    isLive: event.isLive,
    cardFights,
    selectedFight,
  };
}
