import React, { useEffect, useState } from 'react';
import type { MarketingState } from '../server/marketing-automation';

export function MarketingCampaignPage() {
  const [state,setState]=useState<MarketingState|null>(null);
  const [error,setError]=useState('');
  const [busy,setBusy]=useState(false);
  const [email,setEmail]=useState('');
  const [evidence,setEvidence]=useState('');
  async function load() {
    try {
      const response=await fetch('/api/admin/crm/marketing');
      if (!response.ok) throw new Error('Campaign status could not be loaded. Please sign in and try again.');
      const data=await response.json();setState(data.state);setError('');
    } catch (err) { setError(err instanceof Error ? err.message : 'Please try again.'); }
  }
  useEffect(()=>{void load();},[]);
  async function update(body: Record<string,unknown>) {
    setBusy(true);
    try {
      const response=await fetch('/api/admin/crm/marketing',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
      const data=await response.json();if(!response.ok)throw new Error(data.message || 'The update could not be saved.');
      setState(data.state);setError('');setEmail('');setEvidence('');
    } catch(err) {setError(err instanceof Error?err.message:'Please try again.');}
    finally {setBusy(false);}
  }
  return <section className="crm-page marketing-campaign">
    <header><h1>First five clients</h1><p>Three-page website · $2,000 · Up to five messages per business day</p></header>
    {error && <p role="alert">{error}</p>}
    {!state ? <button onClick={()=>void load()}>Refresh campaign</button> : <>
      <p><strong>{state.clients.length}/5 confirmed clients</strong> · {state.paused?'Paused':'Not paused'}</p>
      <p>{state.lastRun ? state.lastRun.message : 'No cloud campaign run has been recorded yet. This does not confirm that sending is active.'}</p>
      <button disabled={busy} onClick={()=>void update({paused:!state.paused})}>{state.paused?'Resume checks':'Pause sending'}</button>{' '}
      <button disabled={busy} onClick={()=>void load()}>Refresh status</button>
      <h2>Accepted projects ready for Safa</h2>
      {(state.conversations || []).filter(c=>c.status==='READY').map(c=><article key={c.email}><h3>{c.email}</h3><p>Explicit acceptance and project brief received. Coordinate payment and start date.</p><pre style={{whiteSpace:'pre-wrap'}}>{c.evidence}</pre></article>)}
      {!(state.conversations || []).some(c=>c.status==='READY') && <p>No accepted project brief yet.</p>}
      <h2>Message history</h2>
      <p>Submitted means accepted by the sending service. Delivered means confirmed by the recipient’s mail server; inbox placement and human reading are not guaranteed.</p>
      {state.attempts.length ? <table><thead><tr><th>Business</th><th>Message</th><th>Submission</th><th>Delivery</th></tr></thead><tbody>
        {state.attempts.map(a=><tr key={a.id}><td>{a.business}<br/>{a.email}</td><td>{a.replyTo?'Client conversation':a.step===0?'First email':`Follow-up ${a.step}`}</td><td>{a.status==='SUBMITTED'?'Submitted':a.status==='CLAIMED'?'Needs reconciliation':'Outcome uncertain'}</td><td>{a.receipt==='UNKNOWN'?'Unverified':a.receipt.toLowerCase()}</td></tr>)}
      </tbody></table> : <p>No campaign messages have been submitted.</p>}
      <h2>Record a confirmed client</h2>
      <p>Use a real payment or your explicit confirmation. A reply or a consultation is not a confirmed client. Promotion stops at five.</p>
      <form onSubmit={event=>{event.preventDefault();void update({client_email:email,evidence});}}>
        <label>Client email <input required type="email" value={email} onChange={e=>setEmail(e.target.value)}/></label>{' '}
        <label>Payment or confirmation reference <input required value={evidence} onChange={e=>setEvidence(e.target.value)}/></label>{' '}
        <button disabled={busy || state.clients.length>=5}>Record confirmed client</button>
      </form>
    </>}
  </section>;
}
