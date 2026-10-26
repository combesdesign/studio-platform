/**
 * Reviews: studio app UI. "Reviews" in the nav (owner, manager, instructors), Settings › Reviews for the Google link.
 */
import React from 'react';
import '../permissions';
import { registerSettingsTab, registerStudioNav, registerStudioRoute } from '../../../shared/registry';
import { ReviewsPage } from './page';
import { ReviewsSettingsTab } from './settings';
import './reviews.css';

registerStudioNav({ id: 'reviews', feature: 'reviews', label: 'Reviews', short: 'Reviews', icon: 'flower', href: '#/reviews', order: 55, perm: 'reviews.view' });
registerStudioRoute({ id: 'reviews', feature: 'reviews', path: '/reviews', nav: 'reviews', perm: 'reviews.view', render: () => <ReviewsPage /> });
registerSettingsTab({ id: 'reviews', feature: 'reviews', label: 'Reviews', order: 55, perm: 'reviews.manage', render: () => <ReviewsSettingsTab /> });
