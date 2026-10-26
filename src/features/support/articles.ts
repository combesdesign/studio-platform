/**
 * The help centre: short plain-English guides, kept as data. Search is simple keyword + fuzzy matching, no AI.
 * Steps name the real screens of the studio app (Schedule, Clients, Point of sale, Settings, ...).
 */
export interface HelpArticle {
  slug: string;
  title: string;
  /** One line shown in lists and suggestions. */
  summary: string;
  steps: string[];
  /** Extra words people might type that aren't in the title (synonyms, typos). */
  keywords: string[];
  tip?: string;
}

export const ARTICLES: HelpArticle[] = [
  {
    slug: 'add-a-class', title: 'Add a class', summary: 'Put a one-off class on the schedule, or set up a weekly one.',
    keywords: ['schedule', 'create', 'new class', 'session', 'timetable', 'weekly', 'repeat', 'recurring', 'put on'],
    steps: [
      'Open Schedule from the menu.',
      'Tap "Add class". For a class that repeats every week, go to Timetable and add it there instead.',
      'Pick the class type, time, instructor and how many spots.',
      'Tap Save. It shows in the client app straight away.',
    ],
    tip: 'Missing a class type? Add it in Settings, then Class types.',
  },
  {
    slug: 'cancel-a-class', title: 'Cancel a class', summary: 'Call off a class and let booked clients know.',
    keywords: ['cancelled', 'call off', 'remove class', 'delete class', 'sick', 'instructor away', 'notify', 'email clients', 'credits back'],
    steps: [
      'Open the class from Today or Schedule.',
      'Tap the menu on the roster, then "Cancel class".',
      'Add a short note if you like. Everyone booked is emailed and gets their credit back.',
      'Confirm. The class stays on the schedule, marked as cancelled.',
    ],
    tip: 'To stop a weekly class from now on, edit it in Schedule, then Timetable.',
  },
  {
    slug: 'refund-a-sale', title: 'Refund a sale', summary: 'Give money back for a pass, product or gift card.',
    keywords: ['refund', 'money back', 'return', 'wrong charge', 'charged twice', 'reverse', 'undo sale', 'void', 'receipt', 'payment'],
    steps: [
      'Open Clients and tap the person.',
      'Find the sale in their history and tap Refund.',
      'Choose how much to give back. Card payments go back to the card. Cash is recorded for you to hand over.',
      'Tick "cancel the pass" if the credits should come off too, add a reason, then confirm.',
    ],
    tip: 'Only owners and managers can refund.',
  },
  {
    slug: 'change-a-clients-pass', title: "Change a client's pass", summary: 'Add credits, extend an expiry, pause or swap a pass.',
    keywords: ['pass', 'credits', 'extend', 'expiry', 'expire', 'membership', 'pause', 'freeze', 'add credit', 'top up', 'adjust', 'pack', 'unlimited', 'intro offer'],
    steps: [
      'Open Clients and tap the person.',
      'Find the pass on their profile and tap it.',
      'Choose Adjust. Add or remove credits, change the expiry date, or pause it.',
      'Add a short note so the team knows why, then Save. It is kept in their history.',
    ],
    tip: 'To give a different pass altogether, sell it from Point of sale with a discount.',
  },
  {
    slug: 'add-a-staff-member', title: 'Add a staff member', summary: 'Invite an instructor, front desk or manager.',
    keywords: ['staff', 'instructor', 'teacher', 'invite', 'new starter', 'employee', 'login', 'access', 'role', 'permissions', 'manager', 'front desk', 'remove staff'],
    steps: [
      'Open Settings, then Staff.',
      'Add the person with their name and email.',
      'Choose a role. Instructors see their own classes. Front desk can check people in and sell. Managers can do most things. Owners can do everything.',
      'Send the invite. They get an email to set a password.',
    ],
    tip: 'Only owners can add managers or other owners.',
  },
  {
    slug: 'set-up-the-kiosk', title: 'Set up the kiosk', summary: 'Let clients check themselves in on a tablet at the front desk.',
    keywords: ['kiosk', 'tablet', 'ipad', 'check in', 'check-in', 'self check in', 'front desk', 'pin', 'door'],
    steps: [
      'Open Settings, then Kiosk and set a staff PIN.',
      'On the tablet, open the studio app in the browser and go to Kiosk mode.',
      'Clients search their name and tap their class to check in.',
      'Add it to the tablet home screen so it opens full screen. Use the PIN to leave kiosk mode.',
    ],
    tip: 'Turn on guided access (iPad) or screen pinning (Android) so the kiosk is the only thing on the tablet.',
  },
  {
    slug: 'sell-a-gift-card', title: 'Sell a gift card', summary: 'Sell one at the desk or let clients buy them online.',
    keywords: ['gift card', 'giftcard', 'voucher', 'gift voucher', 'present', 'code', 'redeem', 'balance', 'christmas'],
    steps: [
      'Open Point of sale.',
      'Tap a gift card amount (or a custom one). Add the buyer if you want them to get a receipt.',
      'Choose the payment and finish the sale. The gift card gets a code.',
      'Give the code to the buyer, or enter the recipient email and we send it for you.',
      'To use one later, type the code in the box under the cart at checkout.',
    ],
    tip: 'Set the gift card amounts in Settings, then Shop.',
  },
  {
    slug: 'add-an-online-video', title: 'Add an online video', summary: 'Put a recorded class in your on-demand library.',
    keywords: ['video', 'online class', 'on demand', 'on-demand', 'recorded', 'library', 'vimeo', 'youtube', 'stream', 'upload', 'virtual'],
    steps: [
      'Open Online classes from the menu.',
      'Tap "Add video".',
      'Paste the video link (from Vimeo or YouTube), then add a title, length and short description.',
      'Choose who can watch: everyone, or only people with a pass or membership.',
      'Publish it. It shows in the Online tab of the client app.',
    ],
    tip: 'Set the video to unlisted on Vimeo or YouTube so only your clients can find it.',
  },
  {
    slug: 'change-branding', title: 'Change branding', summary: 'Update your colours, logo and the look of your app.',
    keywords: ['branding', 'logo', 'colour', 'color', 'theme', 'fonts', 'look', 'appearance', 'app name', 'design', 'palette', 'icon'],
    steps: [
      'Open Settings, then Branding.',
      'Pick a colour palette or set your own colours.',
      'Upload your logo or mark. A square image on a plain background works best.',
      'Check the preview, then Save. Your client app updates straight away.',
    ],
    tip: 'Clients may need to close and reopen the app to see a new logo.',
  },
  {
    slug: 'export-payroll', title: 'Export payroll', summary: 'Get what each instructor is owed for a pay period.',
    keywords: ['payroll', 'pay', 'wages', 'instructor pay', 'timesheet', 'csv', 'export', 'xero', 'payrun', 'pay run', 'hours', 'superannuation'],
    steps: [
      'Open Payroll from the menu.',
      'Choose the pay period (this fortnight, last month, or your own dates).',
      'Check each person and fix any class or shift that looks off.',
      'Tap Export to download the CSV for your accountant or payroll software.',
    ],
    tip: 'Set each person\'s pay rules first, in Settings, then Pay + cover.',
  },
];

// ------------------------------------------------------------------ search
const STOP = new Set(['the', 'an', 'to', 'of', 'and', 'or', 'is', 'it', 'in', 'on', 'for', 'my', 'me', 'we', 'can', 'cant', 'how', 'do', 'does', 'did', 'not', 'with', 'this', 'that', 'but', 'was', 'are', 'be', 'you', 'your', 'our', 'have', 'has', 'get', 'got', 'need', 'want', 'please', 'help', 'when', 'what', 'why', 'there', 'they', 'them', 'its', 'at', 'so', 'if']);

const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s'-]/g, ' ').split(/[\s-]+/).map((w) => w.replace(/^'+|'+$/g, '')).filter((w) => w.length > 1 && !STOP.has(w));

/** Light stemming so "cancelling", "cancelled" and "cancel" meet; "refunds" meets "refund". */
function stem(w: string): string {
  const s = w.replace(/(ing|ed|es|s)$/, (m) => (w.length - m.length >= 3 ? '' : m));
  return s.replace(/(.)\1$/, '$1');
}

/** Are two words one edit apart (or equal)? */
function within1(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (a.length > b.length) i++; else if (a.length < b.length) j++; else { i++; j++; }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

function hit(q: string, t: string): number {
  if (q === t) return 1;
  if (q.length >= 3 && (t.startsWith(q) || (t.length >= 4 && q.startsWith(t)))) return 0.8;
  if (q.length >= 5 && within1(q, t)) return 0.6;
  return 0;
}

/** Score one article for the words typed. 0 = no match. */
export function scoreArticle(a: HelpArticle, query: string): number {
  const q = words(query).map(stem);
  if (!q.length) return 0;
  const title = words(a.title).map(stem);
  const keys = words(a.keywords.join(' ')).map(stem);
  const body = words(a.summary + ' ' + a.steps.join(' ')).map(stem);
  const phrase = query.toLowerCase();
  let score = 0;
  for (const w of q) score += Math.max(...title.map((t) => hit(w, t) * 3), ...keys.map((k) => hit(w, k) * 2), ...body.map((b) => hit(w, b) * 0.5), 0);
  for (const k of a.keywords) if (k.includes(' ') && phrase.includes(k)) score += 2;
  return score;
}

/** Up to `limit` articles that fit what's been typed, best first. Needs at least a few letters. */
export function searchArticles(query: string, limit = 3, list: HelpArticle[] = ARTICLES): HelpArticle[] {
  if (query.trim().length < 3) return [];
  return list
    .map((a) => ({ a, s: scoreArticle(a, query) }))
    .filter((x) => x.s >= 1.2)
    .sort((x, y) => y.s - x.s || x.a.title.localeCompare(y.a.title))
    .slice(0, limit)
    .map((x) => x.a);
}
