import type { Metadata } from "next";
import Link from "next/link";
import HomeLogoLink from "../components/HomeLogoLink";

export const metadata: Metadata = {
  title: "Methodology — Pick'em Labs",
  description:
    "How Pick'em Labs combines fighter statistics, sportsbook odds, and multiple AI models to generate fight predictions.",
};

export default function MethodologyPage() {
  return (
    <main className="meth-page">

      {/* Nav */}
      <nav className="nav reveal-nav">
        <HomeLogoLink />
      </nav>

      {/* Article */}
      <article className="meth-article reveal-meth-article">

        {/* Hero */}
        <header className="meth-hero">
          <div className="meth-eyebrow">Methodology</div>
          <h1 className="meth-title">How Pick&apos;em Labs works</h1>
          <p className="meth-lead">
            Pick&apos;em Labs is a sports analytics tool that combines publicly
            available fighter statistics, live sportsbook odds, and independent
            analysis from multiple AI models. This page explains exactly how
            predictions are generated, what data is used, and where the current
            limitations are.
          </p>
        </header>

        <div className="meth-divider" />

        {/* Section 1 */}
        <section className="meth-section">
          <h2 className="meth-heading">The analysis process</h2>
          <p className="meth-body">
            For every fight on an upcoming card, Pick&apos;em Labs pulls three
            independent inputs and combines them into a single analysis view.
          </p>
          <ol className="meth-steps">
            <li className="meth-step">
              <span className="meth-step-num">01</span>
              <div>
                <div className="meth-step-title">Fighter data is collected</div>
                <p className="meth-step-body">
                  Career records, physical attributes, detailed fight
                  statistics, and recent fight-by-fight results are sourced
                  from the Cito API and Sherdog. This includes striking
                  accuracy, takedown rates, submission attempts, and finish
                  percentages.
                </p>
              </div>
            </li>
            <li className="meth-step">
              <span className="meth-step-num">02</span>
              <div>
                <div className="meth-step-title">Sportsbook odds are fetched</div>
                <p className="meth-step-body">
                  Live moneyline odds are pulled from every major sportsbook
                  available via The Odds API — typically 8-11 books per fight.
                  Rather than relying on any single book&apos;s line, the market
                  probability shown is the median across all of them, so one
                  outlier price can&apos;t skew the picture. Implied probabilities
                  are derived from that consensus price.
                </p>
              </div>
            </li>
            <li className="meth-step">
              <span className="meth-step-num">03</span>
              <div>
                <div className="meth-step-title">AI models analyze the matchup</div>
                <p className="meth-step-body">
                  Three AI models — Claude, GPT-4, and Gemini — independently
                  evaluate the matchup using fighter statistics, each
                  fighter&apos;s recent fight-by-fight results, and odds context.
                  Each model produces a predicted winner, a confidence score, a
                  predicted method and round, and a structured breakdown
                  covering key advantages, risks, and a likely fight script.
                </p>
              </div>
            </li>
            <li className="meth-step">
              <span className="meth-step-num">04</span>
              <div>
                <div className="meth-step-title">Results are surfaced</div>
                <p className="meth-step-body">
                  The three model outputs are compared to produce a consensus
                  pick and an average confidence score. The AI win probability
                  is then shown alongside the market-implied probability so you
                  can see where they agree and where they diverge.
                </p>
              </div>
            </li>
          </ol>
        </section>

        <div className="meth-divider" />

        {/* Section 2 */}
        <section className="meth-section">
          <h2 className="meth-heading">AI models</h2>
          <p className="meth-body">
            Pick&apos;em Labs currently uses three large language models. Each
            model receives the same structured prompt containing fighter
            statistics and odds data. They analyze the matchup independently —
            no model sees another&apos;s output before producing its prediction.
          </p>
          <div className="meth-model-grid">
            <div className="meth-model-card">
              <div className="meth-model-header">
                <span className="meth-model-dot" style={{ background: "#CF9B60" }} />
                <span className="meth-model-name">Claude</span>
              </div>
              <p className="meth-model-desc">
                Developed by Anthropic. Known for careful, structured reasoning
                and nuanced risk assessment. Claude tends to produce detailed
                fight scripts and explicit breakdowns of counter-arguments.
              </p>
            </div>
            <div className="meth-model-card">
              <div className="meth-model-header">
                <span className="meth-model-dot" style={{ background: "#5DC98A" }} />
                <span className="meth-model-name">GPT-4</span>
              </div>
              <p className="meth-model-desc">
                Developed by OpenAI. Broadly capable across sports analysis
                tasks and draws on extensive training data covering MMA
                history, fighter profiles, and fighting styles.
              </p>
            </div>
            <div className="meth-model-card">
              <div className="meth-model-header">
                <span className="meth-model-dot" style={{ background: "#5B9EE8" }} />
                <span className="meth-model-name">Gemini</span>
              </div>
              <p className="meth-model-desc">
                Developed by Google DeepMind. Provides a third independent
                perspective on each matchup, helping to identify cases where
                model agreement is strong versus cases where predictions
                diverge significantly.
              </p>
            </div>
          </div>
        </section>

        <div className="meth-divider" />

        {/* Section 3 */}
        <section className="meth-section">
          <h2 className="meth-heading">Data sources</h2>
          <p className="meth-body">
            Pick&apos;em Labs currently draws from three primary data sources.
          </p>
          <div className="meth-source-list">
            <div className="meth-source">
              <div className="meth-source-label">Fighter statistics</div>
              <p className="meth-source-body">
                Career and per-fight metrics are sourced from the Cito API and
                Sherdog. This includes significant strike rates, accuracy,
                takedown data, submission attempts, and win/loss records.
                Statistics reflect career averages and may not capture very
                recent fights until data is updated.
              </p>
            </div>
            <div className="meth-source">
              <div className="meth-source-label">Recent fight history</div>
              <p className="meth-source-body">
                Each fighter&apos;s most recent completed UFC bouts — opponent,
                result, method, and round — are pulled from the same sources
                and included alongside career stats, so the AI models have
                fight-by-fight context, not just career averages.
              </p>
            </div>
            <div className="meth-source">
              <div className="meth-source-label">Sportsbook odds</div>
              <p className="meth-source-body">
                Moneyline odds are fetched in real time from The Odds API,
                which aggregates lines from multiple major sportsbooks. Odds
                are displayed in American format. A median implied probability
                across all available books is calculated and used as an input
                to the AI analysis prompt.
              </p>
            </div>
          </div>
        </section>

        <div className="meth-divider" />

        {/* Section 4 */}
        <section className="meth-section">
          <h2 className="meth-heading">Confidence scores</h2>
          <p className="meth-body">
            Each AI model returns a confidence score between 0 and 100
            alongside its predicted winner. This score represents the
            model&apos;s self-assessed certainty in its own prediction given
            the data it was provided.
          </p>
          <p className="meth-body">
            The consensus confidence shown in the Model Consensus panel
            is the arithmetic average of the three individual model scores. It
            is not a probability of the predicted fighter winning — it is a
            measure of how certain the models are collectively in their pick.
          </p>
          <p className="meth-body">
            A high consensus confidence combined with a pick that disagrees
            with the betting market is typically the most analytically
            interesting signal Pick&apos;em Labs surfaces.
          </p>
        </section>

        <div className="meth-divider" />

        {/* Section 5 */}
        <section className="meth-section">
          <h2 className="meth-heading">AI vs market</h2>
          <p className="meth-body">
            The AI vs. Market panel compares the AI consensus confidence
            against the market-implied probability derived from sportsbook
            odds. The difference between these two numbers is displayed as the
            AI–Market Gap.
          </p>
          <p className="meth-body">
            A positive gap means the AI models collectively assign a higher
            win probability to a fighter than the market does. A negative gap
            means the market is more confident in that fighter than the AI
            models are. The gap is also labeled with a tier — from
            &quot;Market-aligned&quot; to &quot;High-risk contrarian
            pick&quot; — based on how big an underdog the AI&apos;s pick is
            per the market; a large enough gap on a genuine underdog is
            flagged with a Contrarian pick badge.
          </p>
          <p className="meth-body">
            This comparison is informational. It is intended to surface
            disagreements between AI analysis and market consensus, not to
            imply that either the AI or the market is correct.
          </p>
        </section>

        <div className="meth-divider" />

        {/* Section 6 */}
        <section className="meth-section">
          <h2 className="meth-heading">Current limitations</h2>
          <p className="meth-body">
            Pick&apos;em Labs is an early-stage tool. There are several known
            limitations to be aware of when interpreting its output.
          </p>
          <ul className="meth-limitations">
            <li className="meth-limitation">
              <span className="meth-limitation-label">Statistical recency</span>
              Fighter statistics reflect career averages. Recent form, injuries,
              coaching changes, and camp reports are not systematically
              incorporated into the data layer.
            </li>
            <li className="meth-limitation">
              <span className="meth-limitation-label">AI knowledge cutoffs</span>
              Large language models have training cutoffs. Fights, results, and
              fighter developments that occurred after a model&apos;s cutoff date
              may not be reflected in its analysis.
            </li>
            <li className="meth-limitation">
              <span className="meth-limitation-label">No round-by-round granularity</span>
              Each fighter&apos;s recent fights are included at the result level
              (opponent, method, round, time) — not round-by-round strike or
              grappling breakdowns. Career stat comparisons still rely on
              aggregate averages, not fight-by-fight splits.
            </li>
            <li className="meth-limitation">
              <span className="meth-limitation-label">Model variability</span>
              AI model outputs are not deterministic. The same prompt may
              produce slightly different predictions across separate requests.
              Predictions should be treated as one analytical input, not a
              definitive forecast.
            </li>
          </ul>
        </section>

        <div className="meth-divider" />

        <Link href="/" className="meth-back-link">
          ← Back to home
        </Link>
      </article>
    </main>
  );
}
