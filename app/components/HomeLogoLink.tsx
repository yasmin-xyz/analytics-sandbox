"use client";

import Link from "next/link";
import Image from "next/image";

// Extracted from methodology/page.tsx (a Server Component) because an
// onClick handler can't be passed to a Client Component (next/link) from
// a Server Component during static generation — the handler needs its
// own "use client" boundary. Without it, Next's default Link scroll
// behavior doesn't reliably land at the top of "/" when the home route
// is already cached from a prior visit.
export default function HomeLogoLink() {
  return (
    <Link
      href="/"
      className="nav-logo"
      style={{ textDecoration: "none" }}
      onClick={() => window.scrollTo(0, 0)}
    >
      <Image
        src="/android-chrome-192x192.png"
        alt="Pick'em Labs"
        width={31}
        height={31}
        className="nav-logo-img"
      />
      <div className="nav-logo-text">
        <div className="nav-logo-letters">
          <span className="nav-ltr" style={{ transform: "rotate(-2deg) translateY(1px)" }}>P</span>
          <span className="nav-ltr" style={{ transform: "rotate(1.5deg) translateY(-1px)" }}>I</span>
          <span className="nav-ltr" style={{ transform: "rotate(-1deg) translateY(1px)" }}>C</span>
          <span className="nav-ltr" style={{ transform: "rotate(2deg) translateY(-1px)" }}>K</span>
          <span className="nav-ltr" style={{ transform: "rotate(-1.5deg) translateY(0px)", margin: "0 1px" }}>&apos;</span>
          <span className="nav-ltr" style={{ transform: "rotate(1deg) translateY(1px)" }}>E</span>
          <span className="nav-ltr" style={{ transform: "rotate(-2deg) translateY(-1px)" }}>M</span>
        </div>
        <span className="nav-logo-labs">LABS</span>
      </div>
    </Link>
  );
}
