/**
 * Support settings for the whole platform. NOT per studio: support is run by the platform team in Australia,
 * so these use the platform's own timezone and hours, never a studio's.
 */
/** The platform support team's timezone. Business hours below are in this zone. */
export const SUPPORT_TZ = 'Australia/Sydney';
/** Mon to Fri (0 = Sunday). */
export const SUPPORT_DAYS = [1, 2, 3, 4, 5] as const;
/** Business hours in SUPPORT_TZ: 9am to 5pm. */
export const SUPPORT_OPEN_HOUR = 9;
export const SUPPORT_CLOSE_HOUR = 17;
/** Reply target, in business hours. */
export const SUPPORT_TARGET_HOURS = 2;
/** Public holidays and other closed days ('YYYY-MM-DD' in SUPPORT_TZ). Empty until someone fills it in. */
export const SUPPORT_CLOSED_DATES: readonly string[] = [];
/** Who answers, as the studio sees it ("Pete will reply by..."). */
export const SUPPORT_NAME = 'Pete';
/** Where urgent requests should be emailed (see NOTES.md › support: needs an outbox drain). */
export const SUPPORT_EMAIL = 'support@studioplatform.app';
/** Shown in the context sent with each request. Bump with releases. */
export const APP_VERSION = '0.1.0';
