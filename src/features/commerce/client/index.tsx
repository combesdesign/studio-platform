/**
 * Commerce: client app UI.
 *   /gift-cards       your cards, balance check, buy button      (Profile entry "Gift cards")
 *   /gift-cards/buy   buy a gift card with a live e-card preview
 *   /refer            your referral code and friends             (Profile entry "Bring a friend")
 *   client.shop       Passes tab: gift card banner + "Have a code?" checkout (promo codes, gift cards, credit)
 *   client.timetable  invisible: claims a ?ref=CODE link once the client is signed in
 */
import React from 'react';
import '../permissions';
import { registerClientProfileEntry, registerClientRoute, registerSlot } from '../../../shared/registry';
import { BuyGiftCardScreen, FriendsIcon, GiftCardsScreen, GiftIcon, ReferScreen, ReferralClaimer, ShopExtras, captureReferral } from './screens';
import '../commerce.css';
import './client.css';

captureReferral();

registerClientRoute({ id: 'commerce.gift-cards', feature: 'commerce', path: '/gift-cards', tab: '/profile', render: ({ nav, path }) => <GiftCardsScreen nav={nav} path={path} /> });
registerClientRoute({ id: 'commerce.gift-cards.buy', feature: 'commerce', path: '/gift-cards/buy', chrome: false, render: ({ nav, path }) => <BuyGiftCardScreen nav={nav} path={path} /> });
registerClientRoute({ id: 'commerce.refer', feature: 'commerce', path: '/refer', tab: '/profile', render: ({ nav, path }) => <ReferScreen nav={nav} path={path} /> });

registerClientProfileEntry({ id: 'commerce.gift-cards', feature: 'commerce', label: 'Gift cards', sub: 'Buy one, or check a balance', icon: <GiftIcon />, path: '/gift-cards', order: 20 });
registerClientProfileEntry({ id: 'commerce.refer', feature: 'commerce', label: 'Bring a friend', sub: 'Share your code and earn credit', icon: <FriendsIcon />, path: '/refer', order: 21 });

registerSlot('client.shop', { id: 'commerce.shop', feature: 'commerce', order: 20, render: () => <ShopExtras /> });
registerSlot('client.timetable', { id: 'commerce.referral', feature: 'commerce', order: 90, render: () => <ReferralClaimer /> });
