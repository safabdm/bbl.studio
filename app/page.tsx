'use client';

import { ArrowRight, ArrowUpRight, Check, ChevronRight, Hexagon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

const VIDEO = 'https://d8j0ntlcm91z4.cloudfront.net/user_38xzZboKViGWJOttwIXH07lWA1P/hf_20260729_102822_0e6c87e8-c141-4744-bf32-ad30db296371.mp4';

const PROJECTS = [
  {
    number: '01',
    name: 'Raysan IP',
    category: 'Strategy · Brand · Website',
    description: 'A clear, contemporary digital presence for a global intellectual property information platform.',
    image: '/work/raysanip-portfolio.jpg',
    href: 'https://raysanip.com/',
  },
  {
    number: '02',
    name: '7 Stud Farm',
    category: 'Brand Direction · Website',
    description: 'A cinematic web experience for an international sport horse breeding and development brand.',
    image: '/work/7studfarm-portfolio.jpg',
    href: 'https://7studfarm.com/',
  },
  {
    number: '03',
    name: 'IP Law Nerds',
    category: 'Brand Expression · Website',
    description: 'A confident, approachable website that makes complex intellectual property topics easier to explore.',
    image: '/work/iplawnerds-portfolio.jpg',
    href: 'https://www.iplawnerds.com/',
  },
] as const;

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
        <div className="nav-links"><a href="#services">Services</a><a href="#work">Work</a><a href="#process">Process</a><a href="#contact">Contact</a></div>
        <a href="tel:+19495242324" className="nav-cta" aria-label="Call BBLS at 949 524 2324">Call (949) 524-2324</a>
      </nav>
      <section id="top" className="screen-section hero-screen">
        <div className="top-row">
          <div className="service-list" data-reveal><span>/ BRAND IDENTITY</span><span>/ WEBSITE DESIGN</span><span>/ RESPONSIVE DEVELOPMENT</span></div>
          <p className="intro-copy" data-reveal>BBLS creates distinctive brands and high-impact websites for founder-led businesses ready to launch, grow, or begin again.</p>
        </div>
        <div className="bottom-row">
          <div data-reveal><div className="accent-badge">BOUTIQUE BRAND &amp; WEBSITE STUDIO</div><h1>Your brand,<br />beautifully built.</h1></div>
          <div className="contact-card" data-reveal><div className="contact-orbit"><span /></div><div><strong>Designed to stand out.</strong><small>BRAND &amp; WEBSITE STUDIO · LA</small><a href="tel:+19495242324">Start a project <ArrowUpRight size={14} /></a></div></div>
        </div>
      </section>
      <div className="scroll-space" aria-hidden="true" />

      <section id="services" className="screen-section capability-screen">
        <div className="top-row"><div className="accent-badge" data-reveal>BRAND + WEBSITE, BUILT AS ONE</div><p className="intro-copy" data-reveal>A clear visual identity and custom website, shaped together so every touchpoint feels unmistakably yours.</p></div>
        <div className="capability-bottom">
          <div className="capability-copy"><h2 data-reveal>Distinctive by design.<br />Clear by intention.</h2><p data-reveal>One studio connects the strategy, visual direction, and responsive build so your brand arrives in the world as one confident experience.</p><div className="dual-cta" data-reveal><a href="tel:+19495242324" className="solid-pill">Start a project <ChevronRight size={14} /></a><a href="#work" className="glass-pill">See selected work</a></div></div>
          <div className="frost-panel">
            {[['01','Brand identity','Visual direction, logo, color, typography, and a practical identity system.'],['02','Website design','Strategy, page planning, and a custom responsive experience shaped around your audience.'],['03','Brand + website launch','A cohesive identity and website designed, developed, and prepared for launch together.']].map(([n,title,text],i)=><article className="frost-row" data-reveal style={{transitionDelay:`${i*110}ms`}} key={n}><span>{n}</span><div><h3>{title}<ChevronRight size={16}/></h3><p>{text}</p></div></article>)}
          </div>
        </div>
      </section>

      <section id="work" className="work-section">
        <div className="work-heading top-row">
          <div><div className="accent-badge" data-reveal>SELECTED BRAND &amp; WEBSITE WORK</div><h2 data-reveal>Made to be<br />remembered.</h2></div>
          <p className="intro-copy" data-reveal>Live work shaped for clarity, credibility, and a distinctive first impression.</p>
        </div>
        <div className="work-grid">
          {PROJECTS.map((project, index) => (
            <article className="work-card" data-reveal style={{transitionDelay:`${index*100}ms`}} key={project.name}>
              <a href={project.href} target="_blank" rel="noreferrer" className="work-image" aria-label={`Visit ${project.name} website`}>
                <img src={project.image} alt={`${project.name} website project`} />
                <span>Visit live site <ArrowUpRight size={15}/></span>
              </a>
              <div className="work-meta"><small>{project.number} · {project.category}</small><h3>{project.name}</h3><p>{project.description}</p></div>
            </article>
          ))}
        </div>
      </section>

      <section id="process" className="screen-section process-screen">
        <div className="top-row"><div className="accent-badge" data-reveal>A FOCUSED CREATIVE PROCESS</div><p className="intro-copy" data-reveal>Four clear stages keep decisions moving and connect the brand directly to the final website.</p></div>
        <div className="process-bottom">
          <div><h2 data-reveal>Discover. Define.<br />Design. Deliver.</h2><div className="process-note" data-reveal><small>TYPICAL ENGAGEMENT</small><strong>Focused 2–4 week creative sprints</strong><p>Timing is confirmed around scope, content readiness, and feedback availability.</p></div></div>
          <ol className="step-panel">{[['Discover','Clarify the audience, offer, goals, and visual opportunity.'],['Define','Set the brand direction, page structure, and creative system.'],['Design','Create the identity and responsive website as one experience.'],['Deliver','Refine, develop, prepare assets, and support the launch.']].map(([title,text],i)=><li data-reveal style={{transitionDelay:`${i*90}ms`}} key={title}><span>0{i+1}</span><div><h3>{title}</h3><p>{text}</p></div><ArrowRight size={17}/></li>)}</ol>
        </div>
      </section>

      <section id="pricing" className="screen-section pricing-screen">
        <div className="top-row"><div className="accent-badge" data-reveal>WAYS TO WORK TOGETHER</div><p className="intro-copy" data-reveal>Choose the creative scope that matches where your business is today and where it needs to go next.</p></div>
        <div><h2 data-reveal>Choose your<br />starting point.</h2><div className="price-grid">
          {[['Brand Identity','Custom scope',['Visual direction and identity','Color and typography system','Practical brand guidelines']],['Website Design','Custom scope',['Strategy and page planning','Custom responsive design','Development and launch support']],['Brand + Website','Custom scope',['Complete visual identity','Custom responsive website','Cohesive launch-ready system']]].map(([name,price,features],i)=><article className={`price-panel ${i===2?'selected':''}`} data-reveal style={{transitionDelay:`${i*100}ms`}} key={name as string}><div><small>{i===2?'SIGNATURE ENGAGEMENT':`0${i+1}`}</small><h3>{name as string}</h3><strong>{price as string}</strong></div><ul>{(features as string[]).map(f=><li key={f}><Check size={14}/>{f}</li>)}</ul><a href="tel:+19495242324" aria-label={`Call BBLS about ${name as string}`}>Discuss your project<ArrowUpRight size={14}/></a></article>)}
        </div><div className="retainer-line" data-reveal><span>ONGOING WEBSITE CARE &amp; CREATIVE SUPPORT</span><strong>Available after launch</strong></div><p className="pricing-note" data-reveal>Every engagement is scoped around the number of pages, content readiness, functionality, and creative depth. Platform subscriptions, premium assets, and third-party services are quoted separately when needed.</p></div>
      </section>

      <section id="contact" className="screen-section final-screen">
        <div className="top-row"><div className="accent-badge" data-reveal>START A PROJECT</div><p className="intro-copy" data-reveal>For founder-led businesses that want more than a template and are ready for a distinct, cohesive presence.</p></div>
        <div className="final-bottom"><div><h2 data-reveal>Ready to make your<br />brand unforgettable?</h2><p data-reveal>Tell us what you are building and where you want it to go.<br/><a className="phone-link" href="tel:+19495242324">+1 (949) 524-2324</a></p></div><a href="tel:+19495242324" className="launch-disc" data-reveal aria-label="Call BBLS to start a brand or website project"><span>START A<br/>PROJECT</span><ArrowUpRight size={24}/></a></div>
        <footer><a href="#top" className="footer-brand"><Hexagon size={18}/> bbls</a><p>Boutique Brand &amp; Website Studio · Los Angeles</p><a href="tel:+19495242324" className="footer-phone">+1 (949) 524-2324</a></footer>
      </section>
    </div>
  </main>;
}
