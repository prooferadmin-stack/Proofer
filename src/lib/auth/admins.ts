// Who may use /admin (task 0.7). An email address isn't a secret, so this is a
// committed constant rather than an env var. Add an address here to grant admin.
// Admin email only (David, 2026-10-19, after task 9.5): prooferadmin is the Proofer admin; the earlier studio email and david.draper86 are not admins.
// The first entry also receives admin notices (lib/email/triggers.ts).
export const ADMIN_EMAILS: readonly string[] = ["prooferadmin@gmail.com"];

export function isAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return ADMIN_EMAILS.includes(email.trim().toLowerCase());
}
