import "server-only";
import { supabaseAdmin } from "./supabaseAdmin";
import { namesMatchExactly } from "./fighterName";

// Settles stored predictions against real results once Cito has them, so
// the (not-yet-displayed) AI track record has real win/loss data behind
// it instead of just picks. Deliberately batch/pull-based rather than
// triggered by the fighter-history sync itself — a fighter's history row
// can get a result long after their own fight_predictions row was written
// (Cito backfills on its own schedule), so this just re-checks whatever
// is still unsettled each time it runs.

type PendingPrediction = {
  id: number;
  fight_key: string;
  fighter_a: string;
  fighter_b: string;
};

// Surnames are the stable anchor across providers (see the same
// reasoning in mergeFightData.ts) — used only to narrow the fighter_history
// query before the exact both-names check below confirms the real match.
function lastWord(name: string): string {
  const parts = name.trim().split(/\s+/);
  return parts[parts.length - 1] || "";
}

export interface ReconciliationSummary {
  checked: number;
  settled: number;
  stillPending: number;
  errors: number;
}

export async function reconcilePendingPredictions(): Promise<ReconciliationSummary> {
  const { data: pending, error } = await supabaseAdmin
    .from("fight_predictions")
    .select("id, fight_key, fighter_a, fighter_b")
    .is("actual_winner", null)
    .is("actual_result", null);

  if (error) {
    console.error("[predictionReconciliation] failed to load pending predictions:", error.message);
    return { checked: 0, settled: 0, stillPending: 0, errors: 1 };
  }

  const summary: ReconciliationSummary = { checked: pending.length, settled: 0, stillPending: 0, errors: 0 };

  for (const row of pending as PendingPrediction[]) {
    try {
      const settled = await reconcileOne(row);
      if (settled) summary.settled += 1;
      else summary.stillPending += 1;
    } catch (err) {
      summary.errors += 1;
      console.error(
        `[predictionReconciliation] error reconciling "${row.fight_key}":`,
        err instanceof Error ? err.message : err
      );
    }
  }

  console.log(
    `[predictionReconciliation] checked=${summary.checked} settled=${summary.settled} stillPending=${summary.stillPending} errors=${summary.errors}`
  );

  return summary;
}

async function reconcileOne(row: PendingPrediction): Promise<boolean> {
  const { data: candidates, error } = await supabaseAdmin
    .from("fighter_history")
    .select("fighter_name, opponent_name, result")
    .ilike("fighter_name", `%${lastWord(row.fighter_a)}%`)
    .not("result", "is", null);

  if (error) {
    throw new Error(error.message);
  }

  const match = (candidates || []).find(
    (c) =>
      namesMatchExactly(c.fighter_name, row.fighter_a) &&
      namesMatchExactly(c.opponent_name || "", row.fighter_b)
  );

  if (!match) return false;

  // Same normalization/labels as historyResultBadge() in page.tsx — kept
  // separate rather than imported since that one is UI-facing (returns a
  // badge label+class) while this needs the settled-outcome semantics.
  const result = (match.result || "").trim().toLowerCase();

  let actualResult: string;
  let actualWinner: string | null;

  if (result === "win") {
    actualResult = "win_a";
    actualWinner = row.fighter_a;
  } else if (result === "loss") {
    actualResult = "win_b";
    actualWinner = row.fighter_b;
  } else if (result === "draw") {
    actualResult = "draw";
    actualWinner = null;
  } else if (result === "nc" || result === "no contest" || result === "no-contest") {
    actualResult = "no_contest";
    actualWinner = null;
  } else {
    // Unrecognized value — leave pending rather than guess.
    return false;
  }

  const { error: updateError } = await supabaseAdmin
    .from("fight_predictions")
    .update({
      actual_winner: actualWinner,
      actual_result: actualResult,
      settled_at: new Date().toISOString(),
    })
    .eq("id", row.id);

  if (updateError) {
    throw new Error(updateError.message);
  }

  return true;
}
