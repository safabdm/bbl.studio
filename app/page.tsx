'use client';

import { BblsMark } from '@/components/bbls-mark';
import { BRAND_ADDON, PRICE_DISCLAIMER, PUBLIC_PROJECT_OFFERS } from '@/lib/offers';
import {
  CTA_PRIMARY,
  CTA_SECONDARY,
  POSITIONING,
  SERVICE_INTRO,
  SUBHEAD,
} from '@/lib/copy';
import { ArrowUpRight, Check, ChevronRight } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

const VIDEO = 'https://d8j0ntlcm91z4.cloudfront.net/user_38xzZboKViGWJOttwIXH07lWA1P/hf_20260729_102822_0e6c87e8-c141-4744-bf32-ad30db296371.mp4';
const EMAIL_HREF = 'mailto:hello@bbls.studio';
const EMAIL_LABEL = 'hello@bbls.studio';
const PHONE_HREF = 'tel:+19495242324';
const PHONE_LABEL = '(949) 524-2324';
const STUDIO_LINE = 'BBLS Boutique Brand & Launch Studio';

const projects = [
  {
    number: '01',
    name: 'Raysan IP',
    category: 'Strategy, Brand, Website',
    href: 'https://raysanip.com/',
    image: '/work/raysanip.webp',
    alt: 'Raysan IP website homepage',
    description: 'Brand and website for a global intellectual property information platform.',
  },
  {
    number: '02',
    name: '7 Stud Farm',
    category: 'Brand Direction, Website',
    href: 'https://7studfarm.com/',
    image: '/work/7studfarm.webp',
    alt: '7 Stud Farm website homepage',
    description: 'Brand direction and website for an international sport horse breeding program.',
  },
  {
    number: '03',
    name: 'IP Law Nerds',
    category: 'Brand Expression, Website',
    href: 'https://www.iplawnerds.com/',
    image: '/work/iplawnerds.webp',
    alt: 'IP Law Nerds website homepage',
    description: 'Brand expression and website for an approachable intellectual property practice.',
  },
] as const;

function prefersReducedMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function ScrollVideo() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [ready, setReady] = useState(false);
  const [reduceMotion, setReduceMotion] = useState(false);

  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const sync = () => setReduceMotion(media.matches);
    sync();
    media.addEventListener('change', sync);
    return () => media.removeEventListener('change', sync);
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || reduceMotion) return;
    let frame = 0;
    let smooth = 0;
    const tick = () => {
      const max = Math.max(1, document.documentElement.scrollHeight - innerHeight);
      const target = Math.min(1, Math.max(0, scrollY / max));
      smooth += (target - smooth) * 0.12;
      const nextTime = smooth * Math.max(0, video.duration - 0.05);
      if (Number.isFinite(video.duration) && Math.abs(video.currentTime - nextTime) > 0.04) {
        video.currentTime = nextTime;
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [reduceMotion]);

  return (
    <div className="video-layer" aria-hidden="true">
      <div className="video-fallback" />
      {!reduceMotion && (
        <video
          ref={videoRef}
          muted
          playsInline
          preload="auto"
          src={VIDEO}
          onLoadedData={() => setReady(true)}
          className={ready ? 'ready' : ''}
        />
      )}
      <div className="video-shade" />
    </div>
  );
}

export default function Home() {
  useEffect(() => {
    const elements = [...document.querySelectorAll<HTMLElement>('[data-reveal]')];
    if (prefersReducedMotion()) {
      elements.forEach((element) => element.classList.add('is-visible'));
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible');
          observer.unobserve(entry.target);
        }
      });
    }, { threshold: 0.15 });
    elements.forEach((element) => observer.observe(element));
    return () => observer.disconnect();
  }, []);

  return (
    <main>
      <a className="skip-link" href="#top">Skip to content</a>
      <ScrollVideo />
      <div className="site-layer">
        <nav className="glass-nav" aria-label="Primary">
          <a href="#top" className="brand"><BblsMark size={26} /> bbls</a>
          <div className="nav-links">
            <a href="#services">Services</a>
            <a href="#work">Work</a>
            <a href="#process">Process</a>
            <a href="#engagements">Engagements</a>
            <a href="#contact">Contact</a>
          </div>
          <div className="nav-actions">
            <a href={PHONE_HREF} className="nav-cta" aria-label={`Call BBLS at ${PHONE_LABEL}`}>Call {PHONE_LABEL}</a>
          </div>
        </nav>

        <section id="top" className="screen-section hero-screen">
          <div className="top-row">
            <p className="accent-badge">WEBSITE DESIGN STUDIO</p>
            <p className="intro-copy">A boutique website design studio serving Orange County.</p>
          </div>
          <div className="bottom-row">
            <div>
              <p className="accent-badge">{STUDIO_LINE}</p>
              <h1>Website design<br />in Orange County.</h1>
              <p className="hero-line">{SUBHEAD}</p>
              <div className="dual-cta">
                <a href="#contact" className="solid-pill">{CTA_PRIMARY} <ChevronRight size={14} aria-hidden="true" /></a>
                <a href="#work" className="glass-pill">{CTA_SECONDARY}</a>
              </div>
            </div>
          </div>
        </section>
        <div className="scroll-space" aria-hidden="true" />

        <section id="services" className="screen-section capability-screen" aria-labelledby="services-heading">
          <div className="top-row">
            <p className="accent-badge" data-reveal>BOUTIQUE BRAND & LAUNCH STUDIO</p>
            <p className="intro-copy" data-reveal>{SERVICE_INTRO}</p>
          </div>
          <div className="capability-bottom">
            <div className="capability-copy">
              <h2 id="services-heading" data-reveal>Distinctive by design.<br />Clear by intention.</h2>
              <p data-reveal>{POSITIONING}</p>
            </div>
            <div className="frost-panel">
              {[
                ['01', 'Strategy & Structure', 'Offer, audience, pages, and customer journey.', '#process'],
                ['02', 'Design & Build', 'Custom responsive design with purposeful content.', '#work'],
                ['03', 'Launch & Handoff', 'Testing, analytics, launch, and handoff.', '#process'],
              ].map(([n, title, text, href], i) => (
                <a className="frost-row" href={href} data-reveal style={{ transitionDelay: `${i * 110}ms` }} key={n} aria-label={`View ${title}`}>
                  <span>{n}</span>
                  <div>
                    <h3>{title}<ChevronRight size={16} aria-hidden="true" /></h3>
                    <p>{text}</p>
                  </div>
                </a>
              ))}
              <p className="addon-note" data-reveal>Optional Brand Identity is available when needed.</p>
            </div>
          </div>
        </section>

        <section id="work" className="screen-section work-screen" aria-labelledby="work-heading">
          <div className="top-row">
            <p className="accent-badge" data-reveal>SELECTED BRAND & WEBSITE WORK</p>
            <p className="intro-copy" data-reveal>Selected live websites.</p>
          </div>
          <div>
            <h2 id="work-heading" className="work-heading" data-reveal>Work you can visit.</h2>
            <ul className="work-list">
              {projects.map((project, i) => (
                <li key={project.name}>
                  <article className="work-card" data-reveal style={{ transitionDelay: `${i * 100}ms` }}>
                    <div className="work-media">
                      <img
                        src={project.image}
                        alt={project.alt}
                        width={1100}
                        height={688}
                        loading={i === 0 ? 'eager' : 'lazy'}
                        decoding="async"
                        fetchPriority={i === 0 ? 'high' : 'auto'}
                      />
                    </div>
                    <div className="work-copy">
                      <span className="work-number">{project.number}</span>
                      <p className="work-category">{project.category}</p>
                      <h3>{project.name}</h3>
                      <p>{project.description}</p>
                      <a
                        className="work-link"
                        href={project.href}
                        target="_blank"
                        rel="noopener noreferrer"
                        aria-label={`Visit live ${project.name} website`}
                      >
                        Visit live site <ArrowUpRight size={14} aria-hidden="true" />
                      </a>
                    </div>
                  </article>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section id="process" className="screen-section process-screen" aria-labelledby="process-heading">
          <div className="top-row">
            <p className="accent-badge" data-reveal>A FOCUSED LAUNCH PROCESS</p>
            <p className="intro-copy" data-reveal>From first conversation to launch.</p>
          </div>
          <div className="process-bottom">
            <div>
              <h2 id="process-heading" data-reveal>Discover. Define.<br />Design. Deliver.</h2>
              <div className="note-panel" data-reveal>
                <p className="note-kicker">Timing depends on readiness</p>
                <p>Focused launches may finish in 14 days. Broader projects typically take 2 to 4 weeks.</p>
              </div>
            </div>
            <ol className="step-panel">
              {[
                ['Discover', 'Offer, audience, and goals.'],
                ['Define', 'Scope, structure, and direction.'],
                ['Design', 'Pages, visuals, and customer flow.'],
                ['Deliver', 'Test, launch, and handoff.'],
              ].map(([title, text], i) => (
                <li data-reveal style={{ transitionDelay: `${i * 90}ms` }} key={title}>
                  <span>0{i + 1}</span>
                  <div>
                    <h3>{title}</h3>
                    <p>{text}</p>
                  </div>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section id="engagements" className="screen-section pricing-screen" aria-labelledby="engagements-heading">
          <div className="top-row">
            <p className="accent-badge" data-reveal>ENGAGEMENTS</p>
            <p className="intro-copy" data-reveal>Three focused website packages. Brand Identity is optional.</p>
          </div>
          <div>
            <h2 id="engagements-heading" data-reveal>Clear scope.<br />Clear starting prices.</h2>
            <div className="price-grid cols-3">
              {PUBLIC_PROJECT_OFFERS.map((item, i) => (
                <article className={`price-panel${item.featured ? ' signature' : ''}`} data-reveal style={{ transitionDelay: `${i * 100}ms` }} key={item.name}>
                  <div>
                    <small>{item.badge || item.number}</small>
                    <h3>{item.name}</h3>
                    <strong>{item.label}</strong>
                    <p className="price-lede">{item.lede}</p>
                  </div>
                  <ul>
                    {item.features.map((feature) => (
                      <li key={feature}><Check size={14} aria-hidden="true" />{feature}</li>
                    ))}
                  </ul>
                  <a href="#contact" aria-label={`Start a ${item.name} project`}>{CTA_PRIMARY}<ArrowUpRight size={14} aria-hidden="true" /></a>
                </article>
              ))}
            </div>
            <p className="addon-note pricing-addon" data-reveal>
              <strong>Brand Identity add on. {BRAND_ADDON.label}.</strong> {BRAND_ADDON.lede}
            </p>
            <p className="pricing-note" data-reveal>{PRICE_DISCLAIMER}</p>
          </div>
        </section>

        <section id="contact" className="screen-section final-screen" aria-labelledby="contact-heading">
          <div className="top-row">
            <p className="accent-badge" data-reveal>START A PROJECT</p>
            <p className="intro-copy" data-reveal>Let’s begin.</p>
          </div>
          <div className="final-bottom">
            <div className="capability-copy">
              <h2 id="contact-heading" data-reveal>Ready to build a more distinctive business?</h2>
              <p data-reveal>Share your offer, page count, and launch goal.</p>
              <div className="contact-lines" data-reveal>
                <a href={EMAIL_HREF}>{EMAIL_LABEL}</a>
                <a href={PHONE_HREF}>{PHONE_LABEL}</a>
              </div>
              <div className="dual-cta" data-reveal>
                <a href={EMAIL_HREF} className="solid-pill" aria-label={`Email BBLS at ${EMAIL_LABEL}`}>{CTA_PRIMARY}</a>
                <a href={PHONE_HREF} className="glass-pill" aria-label={`Call BBLS at ${PHONE_LABEL}`}>Call BBLS</a>
              </div>
            </div>
          </div>
          <footer>
            <a href="#top" className="footer-brand"><BblsMark size={20} /> bbls</a>
            <p>BBLS Boutique Brand & Launch Studio</p>
            <div className="footer-contacts">
              <a href={PHONE_HREF} className="footer-phone">{PHONE_LABEL}</a>
            </div>
          </footer>
        </section>
      </div>
    </main>
  );
}
