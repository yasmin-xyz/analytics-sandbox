import Link from "next/link";
import FooterWordmark from "./FooterWordmark";

const PRODUCT_LINKS = [
  { label: "Methodology", href: "/methodology" },
  { label: "Feedback", href: "/feedback" },
  { label: "Responsible Gambling", href: "/responsible-gambling" },
];

const LEGAL_LINKS = [
  { label: "Privacy Policy", href: "/privacy" },
  { label: "Terms of Service", href: "/terms" },
];

export default function Footer() {
  return (
    <footer className="footer">
      <div className="footer-inner">
        <div className="footer-main">

          {/* Left */}
          <div className="footer-brand">
            <div className="footer-brand-name">
              <FooterWordmark />
            </div>
            <p className="footer-desc">
              AI-powered UFC fight analysis that combines advanced fighter data,
              sportsbook odds, and multiple AI models to help you make more
              informed predictions.
            </p>
            <p className="footer-copyright">© 2026 Pick'em Labs</p>
          </div>

          {/* Right */}
          <div className="footer-links">
            <div className="footer-col">
              <span className="footer-col-heading">Product</span>
              <ul className="footer-col-list">
                {PRODUCT_LINKS.map(({ label, href }) => (
                  <li key={href}>
                    <Link href={href} className="footer-link">
                      {label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>

            <div className="footer-col">
              <span className="footer-col-heading">Legal</span>
              <ul className="footer-col-list">
                {LEGAL_LINKS.map(({ label, href }) => (
                  <li key={href}>
                    <Link href={href} className="footer-link">
                      {label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          </div>

        </div>

        <div className="footer-divider" />

        <p className="footer-disclaimer">
          Pick&apos;em Labs is an independent sports analytics platform. We do
          not accept wagers or guarantee prediction outcomes.
        </p>
      </div>
    </footer>
  );
}
