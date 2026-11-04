// Built-in email templates (Phase 8.1). No imports, so Node's test runner can
// load it. David can override any subject/body in /admin/emails; the override
// lives in email_templates and may only use the fields listed here.
//
// Default copy follows 00-resources/voice-principles.md: brief, contractions,
// no dashes, warm without selling, a close that turns toward the client.

export type TemplateKey =
  | "gallery_ready"
  | "invoice_sent"
  | "payment_receipt"
  | "quote_sent"
  | "contract_sent"
  | "contract_signed"
  | "contract_signed_notice"
  | "questionnaire_sent"
  | "booking_confirmation"
  | "inquiry_received"
  | "project_booked"
  | "project_wrapped"
  | "invoice_reminder"
  | "invoice_overdue"
  | "contract_reminder"
  | "questionnaire_reminder"
  | "gift_card_purchased"
  | "invoice_paid_by_gift_card"
  | "gift_card_sold_notice";

export type TemplateDef = {
  key: TemplateKey;
  name: string;
  description: string;
  fields: readonly string[];
  subject: string;
  body: string;
  // Shown in the admin preview and test sends.
  sample: Record<string, string>;
};

const CONTACT = ["contact.first_name", "contact.name"] as const;

const SAMPLE_CONTACT = { "contact.first_name": "Jordan", "contact.name": "Jordan Ellis" };

// Fields a stage-change email can fill from the project alone (Phase 8.2).
// Only templates limited to these can be attached to a stage.
export const PROJECT_FIELDS: readonly string[] = [...CONTACT, "project.title"];

export const TEMPLATES: Record<TemplateKey, TemplateDef> = {
  gallery_ready: {
    key: "gallery_ready",
    name: "Gallery ready",
    description: "A client's photos are published.",
    fields: [...CONTACT, "gallery.name", "gallery.link", "gallery.password"],
    subject: "Your photos are here",
    body: `Hi {{contact.first_name}},

Your gallery is ready. Take your time with it.

{{gallery.link}}

Tap the heart on the ones you love and I'll see them too.

David`,
    sample: {
      ...SAMPLE_CONTACT,
      "gallery.name": "Ellis Family, Forsyth Park",
      "gallery.link": "https://example.com/g/ellis-family",
      "gallery.password": "",
    },
  },
  invoice_sent: {
    key: "invoice_sent",
    name: "Invoice sent",
    description: "An invoice is ready to pay.",
    fields: [...CONTACT, "invoice.amount", "invoice.due_date", "invoice.link"],
    subject: "Your invoice for {{invoice.amount}}",
    body: `Hi {{contact.first_name}},

Here's your invoice for {{invoice.amount}}, due {{invoice.due_date}}. You can pay it securely here:

{{invoice.link}}

Any questions, reply to this email and you'll get me.

David`,
    sample: {
      ...SAMPLE_CONTACT,
      "invoice.amount": "$450.00",
      "invoice.due_date": "October 20, 2026",
      "invoice.link": "https://example.com/pay/1234",
    },
  },
  payment_receipt: {
    key: "payment_receipt",
    name: "Payment receipt",
    description: "A payment came through.",
    fields: [...CONTACT, "payment.amount", "payment.date", "payment.gift_card_note", "invoice.link"],
    subject: "Received, thank you",
    body: `Hi {{contact.first_name}},

Your payment of {{payment.amount}} came through on {{payment.date}}. Thank you.

{{payment.gift_card_note}}

Your receipt and invoice are here any time:

{{invoice.link}}

David`,
    sample: {
      ...SAMPLE_CONTACT,
      "payment.amount": "$450.00",
      "payment.date": "October 6, 2026",
      "payment.gift_card_note": "A gift card covered $350.00 of this invoice.",
      "invoice.link": "https://example.com/pay/1234",
    },
  },
  invoice_paid_by_gift_card: {
    key: "invoice_paid_by_gift_card",
    name: "Paid with a gift card",
    description: "A gift card fully paid an invoice or one of its payments (no card charge, so no Stripe receipt).",
    fields: [...CONTACT, "payment.amount", "payment.date", "card.balance", "invoice.link"],
    subject: "Paid with your gift card",
    body: `Hi {{contact.first_name}},

Your gift card paid {{payment.amount}} on {{payment.date}}. Nothing more is due on it right now.

Left on the card: {{card.balance}}

Your invoice is here any time:

{{invoice.link}}

David`,
    sample: {
      ...SAMPLE_CONTACT,
      "payment.amount": "$350.00",
      "payment.date": "November 4, 2026",
      "card.balance": "$150.00",
      "invoice.link": "https://example.com/pay/1234",
    },
  },
  quote_sent: {
    key: "quote_sent",
    name: "Quote sent",
    description: "A quote with packages to choose from.",
    fields: [...CONTACT, "quote.title", "quote.link"],
    subject: "Your options for {{quote.title}}",
    body: `Hi {{contact.first_name}},

I put together a few options for {{quote.title}}. Pick the one that fits and I'll take it from there.

{{quote.link}}

David`,
    sample: { ...SAMPLE_CONTACT, "quote.title": "Spring Headshots", "quote.link": "https://example.com/quote/1234" },
  },
  contract_sent: {
    key: "contract_sent",
    name: "Contract sent",
    description: "A contract is ready to sign.",
    fields: [...CONTACT, "project.title", "contract.link"],
    subject: "Your contract for {{project.title}}",
    body: `Hi {{contact.first_name}},

Your contract for {{project.title}} is ready. Read it through, and sign when it looks right.

{{contract.link}}

David`,
    sample: {
      ...SAMPLE_CONTACT,
      "project.title": "Ellis Family Session",
      "contract.link": "https://example.com/sign/1234",
    },
  },
  contract_signed: {
    key: "contract_signed",
    name: "Contract signed (client copy)",
    description: "Goes to the client the moment they sign.",
    fields: [...CONTACT, "project.title", "contract.link"],
    subject: "Signed: your contract for {{project.title}}",
    body: `Hi {{contact.first_name}},

Thanks for signing. Your contract for {{project.title}} is locked in, and your signed copy is here any time:

{{contract.link}}

David`,
    sample: {
      ...SAMPLE_CONTACT,
      "project.title": "Ellis Family Session",
      "contract.link": "https://example.com/sign/1234",
    },
  },
  contract_signed_notice: {
    key: "contract_signed_notice",
    name: "Contract signed (note to you)",
    description: "Goes to you when a client signs.",
    fields: [...CONTACT, "project.title", "contract.link"],
    subject: "{{contact.name}} signed the {{project.title}} contract",
    body: `{{contact.name}} just signed the contract for {{project.title}}.

Signed copy and audit trail:

{{contract.link}}`,
    sample: {
      ...SAMPLE_CONTACT,
      "project.title": "Ellis Family Session",
      "contract.link": "https://example.com/admin/contracts/1234",
    },
  },
  questionnaire_sent: {
    key: "questionnaire_sent",
    name: "Questionnaire sent",
    description: "A questionnaire to fill in before the session.",
    fields: [...CONTACT, "project.title", "questionnaire.link"],
    subject: "A few questions before {{project.title}}",
    body: `Hi {{contact.first_name}},

A few questions before we shoot. Your answers help me plan the day around you.

{{questionnaire.link}}

David`,
    sample: {
      ...SAMPLE_CONTACT,
      "project.title": "Ellis Family Session",
      "questionnaire.link": "https://example.com/questionnaire/1234",
    },
  },
  gift_card_purchased: {
    key: "gift_card_purchased",
    name: "Gift card bought",
    description: "Goes to the buyer once their gift card payment clears.",
    fields: ["buyer.first_name", "card.summary", "card.code", "card.expires", "card.terms", "card.link"],
    subject: "Your gift card is ready",
    body: `Hi {{buyer.first_name}},

Thank you. Here's your gift card: {{card.summary}}.

Code: {{card.code}}
Good until {{card.expires}}

A printable card is ready to pass along:

{{card.link}}

The code works on any invoice, all at once or a bit at a time.

{{card.terms}}

David`,
    sample: {
      "buyer.first_name": "Sam",
      "card.summary": "$490 · Headshot Session at today's price",
      "card.code": "DMP-7K3Q-X9PA-M2RT",
      "card.expires": "November 4, 2031",
      "card.terms": "Good toward any David Monroe Photography invoice. Expires on the date shown, 5 years from purchase.",
      "card.link": "https://example.com/gift-cards/card/abc123",
    },
  },
  gift_card_sold_notice: {
    key: "gift_card_sold_notice",
    name: "Gift card sold (note to you)",
    description: "Goes to you when a gift card is bought.",
    fields: ["buyer.name", "buyer.email", "card.summary", "card.paid", "card.admin_link"],
    subject: "Gift card sold: {{card.summary}}",
    body: `{{buyer.name}} ({{buyer.email}}) bought a gift card: {{card.summary}}. They paid {{card.paid}}.

{{card.admin_link}}`,
    sample: {
      "buyer.name": "Sam Lee",
      "buyer.email": "sam@example.com",
      "card.summary": "$490 · Headshot Session at today's price",
      "card.paid": "$392",
      "card.admin_link": "https://example.com/admin/gift-cards/1234",
    },
  },
  booking_confirmation: {
    key: "booking_confirmation",
    name: "Booking confirmation",
    description: "A session is booked.",
    fields: [...CONTACT, "session.name", "session.when", "session.location"],
    subject: "You're booked: {{session.name}}",
    body: `Hi {{contact.first_name}},

You're booked for {{session.name}} on {{session.when}}.

{{session.location}}

Wear what feels like you. I'll handle the rest.

David`,
    sample: {
      ...SAMPLE_CONTACT,
      "session.name": "Headshot Session",
      "session.when": "Saturday, October 17 at 10:00 AM",
      "session.location": "Forsyth Park, Savannah",
    },
  },
  inquiry_received: {
    key: "inquiry_received",
    name: "Inquiry received",
    description: "Stage email: someone just reached out.",
    fields: PROJECT_FIELDS,
    subject: "Got your note",
    body: `Hi {{contact.first_name}},

Your note came through. I read every one myself, and you'll hear back from me within a couple of days.

David`,
    sample: { ...SAMPLE_CONTACT, "project.title": "Portrait inquiry" },
  },
  project_booked: {
    key: "project_booked",
    name: "Project booked",
    description: "Stage email: the project is confirmed.",
    fields: PROJECT_FIELDS,
    subject: "You're on my calendar",
    body: `Hi {{contact.first_name}},

{{project.title}} is on my calendar. It's happening.

Anything on your mind before then, reply here and you'll get me.

David`,
    sample: { ...SAMPLE_CONTACT, "project.title": "Ellis Family Session" },
  },
  project_wrapped: {
    key: "project_wrapped",
    name: "Project wrapped",
    description: "Stage email: the work is delivered.",
    fields: PROJECT_FIELDS,
    subject: "Thank you",
    body: `Hi {{contact.first_name}},

That's a wrap on {{project.title}}. Thank you for trusting me with it.

If one of those photos ends up on a wall or a fridge, I'd love to see where it landed.

David`,
    sample: { ...SAMPLE_CONTACT, "project.title": "Ellis Family Session" },
  },
  invoice_reminder: {
    key: "invoice_reminder",
    name: "Payment reminder",
    description: "Reminder: 3 days before a payment is due, and on the day.",
    fields: [...CONTACT, "invoice.amount", "invoice.due_date", "invoice.link"],
    subject: "A reminder: {{invoice.amount}} due {{invoice.due_date}}",
    body: `Hi {{contact.first_name}},

A heads up that {{invoice.amount}} is due {{invoice.due_date}}. You can pay it here:

{{invoice.link}}

If it's already on its way, ignore this one.

David`,
    sample: {
      ...SAMPLE_CONTACT,
      "invoice.amount": "$450.00",
      "invoice.due_date": "October 20, 2026",
      "invoice.link": "https://example.com/pay/1234",
    },
  },
  invoice_overdue: {
    key: "invoice_overdue",
    name: "Payment overdue",
    description: "Reminder: a week after a payment was due.",
    fields: [...CONTACT, "invoice.amount", "invoice.due_date", "invoice.link"],
    subject: "Still open: {{invoice.amount}}",
    body: `Hi {{contact.first_name}},

Your payment of {{invoice.amount}} was due {{invoice.due_date}} and it hasn't come through yet. Here's the link again:

{{invoice.link}}

If something's come up, reply and tell me. We'll sort it out.

David`,
    sample: {
      ...SAMPLE_CONTACT,
      "invoice.amount": "$450.00",
      "invoice.due_date": "October 20, 2026",
      "invoice.link": "https://example.com/pay/1234",
    },
  },
  contract_reminder: {
    key: "contract_reminder",
    name: "Contract reminder",
    description: "Reminder: 3 and 7 days after a contract went out unsigned.",
    fields: [...CONTACT, "project.title", "contract.link"],
    subject: "Your contract for {{project.title}} is waiting",
    body: `Hi {{contact.first_name}},

Your contract for {{project.title}} is still waiting on your signature. It takes a couple of minutes:

{{contract.link}}

Questions about any of it, reply here and you'll get me.

David`,
    sample: {
      ...SAMPLE_CONTACT,
      "project.title": "Ellis Family Session",
      "contract.link": "https://example.com/sign/1234",
    },
  },
  questionnaire_reminder: {
    key: "questionnaire_reminder",
    name: "Questionnaire reminder",
    description: "Reminder: 3 and 7 days after a questionnaire went out unanswered.",
    fields: [...CONTACT, "project.title", "questionnaire.link"],
    subject: "Those questions before {{project.title}}",
    body: `Hi {{contact.first_name}},

Still hoping to hear from you before {{project.title}}. Your answers help me plan the day around you.

{{questionnaire.link}}

David`,
    sample: {
      ...SAMPLE_CONTACT,
      "project.title": "Ellis Family Session",
      "questionnaire.link": "https://example.com/questionnaire/1234",
    },
  },
};

export const TEMPLATE_KEYS = Object.keys(TEMPLATES) as TemplateKey[];

export function isTemplateKey(value: string): value is TemplateKey {
  return Object.prototype.hasOwnProperty.call(TEMPLATES, value);
}

// A template can run on a stage change only if the project can fill every
// field it uses.
export function isStageTemplate(key: TemplateKey): boolean {
  return TEMPLATES[key].fields.every((f) => PROJECT_FIELDS.includes(f));
}

export const STAGE_TEMPLATE_KEYS = TEMPLATE_KEYS.filter(isStageTemplate);
