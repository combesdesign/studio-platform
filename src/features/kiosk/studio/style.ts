/** Kiosk styles, injected into <head> by studio/index.tsx. Role tokens only, so it wears each studio's branding. */
export const KIOSK_CSS = `
.kiosk { position: fixed; inset: 0; z-index: 100; display: flex; flex-direction: column; overflow: auto; background: var(--bg); color: var(--ink);
  -webkit-user-select: none; user-select: none; touch-action: manipulation; font-family: var(--body); }
.kiosk button { font: inherit; color: inherit; cursor: pointer; -webkit-tap-highlight-color: transparent; }
.k-top { display: flex; align-items: center; justify-content: space-between; padding: 28px 44px 8px; gap: 24px; }
.k-logo { height: 60px; width: auto; max-width: 60vw; }
.k-clock { font-family: var(--display); font-size: 34px; color: var(--muted); }
.k-main { flex: 1; width: 100%; max-width: 1040px; margin: 0 auto; padding: 8px 44px 24px; display: flex; flex-direction: column; }
.kiosk h1 { font-family: var(--display); font-weight: 400; font-size: clamp(40px, 6vw, 60px); line-height: 1.05; margin: 12px 0 6px; letter-spacing: -.01em; }
.kiosk h1 em, .kiosk h2 em { font-style: italic; color: var(--accent); }
.kiosk h2 { font-family: var(--display); font-weight: 400; font-size: 34px; margin: 0 0 10px; text-align: center; }
.k-sub { font-size: 20px; color: var(--muted); margin: 0 0 22px; }
.k-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 16px; }
.k-card { display: flex; flex-direction: column; align-items: flex-start; gap: 4px; text-align: left; min-height: 170px; padding: 26px 28px;
  background: #fff; border: 1px solid var(--line); border-radius: 22px; box-shadow: 0 6px 24px rgba(var(--ink-rgb), .06); }
.k-card:active, .k-person:active:not(:disabled) { transform: scale(.98); background: var(--soft); }
.k-time { font-family: var(--display); font-size: 44px; line-height: 1; color: var(--primary); }
.k-card strong { font-size: 24px; font-weight: 600; margin-top: 8px; }
.k-meta { font-size: 18px; color: var(--muted); }
.k-when { margin-top: auto; padding: 6px 14px; border-radius: 99px; background: var(--soft); font-size: 16px; font-weight: 600; }
.k-back { align-self: flex-start; display: inline-flex; align-items: center; gap: 6px; min-height: 52px; padding: 0 20px 0 12px; background: var(--soft); border: 0; border-radius: 99px; font-size: 18px; margin-top: 4px; }
.k-search { width: 100%; box-sizing: border-box; height: 68px; padding: 0 24px; font: inherit; font-size: 24px; color: var(--ink); background: #fff; border: 1.5px solid var(--line); border-radius: 18px; margin-bottom: 18px;
  -webkit-user-select: text; user-select: text; }
.k-search:focus { outline: 3px solid rgba(var(--primary-rgb), .25); border-color: var(--primary); }
.k-people { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 12px; }
.k-person { display: flex; align-items: center; gap: 14px; min-height: 76px; padding: 10px 18px 10px 12px; text-align: left; background: #fff; border: 1px solid var(--line); border-radius: 18px; }
.k-person.in { background: var(--soft); opacity: .6; cursor: default; }
.k-av { flex: none; display: grid; place-items: center; width: 52px; height: 52px; border-radius: 50%; background: var(--soft); color: var(--primary); font-family: var(--display); font-size: 26px; }
.k-nm { flex: 1; min-width: 0; font-size: 22px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.k-tick { color: var(--ok); }
.k-problem { background: var(--danger-bg); color: var(--danger); border-radius: 14px; padding: 14px 18px; font-size: 18px; margin: 0 0 16px; }
.k-empty { margin: 40px auto; text-align: center; font-size: 22px; color: var(--muted); line-height: 1.5; display: grid; justify-items: center; gap: 8px; }
.k-done { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; text-align: center; background: none; border: 0; padding: 0; animation: kfade .3s ease; }
.k-done h1 { margin: 20px 0 0; font-size: clamp(48px, 8vw, 84px); }
.k-done p { margin: 0; font-family: var(--display); font-size: 36px; color: var(--muted); }
.k-desk { margin-top: 22px; padding: 14px 26px; border-radius: 99px; background: var(--highlight); font-size: 22px; font-weight: 600; }
.k-foot { display: flex; justify-content: flex-end; padding: 8px 44px 24px; }
.k-exit { min-height: 48px; padding: 0 20px; background: none; border: 1px solid var(--line); border-radius: 99px; color: var(--muted); font-size: 16px; }
.k-scrim { position: fixed; inset: 0; z-index: 101; display: grid; place-items: center; background: rgba(var(--shade-rgb), .5); backdrop-filter: blur(3px); padding: 16px; animation: kfade .2s ease; }
.k-modal { width: min(400px, 100%); background: var(--bg); border-radius: 26px; padding: 30px 28px 26px; box-shadow: 0 20px 60px rgba(var(--shade-rgb), .35); }
.k-modal .k-sub { text-align: center; font-size: 17px; }
.k-dots { display: flex; justify-content: center; gap: 16px; margin: 6px 0 4px; }
.k-dots span { width: 18px; height: 18px; border-radius: 50%; border: 2px solid var(--primary); }
.k-dots span.on { background: var(--primary); }
.k-err { min-height: 24px; margin: 8px 0; text-align: center; color: var(--danger); font-size: 17px; }
.k-pad { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; justify-items: center; }
.k-pad button { width: 84px; height: 84px; border-radius: 50%; border: 1px solid var(--line); background: #fff; font-family: var(--display); font-size: 34px; }
.k-pad button:active { background: var(--soft); }
.k-pad button.quiet { background: none; border: 0; font-family: var(--body); font-size: 18px; color: var(--muted); }
.k-actions { display: flex; gap: 12px; justify-content: flex-end; }
.k-btn { min-height: 56px; padding: 0 28px; border: 0; border-radius: 99px; background: var(--primary); color: #fff; font-size: 18px; font-weight: 600; }
.k-btn.quiet { background: var(--soft); color: var(--ink); }
.k-btn:disabled { opacity: .5; }
@keyframes kfade { from { opacity: 0; } to { opacity: 1; } }
@media (max-width: 700px) { .k-top, .k-foot { padding-left: 20px; padding-right: 20px; } .k-main { padding-left: 20px; padding-right: 20px; } }
`;

export function installKioskStyles(): void {
  if (typeof document === 'undefined' || document.getElementById('kiosk-styles')) return;
  const el = document.createElement('style');
  el.id = 'kiosk-styles';
  el.textContent = KIOSK_CSS;
  document.head.appendChild(el);
}
