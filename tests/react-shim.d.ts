// The registry (imported by tests/plans.test.ts) only needs React's types for signatures; core checking doesn't install @types/react.
declare module 'react' {
  export type ReactNode = unknown;
  export type ReactElement = unknown;
  export type ComponentType<P = unknown> = (props: P) => unknown;
}
