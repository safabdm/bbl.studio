import { guideReply } from './studio-guide-data.js';

const root = document.createElement('div');
root.className = 'bbl-guide-root';
root.innerHTML = `<button class="bbl-guide-toggle" type="button" aria-label="Open BBL project guide" aria-expanded="false" aria-controls="bbl-guide-panel" aria-haspopup="dialog"><img src="/brand/bbl-guide-avatar-v2.jpg" width="56" height="56" alt=""><span class="bbl-guide-toggle-badge" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M20 11a8 8 0 0 1-8 8H5l-3 3V11a8 8 0 0 1 8-8h2a8 8 0 0 1 8 8Z"/><path d="M7 9h8M7 13h5"/></svg></span></button>
<section id="bbl-guide-panel" class="bbl-guide-panel" role="dialog" aria-label="BBL project guide" hidden><header class="bbl-guide-head"><img class="bbl-guide-avatar" src="/brand/bbl-guide-avatar-v2.jpg" width="36" height="36" alt=""><div class="bbl-guide-head-copy"><h2>Business Brand Lab</h2><p>Automated project guide</p></div><button class="bbl-guide-close" type="button" aria-label="Close project guide">×</button></header><div class="bbl-guide-thread" role="log" aria-live="polite" aria-label="Conversation"></div><div class="bbl-guide-actions"></div><form class="bbl-guide-form"><label for="bbl-guide-question" class="sr-only">Your question</label><input id="bbl-guide-question" placeholder="What are you building?" autocomplete="off" maxlength="500"><button type="submit" aria-label="Send question" disabled><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m5 12 14 0m-6-6 6 6-6 6"/></svg></button></form><div class="bbl-guide-booking"><a class="bbl-guide-action" href="/booking">Book a consultation</a></div><p class="bbl-guide-note">Automated service guide. Chats stay in this tab. Final scope is confirmed by the studio.</p></section>`;
document.body.append(root);
const toggle = root.querySelector('.bbl-guide-toggle');
const panel = root.querySelector('.bbl-guide-panel');
const thread = root.querySelector('.bbl-guide-thread');
const actions = root.querySelector('.bbl-guide-actions');
const form = root.querySelector('form');
const input = root.querySelector('input');
const send = form.querySelector('button');
const context = {};
function setOpen(open, returnFocus = true) {
  panel.hidden = !open;
  toggle.setAttribute('aria-expanded', String(open));
  if (open) input.focus({ preventScroll: true });
  else if (returnFocus) toggle.focus({ preventScroll: true });
}
function addMessage(text, user = false) {
  const p = document.createElement('p');
  p.className = `bbl-guide-message${user ? ' user' : ''}`;
  p.textContent = text;
  thread.append(p);
  thread.scrollTop = thread.scrollHeight;
}
function renderActions(reply) {
  actions.replaceChildren();
  if (reply.action) {
    const a = document.createElement('a');
    a.className = 'bbl-guide-action';
    a.textContent = reply.action;
    a.href = reply.href || '#inquiry';
    a.addEventListener('click', () => {
      if (!reply.href) {
        const inquiry = document.querySelector('#inquiry');
        const service = inquiry?.querySelector('select[name="service"]');
        const brand = inquiry?.querySelector('input[name="brand"]');
        if (service && context.service) { service.value = context.service; service.dispatchEvent(new Event('change', { bubbles: true })); }
        if (brand && context.brand) { brand.checked = true; brand.dispatchEvent(new Event('change', { bubbles: true })); }
        setOpen(false, false);
        inquiry?.querySelector('input')?.focus({ preventScroll: true });
      } else setOpen(false);
    });
    actions.append(a);
  }
  for (const label of reply.choices || []) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'bbl-guide-chip'; b.textContent = label;
    b.addEventListener('click', () => ask(label)); actions.append(b);
  }
}
function ask(question) {
  const q = question.trim().slice(0, 500);
  if (!q) return;
  addMessage(q, true);
  const reply = guideReply(q, context);
  if (reply.service) context.service = reply.service;
  if (reply.brand) context.brand = true;
  addMessage(reply.text);
  renderActions(reply);
  input.value = ''; send.disabled = true;
}
toggle.addEventListener('click', () => setOpen(panel.hidden));
root.querySelector('.bbl-guide-close').addEventListener('click', () => setOpen(false));
root.addEventListener('keydown', event => { if (event.key === 'Escape' && !panel.hidden) { event.preventDefault(); setOpen(false); } });
input.addEventListener('input', () => { send.disabled = !input.value.trim(); });
form.addEventListener('submit', event => { event.preventDefault(); ask(input.value); input.focus({ preventScroll: true }); });
addMessage('Hi, I’m BBL’s service guide. I can help you choose a website scope, explore branding, or compare starting prices. What do you have in mind?');
renderActions({ choices: ['Find my fit', 'View pricing', 'Brand identity'] });
