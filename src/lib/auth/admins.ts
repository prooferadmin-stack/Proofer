// Who may use /admin (task 0.7). An email address isn't a secret, so this is a
// committed constant rather than an env var. Add an address here to grant admin.
// Studio email only (task 9.5 account split): david.draper86 is no longer admin.
// The first entry also receives admin notices (lib/email/triggers.ts).
export const ADMIN_EMAILS: readonly string[] = ["davidmonroephotos@gmail.com"];

export function isAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return ADMIN_EMAILS.includes(email.trim().toLowerCase());
}
