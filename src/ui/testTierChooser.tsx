import * as React from "react";
import { FlaskConical, X } from "lucide-react";
import { cn } from "./cn.js";
import type { TierOverride } from "./tierOverride.js";

/** One selectable tier in the chooser (the app maps its ladder to these). */
export interface TestTierOption {
  key: string;
  label: string;
  icon?: React.ReactNode;
}

export interface TestTierChooserProps {
  /** The override created via `createTierOverride` — gates visibility + persists the choice. */
  override: TierOverride;
  /** The app's tier ladder as selectable options (low → high). */
  options: TestTierOption[];
  /** The currently-active override key (highlighted), or null for "live". */
  current?: string | null;
  /** Called after a choice (or clear). The app applies it (e.g. refresh stores / re-derive flags). */
  onApply: (key: string | null) => void | Promise<void>;
  title?: string;
}

/**
 * A floating DEV-only tier chooser — preview any tier without meeting its real criteria. Renders
 * nothing unless `override.allowed()` (dev build / prod escape hatch), so it is safe to mount
 * unconditionally. Purely a client-side preview: it grants no real entitlement. Reusable across
 * the suite — each app passes its ladder + an `onApply` that re-derives its tier/flags.
 */
export function TestTierChooser({
  override,
  options,
  current,
  onApply,
  title = "Test tier",
}: TestTierChooserProps): React.ReactElement | null {
  const [open, setOpen] = React.useState(false);
  if (!override.allowed()) return null;

  const apply = async (key: string | null) => {
    override.set(key);
    await onApply(key);
    setOpen(false);
  };

  return (
    <div className="fixed bottom-3 right-3 z-[9999]" data-testid="test-tier-chooser">
      {open ? (
        <div className="w-64 rounded-lg border bg-card p-2 shadow-xl">
          <div className="flex items-center justify-between px-1 pb-1">
            <span className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              <FlaskConical className="h-3.5 w-3.5" /> {title}
            </span>
            <button type="button" onClick={() => setOpen(false)} aria-label="Close tier chooser">
              <X className="h-4 w-4 text-muted-foreground" />
            </button>
          </div>
          <div className="flex flex-col gap-0.5">
            {options.map((o) => (
              <button
                key={o.key}
                type="button"
                data-testid={`test-tier-${o.key}`}
                onClick={() => void apply(o.key)}
                className={cn(
                  "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-accent",
                  current === o.key && "bg-accent text-accent-foreground",
                )}
              >
                {o.icon}
                <span className="flex-1 text-left">{o.label}</span>
              </button>
            ))}
            <button
              type="button"
              data-testid="test-tier-clear"
              onClick={() => void apply(null)}
              className={cn(
                "mt-1 rounded-md border px-2 py-1.5 text-xs transition-colors hover:bg-accent",
                current == null ? "border-primary text-primary" : "text-muted-foreground",
              )}
            >
              Live (no override)
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="Open tier chooser"
          title="Test tier chooser (dev)"
          className="flex h-11 w-11 items-center justify-center rounded-full bg-amber-500 text-white shadow-lg transition-transform hover:scale-105"
        >
          <FlaskConical className="h-5 w-5" />
        </button>
      )}
    </div>
  );
}
