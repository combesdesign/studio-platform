/**
 * Reviews: client app UI. One card at the top of the timetable (slot client.timetable) asks about the latest
 * checked-in class: flower stars, an optional comment and a 0 to 10 "would you recommend us?".
 */
import React from 'react';
import '../permissions';
import { registerSlot } from '../../../shared/registry';
import { ReviewCard } from './card';
import './reviews.css';

registerSlot('client.timetable', { id: 'reviews.prompt', feature: 'reviews', order: 10, render: () => <ReviewCard /> });
