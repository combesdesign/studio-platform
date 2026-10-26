/**
 * Online classes: studio app UI. "Online classes" in the nav (owner, manager) and Settings › Online classes
 * (which products include online access).
 */
import React from 'react';
import '../permissions';
import { registerSettingsTab, registerStudioNav, registerStudioRoute } from '../../../shared/registry';
import { OnDemandPage } from './page';
import { OnDemandSettingsTab } from './settings';
import './ondemand.css';

registerStudioNav({ id: 'ondemand', feature: 'ondemand', label: 'Online classes', short: 'Online', icon: 'play', href: '#/online', order: 56, perm: 'ondemand.manage' });
registerStudioRoute({ id: 'ondemand', feature: 'ondemand', path: '/online', nav: 'ondemand', perm: 'ondemand.manage', render: () => <OnDemandPage /> });
registerSettingsTab({ id: 'online', feature: 'ondemand', label: 'Online classes', order: 56, perm: 'ondemand.manage', render: () => <OnDemandSettingsTab /> });
