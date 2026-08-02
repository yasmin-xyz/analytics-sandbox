# Pick'em Labs

A UFC fight analysis and betting insights app. It pulls live fight cards, real fighter stats, and current odds, then runs each matchup through Claude, GPT-4, and Gemini independently for a consensus prediction.

I'm building this to actually learn React and Next.js — not through tutorials, but by wiring up real APIs, dealing with the mess that comes with them, and shipping something people can use.

## What it does

For every fight on the card:

- **Tale of the Tape** — record, age, height, reach, stance, and weight class side by side
- **Statistical Edge** — striking accuracy, takedown %, defense, submission rate, shown as comparison bars
- **Recent Fight History** — each fighter's last several results, backfilled from Sherdog when they're too new to have much UFC history yet
- **AI Breakdown** — advantages, biggest risks, likely fight script, confidence score, plus a "why the AI could be wrong" section
- **Betting Market** — live odds across bookmakers, implied probability vs. the AI's own, and where the edge is
- **Model Consensus** — Claude, GPT-4, and Gemini each analyze the fight independently, then get compared

## Tech stack

| Layer | Tool |
|---|---|
| Framework | Next.js 16 (App Router, Turbopack), React 19 |
| Styling | Hand-written CSS, no UI framework |
| Fight cards & bios | ESPN (unofficial API) |
| Fighter stats & history | [Cito API](https://citoapi.com), Sherdog as a fallback |
| Odds | [The Odds API](https://the-odds-api.com) |
| AI | Claude, GPT-4, Gemini |
| Data / caching | Supabase (Postgres), RLS on every table |
| Analytics | PostHog — events, AI observability, session replay |
| Testing | Vitest, providers mocked |
| Deployed on | Vercel |

## Handling messy real-world data

- Cito covers UFC results but not much else, so a fighter fresh into the UFC often has little history there — Sherdog fills in the pre-UFC and regional fights, deduped against whatever Cito already has.
- Matching fighter names between ESPN's card and the odds provider's market names isn't always clean (nicknames, spelling, suffixes), so there's a surname-based fallback instead of just showing no odds.
- Odds, fighter data, and predictions are all cached. A "fighter not found" result gets a much shorter cache window than real data, so it corrects itself quickly instead of staying wrong for weeks.

## Security

Rate limiting per route, backed by Postgres instead of memory since that doesn't survive across serverless instances. RLS on every Supabase table with no direct browser access. Strict input validation on every POST endpoint. No secrets or provider errors ever reach the client.

## Status

- [x] Live fight cards, odds, fighter stats/history
- [x] AI predictions — Claude, GPT-4, Gemini + consensus
- [x] Betting value analysis
- [x] Security hardening
- [x] Test suite
- [x] PostHog analytics + AI observability
- [x] Deployed on Vercel
- [ ] Google OAuth login

## Local development

See [`.env.example`](.env.example) and `supabase/migrations/` for setup. Tracking plan lives in [`TRACKING_PLAN.md`](./TRACKING_PLAN.md).
