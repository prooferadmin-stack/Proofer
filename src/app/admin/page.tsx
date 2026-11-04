import Link from "next/link";
import { projectBadges, type Badge } from "@/lib/project-badges";
import { BUSINESS_TIME_ZONE, businessTodayISO, formatDay } from "@/lib/dates";
import { supabaseAdmin } from "@/lib/supabase";
import { isMissingTable } from "@/lib/db-errors";
import { presignGet, r2Configured } from "@/lib/r2";
import { GRID_SIZE, displayKey, type Variants } from "@/lib/galleries/variants";
import { summarizeProjectMoney, type SummaryInstallment, type SummaryInvoice } from "@/lib/payments/summary";
import { loadCreditsFor } from "@/lib/gift-cards/redeem";
import { attentionItems, dollars, type AttentionItem, type Split } from "@/lib/projects/attention";
import { KanbanBoard } from "./projects/kanban-board";
import type { Project, ProjectStage } from "./projects/types";

export const dynamic = "force-dynamic";

// The Projects home (2026-10-14 restyle, layout "C2"): money at a glance, an
// action list (Needs you / Waiting on client / This week), then the pipeline
// board or list.

type SearchParams = { view?: string; archived?: string; tab?: string };

const TABS: { key: Split; name: string }[] = [
  { key: "needs", name: "Needs you" },
  { key: "waiting", name: "Waiting on client" },
  { key: "week", name: "This week" },
];
const EMPTY: Record<Split, string> = {
  needs: "Nothing needs you right now.",
  waiting: "Nothing out with clients.",
  week: "No sessions in the next 7 days.",
};

type InvoiceRow = SummaryInvoice & { project_id: string; created_at: string; paid_at: string | null };
type InstallmentRow = SummaryInstallment & { paid_at: string | null };

export default async function AdminHome({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const { view, archived, tab: tabParam } = await searchParams;
  const showArchived = archived === "1";
  const isListView = view === "list";
  const tab: Split = tabParam === "waiting" || tabParam === "week" ? tabParam : "needs";

  const db = supabaseAdmin();
  const [projectsRes, stagesRes, contactsRes] = await Promise.all([
    db.from("projects").select("*").order("position", { ascending: true }),
    db.from("project_stages").select("*").order("position", { ascending: true }),
    db.from("contacts").select("id, name"),
  ]);
  if (projectsRes.error) throw projectsRes.error;
  if (stagesRes.error) throw stagesRes.error;
  if (contactsRes.error) throw contactsRes.error;

  const allProjects = (projectsRes.data ?? []) as Project[];
  const active = allProjects.filter((p) => !p.archived);
  const projects = allProjects.filter((p) => p.archived === showArchived);
  const stages = (stagesRes.data ?? []) as ProjectStage[];
  const contactNames = new Map((contactsRes.data ?? []).map((c) => [c.id as string, c.name as string]));

  const ids = allProjects.map((p) => p.id);
  const [invRes, conRes, quesRes, collRes] =
    ids.length > 0
      ? await Promise.all([
          db.from("invoices").select("id, project_id, status, due_date, total_cents, amount_paid_cents, created_at, paid_at").in("project_id", ids),
          db.from("contracts").select("id, project_id, status, sent_at, created_at").in("project_id", ids),
          db.from("questionnaires").select("id, project_id, submitted_at, created_at").in("project_id", ids),
          db.from("collections").select("id, project_id").in("project_id", ids),
        ])
      : [{ data: [] }, { data: [] }, { data: [] }, { data: [] }];
  const invoices = (invRes.data ?? []) as InvoiceRow[];
  const contracts = (conRes.data ?? []) as { id: string; project_id: string; status: string; sent_at: string | null; created_at: string }[];
  const questionnaires = (quesRes.data ?? []) as { id: string; project_id: string; submitted_at: string | null; created_at: string }[];

  let installments: InstallmentRow[] = [];
  if (invoices.length > 0) {
    const { data, error } = await db
      .from("invoice_installments")
      .select("id, invoice_id, amount_cents, due_date, status, paid_at")
      .in("invoice_id", invoices.map((i) => i.id));
    if (error && !isMissingTable(error)) throw error;
    installments = (data ?? []) as InstallmentRow[];
  }

  const today = businessTodayISO();
  const month = today.slice(0, 7);
  const inMonth = (ts: string | null) =>
    ts !== null && new Intl.DateTimeFormat("en-CA", { timeZone: BUSINESS_TIME_ZONE, year: "numeric", month: "2-digit" }).format(new Date(ts)) === month;
  const scheduled = new Set(installments.map((i) => i.invoice_id));
  const paidThisMonth =
    installments.filter((i) => i.status === "paid" && inMonth(i.paid_at)).reduce((s, i) => s + i.amount_cents, 0) +
    invoices.filter((i) => i.status === "paid" && !scheduled.has(i.id) && inMonth(i.paid_at)).reduce((s, i) => s + (i.amount_paid_cents ?? i.total_cents), 0);
  const credits = await loadCreditsFor(db, invoices.map((i) => i.id));
  const money = summarizeProjectMoney(invoices, installments, today, credits);

  const firstStageId = stages[0]?.id ?? null;
  const items = attentionItems({ projects: active, invoices, installments, contracts, questionnaires, firstStageId, today });
  const counts: Record<Split, number> = { needs: 0, waiting: 0, week: 0 };
  for (const it of items) counts[it.split] += 1;
  const shown = items.filter((i) => i.split === tab);

  // Gallery covers as small thumbnails (640px variant, presigned locally).
  const covers: Record<string, string> = {};
  const collections = (collRes.data ?? []) as { id: string; project_id: string }[];
  if (collections.length > 0 && r2Configured()) {
    const { data: cards } = await db.from("collection_cards").select("collection_id, cover_id").in("collection_id", collections.map((c) => c.id));
    const coverIds = (cards ?? []).map((c) => c.cover_id as string | null).filter((x): x is string => !!x);
    if (coverIds.length > 0) {
      const { data: assets } = await db.from("media_assets").select("id, collection_id, r2_key, variants, variants_ready").in("id", coverIds);
      for (const a of (assets ?? []) as { id: string; collection_id: string; r2_key: string; variants: Variants | null; variants_ready: boolean }[]) {
        const projectId = collections.find((c) => c.id === a.collection_id)?.project_id;
        if (projectId && !covers[projectId]) covers[projectId] = await presignGet(displayKey(a, GRID_SIZE));
      }
    }
  }

  // One pill per project on the board: the most urgent thing, never a "done" state.
  const badges: Record<string, Badge[]> = {};
  for (const p of projects) {
    badges[p.id] = projectBadges(
      {
        invoices: invoices.filter((r) => r.project_id === p.id),
        contracts: contracts.filter((r) => r.project_id === p.id),
        questionnaires: questionnaires.filter((r) => r.project_id === p.id),
      },
      today
    ).filter((b) => b.tone !== "green");
  }
  const clients: Record<string, string> = {};
  for (const p of projects) if (p.contact_id && contactNames.get(p.contact_id)) clients[p.id] = contactNames.get(p.contact_id)!;
  const stageValues: Record<string, number> = {};
  for (const p of projects) {
    if (!p.stage_id) continue;
    const v = invoices.filter((i) => i.project_id === p.id && i.status !== "void").reduce((s, i) => s + i.total_cents, 0);
    stageValues[p.stage_id] = (stageValues[p.stage_id] ?? 0) + v;
  }

  const monthName = new Intl.DateTimeFormat("en-US", { timeZone: BUSINESS_TIME_ZONE, month: "long" }).format(new Date());
  const dateLabel = new Intl.DateTimeFormat("en-US", { timeZone: BUSINESS_TIME_ZONE, weekday: "long", month: "long", day: "numeric" }).format(new Date());
  const viewParam = isListView ? "list" : "board";
  const keep = `view=${viewParam}${showArchived ? "&archived=1" : ""}`;

  return (
    <main className="fluid projects-home">
      <header className="ph-head">
        <div>
          <span className="ph-date">{dateLabel}</span>
          <h1>Projects</h1>
        </div>
        <dl className="ph-money">
          <div>
            <dd>{dollars(paidThisMonth)}</dd>
            <dt>paid in {monthName}</dt>
          </div>
          <div>
            <dd>{dollars(money.upcomingCents)}</dd>
            <dt>upcoming</dt>
          </div>
          <div className={money.pastDueCents > 0 ? "late" : undefined}>
            <dd>{dollars(money.pastDueCents)}</dd>
            <dt>past due</dt>
          </div>
        </dl>
      </header>

      <section className="attn" aria-label="What needs attention">
        <nav className="seg" aria-label="Lists">
          {TABS.map((t) => (
            <Link key={t.key} href={`/admin?${keep}&tab=${t.key}`} className={t.key === tab ? "on" : undefined} aria-current={t.key === tab ? "page" : undefined}>
              {t.name} <span className="n">{counts[t.key]}</span>
            </Link>
          ))}
        </nav>
        {shown.length === 0 ? (
          <p className="attn-empty">{EMPTY[tab]}</p>
        ) : (
          <ul className="attn-list">
            {shown.map((it: AttentionItem) => (
              <li key={it.key}>
                {covers[it.projectId] ? <img className="thumb" src={covers[it.projectId]} alt="" loading="lazy" /> : <span className="thumb" aria-hidden="true" />}
                <span className={`st ${it.tone}`}>{it.label}</span>
                <span className="what">
                  <Link href={`/admin/projects/${it.projectId}`} className="name">{it.title}</Link>
                  <span className="detail"> · {it.detail}</span>
                </span>
                <span className="when">{it.when}</span>
                <Link href={it.href} className="btn sm">
                  {it.action}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="pipe" aria-label="Pipeline">
        <div className="pipe-head">
          <h2>{showArchived ? "Archived projects" : "Pipeline"}</h2>
          <div className="row">
            <Link href={`/admin?view=${viewParam}${showArchived ? "" : "&archived=1"}`} className="btn quiet">
              {showArchived ? "Back to active" : "Archived"}
            </Link>
            <Link href="/admin/projects/stages" className="btn quiet">
              Edit stages
            </Link>
            <nav className="seg" aria-label="View">
              <Link href={`/admin?view=board${showArchived ? "&archived=1" : ""}&tab=${tab}`} className={isListView ? undefined : "on"}>
                Board
              </Link>
              <Link href={`/admin?view=list${showArchived ? "&archived=1" : ""}&tab=${tab}`} className={isListView ? "on" : undefined}>
                List
              </Link>
            </nav>
          </div>
        </div>

        {isListView ? (
          <table>
            <thead>
              <tr>
                <th>Project</th>
                <th>Client</th>
                <th>Stage</th>
                <th>Date</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {projects.map((pr) => (
                <tr key={pr.id}>
                  <td>
                    <Link href={`/admin/projects/${pr.id}`}>{pr.title}</Link>
                  </td>
                  <td>{clients[pr.id] ?? <span className="muted">—</span>}</td>
                  <td>
                    <span className="st stage">{stages.find((s) => s.id === pr.stage_id)?.name ?? "No stage"}</span>
                  </td>
                  <td>{pr.event_date ? formatDay(pr.event_date) : <span className="muted">TBD</span>}</td>
                  <td>
                    <span className="pills">
                      {badges[pr.id].map((bd) => (
                        <span key={bd.label} className={`st ${bd.tone}`}>
                          {bd.label}
                        </span>
                      ))}
                      {badges[pr.id].length === 0 && <span className="muted">—</span>}
                    </span>
                  </td>
                </tr>
              ))}
              {projects.length === 0 && (
                <tr>
                  <td colSpan={5}>No projects here.</td>
                </tr>
              )}
            </tbody>
          </table>
        ) : (
          <KanbanBoard stages={stages} projects={projects} clients={clients} badges={badges} covers={covers} values={stageValues} />
        )}
      </section>
    </main>
  );
}
