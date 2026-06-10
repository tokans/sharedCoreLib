/**
 * Suite-wide Tailwind **preset** — the shared *default* theme (CONTRACT.md §4.2).
 *
 * This centralizes everything that should mean the same thing in every suite app:
 *   - the shadcn token→`hsl(var(--token))` colour mapping (so `bg-card`, `text-primary`,
 *     `border-border`, … resolve identically across apps),
 *   - the `--radius`-derived border-radius scale,
 *   - `darkMode: ["class"]`, and
 *   - the `tailwindcss-animate` plugin (the slide/fade utilities the shared drawer/sheet use).
 *
 * It deliberately does **not** set `content` — each app owns its content globs and MUST add
 * the lib's UI source so the shared primitives compile (CONTRACT.md §4.2):
 *
 *   // app tailwind.config.cjs
 *   const preset = require("sharedcorelib/tailwind-preset");
 *   module.exports = {
 *     presets: [preset],
 *     content: ["./index.html", "./src/**\/*.{ts,tsx}", "../sharedCoreLib/src/ui/**\/*.{ts,tsx}"],
 *     // app-only brand tokens may be added under theme.extend here; they merge over the preset.
 *   };
 *
 * The token *values* live in `sharedcorelib/ui/theme.css` (the suite default palette). Apps
 * override by re-declaring the `:root` / `.dark` custom properties in their own `index.css`
 * after importing that file — CSS cascade lets the app win, so branding stays per-app.
 *
 * CommonJS on purpose: Tailwind configs are `.cjs` and `require()` this synchronously.
 */

/** @type {Partial<import('tailwindcss').Config>} */
module.exports = {
  darkMode: ["class"],
  theme: {
    container: {
      center: true,
      padding: "1rem",
    },
    extend: {
      colors: {
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
    },
  },
  plugins: [require("tailwindcss-animate")],
};
