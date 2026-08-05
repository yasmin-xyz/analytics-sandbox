// app/feedback/page.tsx
"use client";

import { useState } from "react";
import Link from "next/link";
import HomeLogoLink from "../components/HomeLogoLink";
import Dropdown from "../components/Dropdown";
import posthog from "posthog-js";

const CATEGORIES = ["Bug report", "Feature request", "General feedback"];

export default function FeedbackPage() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [category, setCategory] = useState("General feedback");
  const [message, setMessage] = useState("");
  const [website, setWebsite] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!message.trim()) {
      setError("Please enter a message before submitting.");
      return;
    }
    setError("");
    setSubmitting(true);

    try {
      const res = await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim() || undefined,
          email: email.trim() || undefined,
          category,
          message: message.trim(),
          website,
        }),
      });

      if (res.status === 429) {
        setError("You've submitted a lot of feedback — try again in a few minutes.");
        return;
      }
      if (!res.ok) {
        setError("Something went wrong submitting that. Try again in a moment.");
        return;
      }

      // Feedback is the first moment we know who this visitor actually is —
      // identify() merges everything they did anonymously before this
      // (page views, prior events, this session's recording) onto one
      // Person profile keyed by email instead of the anonymous device id.
      if (email.trim()) {
        posthog.identify(email.trim(), {
          email: email.trim(),
          name: name.trim() || undefined,
        });
      }

      posthog.capture("feedback_submitted", {
        category,
        message_length: message.trim().length,
      });
      setSubmitted(true);
    } catch {
      setError("Something went wrong submitting that. Try again in a moment.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="meth-page">
      <nav className="nav reveal-nav">
        <HomeLogoLink />
      </nav>

      <article className="meth-article reveal-meth-article">
        <header className="meth-hero">
          <div className="meth-eyebrow">Feedback</div>
          <h1 className="meth-title">Help us improve Pick&apos;em Labs</h1>
          <p className="meth-lead">
            Found a bug, have an idea, or just want to tell us what you think?
            Drop us a note below — we read everything.
          </p>
        </header>

        <div className="meth-divider" />

        {submitted ? (
          <div className="feedback-success">
            <div className="feedback-success-title">Thanks for the feedback</div>
            <p className="feedback-success-body">
              We&apos;ve received your message and will take a look.
            </p>
          </div>
        ) : (
          <form className="feedback-form" onSubmit={handleSubmit}>
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

            <div className="form-group">
              <label className="form-label" htmlFor="name">
                Name <span className="form-label-optional">(optional)</span>
              </label>
              <input
                id="name"
                className="form-input"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Your name"
              />
            </div>

            <div className="form-group">
              <label className="form-label" htmlFor="email">
                Email <span className="form-label-optional">(optional)</span>
              </label>
              <input
                id="email"
                className="form-input"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
              />
            </div>

            <div className="form-group">
              <label className="form-label" htmlFor="category">
                Category
              </label>
              <Dropdown
                id="category"
                ariaLabel="Feedback category"
                options={CATEGORIES.map((cat) => ({ key: cat, label: cat, value: cat }))}
                selectedKey={category}
                onSelect={(option) => setCategory(option.value)}
              />
            </div>

            <div className="form-group">
              <label className="form-label" htmlFor="message">
                Message <span className="form-label-required">*</span>
              </label>
              <textarea
                id="message"
                className="form-textarea"
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder="What's on your mind?"
                rows={6}
              />
            </div>

            {error && <div className="form-error">{error}</div>}

            <button type="submit" className="form-submit" disabled={submitting}>
              {submitting ? "Submitting…" : "Submit feedback"}
            </button>
          </form>
        )}

        <div className="meth-divider" />

        <Link href="/" className="meth-back-link">
          ← Back to home
        </Link>
      </article>
    </main>
  );
}
