/**
 * Notice board: client app UI. Compact notice cards at the very top of the timetable (slot client.timetable, above the date strip,
 * the classes and the "register interest" block).
 */
import React from 'react';
import '../permissions';
import { registerSlot } from '../../../shared/registry';
import { NoticeBoard } from './board';
import './notices.css';

registerSlot('client.timetable', { id: 'notices.board', feature: 'notices', order: 5, render: () => <NoticeBoard /> });
