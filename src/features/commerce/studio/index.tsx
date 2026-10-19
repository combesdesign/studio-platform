/**
 * Commerce: studio app UI.
 *   Shop (#/shop/<tab>)        gift cards, promo codes, referrals, retail stock + stock report
 *   Settings › Shop            gift card amounts/expiry, referral reward, low-stock level
 *   Today › Low stock          side widget
 *   pos.products / pos.cart    barcode entry, gift card tiles; promo codes and gift cards at the till
 *   client.profile             gift cards, credit and referrals for that client
 */
import React from 'react';
import '../permissions';
import { registerSettingsTab, registerSlot, registerStudioNav, registerStudioRoute, registerTodayWidget } from '../../../shared/registry';
import { ShopPage } from './shop';
import { ShopSettings } from './settings';
import { PosCodes, PosProducts } from './pos';
import { ClientCommerceCard, LowStockWidget } from './widgets';
import '../commerce.css';
import './studio.css';

registerStudioNav({ id: 'commerce', label: 'Shop', short: 'Shop', icon: 'gift', href: '#/shop', order: 45, perm: 'commerce.view' });
registerStudioRoute({ id: 'commerce', path: '/shop', nav: 'commerce', perm: 'commerce.view', render: () => <ShopPage /> });
registerStudioRoute({ id: 'commerce.tab', path: '/shop/:tab', nav: 'commerce', perm: 'commerce.view', render: ({ params }) => <ShopPage tab={params.tab} /> });
registerSettingsTab({ id: 'commerce', label: 'Shop', order: 45, perm: 'commerce.manage', render: () => <ShopSettings /> });
registerTodayWidget({ id: 'commerce.lowstock', column: 'side', order: 30, perm: 'commerce.stock', render: () => <LowStockWidget /> });

registerSlot('pos.products', { id: 'commerce.pos', order: 10, render: ({ clientId }) => <PosProducts clientId={clientId} /> });
registerSlot('pos.cart', { id: 'commerce.codes', order: 10, perm: 'commerce.sell', render: (p) => <PosCodes clientId={p.clientId} subtotalCents={p.subtotalCents} setDiscount={p.setDiscount} /> });
registerSlot('client.profile', { id: 'commerce.client', order: 40, perm: 'commerce.view', render: ({ client }) => <ClientCommerceCard client={client} /> });
