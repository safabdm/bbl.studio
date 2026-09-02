import { BblsMark } from '@/components/bbls-mark';
import { EMAIL_HREF, PHONE, PHONE_HREF, STUDIO_NAME } from '@/lib/site';
import { useEffect, useState } from 'react';
import { Link, NavLink } from 'react-router-dom';

const VIDEO = 'https://d8j0ntlcm91z4.cloudfront.net/user_38xzZboKViGWJOttwIXH07lWA1P/hf_20260729_102822_0e6c87e8-c141-4744-bf32-ad30db296371.mp4';

function ScrollVideo() {
  const [ready, setReady] = useState(false);
  const [reduceMotion, setReduceMotion] = useState(false);

  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const sync = () => setReduceMotion(media.matches);
    sync();
    media.addEventListener('change', sync);
    return () => media.removeEventListener('change', sync);
  }, []);

  return (
    <div className="video-layer" aria-hidden="true">
      <div className="video-fallback" />
      {!reduceMotion && (
        <video muted playsInline preload="metadata" src={VIDEO} onLoadedData={() => setReady(true)} className={ready ? 'ready' : ''} />
      )}
      <div className="video-shade" />
    </div>
  );
}

const links = [
  { to: '/orange-county-web-design', label: 'Services' },
  { to: '/work', label: 'Work' },
  { to: '/about', label: 'About' },
  { to: '/contact', label: 'Contact' },
];

export function SiteFrame({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);

  return (
    <main>
      <a className="skip-link" href="#content">Skip to content</a>
      <ScrollVideo />
      <div className="site-layer">
        <nav className="glass-nav" aria-label="Primary">
          <Link to="/" className="brand" onClick={() => setOpen(false)}><BblsMark size={26} /> bbls</Link>
          <div className={`nav-links${open ? ' is-open' : ''}`}>
            {links.map((link) => (
              <NavLink key={link.to} to={link.to} onClick={() => setOpen(false)}>
                {link.label}
              </NavLink>
            ))}
          </div>
          <div className="nav-actions">
            <button type="button" className="nav-menu" aria-expanded={open} aria-controls="mobile-nav" onClick={() => setOpen((value) => !value)}>
              {open ? 'Close' : 'Menu'}
            </button>
            <a href={PHONE_HREF} className="nav-cta" aria-label={`Call BBLS at ${PHONE}`}>Call {PHONE}</a>
          </div>
        </nav>
        <div id="content">{children}</div>
        <footer className="site-footer">
          <Link to="/" className="footer-brand"><BblsMark size={20} /> bbls</Link>
          <p>{STUDIO_NAME}</p>
          <div className="footer-contacts">
            <Link to="/orange-county-web-design">Services</Link>
            <Link to="/work">Work</Link>
            <Link to="/about">About</Link>
            <Link to="/contact">Contact</Link>
            <a href={EMAIL_HREF}>{EMAIL_HREF.replace('mailto:', '')}</a>
            <a href={PHONE_HREF} className="footer-phone">{PHONE}</a>
          </div>
        </footer>
      </div>
    </main>
  );
}
