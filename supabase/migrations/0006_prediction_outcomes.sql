-- Groundwork for tracking the AI consensus's real-world accuracy. Adds
-- columns to the existing fight_predictions table rather than a new
-- table, since a prediction and its eventual outcome are the same
-- logical row, already keyed by fight_key.
--
-- actual_result distinguishes a draw/no-contest (a real settled outcome,
-- just not a "win" for either side) from "not settled yet" (null) —
-- collapsing that into a single winner-or-null column would make the two
-- indistinguishable.
alter table public.fight_predictions add column if not exists actual_winner text;
alter table public.fight_predictions add column if not exists actual_result text;
alter table public.fight_predictions add column if not exists settled_at timestamptz;
