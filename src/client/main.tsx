/**
 * Client app entry. Works out the studio (build config -> subdomain / custom domain -> #/s/<slug> -> ?studio=
 * -> remembered), binds the store, applies the studio's branding, then loads the app (./app.tsx).
 * No studio: "Find your studio" (./picker.tsx).
 */
import React from 'react';
import '../shared/theme.css';
import './client.css';
import { bootApp } from '../shared/boot';
import { Closed, FindStudio } from './picker';

bootApp('client', {
  load: () => import('./app'),
  fallback: ({ start, missing }) => <FindStudio start={start} missing={missing} />,
  closed: (studio) => (studio.status === 'live' || (studio.status === 'onboarding' && /[?&]preview=1/.test(location.search)) ? null : <Closed studio={studio} />),
});
