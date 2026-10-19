/** Studio › Shop › Referrals: how many friends clients have brought, and what it has cost. */
import React from 'react';
import { useData } from '../../../shared/react';
import { money } from '../../../shared/format';
import { Avatar, Empty, Loading, useStudio } from '../../../studio/ui';
import { dm, needCommerce } from '../api';
import { Kpi, Tone } from './bits';

export function ReferralsTab() {
  const { can } = useStudio();
  const stats = useData(() => needCommerce().referralStats(), []);
  const s = stats.data;
  if (stats.error && !s) return <Empty title="That didn’t load">{stats.error.message}</Empty>;
  if (!s) return <Loading />;
  const reward = `${money(s.rewardCents)} ${s.rewardKind === 'credit' ? 'account credit' : 'gift card'}`;
  return (
    <>
      <div className={'note cm-note' + (s.enabled ? '' : ' warn')}>
        <span>
          {s.enabled ? <>Clients share their code from Profile › Bring a friend. When a friend joins with it and buys their first paid pass, the client gets <strong>{reward}</strong>.</>
            : <>Referral rewards are off. Clients can still share their code, but no rewards are given.</>}
          {can('commerce.manage') && <> <a className="linkish" href="#/settings/commerce">Change in settings</a></>}
        </span>
      </div>
      <div className="cm-kpis">
        <Kpi tone="hero" label="Friends referred" value={s.referrals} sub={`${s.pending} yet to buy a pass`} />
        <Kpi label="Became clients" value={s.rewarded} sub={s.referrals ? `${Math.round((s.rewarded / s.referrals) * 100)}% of referrals` : 'No referrals yet'} />
        <Kpi label="Rewards given" value={money(s.rewardCentsPaid)} sub={reward + ' each'} />
        <Kpi tone="mist" label="Top referrer" value={s.top[0]?.name.split(' ')[0] ?? '–'} sub={s.top[0] ? `${s.top[0].referrals} friend${s.top[0].referrals === 1 ? '' : 's'}` : undefined} />
      </div>
      <div className="cm-two">
        <section className="card pad">
          <h3 className="cm-h3">Top <em>referrers</em></h3>
          {s.top.length === 0 ? <p className="muted">No one yet.</p> : (
            <div className="cm-people">
              {s.top.map((t) => (
                <a key={t.clientId} className="cm-person" href={`#/clients/${t.clientId}`}>
                  <Avatar name={t.name} size={40} />
                  <span className="grow"><strong>{t.name}</strong><span>{t.referrals} referred · {t.rewarded} rewarded</span></span>
                </a>
              ))}
            </div>
          )}
        </section>
        <section className="card pad">
          <h3 className="cm-h3">Recent <em>referrals</em></h3>
          {s.recent.length === 0 ? <p className="muted">Nothing yet. Remind clients about their code at the desk.</p> : (
            <div className="cm-people">
              {s.recent.map((r) => (
                <div key={r.id} className="cm-person">
                  <Avatar name={r.referredName} size={40} />
                  <span className="grow"><strong><a className="linkish" href={`#/clients/${r.referredClientId}`}>{r.referredName}</a></strong><span>Referred by {r.referrerName} · {dm(r.createdAt)}</span></span>
                  <Tone tone={r.status === 'rewarded' ? 'ok' : ''}>{r.status === 'rewarded' ? `Rewarded ${r.rewardCents != null ? money(r.rewardCents) : ''}` : 'No pass yet'}</Tone>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </>
  );
}
