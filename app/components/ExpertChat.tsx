"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import FightSelect from "./FightSelect";
import posthog from "posthog-js";

type SuggestedFight = { fighterA: string; fighterB: string } | null;
type ChatMessage = { role: "user" | "assistant"; content: string; suggestedFight?: SuggestedFight };

// No trailing ellipsis — the animated dots next to this text already read
// as "...", so "Thinking…" plus the dots was doubling up on the same cue.
const THINKING_MESSAGES = [
  "Thinking",
  "Digging through the stats",
  "Checking the numbers",
  "Doing some research",
  "Putting it together",
];

export default function ExpertChat({
  fights,
  selectedFight,
  onSelectFight,
  marketOddsA,
  marketOddsB,
  marketProbA,
  marketProbB,
}: {
  fights: any[];
  selectedFight: any;
  onSelectFight: (fight: any) => void;
  marketOddsA?: number | null;
  marketOddsB?: number | null;
  marketProbA?: number | null;
  marketProbB?: number | null;
}) {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [thinkingIndex, setThinkingIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);

  const selectedFighterA: string | undefined = selectedFight?.fighterA;
  const selectedFighterB: string | undefined = selectedFight?.fighterB;

  useEffect(() => setMounted(true), []);

  // Cycles the loading bubble's text through a short rotation so a slow
  // (web-search-triggering) reply doesn't just sit on a static "Thinking…"
  // the whole time.
  useEffect(() => {
    if (!loading) {
      setThinkingIndex(0);
      return;
    }
    const interval = setInterval(() => {
      setThinkingIndex((i) => (i + 1) % THINKING_MESSAGES.length);
    }, 3200);
    return () => clearInterval(interval);
  }, [loading]);

  // Whichever fight the chat is scoped to just changed (from the main page
  // selector, or from the picker in the chat header below — same
  // selectFight() call either way) — the old transcript was grounded in a
  // different fight's data, so it doesn't make sense to keep it around.
  useEffect(() => {
    setMessages([]);
    setError(null);
  }, [selectedFighterA, selectedFighterB]);

  useEffect(() => {
    if (!open) return;

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }

    function handlePointerDown(e: MouseEvent | TouchEvent) {
      const target = e.target as Node;
      if (panelRef.current?.contains(target)) return;
      if (btnRef.current?.contains(target)) return;
      // The fight picker's option list is portaled to document.body (see
      // Dropdown.tsx) — a sibling of the panel, not a descendant — so
      // picking a fight from it would otherwise register as an outside
      // click and close the whole chat mid-selection.
      if (target instanceof Element && target.closest(".expert-chat-dropdown-panel")) return;
      setOpen(false);
    }

    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("touchstart", handlePointerDown);

    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("touchstart", handlePointerDown);
    };
  }, [open]);

  useEffect(() => {
    transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, loading]);

  async function sendMessage() {
    const trimmed = input.trim();
    if (!trimmed || loading) return;

    const nextMessages: ChatMessage[] = [...messages, { role: "user", content: trimmed }];
    setMessages(nextMessages);
    setInput("");
    setLoading(true);
    setError(null);
    posthog.capture("expert_chat_message_sent", {
      fighter_a: selectedFighterA,
      fighter_b: selectedFighterB,
      message_index: messages.length,
    });

    try {
      const res = await fetch("/api/expert-chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: trimmed,
          conversationHistory: messages.map(({ role, content }) => ({ role, content })),
          selectedFighterA: selectedFighterA || undefined,
          selectedFighterB: selectedFighterB || undefined,
          marketOddsA: marketOddsA ?? undefined,
          marketOddsB: marketOddsB ?? undefined,
          marketProbA: marketProbA ?? undefined,
          marketProbB: marketProbB ?? undefined,
        }),
      });

      if (res.status === 429) {
        setError("You've sent a lot of messages — give it a few minutes and try again.");
        return;
      }
      if (!res.ok) {
        setError("Something went wrong answering that. Try again in a moment.");
        return;
      }

      const data = await res.json();
      setMessages([
        ...nextMessages,
        { role: "assistant", content: data.reply, suggestedFight: data.suggestedFight ?? null },
      ]);
    } catch {
      setError("Something went wrong answering that. Try again in a moment.");
    } finally {
      setLoading(false);
    }
  }

  function handleKeyPress(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  }

  // The server already validated the suggested pair against the real card
  // (see extractSuggestedFight in the API route) — this just finds the
  // matching entry in the same fights list the dropdown uses, so clicking
  // through reuses the exact selectFight() path as any other fight change.
  function handleSuggestedFightClick(suggestion: SuggestedFight) {
    if (!suggestion) return;
    const match = fights.find(
      (f) =>
        (f.fighterA === suggestion.fighterA && f.fighterB === suggestion.fighterB) ||
        (f.fighterA === suggestion.fighterB && f.fighterB === suggestion.fighterA)
    );
    if (match) {
      posthog.capture("expert_chat_fight_redirect", {
        fighter_a: suggestion.fighterA,
        fighter_b: suggestion.fighterB,
      });
      onSelectFight(match);
    }
  }

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className="nav-chat-btn"
        aria-expanded={open}
        aria-controls="expert-chat-panel"
        onClick={() => {
          const opening = !open;
          setOpen(opening);
          if (opening) {
            posthog.capture("expert_chat_opened", {
              fighter_a: selectedFighterA,
              fighter_b: selectedFighterB,
            });
          }
        }}
      >
        Ask the Expert
      </button>

      {mounted &&
        createPortal(
          <div
            id="expert-chat-panel"
            ref={panelRef}
            role="dialog"
            aria-label="Ask the Expert"
            className={`expert-chat-panel ${open ? "expert-chat-panel-open" : ""}`}
          >
            <div className="expert-chat-header">
              <button type="button" className="expert-chat-close" aria-label="Close chat" onClick={() => setOpen(false)}>
                ×
              </button>
              <span className="expert-chat-picker-label">Ask anything about this matchup:</span>
              {fights.length > 0 && (
                <div className="expert-chat-fight-picker">
                  <FightSelect
                    id="expert-chat-fight-select"
                    panelClassName="expert-chat-dropdown-panel"
                    fights={fights}
                    selectedId={selectedFight?.id}
                    onSelect={onSelectFight}
                  />
                </div>
              )}
            </div>

            <div className="expert-chat-transcript" ref={transcriptRef} aria-live="polite">
              <div className="expert-chat-disclaimer">AI-generated answers, powered by Claude</div>
              {messages.map((m, i) => (
                <div key={i} className={`expert-chat-message expert-chat-message-${m.role}`}>
                  <div className={`expert-chat-bubble expert-chat-bubble-${m.role}`}>{m.content}</div>
                  {m.suggestedFight && (
                    <button
                      type="button"
                      className="expert-chat-redirect"
                      onClick={() => handleSuggestedFightClick(m.suggestedFight ?? null)}
                    >
                      Switch to {m.suggestedFight.fighterA} vs. {m.suggestedFight.fighterB} →
                    </button>
                  )}
                </div>
              ))}
              {loading && (
                <div className="expert-chat-message expert-chat-message-assistant">
                  <div className="expert-chat-bubble expert-chat-bubble-assistant expert-chat-loading">
                    <span>{THINKING_MESSAGES[thinkingIndex]}</span>
                    <span className="expert-chat-loading-dots">
                      <span />
                      <span />
                      <span />
                    </span>
                  </div>
                </div>
              )}
              {error && <div className="expert-chat-error">{error}</div>}
            </div>

            <div className="expert-chat-input-row">
              <textarea
                className="expert-chat-input"
                placeholder="Ask a question…"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyPress}
                rows={1}
              />
              <button
                type="button"
                className="expert-chat-send"
                onClick={sendMessage}
                disabled={loading || !input.trim()}
              >
                Send
              </button>
            </div>
          </div>,
          document.body
        )}
    </>
  );
}
