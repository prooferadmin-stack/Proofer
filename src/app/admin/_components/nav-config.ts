// The admin navigation as plain data, so the "which item is active" rules can
// be tested without rendering anything. A bottom icon bar (Lark-style): three
// items, Projects in the center, three more, the last being "More" which holds
// everything else. Only links to pages that exist.

export type IconName =
  | "user"
  | "dollar"
  | "image"
  | "camera"
  | "mail"
  | "file"
  | "calendar"
  | "more"
  | "search";

export type BarItem = {
  key: string;
  name: string;
  href: string;
  icon: IconName;
  on: (path: string) => boolean;
  center?: boolean;
};

// Matches the prefix itself and anything under it, except the excluded sub-trees.
export const under =
  (prefix: string, except: string[] = []) =>
  (p: string) =>
    (p === prefix || p.startsWith(prefix + "/")) && !except.some((e) => p === e || p.startsWith(e + "/"));

const CONTRACT_TEMPLATES = "/admin/contracts/templates";
const QUESTIONNAIRE_TEMPLATES = "/admin/questionnaires/templates";
const INBOX = "/admin/emails/log";

const documents = (p: string) =>
  under("/admin/contracts", [CONTRACT_TEMPLATES])(p) ||
  under("/admin/questionnaires", [QUESTIONNAIRE_TEMPLATES])(p) ||
  under("/admin/quotes")(p);

// Left to right. Index 3 is the center slot; "More" follows as the seventh.
// Calendar (bookings) replaced Documents on the bar in the 2026-10-14 restyle.
export const BAR: BarItem[] = [
  { key: "contacts", name: "Contacts", href: "/admin/contacts", icon: "user", on: under("/admin/contacts") },
  { key: "finance", name: "Money", href: "/admin/invoices", icon: "dollar", on: under("/admin/invoices") },
  { key: "calendar", name: "Calendar", href: "/admin/bookings", icon: "calendar", on: under("/admin/bookings") },
  { key: "projects", name: "Projects", href: "/admin", icon: "camera", on: (p) => p === "/admin" || under("/admin/projects")(p), center: true },
  { key: "galleries", name: "Galleries", href: "/admin/galleries", icon: "image", on: under("/admin/galleries") },
  { key: "inbox", name: "Inbox", href: INBOX, icon: "mail", on: under(INBOX) },
];

export type MoreLink = { href: string; name: string; on: (path: string) => boolean };
export type MoreGroup = { label: string; links: MoreLink[] };

// What the "More" sheet holds.
export const MORE_GROUPS: MoreGroup[] = [
  {
    label: "Documents",
    links: [
      { href: "/admin/contracts", name: "Contracts, questionnaires, quotes", on: documents },
    ],
  },
  {
    label: "Bookings",
    links: [
      { href: "/admin/session-types", name: "Session types", on: under("/admin/session-types") },
      { href: "/admin/availability", name: "Availability", on: under("/admin/availability") },
    ],
  },
  {
    label: "Templates",
    links: [
      { href: CONTRACT_TEMPLATES, name: "Contracts", on: under(CONTRACT_TEMPLATES) },
      { href: QUESTIONNAIRE_TEMPLATES, name: "Questionnaires", on: under(QUESTIONNAIRE_TEMPLATES) },
      { href: "/admin/emails", name: "Emails", on: under("/admin/emails", [INBOX]) },
    ],
  },
  {
    label: "Shop",
    links: [
      { href: "/admin/gift-cards", name: "Gift cards", on: under("/admin/gift-cards") },
      { href: "/admin/store", name: "Store", on: under("/admin/store") },
    ],
  },
  { label: "Settings", links: [{ href: "/admin/settings", name: "Settings", on: under("/admin/settings") }] },
];

// Which bar slot is lit for a path: a bar item's key, "more", or null (Home).
export function activeKey(path: string): string | null {
  const bar = BAR.find((b) => b.on(path));
  if (bar) return bar.key;
  return MORE_GROUPS.some((g) => g.links.some((l) => l.on(path))) ? "more" : null;
}

export function allHrefs(): string[] {
  return [...BAR.map((b) => b.href), ...MORE_GROUPS.flatMap((g) => g.links.map((l) => l.href))];
}
