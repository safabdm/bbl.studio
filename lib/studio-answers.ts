import { CUSTOM_SCOPE, PROJECT_OFFERS } from './offers';

const EMAIL = 'hello@bbls.studio';
const PHONE = '(949) 524-2324';
const START = `Email ${EMAIL} or call ${PHONE} to start a project.`;

function normalize(text: string) {
  return text.toLowerCase().replace(/[^a-z0-9+.\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function close(text: string) {
  return text;
}

export function answerStudioQuestion(question: string, history: string[] = []) {
  const q = normalize(question);
  const prior = normalize(history.slice(-3).join(' '));
  const context = `${prior} ${q}`;

  if (!q) {
    return 'Tell me whether you need one focused page, a complete business presence, or a larger commercial website. I will recommend the closest starting scope.';
  }

  if (/llc|ein|filing|legal|tax|accounting|formation|retainer|website care|essential care|growth care|priority care|monthly support/.test(q)) {
    return 'BBLS specializes in website strategy, design, build, and launch, with Brand Identity available as an optional add on. Tell me what the website needs to accomplish and I will point you to the right scope.';
  }

  if (/^(hello|hi|hey)\b|good morning|good afternoon/.test(q)) {
    return 'Hello. I can help you choose between a Simple Landing Page, Business Website, or Commercial Website. What does your site need to do?';
  }

  if (/what is bbls|who is bbls|who are you|about|studio/.test(q) && !/website|package|price|cost/.test(q)) {
    return 'BBLS is a boutique website design studio serving Orange County businesses. We plan, design, build, and launch custom websites around a clear offer and customer journey.';
  }

  if (/landing|one page|single page|campaign/.test(q)) {
    return close(`Simple Landing Page is the right start when one offer needs a focused page. It starts at $3,000 and includes responsive custom design, CTA strategy, a lead form, basic on page SEO, analytics, launch support, and two revision rounds.`);
  }

  if (/brand identity|logo|branding|add-on|addon|add on|visual identity/.test(q)) {
    return close(`Brand Identity is an optional website add on starting at $3,500. It covers the logo system, color, typography, and visual direction when the website needs a stronger foundation.`);
  }

  if (/commercial website|six to ten|6 to 10|architecture|customer journey/.test(q) && !/landing/.test(q)) {
    return close(`Commercial Website starts at $8,500 for six to ten custom pages, stronger content architecture, conversion focused layouts, advanced forms or integrations, on page SEO, tracking, launch support, and three revision rounds.`);
  }

  if (/business website|five page|5 page|small business|complete site|full site/.test(q)) {
    return close(`Business Website starts at $5,500 for up to five custom pages. It includes responsive design, clear navigation, forms, basic on page SEO, analytics, launch support, and two revision rounds.`);
  }

  if (/which package|what do you offer|services|what can you|difference|compare|right for/.test(q)) {
    return close('Choose Simple Landing Page from $3,000 for one offer, Business Website from $5,500 for up to five pages, or Commercial Website from $8,500 for six to ten pages and more advanced journeys. Brand Identity is an optional add on from $3,500.');
  }

  if (/price|cost|pricing|rate|fee|budget|how much|estimate|quote|charg|package|plan/.test(q)) {
    return close('Starting prices are $3,000 for a Simple Landing Page, $5,500 for a Business Website, and $8,500 for a Commercial Website. Final pricing depends on page count, content, integrations, and timeline. Tell me the page count and main goal for a closer recommendation.');
  }

  if (/seo|google|search|found|rank|orange county/.test(q) && /seo|google|search|found|rank|visible|visibility/.test(q)) {
    return close('Every BBLS website includes an on page SEO foundation: page titles, headings, content structure, and analytics. Commercial Website also includes conversion tracking. Rankings are never guaranteed.');
  }

  if (/lead|inquir|convert|conversion|sales|customers|grow|growth|trust|credib/.test(q)) {
    return close('A BBLS site is planned around the offer and the next action, so visitors can understand the business, trust what they see, and know how to inquire. Lead volume and rankings are not guaranteed.');
  }

  if (/how long|timing|timeline|14 day|weeks|fast|quickly/.test(q)) {
    return close('A focused landing page can launch in about 14 days when the offer, content, and approvals are ready. A Business or Commercial Website typically takes two to four weeks. Larger or custom work is scheduled after the scope is confirmed. Ready materials are what keep the timeline real.');
  }

  if (/prepare|need from me|what should i|ready|kickoff|start a project|get started|begin/.test(q)) {
    return `To start, send the offer, audience, estimated page count, existing copy or photos, brand files, and any forms or tools the website should connect. ${START}`;
  }

  if (/process|how you work|discover|define|design|deliver/.test(q)) {
    return close('The process is Discover, Define, Design, and Deliver. BBLS clarifies the offer, confirms the scope and structure, designs and builds the pages, then launches and hands off the finished website.');
  }

  if (/work|portfolio|raysan|stud farm|iplaw|examples|case/.test(q)) {
    return close('You can review live work: Raysan IP, 7 Stud Farm, and IP Law Nerds. Those sites show the studio’s editorial direction. Open them from the Work section, then tell us what you are building.');
  }

  if (/why|different|boutique|template|agency/.test(q)) {
    return close('BBLS stays intentionally focused: direct collaboration, custom responsive design, premium visual direction, and a clearly defined website scope without unnecessary agency layers.');
  }

  if (/where|location|irvine|newport|costa mesa|laguna|tustin|los angeles|orange county|based|oc\b/.test(q)) {
    return close('BBLS serves businesses across Orange County, including Irvine, Newport Beach, Costa Mesa, Laguna Beach, and Tustin. Projects can be handled locally or remotely.');
  }

  if (/call|phone|number/.test(q)) {
    return `Call BBLS at ${PHONE}, or email ${EMAIL}. A short conversation about the offer and page count is enough to begin.`;
  }

  if (/custom|ecommerce|e-commerce|booking|membership|portal|multilingual/.test(context)) {
    return close(`${CUSTOM_SCOPE} For a standard site, start with Simple Landing Page, Business Website, or Commercial Website.`);
  }

  return close('Tell me what the business offers, how many pages you expect, and the main action visitors should take. I will recommend the closest website package.');
}

export const estimates = Object.fromEntries(PROJECT_OFFERS.map((offer) => [offer.id, offer.label]));
