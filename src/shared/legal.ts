/**
 * !!! DRAFT: TO BE REVIEWED BY A LAWYER BEFORE ANY STUDIO RELIES ON IT !!!
 *
 * Template for each studio's Privacy Policy and Terms of Use. Written in plain English for Australian studios
 * (Privacy Act 1988 and the Australian Privacy Principles, Australian Consumer Law). It is a starting point, not legal advice.
 * Nobody has checked it against a studio's real set-up. Before a studio goes live (and before the app store listings use the
 * links) a lawyer should read it, and the studio should confirm the facts in it are true for them (who they share data with,
 * how long they keep records, where the data lives).
 *
 * How it works: `privacyPolicy(ctx)` and `termsOfUse(ctx)` return a structured document with the studio's details filled in
 * (name, ABN, contact email, address come from Settings; platform details are the constants below). The client app draws it at
 * `#/privacy` and `#/terms`, which work signed out. A studio can replace either text in Settings > Policies (then that text
 * is shown as is, and this template is not used).
 */

/** The platform operator (the software provider). Keep in step with the real legal entity before launch. */
export const PLATFORM_LEGAL = {
  name: 'Studio Platform',
  email: 'support@studioplatform.app',
} as const;

export interface LegalContext {
  studioName: string;
  /** ABN (or the studio's tax id) if they have one. */
  abn?: string | undefined;
  abnLabel?: string | undefined;
  email: string;
  phone?: string | undefined;
  address: string;
}

export interface LegalSection { heading: string; paragraphs?: string[]; bullets?: string[] }
export interface LegalDoc { title: string; intro: string; sections: LegalSection[]; updated: string }

/** When this template was last changed (shown on the page when the studio hasn't set its own date). */
export const LEGAL_TEMPLATE_UPDATED = '3 November 2026';

const who = (c: LegalContext): string => c.studioName || 'the studio';
const abnLine = (c: LegalContext): string => (c.abn ? ` (${c.abnLabel || 'ABN'} ${c.abn})` : '');
const contact = (c: LegalContext): string =>
  [c.email && `email ${c.email}`, c.phone && `phone ${c.phone}`, c.address && `write to ${c.address}`].filter(Boolean).join(', or ') || 'ask at the studio';

export function privacyPolicy(c: LegalContext): LegalDoc {
  const s = who(c);
  return {
    title: 'Privacy policy',
    updated: LEGAL_TEMPLATE_UPDATED,
    intro: `${s}${abnLine(c)} looks after your personal information under the Privacy Act 1988 (Cth) and the Australian Privacy Principles. This page explains what we collect when you use our app and website, why, who sees it, and your choices.`,
    sections: [
      {
        heading: 'Who we are',
        paragraphs: [
          `${s}${abnLine(c)} is the studio you book with, and is responsible for your information. You can ${contact(c)}.`,
          `${PLATFORM_LEGAL.name} provides the booking software the studio uses. It stores your information on the studio's behalf, only to run the app for the studio, and does not use it for anything else. You can reach ${PLATFORM_LEGAL.name} at ${PLATFORM_LEGAL.email}.`,
        ],
      },
      {
        heading: 'What we collect',
        bullets: [
          'Your details: name, email, mobile, date of birth (if you give it) and your emergency contact.',
          'Your login: your email and a password. The password is stored scrambled, so nobody at the studio or the platform can read it.',
          'Health and injury information: the answers on your health form, any injuries, conditions or pregnancy you tell us about, and when you signed the waiver. This is sensitive information under the Privacy Act, so we only collect it with your consent and handle it with extra care.',
          'Your photo, if you choose to add one.',
          'Your classes and passes: what you booked, whether you attended, what you bought, and your receipts.',
          'Messages you send the studio, and your choices about news and offers.',
          'Your device: if you switch on notifications, a token that lets us send them to your phone. We do not use advertising trackers or sell data.',
          'Notes the studio keeps about you, such as how you like to be looked after in class. Only studio staff see these.',
          'Payments: card details go straight to Stripe. We never see or store your full card number.',
        ],
      },
      {
        heading: 'Why we collect it',
        bullets: [
          'To run your account, take your bookings, manage your passes and memberships, and send receipts and reminders.',
          'To keep you safe in class. Your instructor sees the injuries and health notes you have given us for classes you are booked into, so they can adjust the work for you.',
          'To take payment and keep the financial records the law requires.',
          'To tell you about news and offers, but only if you have said yes. You can change your mind in Profile at any time, or use the unsubscribe link in any email.',
          'To keep the app secure and fix problems.',
        ],
        paragraphs: ['We do not use your health information for marketing, and we do not sell your information.'],
      },
      {
        heading: 'Who it is shared with',
        paragraphs: ['Only the people and services that help us run the studio for you:'],
        bullets: [
          `${s} staff, based on their role. Instructors see class lists and health notes for their classes. The front desk and managers see client records. Pay and financial details are limited to owners.`,
          'Supabase: our database, login system and photo storage.',
          'Stripe: card payments and memberships.',
          'Resend: sending emails such as receipts, booking confirmations and reminders.',
          'Twilio: sending text messages, only if the studio has turned on SMS.',
          'Anthropic: the studio team has a Help assistant inside the studio app. It only gets the question the staff member types, the page they are on and the studio\'s booking settings. It is not given client records.',
          'Tools the studio turns on, such as accounting software, which receive sales totals and receipts.',
          'Anyone else only when the law requires it, or with your consent.',
        ],
      },
      {
        heading: 'Where it is stored',
        paragraphs: [
          'Your information is stored in a database in Australia (Sydney). Some of the services above, such as Stripe, Resend, Twilio and Anthropic, process information in other countries, including the United States, when they do their job for us. We choose providers that protect information to a standard like the Australian Privacy Principles, and we only send them what they need.',
        ],
      },
      {
        heading: 'How long we keep it',
        bullets: [
          'While you have an account, we keep your details so the app works.',
          'If you delete your account, your login, personal details, photo, health information and notes are deleted or anonymised straight away (see Deleting your account).',
          'Booking and sales records are kept for at least five years because tax law requires the studio to. After you delete your account they stay, but with your name and details removed, so they can no longer be tied to you.',
          'Backups are replaced on a regular cycle, so deleted details drop out of backups shortly after.',
        ],
      },
      {
        heading: 'Seeing and correcting your information',
        paragraphs: [
          `You can see and change most of your details in the app under Profile. You can ask for a copy of everything we hold about you, or ask us to correct something, by contacting us (${contact(c)}). We will respond within 30 days and will not charge you for asking.`,
        ],
      },
      {
        heading: 'Deleting your account',
        paragraphs: [
          'In the app, go to Profile, then Account, then Delete my account. When you confirm: your login is removed; your personal details, photo and health information are deleted or anonymised; booking and sales records stay, anonymised, for the studio\'s tax records; and any active memberships are cancelled in Stripe so you are not charged again.',
          `You can also ask the studio to do it for you (${contact(c)}). Deleting your account cannot be undone.`,
        ],
      },
      {
        heading: 'Keeping it safe',
        paragraphs: [
          'Information is encrypted when it travels between your phone and our servers. Access is limited by role, and every studio can only see its own clients. If we find out that your information has been involved in a breach that is likely to cause serious harm, we will tell you and the Office of the Australian Information Commissioner (OAIC), as the law requires.',
        ],
      },
      {
        heading: 'Questions and complaints',
        paragraphs: [
          `If you have a concern about how your information is handled, please tell us first (${contact(c)}). We will look into it and reply within 30 days.`,
          'If you are not happy with our response, you can complain to the Office of the Australian Information Commissioner (OAIC) at oaic.gov.au or on 1300 363 992.',
        ],
      },
      {
        heading: 'Changes',
        paragraphs: ['If we change this policy in a way that matters, we will update this page and the date at the top.'],
      },
    ],
  };
}

export function termsOfUse(c: LegalContext): LegalDoc {
  const s = who(c);
  return {
    title: 'Terms of use',
    updated: LEGAL_TEMPLATE_UPDATED,
    intro: `These terms cover your use of the ${s} app and website. By creating an account or booking, you agree to them. If something here does not make sense, ask us (${contact(c)}).`,
    sections: [
      {
        heading: 'Who we are',
        paragraphs: [
          `${s}${abnLine(c)} runs the classes and sells the passes. ${PLATFORM_LEGAL.name} provides the booking software. When these terms say "we", they mean ${s}.`,
        ],
      },
      {
        heading: 'Your account',
        bullets: [
          'Give us true details and keep them up to date, including your health information.',
          'Keep your password to yourself. You are responsible for what happens on your account.',
          'If you book for children or other family members, you confirm you are their parent or guardian, or have their permission, and that their information is accurate.',
          'You must be 16 or older to have your own account. Younger children can be added by a parent or guardian.',
        ],
      },
      {
        heading: 'Health, safety and the waiver',
        paragraphs: [
          'Exercise carries some risk. Before your first class you complete a health form and sign the studio waiver. Tell your instructor about any injury, condition or pregnancy before class, and work within your limits. If your health changes, update your information in the app.',
        ],
      },
      {
        heading: 'Bookings and cancellations',
        paragraphs: [
          'Classes, waitlists, late cancellations and no-shows work as described in the studio\'s cancellation and waitlist policies, which you can read in the app under Profile. Booking a class means you accept those policies.',
        ],
      },
      {
        heading: 'Passes, memberships and payments',
        bullets: [
          'Prices are in Australian dollars and include GST where the studio is registered for it.',
          'Card payments are processed by Stripe. We do not see or store your card number.',
          'Memberships renew automatically each billing period until you cancel. You can pause or cancel in the app, and the rules for that are shown when you do it.',
          'Packs and passes have the expiry shown at the time you buy.',
          'Refunds are handled by the studio. Nothing in these terms limits your rights under the Australian Consumer Law, including a remedy if a service is not provided with due care and skill.',
        ],
      },
      {
        heading: 'Using the app properly',
        bullets: [
          'Do not try to get into other people\'s accounts or the studio\'s systems.',
          'Do not use the app to harass anyone or to do anything unlawful.',
          'We may suspend an account that does, and will tell you why.',
        ],
      },
      {
        heading: 'Your information',
        paragraphs: ['How we handle your personal information is explained in our Privacy policy. You can delete your account in the app at any time.'],
      },
      {
        heading: 'Our responsibility',
        paragraphs: [
          'We take reasonable care to provide the classes and the app. The app is provided as available, and may sometimes be down for maintenance. To the extent the law allows, we are not responsible for loss that could not reasonably have been foreseen. Nothing in these terms excludes or limits any right or remedy you have under the Australian Consumer Law or other laws that cannot be excluded.',
        ],
      },
      {
        heading: 'Changes and ending',
        paragraphs: [
          'We may update these terms. If the change matters, we will give you notice in the app or by email. You can stop using the app and delete your account at any time. We may end an account that breaks these terms.',
        ],
      },
      {
        heading: 'Law',
        paragraphs: ['These terms are governed by the law of the Australian state or territory where the studio is located, and the courts there can hear any dispute.'],
      },
      {
        heading: 'Contact',
        paragraphs: [`${s}${abnLine(c)}. You can ${contact(c)}.`],
      },
    ],
  };
}

/** A studio's own text (from Settings): blank lines make paragraphs, a line starting "# " is a heading. */
export function customLegalDoc(title: string, text: string): LegalDoc {
  const sections: LegalSection[] = [];
  let cur: LegalSection = { heading: '', paragraphs: [] };
  for (const block of text.split(/\n{2,}/)) {
    const b = block.trim();
    if (!b) continue;
    if (b.startsWith('# ')) {
      const [first, ...rest] = b.split('\n');
      if (cur.heading || cur.paragraphs?.length) sections.push(cur);
      cur = { heading: first!.slice(2).trim(), paragraphs: rest.join('\n').trim() ? [rest.join('\n').trim()] : [] };
    } else (cur.paragraphs ??= []).push(b);
  }
  if (cur.heading || cur.paragraphs?.length) sections.push(cur);
  return { title, intro: '', sections, updated: '' };
}
