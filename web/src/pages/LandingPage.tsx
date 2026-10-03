import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import './landing.css';

export const BG_VIDEO =
  'https://d8j0ntlcm91z4.cloudfront.net/user_38xzZboKViGWJOttwIXH07lWA1P/hf_20260809_012548_ef22562c-c0ae-4816-ad9d-f8922af4e6a7.mp4';

const NAV = [
  { label: 'Home', to: '/' },
  { label: 'Work items', to: '/items?active=true' },
  { label: 'Approvals', to: '/approvals' },
  { label: 'Teams', to: '/teams' },
];

// Every number here is a property the system actually guarantees (and the test suite checks).
const STATS = [
  { icon: '*', target: 1, suffix: '', decimals: 0, label: 'Owner per item, atomically' },
  { icon: '%', target: 100, suffix: '%', decimals: 0, label: 'Changes in the audit trail' },
  { icon: '<', target: 0, suffix: '', decimals: 0, label: 'Lost updates' },
  { icon: '#', target: 57, suffix: '', decimals: 0, label: 'Automated safety tests' },
];

/** Shared full-bleed video backdrop + header used by the landing and sign-in pages. */
export function LandingShell({ active, dim, children }: { active?: string; dim?: boolean; children: ReactNode }) {
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    document.body.classList.toggle('menu-open', menuOpen);
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setMenuOpen(false);
    const onResize = () => window.innerWidth > 720 && setMenuOpen(false);
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onResize);
      document.body.classList.remove('menu-open');
    };
  }, [menuOpen]);

  return (
    <div className={`lp${dim ? ' dim' : ''}`}>
      <div className="bg" aria-hidden>
        <video className="bg-video" autoPlay muted loop playsInline>
          <source src={BG_VIDEO} type="video/mp4" />
        </video>
      </div>
      <div className="page">
        <header className="header">
          <Link to="/" className="logo" aria-label="OpsDesk home">
            <img src="/assets/logo.svg" alt="" width={52} height={52} />
          </Link>
          <nav className="nav" aria-label="Primary">
            {NAV.map((n) => (
              <Link
                key={n.label}
                to={n.to}
                className={active === n.label ? 'active' : ''}
                aria-current={active === n.label ? 'page' : undefined}
              >
                {n.label}
              </Link>
            ))}
          </nav>
          <Link to="/login" className="sign-in">
            Sign in
          </Link>
          <button
            className="burger"
            aria-label={menuOpen ? 'Close menu' : 'Open menu'}
            aria-expanded={menuOpen}
            aria-controls="mobile-menu"
            onClick={() => setMenuOpen((o) => !o)}
          >
            <span className="bars" aria-hidden>
              <i />
              <i />
              <i />
            </span>
          </button>
        </header>

        <div className="menu-overlay" hidden={!menuOpen} onClick={() => setMenuOpen(false)} />
        <nav id="mobile-menu" className="mobile-menu" hidden={!menuOpen} aria-label="Mobile">
          {NAV.map((n, i) => (
            <Link
              key={n.label}
              to={n.to}
              className={`link ${active === n.label ? 'active' : ''}`}
              style={{ animationDelay: `${0.06 + i * 0.05}s` }}
              onClick={() => setMenuOpen(false)}
            >
              {n.label}
            </Link>
          ))}
          <Link to="/login" className="sign-in" style={{ animationDelay: '0.3s' }} onClick={() => setMenuOpen(false)}>
            Sign in
          </Link>
        </nav>

        {children}
      </div>
    </div>
  );
}

function CountUp({
  target,
  suffix,
  decimals,
  index,
}: {
  target: number;
  suffix: string;
  decimals: number;
  index: number;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const [value, setValue] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setValue(target);
      return;
    }
    let raf = 0;
    let timer: ReturnType<typeof setTimeout>;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        observer.disconnect(); // count once
        const duration = 1500 + index * 80;
        timer = setTimeout(
          () => {
            const start = performance.now();
            const tick = (now: number) => {
              const t = Math.min(1, (now - start) / duration);
              const eased = 1 - Math.pow(1 - t, 3); // easeOutCubic
              setValue(target * eased);
              if (t < 1) raf = requestAnimationFrame(tick);
            };
            raf = requestAnimationFrame(tick);
          },
          480 + index * 90,
        );
      },
      { threshold: 0.25 },
    );
    observer.observe(el);
    return () => {
      observer.disconnect();
      clearTimeout(timer);
      cancelAnimationFrame(raf);
    };
  }, [target, index]);

  return (
    <span ref={ref} className="stat-value">
      {value.toFixed(decimals)}
      {suffix}
    </span>
  );
}

export function LandingPage() {
  useEffect(() => {
    document.title = 'OpsDesk — Operations Under Control';
    return () => {
      document.title = 'OpsDesk';
    };
  }, []);

  return (
    <LandingShell active="Home">
      <main className="hero">
        <div className="trust anim" style={{ ['--d' as string]: '0.05s' }}>
          <span className="trust-avatar a1" title="Payments">
            <span className="inner">
              <i className="fa-solid fa-credit-card" aria-hidden />
            </span>
          </span>
          <span className="trust-avatar a2" title="Engineering">
            <span className="inner">
              <i className="fa-solid fa-code" aria-hidden />
            </span>
          </span>
          <span className="trust-avatar a3" title="Compliance">
            <span className="inner">
              <i className="fa-solid fa-shield-halved" aria-hidden />
            </span>
          </span>
          <span className="trust-pill">Built for Payments, Engineering &amp; Ops</span>
        </div>

        <h1 className="headline anim">
          <span>Operations,</span>
          <span>Under Control</span>
        </h1>

        <p className="subhead anim" style={{ ['--d' as string]: '0.28s' }}>
          Create, claim, approve and resolve operational work in one place — with clear ownership, a complete history
          and live updates when teammates act at the same time.
        </p>

        <Link to="/login" className="cta anim" style={{ ['--d' as string]: '0.4s' }}>
          Get Started
        </Link>
      </main>

      <ul className="stats" aria-label="Guarantees">
        {STATS.map((s, i) => (
          <li key={s.label} className="stat anim" style={{ ['--d' as string]: `${0.5 + i * 0.08}s` }}>
            <span className="stat-icon" aria-hidden>
              {s.icon}
            </span>
            <CountUp target={s.target} suffix={s.suffix} decimals={s.decimals} index={i} />
            <span className="stat-label">{s.label}</span>
          </li>
        ))}
      </ul>
    </LandingShell>
  );
}
