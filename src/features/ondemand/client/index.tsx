/**
 * Online classes: client app UI. An "Online" tab (library) and a player screen (/online/:id).
 */
import React from 'react';
import '../permissions';
import { registerClientRoute, registerClientTab } from '../../../shared/registry';
import { Library, WatchScreen } from './screens';
import './ondemand.css';

registerClientTab({ id: 'ondemand.library', path: '/online', label: 'Online', icon: 'play', order: 35 });
registerClientRoute({ id: 'ondemand.library', path: '/online', tab: '/online', render: ({ nav }) => <Library nav={nav} /> });
registerClientRoute({ id: 'ondemand.watch', path: '/online/:id', tab: '/online', render: ({ params, nav }) => <WatchScreen id={params.id ?? ''} nav={nav} /> });
