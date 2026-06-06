/**
 * Reminders engine — app-agnostic.
 *
 * Three reusable parts, none of which know an app's domain:
 *   1. Pure scheduling logic (day-precision 'YYYY-MM-DD' math, bucketing,
 *      should-notify, annual roll-forward) — deterministic, fully testable.
 *   2. Best-effort OS notifications via tauri-plugin-notification.
 *   3. A `runReminderSweep` that raises exactly ONE OS notification per sweep
 *      summarising what's due, driven by injected adapters.
 *
 * The APP supplies the derived-reminder GENERATORS and the DB adapters (sync
 * derived, list open, mark fired). Snooze/dismiss preservation lives in the app's
 * derived-sync (it merges by a stable dedupe key); this module never mutates that
 * state beyond `markFired` after a notification.
 */
import { isTauri } from "../env/index.js";

// ── Pure scheduling logic ───────────────────────────────────────────────────

export type ReminderBucket = "overdue" | "due_soon" | "upcoming" | "snoozed";

/** A reminder is "due soon" when it falls within this many days. */
export const DUE_SOON_DAYS = 14;

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Midnight-UTC epoch for a 'YYYY-MM-DD' string. */
function toUTC(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number);
  return Date.UTC(y!, (m ?? 1) - 1, d ?? 1);
}

function fromUTC(ms: number): string {
  const dt = new Date(ms);
  return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
}

/** Whole days from `a` to `b` (positive when `b` is later). */
export function daysBetween(a: string, b: string): number {
  return Math.round((toUTC(b) - toUTC(a)) / 86_400_000);
}

export function addDaysISO(iso: string, n: number): string {
  return fromUTC(toUTC(iso) + n * 86_400_000);
}

/** Add whole years, preserving month/day (Feb 29 → Feb 28 in non-leap years via clamping). */
export function addYearsISO(iso: string, n: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const year = y! + n;
  const lastDay = new Date(Date.UTC(year, m!, 0)).getUTCDate();
  return `${year}-${pad2(m!)}-${pad2(Math.min(d!, lastDay))}`;
}

export interface ReminderLike {
  due_date: string;
  status?: string;
  snoozed_until?: string | null;
}

/** A snooze is active while `snoozed_until` is strictly after today. */
export function isSnoozed(r: ReminderLike, today: string): boolean {
  return !!r.snoozed_until && daysBetween(today, r.snoozed_until) > 0;
}

/** Which inbox bucket an open reminder belongs in. */
export function bucketFor(r: ReminderLike, today: string): ReminderBucket {
  if (isSnoozed(r, today)) return "snoozed";
  const days = daysBetween(today, r.due_date);
  if (days < 0) return "overdue";
  if (days <= DUE_SOON_DAYS) return "due_soon";
  return "upcoming";
}

/** Reminders that warrant an OS notification today: open, overdue or due-soon, not snoozed. */
export function shouldNotify(r: ReminderLike, today: string): boolean {
  if (r.status && r.status !== "open") return false;
  const b = bucketFor(r, today);
  return b === "overdue" || b === "due_soon";
}

/**
 * Advance an annual due date to its next occurrence strictly in the future
 * relative to `today`.
 */
export function nextAnnual(due: string, today: string): string {
  let next = due;
  while (daysBetween(today, next) < 0) next = addYearsISO(next, 1);
  if (daysBetween(today, next) === 0) next = addYearsISO(next, 1);
  return next;
}

/**
 * Next annual review date: the 1st of the given 1-based month, on or after today.
 * (myFinance uses its FY-start month here; the helper itself is calendar-generic.)
 */
export function fyReviewDueDate(startMonth: number, today: string): string {
  const [y] = today.split("-").map(Number);
  const candidate = `${y}-${pad2(startMonth)}-01`;
  return daysBetween(today, candidate) >= 0 ? candidate : `${y! + 1}-${pad2(startMonth)}-01`;
}

/** Sort comparator: earliest due date first. */
export function byDueDate(a: ReminderLike, b: ReminderLike): number {
  return a.due_date.localeCompare(b.due_date);
}

/** Human-friendly relative label, e.g. "in 3 days", "today", "5 days overdue". */
export function dueLabel(due: string, today: string): string {
  const d = daysBetween(today, due);
  if (d === 0) return "today";
  if (d === 1) return "tomorrow";
  if (d === -1) return "1 day overdue";
  if (d < 0) return `${-d} days overdue`;
  return `in ${d} days`;
}

// ── OS notifications ────────────────────────────────────────────────────────

/**
 * Ensure (request if needed) OS notification permission. Best-effort: any failure
 * (plugin missing, denied, browser mode) returns false rather than throwing.
 */
export async function ensureNotificationPermission(): Promise<boolean> {
  if (!isTauri()) return false;
  try {
    const { isPermissionGranted, requestPermission } = await import(
      "@tauri-apps/plugin-notification"
    );
    if (await isPermissionGranted()) return true;
    return (await requestPermission()) === "granted";
  } catch {
    return false;
  }
}

/** Send one OS notification. No-ops silently outside Tauri or on any failure. */
export async function sendNotification(title: string, body?: string): Promise<void> {
  if (!isTauri()) return;
  try {
    const { sendNotification: send } = await import("@tauri-apps/plugin-notification");
    send({ title, body });
  } catch {
    // No-op: notifications are a nice-to-have, never block on them.
  }
}

// ── Sweep ───────────────────────────────────────────────────────────────────

/** Minimal reminder row the sweep needs; the app's row is a superset. */
export interface SweepReminder extends ReminderLike {
  id: number | string;
  title: string;
  last_fired_on?: string | null;
}

export interface ReminderSweepAdapters<R extends SweepReminder> {
  /** Today as 'YYYY-MM-DD' (injected so the sweep stays deterministic + testable). */
  today: string;
  /** Regenerate derived reminders from app data (preserving snooze/dismiss). Result ignored. */
  syncDerived: () => Promise<unknown>;
  /** List currently-open reminders. */
  listOpen: () => Promise<R[]>;
  /** Record that a reminder fired a notification today (so it won't re-fire). Result ignored. */
  markFired: (id: R["id"], today: string) => Promise<unknown>;
}

/**
 * Run one reminder sweep: refresh derived reminders, then raise a SINGLE OS
 * notification summarising anything overdue/due-soon not already notified today.
 * Best-effort — any failure is swallowed so it never blocks startup. Returns the
 * open reminder count.
 */
export async function runReminderSweep<R extends SweepReminder>(
  a: ReminderSweepAdapters<R>,
): Promise<number> {
  if (!isTauri()) return 0;
  try {
    await a.syncDerived();
    const open = await a.listOpen();
    const due = open.filter((r) => shouldNotify(r, a.today) && r.last_fired_on !== a.today);

    if (due.length > 0 && (await ensureNotificationPermission())) {
      const title =
        due.length === 1 ? "1 reminder needs attention" : `${due.length} reminders need attention`;
      const body =
        due.slice(0, 4).map((r) => `• ${r.title}`).join("\n") +
        (due.length > 4 ? `\n…and ${due.length - 4} more` : "");
      await sendNotification(title, body);
      for (const r of due) await a.markFired(r.id, a.today);
    }
    return open.length;
  } catch {
    return 0;
  }
}
