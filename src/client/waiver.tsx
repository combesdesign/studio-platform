/** Waiver + health form. Required before a client's first booking (WAIVER_REQUIRED). */
import React, { useMemo, useState } from 'react';
import { store, useToast, errorMessage, leaveSheets, useBackHandler } from '../shared/react';
import { BackPill, Flower, Icon, useApp } from './ui';
import { backOut, dateShortNoDay, flowFrom, queryOf, saveClient, swapFlow } from './lib';
import { healthPolicy } from '../domain';

type Nav = (to: string, o?: { replace?: boolean }) => void;
type YN = 'Yes' | 'No' | '';

function parseAnswer(a?: string): { yn: YN; detail: string } {
  if (!a) return { yn: '', detail: '' };
  if (/^no\b/i.test(a)) return { yn: 'No', detail: '' };
  if (/^yes\b/i.test(a)) return { yn: 'Yes', detail: a.replace(/^yes[:\s–-]*/i, '') };
  return { yn: 'Yes', detail: a };
}

export function Waiver({ nav, path }: { nav: Nav; path: string }) {
  const app = useApp();
  const toast = useToast();
  const q = queryOf(path);
  const then = q.get('then') || undefined;
  // the pass (and spot) they picked before the waiver, so the booking at the end uses them
  const passId = q.get('pass') || undefined;
  const spot = q.get('spot') || undefined;
  const edit = q.get('edit') === '1' || !!app.client.waiverSignedAt && !then;
  const c = app.client;
  const qs = app.settings.healthQuestions ?? [];

  const [step, setStep] = useState(0);
  const [about, setAbout] = useState({
    phone: c.phone ?? '', birthday: c.birthday ?? '',
    emergencyContactName: c.emergencyContactName ?? '', emergencyContactPhone: c.emergencyContactPhone ?? '',
  });
  const [answers, setAnswers] = useState<Record<string, { yn: YN; detail: string }>>(() => {
    const o: Record<string, { yn: YN; detail: string }> = {};
    qs.forEach((x) => { o[x] = parseAnswer(c.healthForm?.answers?.[x]); });
    return o;
  });
  const [injuries, setInjuries] = useState(c.healthForm?.injuries ?? c.injuries ?? '');
  const [preg, setPreg] = useState<YN>(c.healthForm?.pregnantOrPostnatal == null ? '' : c.healthForm.pregnantOrPostnatal ? 'Yes' : 'No');
  const [agree, setAgree] = useState(false);
  const [sig, setSig] = useState('');
  const [busy, setBusy] = useState(false);
  const fullName = `${c.firstName} ${c.lastName}`.trim();

  // First-timers get the long health questions unless the studio has turned that off (Settings > Policies). The waiver is always needed.
  // Updating from Profile (already signed, or edit=1) always shows them.
  const skipHealth = !healthPolicy(app.settings).longFormFirstTimers && !edit && !c.waiverSignedAt;
  const steps = skipHealth ? ['About you', 'Waiver'] : ['About you', 'Your health', 'Waiver'];
  const stepName = steps[step];
  const okAbout = about.emergencyContactName.trim().length > 1 && about.emergencyContactPhone.trim().length >= 6;
  const okHealth = qs.every((x) => answers[x]?.yn) && preg !== '';
  const okSign = agree && sig.trim().length >= 2;
  const canNext = stepName === 'About you' ? okAbout : stepName === 'Your health' ? okHealth : okSign;

  // Back goes one step at a time, then out to where the waiver was opened from (the class, or Profile).
  // Each step after the first has its own history entry, so the phone back button does the same.
  const origin = flowFrom(path);
  const outTo = then ? '/class/' + encodeURIComponent(then) : edit ? '/profile' : '/';
  const leaveFlow = () => backOut(nav, path, outTo);
  const goStep = (n: number) => { setStep(n); window.scrollTo(0, 0); };
  useBackHandler(step >= 1, () => goStep(0));
  useBackHandler(step >= 2, () => goStep(1));
  const back = () => { if (step > 0) goStep(step - 1); else leaveFlow(); };
  const next = () => goStep(step + 1);
  const backLabel = step > 0 ? steps[step - 1]! : origin?.label ?? (then ? 'Class' : edit ? 'Profile' : 'Timetable');

  const submit = async () => {
    setBusy(true);
    try {
      await saveClient(c, {
        phone: about.phone.trim() || undefined,
        birthday: about.birthday || undefined,
        emergencyContactName: about.emergencyContactName.trim(),
        emergencyContactPhone: about.emergencyContactPhone.trim(),
        injuries: injuries.trim() || undefined,
      });
      const out: Record<string, string> = {};
      if (!skipHealth) qs.forEach((x) => { const a = answers[x]!; out[x] = a.yn === 'Yes' ? (a.detail.trim() ? `Yes: ${a.detail.trim()}` : 'Yes') : 'No'; });
      await store.submitWaiver(c.id, { answers: out, ...(injuries.trim() ? { injuries: injuries.trim() } : {}), ...(skipHealth ? {} : { pregnantOrPostnatal: preg === 'Yes' }) });
      app.refreshAuth();
      // Step off the step entries first (quietly), then leave the flow.
      if (then) {
        try {
          const r = await store.bookClass(c.id, then, { ...(passId ? { passId } : {}), ...(spot ? { spot } : {}) });
          toast(r.outcome === 'booked' ? 'All signed – and you’re booked in' : 'All signed – you’re on the waitlist');
          leaveSheets(leaveFlow, { quiet: true });
        } catch (e: any) {
          if (e?.code === 'NO_CREDITS') { toast('All signed. Now grab a pass to book'); leaveSheets(() => swapFlow(nav, path, '/passes?for=' + encodeURIComponent(then)), { quiet: true }); }
          else { toast(errorMessage(e)); leaveSheets(leaveFlow, { quiet: true }); }
        }
      } else {
        toast(edit ? 'Health info updated – thank you' : 'All signed – thank you');
        leaveSheets(leaveFlow, { quiet: true });
      }
    } catch (e) { toast(errorMessage(e)); }
    finally { setBusy(false); }
  };

  const waiverParas = useMemo(() => (app.settings.waiverText || '').split(/\n{2,}|\r?\n/).filter((s) => s.trim()), [app.settings.waiverText]);

  return (
    <div className="flow">
      <div className="flow-top">
        <BackPill label={backLabel} onClick={back} />
        <div className="flow-progress" aria-label={`Step ${step + 1} of ${steps.length}`}>
          {steps.map((s, i) => <span key={s} className={i <= step ? 'on' : ''} />)}
        </div>
        <span className="flow-step muted">{step + 1}/{steps.length}</span>
      </div>

      <div className="flow-body" key={step}>
        {stepName === 'About you' && (
          <>
            <div className="kicker">{then ? 'Before your first class' : edit ? 'Update your details' : 'Health + waiver'}</div>
            <h1>A little about <em>you</em></h1>
            <p className="lede">{then ? 'We just need a few details before your first booking. It takes about two minutes, and you only do it once.' : 'Keep this up to date so your instructors can look after you.'}</p>
            <div className="stack lg">
              <div className="grid2">
                <label className="field"><span>Mobile</span><input className="input" type="tel" inputMode="tel" autoComplete="tel" value={about.phone} onChange={(e) => setAbout({ ...about, phone: e.target.value })} /></label>
                <label className="field"><span>Birthday <i className="faint">(optional)</i></span><input className="input" type="date" value={about.birthday} onChange={(e) => setAbout({ ...about, birthday: e.target.value })} /></label>
              </div>
              <div className="group-head"><h3>Emergency contact</h3><p className="muted">Who should we call if something happens in class?</p></div>
              <label className="field"><span>Name</span><input className="input" autoComplete="off" value={about.emergencyContactName} onChange={(e) => setAbout({ ...about, emergencyContactName: e.target.value })} /></label>
              <label className="field"><span>Phone</span><input className="input" type="tel" inputMode="tel" autoComplete="off" value={about.emergencyContactPhone} onChange={(e) => setAbout({ ...about, emergencyContactPhone: e.target.value })} /></label>
            </div>
          </>
        )}

        {stepName === 'Your health' && (
          <>
            <div className="kicker">Health check</div>
            <h1>How’s your <em>body</em> feeling?</h1>
            <p className="lede">Pilates is for every body. This just helps your instructor offer the right options. Only the studio team sees it.</p>
            <div className="stack lg">
              {qs.map((x) => {
                const a = answers[x] ?? { yn: '' as YN, detail: '' };
                return (
                  <div key={x} className="hq">
                    <p className="hq-q">{x}</p>
                    <YesNo value={a.yn} onChange={(yn) => setAnswers({ ...answers, [x]: { ...a, yn } })} />
                    {a.yn === 'Yes' && (
                      <input className="input mt-8" placeholder="A few words, if you’re comfortable" value={a.detail} onChange={(e) => setAnswers({ ...answers, [x]: { ...a, detail: e.target.value } })} />
                    )}
                  </div>
                );
              })}
              <div className="hq">
                <p className="hq-q">Are you pregnant or postnatal (had a baby in the last 12 months)?</p>
                <YesNo value={preg} onChange={setPreg} />
                {preg === 'Yes' && <p className="note cream mt-8"><Icon name="heart" size={20} /><span>Congratulations! Please chat to your instructor before class, and make sure you have clearance from a women’s health professional for Mums + Bubs.</span></p>}
              </div>
              <label className="field"><span>Any injuries, niggles or conditions we should know about?</span>
                <textarea className="textarea" placeholder="e.g. lower back pain, recent knee surgery – or leave blank" value={injuries} onChange={(e) => setInjuries(e.target.value)} />
              </label>
            </div>
          </>
        )}

        {stepName === 'Waiver' && (
          <>
            <div className="kicker">Last step</div>
            <h1>The <em>fine print</em></h1>
            <p className="lede">Please read and sign the studio waiver.</p>
            <div className="waiver-text" tabIndex={0}>
              {waiverParas.length ? waiverParas.map((p, i) => <p key={i}>{p}</p>) : <p>I understand that Pilates involves physical exercise and I take part at my own risk.</p>}
            </div>
            <div className="stack lg mt-20">
              <label className="check"><input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} /><span>I’ve read and agree to the waiver, and my health info is correct.</span></label>
              <label className="field"><span>Type your full name to sign</span>
                <input className="input sig" placeholder={fullName} value={sig} onChange={(e) => setSig(e.target.value)} autoComplete="name" />
              </label>
              {c.waiverSignedAt && <p className="muted fine">Last signed {dateShortNoDay(c.waiverSignedAt)}.</p>}
            </div>
          </>
        )}
      </div>

      <div className="flow-foot">
        {step < steps.length - 1 ? (
          <button className="btn block big" disabled={!canNext} onClick={next}>Continue</button>
        ) : (
          <button className="btn block big" disabled={!canNext || busy} onClick={submit}>
            {busy ? <><Flower size={20} white spin />Saving…</> : then ? 'Sign and book my class' : 'Sign and save'}
          </button>
        )}
      </div>
    </div>
  );
}

export function YesNo({ value, onChange }: { value: YN; onChange: (v: YN) => void }) {
  return (
    <div className="yn" role="radiogroup">
      {(['No', 'Yes'] as YN[]).map((v) => (
        <button key={v} type="button" role="radio" aria-checked={value === v} className={value === v ? 'on' : ''} onClick={() => onChange(v)}>{v}</button>
      ))}
    </div>
  );
}
