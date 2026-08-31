'use client';

import { ArrowRight, ArrowUpRight, Check, ChevronRight, MessageCircle, Orbit, Phone, Send, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

const VIDEO = 'https://d8j0ntlcm91z4.cloudfront.net/user_38xzZboKViGWJOttwIXH07lWA1P/hf_20260729_102822_0e6c87e8-c141-4744-bf32-ad30db296371.mp4';

const quickQuestions = ['What can BBLS build?', 'How does the 14-day launch work?', 'Which package fits me?'];

function answerLaunchQuestion(question: string) {
  const q = question.toLowerCase();
  if (q.includes('price') || q.includes('cost') || q.includes('package') || q.includes('how much')) return 'Starter begins at $1,500, Growth at $3,500, and Premium at $6,500+. Ongoing support is $300–$750 per month. Final pricing depends on scope; filing fees and third-party costs are separate.';
  if (q.includes('14') || q.includes('long') || q.includes('time') || q.includes('process')) return 'The launch follows four focused stages: Discover, Build, Launch, and Grow. The core launch is designed for 14 days once scope, content, and required approvals are ready.';
  if (q.includes('llc') || q.includes('ein') || q.includes('legal') || q.includes('setup')) return 'BBLS supports LLC and EIN setup, core contracts, and essential business foundations. Legal and filing needs are confirmed during discovery, and government fees are billed separately.';
  if (q.includes('website') || q.includes('brand') || q.includes('design')) return 'BBLS can create your brand direction, customer experience, conversion-focused website, launch copy, payment or booking setup, and the systems needed for day one.';
  if (q.includes('orange') || q.includes('oc') || q.includes('location')) return 'BBLS is positioned as a Boutique Business Launch Studio serving Orange County founders, with a streamlined process that can also support remote collaboration.';
  return 'BBLS helps founders move from idea to a launch-ready business through setup, brand and experience design, a premium website, and launch systems. Ask me about pricing, timing, LLC/EIN support, branding, or websites.';
}

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
  const [chatOpen, setChatOpen] = useState(false);
  const [question, setQuestion] = useState('');
  const [messages, setMessages] = useState<{role:'assistant'|'user';text:string}[]>([{ role:'assistant', text:'Hi — I’m the BBLS Launch Guide. What would you like to know about launching your business?' }]);
  const askQuestion = (text: string) => {
    const clean = text.trim();
    if (!clean) return;
    setMessages((current) => [...current, { role:'user', text:clean }, { role:'assistant', text:answerLaunchQuestion(clean) }]);
    setQuestion('');
  };
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
        <a href="#top" className="brand" aria-label="BBLS — Business Launch Studio, Orange County"><span className="brand-mark"><Orbit size={22} strokeWidth={2.35} /></span><span className="brand-lockup"><strong>BBLS</strong><small>BUSINESS LAUNCH STUDIO · OC</small></span></a>
        <div className="nav-links"><a href="#services">Services</a><a href="#process">Process</a><a href="#pricing">Pricing</a><a href="#contact">Contact</a></div>
        <a href="tel:+19495242324" className="nav-cta" aria-label="Call BBLS at 949 524 2324"><Phone size={14}/> (949) 524-2324</a>
      </nav>
      {chatOpen && <div className="chat-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setChatOpen(false); }}><section className="chat-panel" role="dialog" aria-modal="true" aria-labelledby="chat-title"><header><div><small>BUSINESS LAUNCH STUDIO · OC</small><h2 id="chat-title">Ask BBLS AI</h2></div><button type="button" onClick={() => setChatOpen(false)} aria-label="Close BBLS AI"><X size={19}/></button></header><div className="chat-messages" aria-live="polite">{messages.map((message,index)=><p className={message.role} key={`${message.role}-${index}`}>{message.text}</p>)}</div><div className="quick-questions">{quickQuestions.map((item)=><button type="button" key={item} onClick={() => askQuestion(item)}>{item}</button>)}</div><form onSubmit={(event) => { event.preventDefault(); askQuestion(question); }}><label htmlFor="launch-question">Ask about your launch</label><div><input id="launch-question" value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="Pricing, timing, LLC, website…" autoComplete="off"/><button type="submit" aria-label="Send question"><Send size={17}/></button></div></form><div className="chat-note">Answers use the current BBLS service and pricing information.</div></section></div>}
      <section id="top" className="screen-section hero-screen">
        <div className="top-row">
          <div className="service-list" data-reveal><span>/ BUSINESS SETUP</span><span>/ BRAND & EXPERIENCE</span><span>/ WEBSITE & LAUNCH SYSTEMS</span></div>
          <p className="intro-copy" data-reveal>We turn founder ideas into fully designed, revenue-ready businesses — with strategy, systems, and taste.</p>
        </div>
        <div className="bottom-row">
          <div data-reveal><div className="accent-badge">LAUNCH-READY IN 14 DAYS</div><h1>Clear. Complete.<br />Ready to launch.</h1></div>
          <div className="contact-card" data-reveal><img className="ai-portrait" src="/bbls-ai-concierge.png" alt="Abstract BBLS AI concierge"/><div><strong>Meet your launch guide.</strong><small>BBLS AI · AVAILABLE NOW</small><button type="button" onClick={() => setChatOpen(true)}>Ask a question <ArrowUpRight size={14} /></button></div></div>
        </div>
      </section>
      <div className="scroll-space" aria-hidden="true" />

      <section id="services" className="screen-section capability-screen">
        <div className="top-row"><div className="accent-badge" data-reveal>EVERYTHING BETWEEN IDEA & INCOME</div><p className="intro-copy" data-reveal>We don’t just file paperwork. We build the brand, experience, website, and systems that make the business ready to earn.</p></div>
        <div className="capability-bottom">
          <div className="capability-copy"><h2 data-reveal>Built beautifully.<br />Built to work.</h2><p data-reveal>One studio, one focused process, one launch-ready result. No disconnected vendors and no months lost coordinating the basics.</p><div className="dual-cta" data-reveal><a href="tel:+19495242324" className="solid-pill">Start your launch <ChevronRight size={14} /></a><a href="#process" className="glass-pill">See the process</a></div></div>
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
          {[['Starter','$1,500',['LLC + EIN filing support','Brand direction + mini identity','Conversion-focused landing page']],['Growth','$3,500',['Up to 5-page custom website','Core contracts + launch copy','Payment or booking setup']],['Premium','$6,500+',['Full brand identity system','UX strategy + custom website','Complete launch kit + systems']]].map(([name,price,features],i)=><article className={`price-panel ${i===1?'selected':''}`} data-reveal style={{transitionDelay:`${i*100}ms`}} key={name as string}><div><small>{i===1?'MOST SELECTED':`0${i+1}`}</small><h3>{name as string}</h3><strong>{price as string}</strong></div><ul>{(features as string[]).map(f=><li key={f}><Check size={14}/>{f}</li>)}</ul><a href="tel:+19495242324" aria-label={`Call BBLS about the ${name as string} package`}>Choose {name as string}<ArrowUpRight size={14}/></a></article>)}
        </div><div className="retainer-line" data-reveal><span>ONGOING SUPPORT & OPTIMIZATION</span><strong>$300–$750 / month</strong></div><p className="pricing-note" data-reveal>State filing fees, platform subscriptions, premium fonts, stock assets, and other third-party costs are billed separately. Final scope and price are confirmed before work begins.</p></div>
      </section>

      <section id="contact" className="screen-section final-screen">
        <div className="top-row"><div className="accent-badge" data-reveal>WHY BBLS</div><p className="intro-copy" data-reveal>Design-first. Done for you. Built in 14 days. Premium by default.</p></div>
        <div className="final-bottom"><div><h2 data-reveal>We don’t shape bodies.<br />We build businesses.</h2><p data-reveal>Bring the idea. We’ll build the business around it.</p></div><a href="tel:+19495242324" className="launch-disc" data-reveal aria-label="Call BBLS at 949 524 2324 to start"><span className="launch-copy"><small>CALL TO START</small><strong>(949) 524-2324</strong></span><ArrowUpRight size={22}/></a></div>
        <footer><a href="#top" className="footer-brand"><span className="footer-mark"><Orbit size={17} strokeWidth={2.3}/></span><strong>BBLS</strong></a><p>Business Launch Studio · Orange County</p><a href="tel:+19495242324" className="footer-phone">+1 (949) 524-2324</a></footer>
      </section>
    </div>
  </main>;
}
