import Link from "next/link";
import { notFound } from "next/navigation";
import { supabaseAdmin } from "@/lib/supabase";
import { deleteProject, updateProject } from "../actions";
import { ProjectFields } from "../project-fields";
import type { Project, ProjectStage } from "../types";
import { formatCents } from "../../invoices/money";
import type { Invoice } from "../../invoices/types";
import { summarizeProjectMoney, type SummaryInstallment } from "@/lib/payments/summary";
import { businessTodayISO, formatDateTime, formatDay } from "@/lib/dates";
import { isMissingTable } from "@/lib/db-errors";
import { attentionItems } from "@/lib/projects/attention";
import { generateContract } from "../../contracts/actions";
import type { Contract, ContractTemplate } from "../../contracts/types";
import { sendQuestionnaire } from "../../questionnaires/actions";
import type { Questionnaire, QuestionnaireTemplate } from "../../questionnaires/types";
import type { Quote } from "../../quotes/types";
import { ConfirmButton } from "@/app/admin/_components/confirm-button";
import { cancelBooking, createManualBooking } from "../../bookings/actions";
import type { SessionType } from "../../session-types/types";
import { BUSINESS_TIME_ZONE } from "@/lib/dates";

export const dynamic = "force-dynamic";

// The project workspace (2026-10-14 restyle, C2): a sticky summary column
// (client, date, money, what's next, edit details) beside one scrolling
// column of sections. Status pills follow the color key in
// src/lib/projects/attention.ts.

type ProjectWithContact = Project & { contacts: { id: string; name: string; email: string | null } | null };
type Tone = "red" | "amber" | "blue" | "green" | "grey";

const contractPill: Record<string, [Tone, string]> = {
  draft: ["blue", "Draft"],
  awaiting_signature: ["amber", "Awaiting signature"],
  in_progress: ["amber", "Signing"],
  completed: ["green", "Signed"],
  canceled: ["grey", "Canceled"],
};
const quotePill: Record<string, [Tone, string]> = { draft: ["blue", "Draft"], sent: ["amber", "Sent"], accepted: ["green", "Accepted"] };

// The sections are grouped into tabs (2026-10-19) so the page shows one
// topic at a time. The tab lives in ?tab= so it survives reloads and links.
const TABS = [
  { key: "overview", label: "Overview" },
  { key: "sessions", label: "Sessions" },
  { key: "money", label: "Money" },
  { key: "documents", label: "Documents" },
  { key: "gallery", label: "Gallery" },
  { key: "activity", label: "Activity" },
] as const;
type TabKey = (typeof TABS)[number]["key"];

function Pill({ tone, label }: { tone: Tone; label: string }) {
  return <span className={`st ${tone}`}>{label}</span>;
}

export default async function ProjectDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ booking_error?: string; tab?: string }>;
}) {
  const { id } = await params;
  const { booking_error: bookingError, tab: tabParam } = await searchParams;
  const tab: TabKey = TABS.some((t) => t.key === tabParam) ? (tabParam as TabKey) : "overview";

  const db = supabaseAdmin();
  const [
    { data, error },
    { data: stages, error: stagesError },
    { data: invoices, error: invoicesError },
    { data: contracts, error: contractsError },
    { data: templates, error: templatesError },
    { data: questionnaires, error: questionnairesError },
    { data: questionnaireTemplates, error: questionnaireTemplatesError },
    { data: quotes, error: quotesError },
    { data: galleries, error: galleriesError },
    { data: emails, error: emailsError },
    { data: bookings, error: bookingsError },
    { data: sessionTypes, error: sessionTypesError },
  ] = await Promise.all([
    db.from("projects").select("*, contacts(id, name, email)").eq("id", id).single(),
    db.from("project_stages").select("*").order("position", { ascending: true }),
    db.from("invoices").select("*").eq("project_id", id).order("created_at", { ascending: false }),
    db.from("contracts").select("*").eq("project_id", id).order("created_at", { ascending: false }),
    db.from("contract_templates").select("*").order("name", { ascending: true }),
    db.from("questionnaires").select("*").eq("project_id", id).order("created_at", { ascending: false }),
    db.from("questionnaire_templates").select("*").order("name", { ascending: true }),
    db.from("quotes").select("*").eq("project_id", id).order("created_at", { ascending: false }),
    db.from("collections").select("id, name, status, visibility").eq("project_id", id).order("created_at", { ascending: false }),
    db
      .from("email_log")
      .select("id, subject, to_email, status, error, created_at")
      .eq("project_id", id)
      .order("created_at", { ascending: false })
      .limit(20),
    db
      .from("bookings")
      .select("id, status, starts_at, timezone, hold_expires_at, session_types(name)")
      .eq("project_id", id)
      .order("starts_at", { ascending: true }),
    db.from("session_types").select("id, name, duration_minutes, price_cents").eq("active", true).order("name", { ascending: true }),
  ]);
  if (error || !data) notFound();
  if (stagesError) throw stagesError;
  if (invoicesError) throw invoicesError;
  if (contractsError) throw contractsError;
  if (templatesError) throw templatesError;
  if (questionnairesError) throw questionnairesError;
  if (questionnaireTemplatesError) throw questionnaireTemplatesError;
  if (quotesError) throw quotesError;
  if (galleriesError) throw galleriesError;
  // Email history is a side section: if its table isn't migrated yet, say so
  // instead of taking the whole project page down.

  const project = data as ProjectWithContact;
  const invoiceRows = (invoices ?? []) as Invoice[];
  const contractRows = (contracts ?? []) as (Contract & { sent_at: string | null })[];
  const questionnaireRows = (questionnaires ?? []) as Questionnaire[];
  const quoteRows = (quotes ?? []) as Quote[];
  const stageList = (stages ?? []) as ProjectStage[];
  const stage = stageList.find((s) => s.id === project.stage_id);
  // Sessions are a side section: if the bookings table isn't migrated, say so
  // instead of taking the page down. Expired unpaid holds aren't sessions.
  const bookingRows = ((bookings ?? []) as unknown as {
    id: string;
    status: string;
    starts_at: string;
    timezone: string;
    hold_expires_at: string;
    session_types: { name: string } | null;
  }[]).filter((b) => b.status !== "pending_payment" || new Date(b.hold_expires_at).getTime() > Date.now());
  const typeOptions = (sessionTypes ?? []) as Pick<SessionType, "id" | "name" | "duration_minutes" | "price_cents">[];

  // Payment summary (2.5). Schedules live in invoice_installments (2.4).
  let installments: SummaryInstallment[] = [];
  if (invoiceRows.length > 0) {
    const { data: rows, error: instError } = await db
      .from("invoice_installments")
      .select("invoice_id, amount_cents, due_date, status")
      .in("invoice_id", invoiceRows.map((i) => i.id));
    if (instError && !isMissingTable(instError)) throw instError;
    installments = (rows ?? []) as SummaryInstallment[];
  }
  const today = businessTodayISO();
  const money = summarizeProjectMoney(invoiceRows, installments, today);
  const attention = attentionItems({
    projects: [project],
    invoices: invoiceRows,
    installments,
    contracts: contractRows,
    questionnaires: questionnaireRows,
    firstStageId: stageList[0]?.id ?? null,
    today,
  }).filter((i) => i.split !== "week");
  const lateInvoices = new Set(attention.filter((i) => i.label === "Overdue").map((i) => i.href.split("/").pop()));
  const invoicePill = (inv: Invoice): [Tone, string] =>
    inv.status === "paid" ? ["green", "Paid"] : inv.status === "void" ? ["grey", "Void"] : inv.status === "draft" ? ["blue", "Draft"] : lateInvoices.has(inv.id) ? ["red", "Overdue"] : ["blue", "Unpaid"];

  const updateThisProject = updateProject.bind(null, project.id);
  const deleteThisProject = deleteProject.bind(null, project.id, project.contact_id);
  const generateThisContract = generateContract.bind(null, project.id);
  const sendThisQuestionnaire = sendQuestionnaire.bind(null, project.id);
  const addThisBooking = createManualBooking.bind(null, project.id);

  const tabCounts: Record<TabKey, number> = {
    overview: attention.length,
    sessions: bookingRows.filter((b) => b.status !== "canceled").length,
    money: invoiceRows.length,
    documents: contractRows.length + questionnaireRows.length + quoteRows.length,
    gallery: (galleries ?? []).length,
    activity: (emails ?? []).length + (project.description ? 1 : 0),
  };

  return (
    <main className="fluid workspace">
      <Link className="back" href="/admin">
        ← Projects
      </Link>
      <header className="ws-head">
        <h1>{project.title}</h1>
        <div className="ws-meta">
          <details className="ws-edit">
            <summary className="btn sm">Edit details</summary>
            <div className="ws-edit-panel">
              <form action={updateThisProject}>
                <ProjectFields project={project} stages={stageList} />
                <button type="submit" className="primary">
                  Save changes
                </button>
              </form>
              <form action={deleteThisProject}>
                <ConfirmButton message="Delete this project? This can't be undone.">Delete project</ConfirmButton>
              </form>
            </div>
          </details>

          {stage && <span className="st stage">{stage.name}</span>}
          {project.event_date && <span>{formatDay(project.event_date)}</span>}
          {project.location && <span>{project.location}</span>}
          {project.type && <span>{project.type}</span>}
        </div>
      </header>


      <div className="ws">
        <aside className="ws-side" aria-label="Summary">
          <dl className="ws-facts">
            <div>
              <dt>Client</dt>
              <dd>
                {project.contacts ? <Link href={`/admin/contacts/${project.contacts.id}`}>{project.contacts.name}</Link> : "No client linked"}
                {project.contacts?.email && <span className="sub">{project.contacts.email}</span>}
              </dd>
            </div>
            <div>
              <dt>Session</dt>
              <dd>{project.event_date ? formatDay(project.event_date) : "Date TBD"}</dd>
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
          </dl>
          {attention[0] && (
            <div className="ws-next">
              <span className="lbl">Next up</span>
              <span>
                <Pill tone={attention[0].tone} label={attention[0].label} /> {attention[0].detail}
              </span>
              <Link href={attention[0].href} className="btn primary">
                {attention[0].action}
              </Link>
            </div>
          )}
        </aside>

        <div className="ws-main">
          <nav className="ws-tabs" aria-label="Sections">
            {TABS.map((t) => (
              <Link
                key={t.key}
                href={t.key === "overview" ? `/admin/projects/${project.id}` : `/admin/projects/${project.id}?tab=${t.key}`}
                className={t.key === tab ? "on" : undefined}
                aria-current={t.key === tab ? "page" : undefined}
              >
                {t.label}
                {tabCounts[t.key] > 0 && <span className="count">{tabCounts[t.key]}</span>}
              </Link>
            ))}
          </nav>

          {tab === "overview" && (
          <section id="attention" className="ws-sec">
            <h3>Needs attention</h3>
            {attention.length === 0 ? (
              <p className="muted">All caught up on this project.</p>
            ) : (
              <ul className="ws-rows">
                {attention.map((it) => (
                  <li key={it.key}>
                    <Pill tone={it.tone} label={it.label} />
                    <span className="grow">{it.detail}</span>
                    <span className="muted small">{it.when}</span>
                    <Link href={it.href} className="btn sm">
                      {it.action}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>
          )}

          {tab === "sessions" && (
          <section id="sessions" className="ws-sec">
            <h3>Sessions</h3>
            {bookingError && (
              <p className="late" role="alert">
                {bookingError}
              </p>
            )}
            {bookingsError ? (
              <p className="muted">Bookings aren&apos;t available yet (run the booking migrations).</p>
            ) : bookingRows.length === 0 ? (
              <p className="muted">No sessions booked yet.</p>
            ) : (
              <ul className="ws-rows">
                {bookingRows.map((b) => (
                  <li key={b.id}>
                    <Pill
                      tone={b.status === "confirmed" ? "green" : b.status === "canceled" ? "grey" : "amber"}
                      label={b.status === "confirmed" ? "Confirmed" : b.status === "canceled" ? "Canceled" : "Awaiting payment"}
                    />
                    <span className="grow">
                      {b.session_types?.name ?? "Session"}{" "}
                      <span className="muted">
                        ·{" "}
                        {new Date(b.starts_at).toLocaleString("en-US", {
                          dateStyle: "medium",
                          timeStyle: "short",
                          timeZone: b.timezone,
                        })}
                      </span>
                    </span>
                    {b.status !== "canceled" && (
                      <form action={cancelBooking.bind(null, b.id)} className="row-action">
                        <ConfirmButton message="Cancel this booking? It comes off your Google Calendar. Any refund is done in Stripe by hand.">
                          Cancel
                        </ConfirmButton>
                      </form>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {sessionTypesError ? (
              <p className="muted">Session types couldn&apos;t be loaded.</p>
            ) : !project.contacts ? (
              <p className="muted">Link a client to this project before adding a booking.</p>
            ) : typeOptions.length === 0 ? (
              <p className="muted">
                Create a session type first (<Link href="/admin/session-types">Session types</Link>).
              </p>
            ) : (
              <details className="ws-add" open={Boolean(bookingError)}>
                <summary className="btn sm">+ Add a booking</summary>
                <div className="ws-tools">
                  <form action={addThisBooking}>
                    <label htmlFor="booking_type">Session type</label>
                    <select id="booking_type" name="session_type_id" required>
                      {typeOptions.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name} ({t.duration_minutes} min)
                        </option>
                      ))}
                    </select>
                    <input type="date" name="date" aria-label="Date" required />
                    <input type="time" name="time" aria-label="Start time" required />
                    <input type="text" name="notes" aria-label="Notes" placeholder="Notes (optional)" maxLength={2000} />
                    <button type="submit">Add booking</button>
                  </form>
                  <p className="muted small">
                    Times are {BUSINESS_TIME_ZONE.replace("_", " ")}. Any time works, even outside your open hours. It&apos;s
                    confirmed right away, goes on your Google Calendar, and a draft invoice is created for you to edit and send.
                  </p>
                </div>
              </details>
            )}
          </section>
          )}

          {tab === "money" && (
          <section id="money" className="ws-sec">
            <div className="ws-sechead">
              <h3>Money</h3>
              <Link href={`/admin/invoices/new?project_id=${project.id}`} className="btn sm">
                + New invoice
              </Link>
            </div>
            {invoiceRows.length === 0 ? (
              <p className="muted">No invoices yet.</p>
            ) : (
              <ul className="ws-rows">
                {invoiceRows.map((inv) => {
                  const [tone, label] = invoicePill(inv);
                  return (
                    <li key={inv.id}>
                      <Pill tone={tone} label={label} />
                      <Link href={`/admin/invoices/${inv.id}`} className="grow">
                        Invoice · {formatCents(inv.total_cents, inv.currency)}
                      </Link>
                      <span className="muted small">{inv.due_date ? `Due ${formatDay(inv.due_date)}` : "Due on receipt"}</span>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
          )}

          {tab === "documents" && (
          <section id="documents" className="ws-sec">
            <div className="ws-sechead">
              <h3>Documents</h3>
              <Link href={`/admin/quotes/new?project_id=${project.id}`} className="btn sm">
                + New quote
              </Link>
            </div>
            {contractRows.length + questionnaireRows.length + quoteRows.length === 0 ? (
              <p className="muted">No contracts, questionnaires or quotes yet.</p>
            ) : (
              <ul className="ws-rows">
                {contractRows.map((c) => {
                  const [tone, label] = contractPill[c.status] ?? ["grey", c.status];
                  return (
                    <li key={c.id}>
                      <Pill tone={tone} label={label} />
                      <Link href={`/admin/contracts/${c.id}`} className="grow">
                        Contract
                      </Link>
                      <span className="muted small">{formatDay(c.created_at.slice(0, 10))}</span>
                    </li>
                  );
                })}
                {questionnaireRows.map((q) => (
                  <li key={q.id}>
                    <Pill tone={q.submitted_at ? "green" : "amber"} label={q.submitted_at ? "Submitted" : "Awaiting response"} />
                    <Link href={`/admin/questionnaires/${q.id}`} className="grow">
                      Questionnaire
                    </Link>
                    <span className="muted small">{formatDay(q.created_at.slice(0, 10))}</span>
                  </li>
                ))}
                {quoteRows.map((q) => {
                  const [tone, label] = quotePill[q.status] ?? ["grey", q.status];
                  return (
                    <li key={q.id}>
                      <Pill tone={tone} label={label} />
                      <Link href={`/admin/quotes/${q.id}`} className="grow">
                        {q.title}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
            {project.contacts ? (
              <details className="ws-add">
              <summary className="btn sm">+ Contract or questionnaire from a template</summary>
              <div className="ws-tools">
                <form action={generateThisContract}>
                  <label htmlFor="template_id">Contract from template</label>
                  <select id="template_id" name="template_id" required>
                    {((templates ?? []) as ContractTemplate[]).map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                  </select>
                  <button type="submit">Generate</button>
                </form>
                <form action={sendThisQuestionnaire}>
                  <label htmlFor="questionnaire_template_id">Questionnaire from template</label>
                  <select id="questionnaire_template_id" name="template_id" required>
                    {((questionnaireTemplates ?? []) as QuestionnaireTemplate[]).map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                  </select>
                  <button type="submit">Send</button>
                </form>
              </div>
              </details>
            ) : (
              <p className="muted">Link a client to this project before sending a contract or questionnaire.</p>
            )}
          </section>
          )}

          {tab === "gallery" && (
          <section id="gallery" className="ws-sec">
            <div className="ws-sechead">
              <h3>Gallery</h3>
              <Link href={`/admin/galleries/new?project_id=${project.id}`} className="btn sm">
                + New gallery
              </Link>
            </div>
            {(galleries ?? []).length === 0 ? (
              <p className="muted">No gallery yet.</p>
            ) : (
              <ul className="ws-rows">
                {(galleries ?? []).map((g) => (
                  <li key={g.id}>
                    <Pill tone={g.status === "published" ? "green" : "blue"} label={g.status === "published" ? "Published" : "Draft"} />
                    <Link href={`/admin/galleries/${g.id}`} className="grow">
                      {g.name}
                    </Link>
                    <span className="muted small">{g.status === "published" ? g.visibility : ""}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
          )}

          {tab === "activity" && (
          <>
          <section id="emails" className="ws-sec">
            <div className="ws-sechead">
              <h3>Emails</h3>
              <Link href="/admin/emails/log" className="btn quiet">
                All emails
              </Link>
            </div>
            {emailsError ? (
              <p className="muted">Email history isn&apos;t available yet (run the email migrations).</p>
            ) : (emails ?? []).length === 0 ? (
              <p className="muted">No emails yet.</p>
            ) : (
              <ul className="ws-rows">
                {(emails ?? []).map((e) => (
                  <li key={e.id as string}>
                    <Pill
                      tone={e.status === "sent" ? "green" : e.status === "failed" ? "red" : "grey"}
                      label={e.status === "sent" ? "Sent" : e.status === "failed" ? "Failed" : "Not sent"}
                    />
                    <span className="grow">
                      {e.subject as string} <span className="muted">· to {e.to_email as string}</span>
                      {e.error && e.status !== "sent" ? <span className="muted"> · {e.error as string}</span> : null}
                    </span>
                    <span className="muted small">{formatDateTime(e.created_at as string)}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {project.description && (
            <section id="notes" className="ws-sec">
              <h3>Notes</h3>
              <p style={{ whiteSpace: "pre-wrap" }}>{project.description}</p>
            </section>
          )}
          </>
          )}
        </div>
      </div>
    </main>
  );
}
