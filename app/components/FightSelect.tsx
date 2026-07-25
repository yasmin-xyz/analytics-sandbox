"use client";

import Dropdown from "./Dropdown";

interface Fight {
  id: string | number;
  fighterA: string;
  fighterB: string;
}

interface FightSelectProps {
  fights: Fight[];
  selectedId: string | number | null | undefined;
  onSelect: (fight: Fight) => void;
  // Both default to the original values so the main page's fight selector
  // (the first caller, before ExpertChat needed a second instance) doesn't
  // have to change. A second instance on the same page must override `id`
  // — duplicate DOM ids break aria-activedescendant/label association.
  id?: string;
  panelClassName?: string;
}

function fightLabel(fight: Fight) {
  return `${fight.fighterA} vs. ${fight.fighterB}`;
}

// Thin wrapper around the generic Dropdown, keeping the same external
// API this had before Dropdown.tsx was extracted (fights/selectedId/
// onSelect) so app/page.tsx didn't need to change.
export default function FightSelect({ fights, selectedId, onSelect, id = "fight-select", panelClassName }: FightSelectProps) {
  return (
    <Dropdown
      id={id}
      panelClassName={panelClassName}
      ariaLabel="Select a matchup to analyze"
      placeholder="Select a matchup"
      options={fights.map((fight) => ({ key: String(fight.id), label: fightLabel(fight), value: fight }))}
      selectedKey={selectedId != null ? String(selectedId) : null}
      onSelect={(option) => onSelect(option.value)}
    />
  );
}
