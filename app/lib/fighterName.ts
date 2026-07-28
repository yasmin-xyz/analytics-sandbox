// A handful of Latin letters that don't decompose into base + combining
// mark under Unicode NFD (unlike é, ć, š, etc., which do) — Polish/
// Scandinavian letters that do show up in fighter names (e.g. Błachowicz).
// Anything not covered here that also resists NFD decomposition would
// still fall through to the same silent-deletion failure this is fixing —
// extend this map if that turns up in practice.
const DIACRITIC_MAP: Record<string, string> = {
  ł: "l", Ł: "L",
  đ: "d", Đ: "D",
  ø: "o", Ø: "O",
  æ: "ae", Æ: "AE",
  œ: "oe", Œ: "OE",
  ß: "ss",
  ı: "i", İ: "I",
};

// Transliterates accented letters to their plain-Latin base (e.g.
// "Rakić" -> "Rakic", "Błachowicz" -> "Blachowicz") instead of deleting
// them outright. Cito and ESPN don't consistently agree on whether a
// given fighter's name is spelled with or without diacritics — the old
// `[^\w\s]` strip below treats "ć" as just another punctuation character
// and drops it, which silently breaks an exact-match comparison against
// the plain-ASCII spelling of the same name (this is exactly how
// established fighters like Aleksandar Rakić/Rakic and Jan Błachowicz/
// Blachowicz ended up failing Cito lookups despite clearly being in its
// database).
export function stripDiacritics(value: string): string {
  const mapped = value.replace(/[łŁđĐøØæÆœŒßıİ]/g, (ch) => DIACRITIC_MAP[ch] ?? ch);
  return mapped.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

export function normalizeFighterName(name: string) {
  return stripDiacritics(name)
    .toLowerCase()
    .replace(/[^\w\s]/g, "")
    .replace(/\s+/g, "-")
    .trim();
}

// For comparing two display names for an exact match (case/whitespace/basic
// punctuation insensitive) without attempting nickname/alias resolution.
export function namesMatchExactly(a: string, b: string) {
  const clean = (value: string) =>
    stripDiacritics(value)
      .toLowerCase()
      .replace(/[^\w\s]/g, "")
      .replace(/\s+/g, " ")
      .trim();

  return clean(a) === clean(b);
}
