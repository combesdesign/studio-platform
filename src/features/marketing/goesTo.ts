/** The places a button can open in the app. The stored values are the same as before: `{{app_url}}` (filled in per studio when sent) with an optional #/page on the end. */
export const GOES_TO = [
  { label: 'App home', value: '{{app_url}}' },
  { label: 'Timetable', value: '{{app_url}}#/' },
  { label: 'Passes', value: '{{app_url}}#/passes' },
] as const;

