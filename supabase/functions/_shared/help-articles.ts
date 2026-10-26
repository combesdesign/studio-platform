// A copy of the help centre guides (src/features/support/articles.ts) for the support-assist edge function, because
// edge functions can't import from src/. tests/support.test.ts fails if it drifts.
// Regenerate: node --import tsx scripts/sync-help-articles.mts
export const HELP_ARTICLES: { slug: string; title: string; summary: string; steps: string[]; tip?: string }[] = [
  {
    "slug": "add-a-class",
    "title": "Add a class",
    "summary": "Put a one-off class on the schedule, or set up a weekly one.",
    "steps": [
      "Open Schedule from the menu.",
      "Tap \"Add class\". For a class that repeats every week, go to Timetable and add it there instead.",
      "Pick the class type, time, instructor and how many spots.",
      "Tap Save. It shows in the client app straight away."
    ],
    "tip": "Missing a class type? Add it in Settings, then Class types."
  },
  {
    "slug": "cancel-a-class",
    "title": "Cancel a class",
    "summary": "Call off a class and let booked clients know.",
    "steps": [
      "Open the class from Today or Schedule.",
      "Tap the menu on the roster, then \"Cancel class\".",
      "Add a short note if you like. Everyone booked is emailed and gets their credit back.",
      "Confirm. The class stays on the schedule, marked as cancelled."
    ],
    "tip": "To stop a weekly class from now on, edit it in Schedule, then Timetable."
  },
  {
    "slug": "refund-a-sale",
    "title": "Refund a sale",
    "summary": "Give money back for a pass, product or gift card.",
    "steps": [
      "Open Clients and tap the person.",
      "Find the sale in their history and tap Refund.",
      "Choose how much to give back. Card payments go back to the card. Cash is recorded for you to hand over.",
      "Tick \"cancel the pass\" if the credits should come off too, add a reason, then confirm."
    ],
    "tip": "Only owners and managers can refund."
  },
  {
    "slug": "change-a-clients-pass",
    "title": "Change a client's pass",
    "summary": "Add credits, extend an expiry, pause or swap a pass.",
    "steps": [
      "Open Clients and tap the person.",
      "Find the pass on their profile and tap it.",
      "Choose Adjust. Add or remove credits, change the expiry date, or pause it.",
      "Add a short note so the team knows why, then Save. It is kept in their history."
    ],
    "tip": "To give a different pass altogether, sell it from Point of sale with a discount."
  },
  {
    "slug": "add-a-staff-member",
    "title": "Add a staff member",
    "summary": "Invite an instructor, front desk or manager.",
    "steps": [
      "Open Settings, then Staff.",
      "Add the person with their name and email.",
      "Choose a role. Instructors see their own classes. Front desk can check people in and sell. Managers can do most things. Owners can do everything.",
      "Send the invite. They get an email to set a password."
    ],
    "tip": "Only owners can add managers or other owners."
  },
  {
    "slug": "set-up-the-kiosk",
    "title": "Set up the kiosk",
    "summary": "Let clients check themselves in on a tablet at the front desk.",
    "steps": [
      "Open Settings, then Kiosk and set a staff PIN.",
      "On the tablet, open the studio app in the browser and go to Kiosk mode.",
      "Clients search their name and tap their class to check in.",
      "Add it to the tablet home screen so it opens full screen. Use the PIN to leave kiosk mode."
    ],
    "tip": "Turn on guided access (iPad) or screen pinning (Android) so the kiosk is the only thing on the tablet."
  },
  {
    "slug": "sell-a-gift-card",
    "title": "Sell a gift card",
    "summary": "Sell one at the desk or let clients buy them online.",
    "steps": [
      "Open Point of sale.",
      "Tap a gift card amount (or a custom one). Add the buyer if you want them to get a receipt.",
      "Choose the payment and finish the sale. The gift card gets a code.",
      "Give the code to the buyer, or enter the recipient email and we send it for you.",
      "To use one later, type the code in the box under the cart at checkout."
    ],
    "tip": "Set the gift card amounts in Settings, then Shop."
  },
  {
    "slug": "add-an-online-video",
    "title": "Add an online video",
    "summary": "Put a recorded class in your on-demand library.",
    "steps": [
      "Open Online classes from the menu.",
      "Tap \"Add video\".",
      "Paste the video link (from Vimeo or YouTube), then add a title, length and short description.",
      "Choose who can watch: everyone, or only people with a pass or membership.",
      "Publish it. It shows in the Online tab of the client app."
    ],
    "tip": "Set the video to unlisted on Vimeo or YouTube so only your clients can find it."
  },
  {
    "slug": "change-branding",
    "title": "Change branding",
    "summary": "Update your colours, logo and the look of your app.",
    "steps": [
      "Open Settings, then Branding.",
      "Pick a colour palette or set your own colours.",
      "Upload your logo or mark. A square image on a plain background works best.",
      "Check the preview, then Save. Your client app updates straight away."
    ],
    "tip": "Clients may need to close and reopen the app to see a new logo."
  },
  {
    "slug": "export-payroll",
    "title": "Export payroll",
    "summary": "Get what each instructor is owed for a pay period.",
    "steps": [
      "Open Payroll from the menu.",
      "Choose the pay period (this fortnight, last month, or your own dates).",
      "Check each person and fix any class or shift that looks off.",
      "Tap Export to download the CSV for your accountant or payroll software."
    ],
    "tip": "Set each person's pay rules first, in Settings, then Pay + cover."
  }
];
