const offers = {
  landing: { name: 'Simple Landing Page', price: '$3,000', service: 'Simple Landing Page', detail: 'One focused page for one offer, with responsive design, a lead form, and launch setup.' },
  business: { name: 'Business Website', price: '$5,500', service: 'Business Website', detail: 'Up to five custom pages with strategy, navigation, forms, and launch setup.' },
  commercial: { name: 'Commercial Website', price: '$8,500', service: 'Commercial Website', detail: 'Six to ten custom pages with stronger content structure, UX, and conversion tracking.' },
};
const chooser = ['One page', '2–5 pages', '6–10 pages', 'Custom features'];
function recommend(key) {
  const offer = offers[key];
  return { text: `${offer.name} starts at ${offer.price}. ${offer.detail} Final scope and price are confirmed by the studio.`, service: offer.service, action: 'Start a brief', choices: ['Add branding', 'What’s the process?'] };
}
export function guideReply(question, context = {}) {
  const q = String(question).toLowerCase().trim();
  if (/custom features|e.?commerce|online store|checkout|membership|multilingual|portal|integration|booking system|more than (?:10|ten)|1[1-9]\s*pages|[2-9]\d\s*pages/.test(q)) {
    return { text: 'That needs a custom scope. The studio will review the features, page count, and content before quoting. Tell us the key requirements in a short brief.', service: 'Not sure yet', action: 'Start a brief', choices: ['View pricing', 'Brand identity'] };
  }
  if (/brand|logo|identity|colour|color|typography/.test(q)) {
    return { text: 'Brand Identity starts at $3,500 and covers the logo system, color, typography, and visual direction. The studio will confirm the right scope for your business.', brand: true, action: 'Start a brief', choices: ['View pricing', 'Find my fit'] };
  }
  if (/\bai\b|artificial intelligence|prototype|prototyping/.test(q)) {
    return { text: 'Design Faster with AI is designer-led work supported by AI for exploration, iteration, prototyping, and production. Scope and pricing are agreed per project.', service: 'Design Faster with AI', action: 'Start a brief', choices: ['What’s the process?', 'View pricing'] };
  }
  if (/6\s*[–-]\s*10|six to ten|commercial|(?:[6-9]|10)\s*pages/.test(q)) return recommend('commercial');
  if (/2\s*[–-]\s*5|business website|full website|complete website|(?:[2-5]|two|three|four|five)\s*pages/.test(q)) return recommend('business');
  if (/one page|1 page|single page|landing page/.test(q)) return recommend('landing');
  if (/price|pricing|cost|budget|how much|rates/.test(q)) {
    return { text: 'Starting prices: Landing Page $3,000 · Business Website $5,500 · Commercial Website $8,500 · Brand Identity $3,500. Custom work is quoted after review; platform costs are separate.', choices: chooser, action: 'View packages', href: '#engagements' };
  }
  if (/choose|find my fit|recommend|which|help me|not sure|services|what do you offer/.test(q)) {
    return { text: 'How much does your website need to cover? Choose a page count, or tell me about the features you need.', choices: chooser };
  }
  if (/timeline|how long|deadline|when|fast/.test(q)) {
    return { text: 'Timing depends on the agreed scope, content, access, and approvals. Share your target date in the brief so the studio can confirm a realistic schedule.', action: 'Start a brief', choices: ['Find my fit', 'What’s the process?'] };
  }
  if (/process|how .*work|next step/.test(q)) {
    return { text: 'Discover → Define → Design & Build → Deliver. We agree the scope and direction, review the work together, then prepare the site for launch and handoff.', action: 'Start a brief', choices: ['Timeline', 'View pricing'] };
  }
  if (/seo|rank|google|traffic|sales|conversion/.test(q)) {
    return { text: 'Website projects include an SEO foundation and analytics. Content structure and clear next steps support inquiries; rankings and sales are not guaranteed.', action: 'Start a brief', choices: ['Find my fit', 'View pricing'] };
  }
  if (/work|portfolio|examples/.test(q)) {
    return { text: 'Explore Raysan IP, 7 Stud Farm, and IP Law Nerds in Selected Work. Each project links to the live website.', action: 'View work', href: '#work', choices: ['Find my fit', 'View pricing'] };
  }
  if (/call|email|contact|human|person|talk|start|brief/.test(q)) {
    return { text: 'You can prepare a project brief, email hello@bbl.studio, or call (949) 524-2324. The brief prepares an email draft; you decide when to send it.', action: 'Start a brief', choices: ['View pricing', 'Find my fit'] };
  }
  if (/where|location|orange county|irvine|newport|costa mesa|laguna|tustin/.test(q)) {
    return { text: 'Business Brand Lab serves businesses across Orange County, including Irvine, Newport Beach, Costa Mesa, Laguna Beach, and Tustin. Ask the studio about your project location.', action: 'Start a brief', choices: ['View pricing', 'View work'] };
  }
  return { text: 'I can guide you through BBL’s services, starting prices, and project process. For a specific request, share what you need in a brief and the studio will review it.', action: 'Start a brief', choices: ['Find my fit', 'View pricing', 'Brand identity'] };
}
