/**
 * PiiEgressDialog — app-agnostic confirm-before-egress gate. When a payload is about to
 * leave the device, the app scans it and (if PII is found) renders this dialog: the user
 * must explicitly confirm, or choose to send a redacted copy. Egress is GATED — there is no
 * default-allow path.
 *
 * Purge-safe + SSR-safe like the rest of `ui`: bakes in NO utility classes (the app styles
 * via `className`s), no `window` at import. Content + actions are injected via props.
 */
import * as React from "react";
import type { PiiMatch } from "./index.js";

export interface PiiEgressDialogProps {
  /** The PII the app's scan found in the outgoing payload. Empty → nothing to warn about. */
  matches: PiiMatch[];
  /** A human label for what's being sent (e.g. "AI insight request"). */
  purpose?: string;
  /** User approved sending as-is. */
  onSend: () => void;
  /** User chose to send a redacted copy. Omit to hide that action. */
  onSendRedacted?: () => void;
  /** User cancelled — nothing egresses. */
  onCancel: () => void;
  className?: string;
}

/** Group matches by kind for a compact summary ("2 emails, 1 PAN"). */
export function summarizeMatches(matches: PiiMatch[]): { kind: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const m of matches) counts.set(m.kind, (counts.get(m.kind) ?? 0) + 1);
  return [...counts.entries()].map(([kind, count]) => ({ kind, count }));
}

/**
 * The egress confirmation dialog. Renders nothing when there's no PII (the caller can send
 * straight through). When PII is present the only ways forward are an explicit Send, an
 * optional Send-redacted, or Cancel — the guard never auto-approves.
 */
export function PiiEgressDialog(props: PiiEgressDialogProps): React.ReactElement | null {
  if (!props.matches.length) return null;
  const summary = summarizeMatches(props.matches);
  return (
    <div role="alertdialog" aria-modal="true" aria-label="Confirm data before it leaves your device" className={props.className} data-pii-egress-dialog="">
      <p>
        This {props.purpose ?? "request"} contains personal data that will leave your device:
      </p>
      <ul>
        {summary.map((s) => (
          <li key={s.kind} data-pii-kind={s.kind}>
            {s.count} × {s.kind}
          </li>
        ))}
      </ul>
      <div data-pii-actions="">
        <button type="button" onClick={props.onCancel} data-action="cancel">Cancel</button>
        {props.onSendRedacted && (
          <button type="button" onClick={props.onSendRedacted} data-action="send-redacted">Send redacted</button>
        )}
        <button type="button" onClick={props.onSend} data-action="send">Send anyway</button>
      </div>
    </div>
  );
}
