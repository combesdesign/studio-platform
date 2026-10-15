/** <Slot name="client.profile" props={{ client }} can={can} />: renders every feature registered for a slot. */
import React from 'react';
import { slotEntries, type SlotName, type SlotProps } from './registry';

class SlotBoundary extends React.Component<{ id: string; children: React.ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(e: unknown) { console.warn(`[slot ${this.props.id}]`, e); }
  render() { return this.state.failed ? null : this.props.children; }
}

/** A feature's slot content that throws is hidden (and logged as a warning), so one feature can't break a core screen. */
export function Slot<N extends SlotName>({ name, props, can, wrap }: { name: N; props: SlotProps[N]; can?: (perm: string) => boolean; wrap?: (node: React.ReactNode, id: string) => React.ReactNode }) {
  const list = slotEntries(name).filter((e) => !e.perm || !can || can(e.perm));
  if (!list.length) return null;
  return <>{list.map((e) => <SlotBoundary key={e.id} id={e.id}>{wrap ? wrap(e.render(props), e.id) : e.render(props)}</SlotBoundary>)}</>;
}
