import { describe, it, expect } from "vitest";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DevRoleSwitcher, DevIdentitySwitcher, parseDevTestIdentities } from "./devSwitcher.js";

describe("parseDevTestIdentities", () => {
  it("parses a valid JSON array", () => {
    const raw = JSON.stringify([{ id: "u_local", label: "Customer", token: "t1" }]);
    expect(parseDevTestIdentities(raw)).toEqual([{ id: "u_local", label: "Customer", token: "t1" }]);
  });

  it("returns [] for missing/empty/malformed/non-array input", () => {
    expect(parseDevTestIdentities(undefined)).toEqual([]);
    expect(parseDevTestIdentities(null)).toEqual([]);
    expect(parseDevTestIdentities("")).toEqual([]);
    expect(parseDevTestIdentities("not json")).toEqual([]);
    expect(parseDevTestIdentities('{"id":"x"}')).toEqual([]);
  });
});

describe("DevRoleSwitcher", () => {
  const roles = [
    { key: "customer", label: "Customer" },
    { key: "admin", label: "Administrator" },
  ];

  it("renders every role as a pill", () => {
    const html = renderToStaticMarkup(
      <DevRoleSwitcher roles={roles} held={["customer"]} active="customer" onToggle={() => {}} />,
    );
    expect(html).toContain("Customer");
    expect(html).toContain("Administrator");
  });

  it("marks only the active held role with the ● marker", () => {
    const html = renderToStaticMarkup(
      <DevRoleSwitcher roles={roles} held={["customer", "admin"]} active="admin" onToggle={() => {}} />,
    );
    expect(html).toMatch(/Administrator\s*●/);
    expect(html).not.toMatch(/Customer\s*●/);
  });

  it("does not mark a held-but-inactive role", () => {
    const html = renderToStaticMarkup(
      <DevRoleSwitcher roles={roles} held={["customer", "admin"]} active="customer" onToggle={() => {}} />,
    );
    expect(html).toMatch(/Customer\s*●/);
    expect(html).not.toMatch(/Administrator\s*●/);
  });

  it("marks no role when there is no active held role", () => {
    const html = renderToStaticMarkup(
      <DevRoleSwitcher roles={roles} held={["customer"]} active={null} onToggle={() => {}} />,
    );
    expect(html).not.toMatch(/Customer\s*●/);
  });
});

describe("DevIdentitySwitcher", () => {
  const identities = [
    { id: "u_local", label: "Customer (requester)", token: "t1" },
    { id: "u_admin", label: "Admin (approver)", token: "t2" },
  ];

  it("renders nothing when there are no test identities", () => {
    expect(
      renderToStaticMarkup(<DevIdentitySwitcher identities={[]} currentId="u_local" onSwitch={() => {}} />),
    ).toBe("");
  });

  it("renders a pill per identity and the default title/hint", () => {
    const html = renderToStaticMarkup(
      <DevIdentitySwitcher identities={identities} currentId="u_local" onSwitch={() => {}} />,
    );
    expect(html).toContain("Customer (requester)");
    expect(html).toContain("Admin (approver)");
    expect(html).toContain("Test session");
    expect(html).toContain("swaps the REAL backend identity");
  });
});
