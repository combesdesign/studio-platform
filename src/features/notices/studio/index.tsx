/** Notice board: studio app UI. Settings › Notice board (owner and manager): post, edit, pin and remove notices. */
import React from 'react';
import '../permissions';
import { registerSettingsTab } from '../../../shared/registry';
import { NoticesSettingsTab } from './page';

registerSettingsTab({ id: 'notices', feature: 'notices', label: 'Notice board', order: 25, perm: 'notices.manage', render: () => <NoticesSettingsTab /> });
