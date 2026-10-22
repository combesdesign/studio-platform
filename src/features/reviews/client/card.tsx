/**
 * The "How was Mat Essentials with Julia?" card, at the top of the client timetable.
 * Shows once per checked-in class: 1 to 5 flowers, an optional comment, and "Would you recommend us?" 0 to 10.
 * "Not now" never asks about that class again. A 9 or 10 gets a Google review button when the studio set a link.
 */
import React, { useState } from 'react';
import { Flower } from '../../../shared/brand';
import { errorMessage, store, useData } from '../../../shared/react';
import { MAX_COMMENT } from '../calc';
import type { ReviewPrompt } from '../types';

const LABELS = ['', 'Not for me', 'It was okay', 'Good', 'Really good', 'Loved it'];

export function ReviewCard() {
  const reviews = store.features.reviews;
  const prompt = useData(async () => (reviews ? reviews.pendingPrompt().catch(() => null) : null), []);
  const [rating, setRating] = useState(0);
  const [nps, setNps] = useState<number | null>(null);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const [thanks, setThanks] = useState<{ googleUrl?: string } | null>(null);
  const [shown, setShown] = useState<ReviewPrompt | null>(null);

  const p = shown ?? prompt.data ?? null;
  if (!reviews || (!p && !thanks)) return null;

  if (thanks) {
    return (
      <section className="rv-card rv-thanks" aria-live="polite">
        <Flower size={34} color="var(--accent)" />
        <h3 className="serif">Thank you!</h3>
        <p className="muted">That really helps us look after your classes.</p>
        {thanks.googleUrl && (
          <a className="btn block" href={thanks.googleUrl} target="_blank" rel="noopener noreferrer">Share it on Google too</a>
        )}
        <button className="rv-link" onClick={() => { setThanks(null); setShown(null); }}>Close</button>
      </section>
    );
  }
  if (!p) return null;

  const send = async () => {
    if (!rating || busy) return;
    setBusy(true); setProblem('');
    try {
      setShown(p); // keep the card (and its thank-you) up while the list refreshes
      const r = await reviews.submit(p.bookingId, { rating, nps, comment });
      setThanks(r);
    } catch (e) {
      setProblem(errorMessage(e));
      setShown(null);
    } finally { setBusy(false); }
  };
  const later = async () => {
    setBusy(true);
    try { await reviews.dismiss(p.bookingId); } catch { /* it just shows again next time */ } finally { setBusy(false); }
  };

  return (
    <section className="rv-card" aria-label="Rate your class">
      <h3 className="serif">How was <em>{p.className}</em>{p.instructorName ? ` with ${p.instructorName.split(' ')[0]}` : ''}?</h3>
      <div className="rv-stars" role="radiogroup" aria-label="Your rating out of 5">
        {[1, 2, 3, 4, 5].map((n) => (
          <button key={n} type="button" role="radio" aria-checked={rating === n} aria-label={`${n} out of 5: ${LABELS[n]}`} className={n <= rating ? 'on' : ''} onClick={() => setRating(n)}>
            <Flower size={34} color={n <= rating ? 'var(--accent)' : 'var(--faint)'} />
          </button>
        ))}
      </div>
      <p className="rv-label" aria-live="polite">{rating ? LABELS[rating] : 'Tap a flower'}</p>

      {rating > 0 && (
        <>
          <textarea className="input rv-text" rows={2} maxLength={MAX_COMMENT} placeholder="Anything you'd like to add? (optional)" aria-label="Comment (optional)" value={comment} onChange={(e) => setComment(e.target.value)} />
          <p className="rv-q">Would you recommend us to a friend?</p>
          <div className="rv-nps" role="radiogroup" aria-label="Likelihood to recommend, 0 to 10">
            {Array.from({ length: 11 }, (_, n) => (
              <button key={n} type="button" role="radio" aria-checked={nps === n} className={nps === n ? 'on' : ''} onClick={() => setNps(nps === n ? null : n)}>{n}</button>
            ))}
          </div>
          <div className="rv-ends"><span>Not likely</span><span>Very likely</span></div>
        </>
      )}
      {problem && <p className="rv-problem" role="alert">{problem}</p>}
      <div className="rv-actions">
        <button className="btn" disabled={!rating || busy} onClick={send}>Send</button>
        <button className="rv-link" disabled={busy} onClick={later}>Not now</button>
      </div>
    </section>
  );
}
