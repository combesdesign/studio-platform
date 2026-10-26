/**
 * Support: studio app UI. A floating Help button + status banner (own small root, since the app has no always-on slot)
 * and the #/help help centre. Every staff role can use it.
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import '../permissions';
import { registerStudioRoute } from '../../../shared/registry';
import { HelpPage } from './page';
import { Launcher } from './overlay';
import './support.css';

registerStudioRoute({ id: 'support.help', path: '/help', perm: 'support.use', render: () => <HelpPage /> });
registerStudioRoute({ id: 'support.help.article', path: '/help/:slug', perm: 'support.use', render: ({ params }) => <HelpPage slug={params.slug} /> });

if (typeof document !== 'undefined' && !document.getElementById('support-root')) {
  const host = document.createElement('div');
  host.id = 'support-root';
  const app = document.getElementById('root');
  if (app?.parentNode) app.parentNode.insertBefore(host, app); else document.body.prepend(host);
  createRoot(host).render(<Launcher />);
}
