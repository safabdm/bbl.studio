import { createHash } from 'node:crypto';
import { isPublicContactEmail } from './public-contact-email.js';
import type { DiscoveredLead } from './crm-discovery-types.js';

/** Owner-attested official-source research, never a substitute for provider history checks. */
export function parseVerifiedOpportunities(raw: unknown, now=Date.now()): DiscoveredLead[] {
  const rows=(raw as {opportunities?:unknown})?.opportunities;
  if (!Array.isArray(rows) || rows.length<1 || rows.length>5) throw new Error('Import one to five verified opportunities.');
  return rows.map(row=>{
    const x=row as Record<string,string>;
    const website=new URL(x.website), source=new URL(x.source_url);
    if ([website,source].some(u=>u.protocol!=='https:' || u.username || u.password)
      || website.hostname.replace(/^www\./,'')!==source.hostname.replace(/^www\./,'')) throw new Error('Use the official HTTPS website and its contact source.');
    if (!isPublicContactEmail(x.email || '') || !x.business_name?.trim() || !x.observation?.trim()) throw new Error('Verified contact and observation required.');
    const at=Date.parse(x.verified_at);
    if (!Number.isFinite(at) || at>now || now-at>3600000) throw new Error('Official-source research must be verified within one hour.');
    const id='official_'+createHash('sha256').update(source.href).digest('hex').slice(0,16);
    return {id,place_id:id,business_name:x.business_name,website:website.href,city:x.city || null,category:x.category || null,
      public_email:x.email.toLowerCase(),phone:x.phone || null,social:{},source_url:source.href,last_verified_at:x.verified_at,
      status:'qualified',score_total:0,scores:{website:0,mobile:0,brand:0,booking:0,fit:0,contactability:0},
      evidence:[{field:'website',signal:'verified_website_need',detail:x.observation,source:source.href},
        {field:'contactability',signal:'public_email',detail:'Email verified on the official contact page by the owner-authorized researcher.',source:source.href}],
      fit_summary:'Official-source opportunity reviewed by the studio researcher; no automated score assigned.',
      problems:[x.observation],service_opportunity:'Three-page informational website within the approved BBL offer.',
      payment_capacity_signals:[],weak_website_signals:[x.observation],
      enrichment:{email_source:'website_text',email_verified_public:true,last_enrichment_at:x.verified_at},created_at:x.verified_at,updated_at:x.verified_at};
  });
}
