'use client';

import { ArrowRight, ArrowUpRight, Check, ChevronRight, Hexagon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

const VIDEO = 'https://d8j0ntlcm91z4.cloudfront.net/user_38xzZboKViGWJOttwIXH07lWA1P/hf_20260729_102822_0e6c87e8-c141-4744-bf32-ad30db296371.mp4';

function ScrollVideo() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    let frame = 0, smooth = 0;
    const tick = () => {
      const max = Math.max(1, document.documentElement.scrollHeight - innerHeight);
      const target = Math.min(1, Math.max(0, scrollY / max));
      smooth += (target - smooth) * .12;
      if (Number.isFinite(video.duration) && Math.abs(video.currentTime - smooth * Math.max(0, video.duration - .05)) > .04) video.currentTime = smooth * Math.max(0, video.duration - .05);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, []);
  return <div className="video-layer" aria-hidden="true"><div className="video-fallback" /><video ref={videoRef} muted playsInline preload="auto" src={VIDEO} onLoadedData={() => setReady(true)} className={ready ? 'ready' : ''} /><div className="video-shade" /></div>;
}

export default function Home() {
  useEffect(() => {
    const elements = [...document.querySelectorAll<HTMLElement>('[data-reveal]')];
    const observer = new IntersectionObserver((entries) => entries.forEach((entry) => {
      if (entry.isIntersecting) { entry.target.classList.add('is-visible'); observer.unobserve(entry.target); }
    }), { threshold: .15 });
    elements.forEach((element) => observer.observe(element));
    return () => observer.disconnect();
  }, []);
  return <main>
    <ScrollVideo />
    <div className="site-layer">
      <nav className="glass-nav">
        <a href="#top" className="brand"><Hexagon size={24} strokeWidth={1.5} /> bbls</a>
        <div className="nav-links"><a href="#services">Services</a><a href="#process">Process</a><a href="#pricing">Pricing</a><a href="#contact">Contact</a></div>
        <a href="#contact" className="nav-cta">Start your launch</a>
      </nav>
      <section id="top" className="screen-section hero-screen">
        <div className="top-row">
          <div className="service-list" data-reveal><span>/ BUSINESS SETUP</span><span>/ BRAND & EXPERIENCE</span><span>/ WEBSITE & LAUNCH SYSTEMS</span></div>
          <p className="intro-copy" data-reveal>We turn founder ideas into fully designed, revenue-ready businesses — with strategy, systems, and taste.</p>
        </div>
        <div className="bottom-row">
          <div data-reveal><div className="accent-badge">LAUNCH-READY IN 14 DAYS</div><h1>Clear. Complete.<br />Ready to launch.</h1></div>
          <div className="contact-card" data-reveal><div className="contact-orbit"><span /></div><div><strong>Boutique, not basic.</strong><small>BUSINESS LAUNCH STUDIO · LA</small><a href="#contact">Book a launch call <ArrowUpRight size={14} /></a></div></div>
        </div>
      </section>
      <div className="scroll-space" aria-hidden="true" />

      <section id="services" className="screen-section capability-screen">
        <div className="top-row"><div className="accent-badge" data-reveal>EVERYTHING BETWEEN IDEA & INCOME</div><p className="intro-copy" data-reveal>We don’t just file paperwork. We build the brand, experience, website, and systems that make the business ready to earn.</p></div>
        <div className="capability-bottom">
          <div className="capability-copy"><h2 data-reveal>Built beautifully.<br />Built to work.</h2><p data-reveal>One studio, one focused process, one launch-ready result. No disconnected vendors and no months lost coordinating the basics.</p><div className="dual-cta" data-reveal><a href="#contact" className="solid-pill">Start your launch <ChevronRight size={14} /></a><a href="#process" className="glass-pill">See the process</a></div></div>
          <div className="frost-panel">
            {[['01','Business setup','LLC, EIN, contracts, and the foundations that make your company real.'],['02','Brand & experience','Direction, identity, and customer experience designed to feel distinctly yours.'],['03','Website & launch systems','A premium website, payments, booking, and a launch system ready for day one.']].map(([n,title,text],i)=><article className="frost-row" data-reveal style={{transitionDelay:`${i*110}ms`}} key={n}><span>{n}</span><div><h3>{title}<ChevronRight size={16}/></h3><p>{text}</p></div></article>)}
          </div>
        </div>
      </section>

      <section id="process" className="screen-section process-screen">
        <div className="top-row"><div className="accent-badge" data-reveal>A CLEAR 14-DAY PATH</div><p className="intro-copy" data-reveal>Four decisive stages replace the usual maze of meetings, handoffs, and unfinished details.</p></div>
        <div className="process-bottom">
          <div><h2 data-reveal>Discover. Build.<br />Launch. Grow.</h2><div className="quote-panel" data-reveal><p>“They simplified everything.”</p><p>“We launched in days, not months.”</p><p>“Finally, a team that understands product and brand.”</p></div></div>
          <ol className="step-panel">{[['Discover','Align the offer, audience, and ambition.'],['Build','Shape the business, brand, and experience.'],['Launch','Bring the website and revenue systems live.'],['Grow','Refine, support, and keep momentum.']].map(([title,text],i)=><li data-reveal style={{transitionDelay:`${i*90}ms`}} key={title}><span>0{i+1}</span><div><h3>{title}</h3><p>{text}</p></div><ArrowRight size={17}/></li>)}</ol>
        </div>
      </section>

      <section id="pricing" className="screen-section pricing-screen">
        <div className="top-row"><div className="accent-badge" data-reveal>LAUNCH PACKAGES</div><p className="intro-copy" data-reveal>Clear scope. Premium execution. Choose the right starting point for the business you’re ready to build.</p></div>
        <div><h2 data-reveal>Invest in a<br />real beginning.</h2><div className="price-grid">
          {[['Starter','$1,200',['LLC + EIN','Brand direction','Landing page']],['Growth','$2,800',['Full website','Contracts','Payment setup']],['Premium','$5,000+',['Full brand system','UX strategy','Custom site + launch kit']]].map(([name,price,features],i)=><article className={`price-panel ${i===1?'selected':''}`} data-reveal style={{transitionDelay:`${i*100}ms`}} key={name as string}><div><small>{i===1?'MOST SELECTED':`0${i+1}`}</small><h3>{name as string}</h3><strong>{price as string}</strong></div><ul>{(features as string[]).map(f=><li key={f}><Check size={14}/>{f}</li>)}</ul><a href="#contact">Choose {name as string}<ArrowUpRight size={14}/></a></article>)}
        </div><div className="retainer-line" data-reveal><span>ONGOING SUPPORT & UPDATES</span><strong>$150–$400 / month</strong></div></div>
      </section>

      <section id="contact" className="screen-section final-screen">
        <div className="top-row"><div className="accent-badge" data-reveal>WHY BBLS</div><p className="intro-copy" data-reveal>Design-first. Done for you. Built in 14 days. Premium by default.</p></div>
        <div className="final-bottom"><div><h2 data-reveal>We don’t shape bodies.<br />We build businesses.</h2><p data-reveal>Bring the idea. We’ll build the business around it.</p></div><a href="#top" className="launch-disc" data-reveal><span>BOOK A<br/>LAUNCH CALL</span><ArrowUpRight size={24}/></a></div>
        <footer><span><Hexagon size={18}/> bbls</span><p>Boutique Business Launch Studio · Los Angeles</p><small>© 2026 BBLS</small></footer>
      </section>
    </div>
  </main>;
}
