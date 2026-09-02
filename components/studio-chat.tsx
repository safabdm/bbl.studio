'use client';

import { BblsMark } from '@/components/bbls-mark';
import { answerStudioQuestion } from '@/lib/studio-answers';
import { ArrowUpRight, Send, X } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';

type ChatMessage = {
  id: string;
  role: 'assistant' | 'user';
  text: string;
};

const PHONE_HREF = 'tel:+19495242324';

const starters = [
  { label: 'Help me choose', question: 'Which package is right for me?' },
  { label: 'One page site', question: 'I need one focused landing page' },
  { label: 'Full website', question: 'I need a complete business website' },
  { label: 'Pricing', question: 'What are the starting prices?' },
] as const;

function delay(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

export function StudioChat({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const titleId = useId();
  const inputId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState('');
  const [pending, setPending] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([{
    id: 'welcome',
    role: 'assistant',
    text: 'Tell me what you are building. I can recommend the closest website package, explain starting prices, and prepare you for the first project conversation.',
  }]);
  const started = messages.some((message) => message.role === 'user');

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.show();
      window.requestAnimationFrame(() => inputRef.current?.focus());
    }
    if (!open && dialog.open) {
      dialog.close();
      document.getElementById('bbls-estimate-trigger')?.focus();
    }
  }, [open]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const onClose = () => onOpenChange(false);
    dialog.addEventListener('close', onClose);
    return () => dialog.removeEventListener('close', onClose);
  }, [onOpenChange]);

  useEffect(() => {
    listRef.current?.lastElementChild?.scrollIntoView({ block: 'end' });
  }, [messages, pending]);

  async function replyTo(question: string, history: string[]) {
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    setPending(true);
    if (!reduce) await delay(380);
    setMessages((current) => [
      ...current,
      { id: `a-${Date.now()}`, role: 'assistant', text: answerStudioQuestion(question, history) },
    ]);
    setPending(false);
  }

  function submitQuestion(question: string) {
    const next = question.trim();
    if (!next || pending) return;
    const history = messages.filter((message) => message.role === 'user').map((message) => message.text);
    setMessages((current) => [...current, { id: `u-${Date.now()}`, role: 'user', text: next }]);
    setValue('');
    void replyTo(next, history);
  }

  return (
    <div className={`studio-chat-root${open ? ' is-open' : ''}`}>
      {!open && (
        <button
          type="button"
          id="bbls-estimate-trigger"
          className="chat-card-launcher"
          onClick={() => onOpenChange(true)}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-controls="bbls-studio-chat"
        >
          <span className="contact-photo" aria-hidden="true">
            <BblsMark size={44} />
          </span>
          <span className="chat-card-copy">
            <strong>Plan your website with BBLS.</strong>
            <small>Choose a scope, compare starting prices, or prepare for kickoff.</small>
            <span className="chat-card-cta">
              Ask BBLS <ArrowUpRight size={14} aria-hidden="true" />
            </span>
          </span>
        </button>
      )}
      <dialog ref={dialogRef} id="bbls-studio-chat" className="studio-chat" aria-labelledby={titleId}>
        <div className="chat-head">
          <div className="chat-head-mark" aria-hidden="true">
            <BblsMark size={28} />
          </div>
          <div>
            <h2 id={titleId}>Ask BBLS</h2>
            <p>Website scope and starting price guide</p>
          </div>
          <button type="button" className="chat-close" aria-label="Close chat" onClick={() => onOpenChange(false)}>
            <X size={16} aria-hidden="true" />
          </button>
        </div>

        <div ref={listRef} className="chat-thread" aria-live="polite">
          {messages.map((message) => (
            <p key={message.id} className={`chat-bubble ${message.role === 'user' ? 'is-user' : 'is-assistant'}`}>
              {message.text}
            </p>
          ))}
          {pending && <p className="chat-bubble is-assistant is-pending">Preparing a reply…</p>}
        </div>

        {!started && (
          <div className="chat-starters">
            {starters.map((starter) => (
              <button key={starter.label} type="button" onClick={() => submitQuestion(starter.question)} disabled={pending}>
                {starter.label}
              </button>
            ))}
          </div>
        )}

        <form
          className="chat-form"
          onSubmit={(event) => {
            event.preventDefault();
            submitQuestion(value);
          }}
        >
          <label className="sr-only" htmlFor={inputId}>Ask BBLS a question</label>
          <input
            ref={inputRef}
            id={inputId}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder="Ask about a website project…"
            autoComplete="off"
            maxLength={240}
          />
          <button type="submit" aria-label="Send question" disabled={pending || !value.trim()}>
            <Send size={16} aria-hidden="true" />
          </button>
        </form>
        <a className="chat-call" href={PHONE_HREF} aria-label="Call BBLS at (949) 524-2324">
          Or call (949) 524-2324
        </a>
      </dialog>
    </div>
  );
}
