"use client";

import { useState } from "react";
import posthog from "posthog-js";

// Shown only in the event bar's concluded state (see page.tsx) — lets a
// visitor leave an email to hear about the next card once its data is
// live, without needing to keep checking back manually.
export default function NotifySignup() {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [website, setWebsite] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim()) {
      setError("Enter an email first.");
      return;
    }
    setError(null);
    setSubmitting(true);

    try {
      const res = await fetch("/api/notify-signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), website }),
      });

      if (res.status === 429) {
        setError("Too many attempts — try again in a few minutes.");
        return;
      }
      if (!res.ok) {
        setError("Something went wrong. Try again in a moment.");
        return;
      }

      // First moment we know who this visitor is — merge their prior
      // anonymous activity (page views, session recording) onto a Person
      // profile keyed by email instead of the anonymous device id.
      posthog.identify(email.trim(), { email: email.trim() });

      setDone(true);
    } catch {
      setError("Something went wrong. Try again in a moment.");
    } finally {
      setSubmitting(false);
    }
  }

  if (done) {
    return (
      <span className="notify-signup-done">
        You&apos;re on the list — we&apos;ll email you as soon as the data is live.
      </span>
    );
  }

  if (!open) {
    return (
      <button type="button" className="notify-signup-trigger" onClick={() => setOpen(true)}>
        Notify me when event data is live
      </button>
    );
  }

  return (
    <form className="notify-signup-form" onSubmit={handleSubmit}>
      <input
        type="text"
        className="form-honeypot"
        tabIndex={-1}
        autoComplete="off"
        aria-hidden="true"
        value={website}
        onChange={(e) => setWebsite(e.target.value)}
        name="website"
      />
      <input
        type="email"
        className="notify-signup-input"
        placeholder="you@example.com"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        aria-label="Email for next-event notification"
        autoFocus
      />
      <button type="submit" className="notify-signup-submit" disabled={submitting}>
        {submitting ? "…" : "Notify me"}
      </button>
      {error && <span className="notify-signup-error">{error}</span>}
    </form>
  );
}
