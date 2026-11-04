import Link from "next/link";
import { notFound } from "next/navigation";
import { supabaseAdmin } from "@/lib/supabase";
import { deleteContact, updateContact } from "../actions";
import { ContactFields } from "../contact-fields";
import type { Contact } from "../types";
import type { Project, ProjectStage } from "../../projects/types";
import type { Invoice } from "../../invoices/types";
import { formatCents } from "../../invoices/money";
import { clearSuppression } from "../../emails/actions";
import { ConfirmButton } from "@/app/admin/_components/confirm-button";
import { summarizeProjectMoney, type SummaryInstallment } from "@/lib/payments/summary";
import { loadCreditsFor } from "@/lib/gift-cards/redeem";
import { businessTodayISO, formatDay } from "@/lib/dates";
import { isMissingTable } from "@/lib/db-errors";

export const dynamic = "force-dynamic";

// The contact workspace (2026-10-14 restyle, C2): who they are on the left,
// everything you've done together on the right.
export default async function ContactDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const db = supabaseAdmin();
  const [{ data, error }, { data: projects, error: projectsError }, { data: stages }, { data: invoices }, { data: galleries }] =
    await Promise.all([
      db.from("contacts").select("*").eq("id", id).single(),
      db.from("projects").select("*").eq("contact_id", id).order("created_at", { ascending: false }),
      db.from("project_stages").select("id, name"),
      db.from("invoices").select("*").eq("contact_id", id),
      db.from("collections").select("id, name, status").eq("contact_id", id).order("created_at", { ascending: false }),
    ]);
  if (error || !data) notFound();
  if (projectsError) throw projectsError;
  const contact = data as Contact;
  const projectRows = (projects ?? []) as Project[];
  const stageName = new Map(((stages ?? []) as Pick<ProjectStage, "id" | "name">[]).map((s) => [s.id, s.name]));
  const invoiceRows = (invoices ?? []) as Invoice[];

  let installments: SummaryInstallment[] = [];
  if (invoiceRows.length > 0) {
    const { data: rows, error: instError } = await db
      .from("invoice_installments")
      .select("id, invoice_id, amount_cents, due_date, status")
      .in("invoice_id", invoiceRows.map((i) => i.id));
    if (instError && !isMissingTable(instError)) throw instError;
    installments = (rows ?? []) as SummaryInstallment[];
  }
  const credits = await loadCreditsFor(db, invoiceRows.map((i) => i.id));
  const money = summarizeProjectMoney(invoiceRows, installments, businessTodayISO(), credits);

  // Phase 8.4: warn when this contact's address can't be mailed.
  const { data: blocked } = contact.email
    ? await db
        .from("email_suppressions")
        .select("reason, detail, created_at")
        .eq("email", contact.email.trim().toLowerCase())
        .maybeSingle()
    : { data: null };

  const updateThisContact = updateContact.bind(null, contact.id);
  const deleteThisContact = deleteContact.bind(null, contact.id);

  return (
    <main className="fluid workspace">
      <Link className="back" href="/admin/contacts">
        ← Contacts
      </Link>
      <header className="ws-head">
        <h1>{contact.name}</h1>
        <div className="ws-meta">
          <span className={`st ${contact.kind === "client" ? "green" : "blue"}`}>{contact.kind === "client" ? "Client" : "Lead"}</span>
          {contact.email && <a href={`mailto:${contact.email}`}>{contact.email}</a>}
          {contact.phone && <a href={`tel:${contact.phone}`}>{contact.phone}</a>}
          {contact.source && <span>via {contact.source}</span>}
        </div>
      </header>

      {blocked && contact.email && (
        <form role="alert" className="notice row" action={clearSuppression.bind(null, contact.email, `/admin/contacts/${contact.id}`)}>
          <span>
            Emails to {contact.email} are blocked: it {blocked.reason === "complained" ? "marked an email as spam" : "bounced"} on{" "}
            {formatDay(String(blocked.created_at).slice(0, 10))}
            {blocked.detail ? ` (${blocked.detail as string})` : ""}. Fix the address, or clear the block if it works again.
          </span>
          <button type="submit">Clear block</button>
        </form>
      )}

      <div className="ws">
        <aside className="ws-side" aria-label="Summary">
          <dl className="ws-facts">
            <div>
              <dt>Projects</dt>
              <dd className="num">{projectRows.length}</dd>
            </div>
            <div>
              <dt>Paid</dt>
              <dd className="num">{formatCents(money.paidCents)}</dd>
            </div>
            <div>
              <dt>Upcoming</dt>
              <dd className="num">{formatCents(money.upcomingCents)}</dd>
            </div>
            <div>
              <dt>Past due</dt>
              <dd className={`num${money.pastDueCents > 0 ? " late" : ""}`}>{formatCents(money.pastDueCents)}</dd>
            </div>
            {contact.tags.length > 0 && (
              <div>
                <dt>Tags</dt>
                <dd>{contact.tags.join(", ")}</dd>
              </div>
            )}
          </dl>
          <details className="ws-edit">
            <summary className="btn">Edit details</summary>
            <form action={updateThisContact}>
              <ContactFields contact={contact} />
              <button type="submit" className="primary">
                Save changes
              </button>
            </form>
            <form action={deleteThisContact}>
              <ConfirmButton message="Delete this contact? This can't be undone.">Delete contact</ConfirmButton>
            </form>
          </details>
        </aside>

        <div className="ws-main">
          <section className="ws-sec">
            <div className="ws-sechead">
              <h3>Projects</h3>
              <Link href={`/admin/projects/new?contact_id=${contact.id}`} className="btn sm">
                + New project
              </Link>
            </div>
            {projectRows.length === 0 ? (
              <p className="muted">No projects yet.</p>
            ) : (
              <ul className="ws-rows">
                {projectRows.map((p) => (
                  <li key={p.id}>
                    <span className="st stage">{p.archived ? "Archived" : stageName.get(p.stage_id ?? "") ?? "No stage"}</span>
                    <Link href={`/admin/projects/${p.id}`} className="grow">
                      {p.title}
                    </Link>
                    <span className="muted small">{p.event_date ? formatDay(p.event_date) : "Date TBD"}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="ws-sec">
            <h3>Galleries</h3>
            {(galleries ?? []).length === 0 ? (
              <p className="muted">No galleries linked to {contact.name} yet.</p>
            ) : (
              <ul className="ws-rows">
                {(galleries ?? []).map((g) => (
                  <li key={g.id}>
                    <span className={`st ${g.status === "published" ? "green" : "blue"}`}>{g.status === "published" ? "Published" : "Draft"}</span>
                    <Link href={`/admin/galleries/${g.id}`} className="grow">
                      {g.name}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {contact.notes && (
            <section className="ws-sec">
              <h3>Notes</h3>
              <p style={{ whiteSpace: "pre-wrap" }}>{contact.notes}</p>
            </section>
          )}
        </div>
      </div>
    </main>
  );
}
