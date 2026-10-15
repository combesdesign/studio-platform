/**
 * Studio app entry (served at /studio/). The studio comes from the build config, the address
 * (subdomain, #/s/<slug>, ?studio=) or what was picked last on this device; otherwise from the staff
 * member's own memberships (./choose.tsx), with a switcher in the app when they work at several studios.
 */
import React from 'react';
import '../shared/theme.css';
import './studio.css';
import { bootApp } from '../shared/boot';
import { ChooseStudio } from './choose';

bootApp('studio', {
  load: () => import('./app'),
  fallback: ({ start, missing }) => <ChooseStudio start={start} missing={missing} />,
});
