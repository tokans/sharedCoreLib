import * as React from "react";
import { cn } from "./cn.js";

/** Visual emphasis. `primary` = the accent CTA; `secondary` = outlined; `ghost` = bare; `danger` = destructive. */
export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md";

const VARIANTS: Record<ButtonVariant, string> = {
  primary: "bg-primary text-primary-foreground hover:opacity-90",
  secondary: "border border-border bg-card text-foreground hover:bg-accent",
  ghost: "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
  danger: "bg-destructive text-destructive-foreground hover:opacity-90",
};

const SIZES: Record<ButtonSize, string> = {
  sm: "px-3 py-1.5 text-xs",
  md: "px-4 py-2 text-sm",
};

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

/**
 * The shared suite button primitive (CONTRACT §4 — the first of the in-app shadcn primitives,
 * promoted to core so every app stops re-pasting the same CTA class string). Tailwind-styled, so
 * consuming apps need the shared preset + theme + `../sharedCoreLib/src/ui/**` content glob.
 */
export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "primary", size = "md", className, type, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type ?? "button"}
      className={cn(
        "inline-flex items-center justify-center gap-2 rounded-md font-medium transition-opacity disabled:opacity-50",
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...rest}
    />
  );
});
