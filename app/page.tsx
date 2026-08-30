import { ArrowRight, ArrowUpRight, Check, Layers3, MoveUpRight, Sparkles } from 'lucide-react';

const services = [
  { number: '01', title: 'Business setup', text: 'LLC, EIN, contracts, and the essential foundations — handled with clarity.', detail: 'Structure · Protection · Readiness' },
  { number: '02', title: 'Brand & experience', text: 'A considered identity and customer experience designed to make your idea feel inevitable.', detail: 'Direction · Identity · UX' },
  { number: '03', title: 'Website & launch', text: 'A high-converting digital presence, connected payments, booking, and launch systems.', detail: 'Website · Systems · Launch' },
];
const plans = [
  { name: 'Starter', price: '$1,200', description: 'For a focused idea ready to become real.', features: ['LLC + EIN', 'Brand direction', 'Landing page'] },
  { name: 'Growth', price: '$2,800', description: 'For founders ready to launch with confidence.', features: ['Full website', 'Contracts', 'Payment setup'], featured: true },
  { name: 'Premium', price: '$5,000+', description: 'The complete, custom launch experience.', features: ['Full brand system', 'UX strategy', 'Custom site + launch kit'] },
];

export default function Home() {
  return <main className="min-h-screen overflow-hidden bg-background text-foreground">
    <nav className="relative z-20 mx-auto flex max-w-[1440px] items-center justify-between px-5 py-6 sm:px-10 lg:px-16">
      <a href="#top" className="text-sm font-black tracking-[-0.04em]">BBLS<span className="text-lime">.</span></a>
      <div className="hidden items-center gap-8 text-xs text-muted-foreground md:flex"><a href="#services" className="nav-link">Services</a><a href="#process" className="nav-link">Process</a><a href="#pricing" className="nav-link">Pricing</a></div>
      <a href="#contact" className="button button-small">Book a call <ArrowUpRight size={14} /></a>
    </nav>

    <section id="top" className="hero section-shell">
      <div className="hero-orbit" aria-hidden="true"><span /></div>
      <div className="relative z-10 max-w-[1020px]"><p className="eyebrow mb-8"><span /> Boutique Business Launch Studio · Los Angeles</p><h1 className="display-title">We build your<br />business<span className="text-lime">—</span><br /><em>not just your paperwork.</em></h1></div>
      <div className="hero-copy"><p className="text-balance text-lg leading-7 text-muted-foreground">From idea to income in 14 days. Fully designed. Fully ready.</p><div className="mt-8 flex flex-wrap gap-3"><a href="#contact" className="button">Start your launch <ArrowUpRight size={16} /></a><a href="#process" className="button button-ghost">See how it works</a></div></div>
    </section>

    <section className="proof-strip" aria-label="Client feedback">{['“They simplified everything.”', '“We launched in days, not months.”', '“Finally, a team that gets product and brand.”'].map((quote, i) => <p key={quote}><span>0{i + 1}</span>{quote}</p>)}</section>

    <section id="services" className="section-shell block-section">
      <div className="section-intro"><p className="eyebrow"><span /> What we build</p><h2>Everything between<br /><em>idea and income.</em></h2></div>
      <div className="services-grid">{services.map((service) => <article className="service-card" key={service.number}><div className="card-top"><span>{service.number}</span><MoveUpRight size={20} /></div><div><h3>{service.title}</h3><p>{service.text}</p></div><small>{service.detail}</small></article>)}</div>
    </section>

    <section id="process" className="process-section section-shell block-section">
      <div><p className="eyebrow"><span /> Four decisive moves</p><h2>14 days.<br /><em>One clear path.</em></h2><p className="section-copy">No handoffs into a void. No months of coordination. One studio takes your business from concept to a coherent, launch-ready system.</p></div>
      <ol className="process-list">{[['Discover','We align the offer, audience, and ambition.'],['Build','We shape the business, brand, and experience.'],['Launch','Your website and revenue systems go live.'],['Grow','We refine, support, and keep momentum.']].map(([title, text], i) => <li key={title}><span>0{i + 1}</span><h3>{title}</h3><p>{text}</p><ArrowRight size={18} /></li>)}</ol>
    </section>

    <section id="pricing" className="pricing-wrap"><div className="section-shell block-section">
      <div className="pricing-head"><div><p className="eyebrow"><span /> Launch packages</p><h2>Choose your<br /><em>starting point.</em></h2></div><p>Clear scope. Premium execution. A business that is ready to earn — not merely exist.</p></div>
      <div className="pricing-grid">{plans.map((plan) => <article className={`price-card ${plan.featured ? 'featured' : ''}`} key={plan.name}>{plan.featured && <span className="recommended">Most selected</span>}<p className="plan-name">{plan.name}</p><h3>{plan.price}</h3><p className="plan-description">{plan.description}</p><ul>{plan.features.map((feature) => <li key={feature}><Check size={15} />{feature}</li>)}</ul><a href="#contact" className={plan.featured ? 'button' : 'button button-ghost'}>Start with {plan.name}<ArrowUpRight size={15} /></a></article>)}</div>
      <div className="retainer"><div><Sparkles size={18} /><span>Ongoing momentum</span></div><p>Monthly support & updates</p><strong>$150–$400 <small>/mo</small></strong></div>
    </div></section>

    <section className="section-shell block-section why-section"><div className="why-mark" aria-hidden="true"><Layers3 /></div><div><p className="eyebrow"><span /> Why BBLS</p><h2>A launch studio,<br /><em>not another vendor.</em></h2></div><div className="why-grid">{[['Design-first','Every decision feels intentional, clear, and distinctly yours.'],['Done for you','Strategy and execution live under one roof.'],['Built in 14 days','A focused process designed around momentum.'],['Premium by default','No generic templates. No basic-business energy.']].map(([title,text], i) => <article key={title}><span>0{i+1}</span><h3>{title}</h3><p>{text}</p></article>)}</div></section>

    <section id="contact" className="cta-section section-shell"><div className="cta-glow" aria-hidden="true" /><p className="eyebrow"><span /> Your move</p><h2>Ready to launch<br /><em>your business?</em></h2><p>Bring the idea. We’ll build the business around it.</p><a href="#top" className="button button-large">Book a call <ArrowUpRight size={18} /></a></section>

    <footer className="footer section-shell"><a href="#top" className="footer-logo">BBLS<span>.</span></a><p>Boutique Business Launch Studio<br />Los Angeles, California</p><div><a href="#services">Services</a><a href="#pricing">Pricing</a><a href="#contact">Contact</a></div><small>© 2026 BBLS. Built for bold beginnings.</small></footer>
  </main>;
}
