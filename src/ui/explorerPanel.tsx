/**
 * ExplorerPanel — a collapsible left-hand panel for the suite's "explorer + canvas" layouts
 * (an asset/page/file list on the left, a big work surface on the right — e.g. myWorkAssistant's
 * comic studio, a future document/photo explorer). Collapsing it to an icon-only rail hands the
 * freed width back to the canvas; expanding restores the full panel. Pure presentation — the
 * collapsed flag is controlled by the app (so it can persist it) and the rail's icons/actions are
 * app-supplied.
 *
 * Primitive-kit member (CONTRACT.md §4.2): bakes Tailwind utilities like `SuiteShell`/`Sheet`.
 */
import * as React from "react";
import { PanelLeftClose, PanelLeftOpen, type LucideIcon } from "lucide-react";
import { cn } from "./cn.js";

/** One icon button shown on the collapsed rail. */
export interface ExplorerPanelRailItem {
  key: string;
  icon: LucideIcon;
  label: string;
  /** Defaults to expanding the panel when omitted. */
  onClick?: () => void;
  active?: boolean;
}

export interface ExplorerPanelProps {
  /** Controlled collapse state — the app owns it (e.g. persists it per editor). */
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
  /** The panel's full content, shown only while expanded. */
  children: React.ReactNode;
  /** Icon-only buttons shown on the collapsed rail, top to bottom. */
  railItems?: ExplorerPanelRailItem[];
  /** Heading shown in the expanded header, left of the collapse button. */
  title?: string;
  /** CSS width while expanded. Default "260px". */
  width?: string;
  /** CSS width while collapsed (the icon rail). Default "48px". */
  collapsedWidth?: string;
  className?: string;
}

/**
 * A collapsible side panel: full content when expanded, an icon-only rail when collapsed. Sizes
 * itself via inline `width` so a CSS-grid host column (`gridTemplateColumns`) can read the same
 * value back for the column track — see myWorkAssistant's ComicEditor for the pattern.
 */
export function ExplorerPanel(props: ExplorerPanelProps): React.ReactElement {
  const {
    collapsed, onCollapsedChange, children, railItems = [], title,
    width = "260px", collapsedWidth = "48px", className,
  } = props;

  return (
    <div
      className={cn("flex h-full min-h-0 min-w-0 flex-col", className)}
      style={{ width: collapsed ? collapsedWidth : width }}
    >
      <div className={cn("flex items-center gap-1 pb-2", collapsed ? "justify-center" : "justify-between")}>
        {!collapsed && title && (
          <span className="truncate text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {title}
          </span>
        )}
        <button
          type="button"
          aria-label={collapsed ? "Expand panel" : "Collapse panel"}
          title={collapsed ? "Expand" : "Collapse"}
          onClick={() => onCollapsedChange(!collapsed)}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
        >
          {collapsed ? <PanelLeftOpen className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
        </button>
      </div>

      {collapsed ? (
        <div className="flex flex-1 flex-col items-center gap-1 overflow-y-auto">
          {railItems.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.key}
                type="button"
                aria-label={item.label}
                title={item.label}
                onClick={item.onClick ?? (() => onCollapsedChange(false))}
                className={cn(
                  "flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground",
                  item.active && "bg-accent text-accent-foreground",
                )}
              >
                <Icon className="h-4 w-4" />
              </button>
            );
          })}
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
      )}
    </div>
  );
}
