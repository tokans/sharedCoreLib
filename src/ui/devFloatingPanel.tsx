import * as React from "react";
import { FlaskConical, X } from "lucide-react";

export interface DevFloatingPanelProps {
  /** Gate — pass `import.meta.env.DEV` (or a prod escape hatch). Renders nothing when false. */
  dev: boolean;
  title?: string;
  icon?: React.ReactNode;
  /** The panel's contents when open (e.g. a stack of {@link DevRoleSwitcher}/{@link DevIdentitySwitcher} sections). */
  children: React.ReactNode;
  defaultOpen?: boolean;
}

/**
 * The floating bottom-right "dev tools" affordance every dev-only chooser in the suite uses
 * (the same chrome {@link TestTierChooser} renders internally) — collapsed to a small round
 * button, expands into a scrollable card. Generalized here (children instead of a fixed
 * option list) so an app can compose several dev sections (role switcher, test-identity
 * switcher, tier/persona pickers, …) behind ONE floating affordance instead of a Settings-page
 * card. Self-gates on `dev`, so it is safe to mount unconditionally at the app-shell root.
 */
export function DevFloatingPanel({
  dev,
  title = "Dev tools",
  icon,
  children,
  defaultOpen = false,
}: DevFloatingPanelProps): React.ReactElement | null {
  const [open, setOpen] = React.useState(defaultOpen);
  if (!dev) return null;

  return (
    <div className="fixed bottom-3 right-3 z-[9999]" data-testid="dev-floating-panel">
      {open ? (
        <div className="max-h-[80vh] w-72 space-y-3 overflow-y-auto rounded-lg border bg-card p-3 shadow-xl">
          <div className="flex items-center justify-between px-1 pb-1">
            <span className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {icon ?? <FlaskConical className="h-3.5 w-3.5" />} {title}
            </span>
            <button type="button" onClick={() => setOpen(false)} aria-label={`Close ${title}`}>
              <X className="h-4 w-4 text-muted-foreground" />
            </button>
          </div>
          {children}
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label={`Open ${title}`}
          title={`${title} (dev)`}
          className="flex h-11 w-11 items-center justify-center rounded-full bg-amber-500 text-white shadow-lg transition-transform hover:scale-105"
        >
          {icon ?? <FlaskConical className="h-5 w-5" />}
        </button>
      )}
    </div>
  );
}
