/**
 * Reviews: client app UI. One card at the top of the timetable and of Bookings (slots client.timetable, client.bookings) asks about the latest
 * checked-in class: flower stars, an optional comment and a 0 to 10 "would you recommend us?".
 */
import React from 'react';
import '../permissions';
import { registerSlot } from '../../../shared/registry';
import { ReviewCard } from './card';
import './reviews.css';

registerSlot('client.timetable', { id: 'reviews.prompt', feature: 'reviews', order: 10, render: () => <ReviewCard /> });
// and again at the top of Bookings, where people look back at classes they've done
registerSlot('client.bookings', { id: 'reviews.prompt', feature: 'reviews', order: 10, render: () => <ReviewCard /> });
