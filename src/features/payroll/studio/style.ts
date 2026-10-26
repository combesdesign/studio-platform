/**
 * Payroll studio styles, as a string injected into <head> by studio/index.tsx.
 * (A plain `import './x.css'` from a feature is bundled into the lazily loaded app chunk's own .css file, which the
 * studio page never links, so the rules would never apply. Injecting keeps the feature self-contained.)
 */
export const PAYROLL_CSS = `/* Payroll (studio app): cover, timesheets, pay periods and rules. Built on the studio's role tokens only. */

/* ---------------------------------------------------------------- cover */
.cover-page .seg .count, .payroll-page .seg .count { margin-left: 8px; font-size: 14px; background: rgba(var(--ink-rgb), .1); }
.cover-page .seg button.on .count, .payroll-page .seg button.on .count { background: var(--soft); }
.payroll-page h3 .count { font-size: 14px; }
.cv-list { display: grid; gap: 10px; }
.cv-card {
  position: relative; display: grid; grid-template-columns: 92px minmax(0, 1fr) auto; align-items: center; gap: 18px;
  padding: 18px 20px 18px 24px; background: #fff; border: 1px solid var(--line); border-radius: var(--r); min-height: 96px;
}
.cv-card::before { content: ''; position: absolute; left: 0; top: 14px; bottom: 14px; width: 4px; border-radius: 0 4px 4px 0; background: var(--ct); }
.cv-card.st-open { border-color: rgba(var(--primary-rgb), .28); }
.cv-card.st-cancelled, .cv-card.st-expired { background: transparent; }
.cv-card.st-cancelled .cv-title, .cv-card.st-expired .cv-title { color: var(--muted); }
.cv-when { display: grid; grid-template-columns: auto 1fr; align-items: baseline; column-gap: 2px; font-variant-numeric: tabular-nums; }
.cv-when strong { font-family: var(--display); font-weight: 400; font-size: 32px; line-height: 1; }
.cv-when span { font-size: 14px; color: var(--muted); }
.cv-when em { grid-column: 1 / -1; font-style: normal; font-size: 13px; color: var(--muted); margin-top: 4px; }
.cv-title { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; font-size: 18px; }
.cv-who { display: flex; align-items: center; gap: 8px; margin-top: 6px; color: var(--ink); font-size: 15px; }
.cv-reason { margin: 6px 0 0; color: var(--muted); font-size: 14.5px; font-style: italic; }
.cv-meta { margin: 4px 0 0; color: var(--faint); font-size: 13.5px; }
.cv-actions { display: flex; gap: 8px; flex-wrap: wrap; justify-content: flex-end; align-items: center; }
.cv-actions:empty { display: none; }
.cv-card:has(.cv-actions:empty) { grid-template-columns: 92px minmax(0, 1fr); }
.cv-setting { margin-top: 22px; max-width: 720px; }
.cv-pick { display: grid; gap: 8px; }
.cv-pick-row {
  position: relative; display: grid; grid-template-columns: 120px minmax(0, 1fr) 20px; align-items: center; gap: 12px; min-height: 60px; padding: 8px 14px 8px 20px;
  background: #fff; border: 1px solid var(--line); border-radius: 14px; cursor: pointer; text-align: left; font: inherit; color: var(--ink);
}
.cv-pick-row::before { content: ''; position: absolute; left: 0; top: 12px; bottom: 12px; width: 4px; border-radius: 0 4px 4px 0; background: var(--ct); }
.cv-pick-row:hover { border-color: var(--accent); }
.cv-pick-t { display: grid; }
.cv-pick-t strong { font-weight: 400; font-size: 17px; }
.cv-pick-t span { font-size: 13px; color: var(--muted); }
.cv-chosen { position: relative; padding: 14px 16px 14px 22px; background: var(--soft); border-radius: 14px; display: grid; gap: 2px; }
.cv-chosen::before { content: ''; position: absolute; left: 0; top: 12px; bottom: 12px; width: 4px; border-radius: 0 4px 4px 0; background: var(--ct); }
.cv-chosen span { color: var(--muted); font-size: 14.5px; }
.cv-strip { position: relative; margin-bottom: 16px; }
.cv-strip .cv-fl { display: none; }
.cv-card.strip { min-height: 0; padding: 14px 18px 14px 22px; box-shadow: var(--shadow); }
.cv-card.strip .cv-when strong { font-size: 26px; }
.cv-strip-ask { margin-bottom: 14px; }
.cv-today .cv-mini { display: grid; gap: 2px; }
.cv-mini-row { position: relative; display: flex; align-items: center; gap: 12px; padding: 10px 6px 10px 14px; margin: 0 -6px; border-radius: 12px; min-height: 64px; }
.cv-mini-row::before { content: ''; position: absolute; left: 0; top: 12px; bottom: 12px; width: 3px; border-radius: 3px; background: var(--ct); }
.cv-mini-t { display: grid; flex: 1; min-width: 0; font-size: 14.5px; }
.cv-mini-t strong { font-weight: 400; font-size: 16px; }
.cv-mini-t span { color: var(--muted); font-size: 13.5px; }

/* ---------------------------------------------------------------- clock + timesheets */
.ck-card .ck-big { font-family: var(--display); font-size: 48px; line-height: 1; margin: 6px 0 2px; font-variant-numeric: tabular-nums; }
.ck-card .ck-sub { margin: 0 0 4px; }
.ck-card .ck-btn { margin-top: 14px; min-height: 52px; }
.ck-card.on { border-color: rgba(62, 142, 110, .35); background: linear-gradient(180deg, var(--ok-bg), #fff 62%); }
.ts-list { display: grid; }
.ts-list.card, .ts-block .ts-list { padding: 4px 0; }
.ts-row {
  display: grid; grid-template-columns: minmax(110px, 0.8fr) minmax(0, 1.6fr) 84px auto auto; align-items: center; gap: 14px; padding: 12px 8px; border-bottom: 1px solid var(--line);
}
.ts-list > :last-child .ts-row, .ts-list > .ts-row:last-child { border-bottom: 0; }
.ts-date { display: grid; }
.ts-date strong { font-weight: 400; }
.ts-date span { color: var(--muted); font-size: 13.5px; }
.ts-what { display: grid; min-width: 0; }
.ts-time { font-variant-numeric: tabular-nums; }
.ts-hrs { text-align: right; font-variant-numeric: tabular-nums; }
.ts-act { display: flex; gap: 6px; justify-content: flex-end; }
.ts-sel { display: grid; grid-template-columns: auto minmax(0, 1fr); align-items: center; gap: 6px; border-bottom: 1px solid var(--line); }
.ts-sel:last-child { border-bottom: 0; }
.ts-sel .ts-row { border-bottom: 0; }
.ts-sel input[type=checkbox] { width: 22px; height: 22px; margin-left: 8px; accent-color: var(--primary); }
.ts-list .ts-row { padding-left: 14px; padding-right: 14px; }
.ts-pair { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; align-items: end; }
.ts-kpis { grid-template-columns: repeat(3, minmax(0, 1fr)); margin-bottom: 18px; }
.ts-kpis .kpi-v { font-family: var(--display); font-size: 34px; line-height: 1.05; }

/* ---------------------------------------------------------------- payroll */
.pr-nav { display: inline-flex; align-items: center; gap: 10px; }
.pr-nav-t { display: grid; min-width: 150px; text-align: center; }
.pr-nav-t strong { font-family: var(--display); font-weight: 400; font-size: 26px; line-height: 1.05; }
.pr-nav-t span { font-size: 13px; color: var(--muted); }
.pr-period-bar { justify-content: space-between; }
.pr-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.pr-status { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.pr-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.pr-note { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 12px 16px; border-radius: 14px; background: var(--warn-bg); color: #7a5214; font-size: 14.5px; }
.pr-note .linkish { margin-left: auto; color: #7a5214; font-weight: 500; }
.pr-staff { display: grid; gap: 10px; }
.pr-card { overflow: hidden; }
.pr-card-h { width: 100%; display: flex; align-items: center; gap: 14px; padding: 14px 18px; background: none; border: 0; cursor: pointer; text-align: left; font: inherit; color: var(--ink); min-height: 76px; }
.pr-card-h:hover { background: rgba(var(--soft-rgb, 0,0,0), .0); }
.pr-card-t { display: grid; flex: 1; min-width: 0; }
.pr-card-t strong { font-weight: 400; font-size: 18px; }
.pr-amt { font-family: var(--display); font-size: 28px; line-height: 1; font-variant-numeric: tabular-nums; }
.pr-chev { color: var(--faint); transition: transform .2s; }
.pr-card.open .pr-chev { transform: rotate(180deg); }
.pr-card-b { padding: 4px 18px 18px; display: grid; gap: 14px; border-top: 1px solid var(--line); }
.pr-warn { display: flex; align-items: flex-start; gap: 8px; margin: 12px 0 0; color: #7a5214; font-size: 14.5px; }
.pr-tbl { margin-top: 4px; }
.pr-reason { display: block; }
.pr-x { margin-left: 8px; width: 28px; height: 28px; border-radius: 50%; border: 0; background: var(--soft); color: var(--muted); cursor: pointer; display: inline-grid; place-items: center; vertical-align: middle; }
.pr-x:hover { background: var(--danger-bg); color: var(--danger); }
.pr-classes summary { cursor: pointer; color: var(--primary); font-size: 14.5px; min-height: 32px; display: flex; align-items: center; }
.pr-classes ul { list-style: none; margin: 8px 0 0; padding: 0; display: grid; }
.pr-classes li { display: grid; grid-template-columns: 150px minmax(0, 1fr) 100px 90px; gap: 10px; padding: 8px 0; border-bottom: 1px solid var(--line); font-size: 14.5px; }
.pr-classes li .num { text-align: right; font-variant-numeric: tabular-nums; }
.pr-none { margin: 0; }
.pr-runs { display: grid; gap: 8px; margin-top: 14px; }
.pr-run { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 16px; border: 1px solid var(--line); border-radius: 14px; background: #fff; cursor: pointer; text-align: left; font: inherit; color: var(--ink); min-height: 60px; }
.pr-run > span:first-child { display: grid; }
.pr-run.on { border-color: var(--primary); box-shadow: 0 0 0 1px var(--primary); }
.pr-run:hover { border-color: var(--accent); }
.pr-run-amt { font-family: var(--display); font-size: 24px; }
.pr-rules { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; align-items: start; }
.pr-rule-card.focus { border-color: var(--primary); box-shadow: 0 0 0 1px var(--primary), var(--shadow); }
.pr-rule-h { display: flex; align-items: center; gap: 14px; }
.pr-norule { display: flex; align-items: center; gap: 8px; margin: 14px 0 0; color: #7a5214; font-size: 14.5px; }
.pr-rule-list { list-style: none; margin: 12px 0 0; padding: 0; display: grid; }
.pr-rule-list li { display: grid; gap: 2px; padding: 12px 0; border-top: 1px solid var(--line); }
.pr-rule-list li.off { opacity: .55; }
.pr-rule-k { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 13px; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); }
.pr-rule-d { font-size: 17px; }
.pr-rule-a { display: flex; gap: 4px; margin-top: 4px; }
.pr-tiers { display: grid; gap: 10px; }
.pr-tier { display: grid; grid-template-columns: 88px auto minmax(0, 1fr) 44px; align-items: center; gap: 10px; }

/* ---------------------------------------------------------------- narrower screens */
@media (max-width: 999px) {
  .pr-rules { grid-template-columns: minmax(0, 1fr); }
  .ts-row { grid-template-columns: minmax(0, 1fr) auto; row-gap: 4px; }
  .ts-row .ts-what { grid-column: 1; }
  .ts-row .ts-hrs { grid-column: 2; grid-row: 1; }
  .ts-row .ts-st { grid-column: 1; }
  .ts-row .ts-act { grid-column: 2; grid-row: 2 / span 2; align-self: end; }
}
@media (max-width: 699px) {
  .cv-card { grid-template-columns: minmax(0, 1fr); gap: 12px; padding: 16px 16px 16px 22px; }
  .cv-card:has(.cv-actions:empty) { grid-template-columns: minmax(0, 1fr); }
  .cv-when { grid-template-columns: auto auto 1fr; align-items: baseline; column-gap: 4px; }
  .cv-when em { grid-column: auto; margin: 0 0 0 8px; }
  .cv-actions { justify-content: flex-start; }
  .cv-actions .btn { flex: 1 1 auto; min-height: 48px; }
  .cv-pick-row { grid-template-columns: 96px minmax(0, 1fr) 20px; }
  .ts-kpis { grid-template-columns: minmax(0, 1fr); }
  .pr-card-h { flex-wrap: wrap; padding: 14px; }
  .pr-card-h .pr-amt { margin-left: auto; font-size: 24px; }
  .pr-card-h .chip { order: 5; }
  .pr-chev { display: none; }
  .pr-card-b { padding: 4px 12px 14px; }
  .pr-classes li { grid-template-columns: minmax(0, 1fr) auto; }
  .pr-classes li span:nth-child(3) { display: none; }
  .pr-nav-t { min-width: 0; flex: 1; }
  .pr-nav { width: 100%; justify-content: space-between; }
  .pr-period-bar { align-items: stretch; }
  .pr-tier { grid-template-columns: 64px minmax(0, 1fr) 44px; }
  .pr-tier > .faint { display: none; }
  .ts-pair { grid-template-columns: 1fr 1fr; }
}
`;

export function installPayrollStyles(): void {
  if (typeof document === 'undefined' || document.getElementById('payroll-styles')) return;
  const el = document.createElement('style');
  el.id = 'payroll-styles';
  el.textContent = PAYROLL_CSS;
  document.head.appendChild(el);
}
