import * as React from "react";
import { cn } from "./cn.js";

export interface MetricCardProps {
  /** Small muted caption above the value. */
  label: string;
  /** The headline value (string or rich node, e.g. an icon + number). */
  value: React.ReactNode;
  /** Optional sub-line below the value. */
  hint?: React.ReactNode;
  className?: string;
  "data-testid"?: string;
}

/**
 * A small stat / metric card (muted surface, caption + 24px value). Shared so apps stop
 * re-declaring an inline `Stat` component per page. Tailwind-styled (shared preset + content glob).
 */
export function MetricCard({
  label,
  value,
  hint,
  className,
  "data-testid": testid,
}: MetricCardProps): React.ReactElement {
  return (
    <div className={cn("rounded-lg bg-muted/60 p-4", className)} data-testid={testid}>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-0.5 text-2xl font-medium text-foreground">{value}</div>
      {hint && <div className="mt-0.5 text-[11px] text-muted-foreground">{hint}</div>}
    </div>
  );
}
