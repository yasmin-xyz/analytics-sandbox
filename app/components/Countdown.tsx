"use client";

import { useEffect, useState } from "react";

// Ticks on its own 1s interval rather than sharing the page's slower
// (60s) clock — isolating that to this small component means only this
// text re-renders every second instead of the whole page.
function formatCountdown(targetMs: number, nowMs: number): string | null {
  const diffMs = targetMs - nowMs;
  if (diffMs <= 0) return null;

  const totalSeconds = Math.floor(diffMs / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (days >= 1) return `${days}d ${hours}h ${minutes}m ${seconds}s`;
  if (hours >= 1) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes >= 1) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

export default function Countdown({
  targetDate,
  className = "",
}: {
  targetDate: string | null | undefined;
  className?: string;
}) {
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    const interval = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(interval);
  }, []);

  if (!targetDate) return null;

  const targetMs = new Date(targetDate).getTime();
  if (isNaN(targetMs)) return null;

  const formatted = formatCountdown(targetMs, nowMs);

  return <span className={className}>{formatted ? `Starts in ${formatted}` : "Starts today"}</span>;
}
