/** The studios that ship with the codebase: Snowy (studio #1) and the demo's second sample studio. */
import type { Studio } from '../../shared/types';
import { SNOWY_STUDIO } from './snowy';
import { HARBOUR_STUDIO } from './harbour';

export { SNOWY_ID, SNOWY_STUDIO, SNOWY_BRANDING } from './snowy';
export { HARBOUR_ID, HARBOUR_STUDIO, HARBOUR_BRANDING } from './harbour';

export const BUILTIN_STUDIOS: Studio[] = [SNOWY_STUDIO, HARBOUR_STUDIO];

/** Platform admins in the demo (Pete). */
export const DEMO_PLATFORM_ADMINS = [{ email: 'pete@studioplatform.example', name: 'Pete' }];
