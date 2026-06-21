/**
 * Sheet — a side/bottom drawer built on Radix Dialog, shared across the suite.
 *
 * Part of the primitive UI kit (CONTRACT.md §4.2): it bakes in Tailwind utility classes, so a
 * consuming app MUST add `../sharedCoreLib/src/ui/**` to its Tailwind `content` globs (and use
 * the shared preset + `theme.css`) or these classes get purged. Styling reads the shared theme
 * tokens (`bg-background`, `border`, `text-muted-foreground`, …) so each app's palette applies.
 *
 * `side="right"|"left"` is the navigation drawer (More / Profile); `side="bottom"` is the mobile
 * bottom sheet (the central-action sheet) and renders a grab handle. The slide/fade utilities
 * come from `tailwindcss-animate` (provided by the shared preset).
 */
import * as React from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { cn } from "./cn.js";

export const Sheet = Dialog.Root;
export const SheetClose = Dialog.Close;

export type SheetSide = "right" | "left" | "bottom";

const SIDE: Record<SheetSide, string> = {
  // Full-height side drawers pad the top inset (notch/status bar) so the header isn't
  // clipped, and the matching horizontal inset for a landscape notch.
  right:
    "inset-y-0 right-0 h-full w-80 max-w-[85vw] border-l pt-[var(--safe-top,env(safe-area-inset-top))] pr-[env(safe-area-inset-right)] data-[state=open]:slide-in-from-right data-[state=closed]:slide-out-to-right",
  left:
    "inset-y-0 left-0 h-full w-80 max-w-[85vw] border-r pt-[var(--safe-top,env(safe-area-inset-top))] pl-[env(safe-area-inset-left)] data-[state=open]:slide-in-from-left data-[state=closed]:slide-out-to-left",
  bottom:
    "inset-x-0 bottom-0 max-h-[85vh] rounded-t-2xl border-t pb-[var(--safe-bottom,env(safe-area-inset-bottom))] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] data-[state=open]:slide-in-from-bottom data-[state=closed]:slide-out-to-bottom",
};

export interface SheetContentProps
  extends Omit<React.ComponentPropsWithoutRef<typeof Dialog.Content>, "title"> {
  side?: SheetSide;
  title: string;
  description?: string;
  /** Hide the default header (title/description/close) — e.g. a fully custom sheet body. */
  hideHeader?: boolean;
}

export function SheetContent({
  side = "right",
  title,
  description,
  hideHeader,
  className,
  children,
  ...props
}: SheetContentProps): React.ReactElement {
  return (
    <Dialog.Portal>
      <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
      <Dialog.Content
        className={cn(
          "fixed z-50 flex flex-col bg-background shadow-lg focus:outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:duration-200 data-[state=open]:duration-300",
          SIDE[side],
          className,
        )}
        {...props}
      >
        {side === "bottom" && (
          <div className="flex justify-center pt-2.5">
            <div className="h-1 w-10 rounded-full bg-muted-foreground/30" />
          </div>
        )}
        {hideHeader ? (
          // Radix requires an accessible title; keep it for screen readers only.
          <Dialog.Title className="sr-only">{title}</Dialog.Title>
        ) : (
          <div className="flex items-start justify-between gap-3 border-b p-4">
            <div className="min-w-0">
              <Dialog.Title className="text-base font-semibold tracking-tight">{title}</Dialog.Title>
              {description && (
                <Dialog.Description className="text-sm text-muted-foreground">
                  {description}
                </Dialog.Description>
              )}
            </div>
            <Dialog.Close className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground">
              <X className="h-4 w-4" />
              <span className="sr-only">Close</span>
            </Dialog.Close>
          </div>
        )}
        {children}
      </Dialog.Content>
    </Dialog.Portal>
  );
}
