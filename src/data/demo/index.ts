// PLACEHOLDER — replaced by the demo-store agent.
import type { DataStore } from '../../shared/store';
export function createDemoStore(): DataStore { return { mode: 'demo', subscribe: () => () => {} } as unknown as DataStore; }
