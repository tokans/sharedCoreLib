import * as React from "react";
import { cn } from "./cn.js";

/**
 * DEV-ONLY role + test-identity switchers — promoted out of myWorkAssistant (every app with
 * backend-resolved roles/sessions was about to re-implement the same pills). Both pieces are
 * dumb UI over an app-injected callback: they hold no state, call no backend, and grant
 * nothing. The app decides what a toggle/switch DOES (e.g. write into a local UAM store, or
 * swap a real session token) — these just render the chooser and gate visibility, mirroring
 * the dev/test tier-chooser split (`sharedcorelib/tiers` + `ui/tierOverride` + `TestTierChooser`).
 */

export interface DevPillProps {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}

/** The toggle chip every dev switcher below is built from. Exported so an app's own dev
 *  panel sections (e.g. tier/persona pickers) can match the same chrome. */
export function DevPill({ active, onClick, children }: DevPillProps): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-full border px-3 py-1 text-xs transition",
        active ? "border-primary bg-primary text-primary-foreground" : "hover:bg-muted",
      )}
    >
      {children}
    </button>
  );
}

/** One selectable role in a {@link DevRoleSwitcher} (the app maps its role catalog to these). */
export interface DevRoleOption {
  key: string;
  label: string;
}

export interface DevRoleSwitcherProps {
  roles: DevRoleOption[];
  /** Roles currently held (multi-select, so the app's own role-switcher UI can be exercised). */
  held: string[];
  /** The held role whose features are currently active — marked with "●". */
  active?: string | null;
  /** Toggle one role in/out of the held set. The app applies it (e.g. a local UAM override). */
  onToggle: (roleKey: string) => void;
  title?: string;
}

/**
 * DEV-ONLY multi-select role switcher — toggle roles in/out of the held set to exercise an
 * app's role-gated UI (nav, feature flags, its own role switcher) without a backend round
 * trip. Always render this behind the same dev-build check the rest of an app's dev panel
 * uses; this component itself does not know about `import.meta.env`.
 */
export function DevRoleSwitcher({
  roles,
  held,
  active,
  onToggle,
  title = "Roles",
}: DevRoleSwitcherProps): React.ReactElement {
  return (
    <div className="space-y-1.5" data-testid="dev-role-switcher">
      <p className="text-xs font-medium text-muted-foreground">
        {title} <span className="font-normal">(multi-select — toggle to test the role switcher)</span>
      </p>
      <div className="flex flex-wrap gap-1.5">
        {roles.map((r) => {
          const isHeld = held.includes(r.key);
          return (
            <DevPill key={r.key} active={isHeld} onClick={() => onToggle(r.key)}>
              {r.label}
              {isHeld && r.key === active ? " ●" : ""}
            </DevPill>
          );
        })}
      </div>
      <p className="text-[11px] text-muted-foreground">
        ● = active role. Multiple roles ⇒ a switcher appears in your profile.
      </p>
    </div>
  );
}

/** One backend-seeded test identity, minted by a dev-fullstack script (id/label/session token). */
export interface DevTestIdentity {
  id: string;
  label: string;
  token: string;
}

/**
 * Parse a `VITE_DEV_TEST_USERS`-style env value into test identities. Pure — the app injects
 * the raw string (or undefined/null); this never reads `import.meta.env` itself. Malformed or
 * missing input yields an empty list (the switcher below renders nothing), never throws.
 */
export function parseDevTestIdentities(raw: string | undefined | null): DevTestIdentity[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as DevTestIdentity[]) : [];
  } catch {
    return [];
  }
}

export interface DevIdentitySwitcherProps {
  identities: DevTestIdentity[];
  currentId: string;
  /** Switch the ACTIVE identity. The app applies it (e.g. set the session token + re-hydrate). */
  onSwitch: (identity: DevTestIdentity) => void;
  title?: string;
  hint?: React.ReactNode;
}

/**
 * DEV-ONLY test-session switcher — swaps the REAL identity between backend-seeded test users,
 * so an admin-approval-style loop can be exercised end to end without separate logins: request
 * as one user, switch here, approve as another. Renders nothing when `identities` is empty
 * (e.g. plain `npm run dev` without a fullstack/seed script behind it).
 */
export function DevIdentitySwitcher({
  identities,
  currentId,
  onSwitch,
  title = "Test session",
  hint = "swaps the REAL backend identity",
}: DevIdentitySwitcherProps): React.ReactElement | null {
  if (identities.length === 0) return null;
  return (
    <div className="space-y-1.5" data-testid="dev-identity-switcher">
      <p className="text-xs font-medium text-muted-foreground">
        {title} <span className="font-normal">({hint})</span>
      </p>
      <div className="flex flex-wrap gap-1.5">
        {identities.map((u) => (
          <DevPill key={u.id} active={currentId === u.id} onClick={() => onSwitch(u)}>
            {u.label}
          </DevPill>
        ))}
      </div>
    </div>
  );
}
