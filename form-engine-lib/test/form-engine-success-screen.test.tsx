/**
 * Tests for the overridable submit/success-screen behaviour.
 *
 *  • Default: a successful submit shows the built-in success screen.
 *  • Manifest `show_success_screen: false` (used by signin/signup): NO success
 *    screen — the form stays mounted so the caller can redirect on the server
 *    response.
 *  • Prop `showSuccessScreen={false}` overrides the manifest.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import React from "react";
import { FormEngine } from "../src/components/FormEngine";
import { useFormEngineStore } from "../src/store/form-engine-store";
import type { FormManifest } from "../src/libs/types";

function makeManifest(opts: { showSuccess?: boolean } = {}): FormManifest {
  return {
    manifest_id: "auth_test",
    manifest_version: "4.0.0",
    forms: {
      signin: {
        title: "Sign in",
        version: "1.0.0",
        layout: { type: "single-page" },
        submit_label: "Sign in",
        on_submit: { type: "local", success_message: "Welcome back!" },
        ...(opts.showSuccess === false ? { show_success_screen: false } : {}),
        sections: [{ id: "s", fields: [{ id: "email", type: "text", label: "Email" }] }],
      },
    },
  } as unknown as FormManifest;
}

beforeEach(() => {
  useFormEngineStore.getState().reset();
  localStorage.clear();
});

describe("success-screen override", () => {
  it("shows the success screen by default", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<FormEngine manifest={makeManifest()} formId="signin" onSubmit={onSubmit} />);
    fireEvent.click(await screen.findByRole("button", { name: /sign in/i }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(await screen.findByText("Welcome back!")).toBeInTheDocument();
  });

  it("suppresses the success screen when manifest sets show_success_screen=false", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<FormEngine manifest={makeManifest({ showSuccess: false })} formId="signin" onSubmit={onSubmit} />);
    fireEvent.click(await screen.findByRole("button", { name: /sign in/i }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    // No success screen — form stays mounted (caller handles redirect)
    expect(screen.queryByText("Welcome back!")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /sign in/i })).toBeInTheDocument();
  });

  it("prop showSuccessScreen=false overrides the manifest default", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<FormEngine manifest={makeManifest()} formId="signin" onSubmit={onSubmit} showSuccessScreen={false} />);
    fireEvent.click(await screen.findByRole("button", { name: /sign in/i }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(screen.queryByText("Welcome back!")).not.toBeInTheDocument();
  });

  it("surfaces an error banner instead of success when onSubmit throws", async () => {
    const onSubmit = vi.fn().mockRejectedValue(new Error("Invalid email or password"));
    render(<FormEngine manifest={makeManifest({ showSuccess: false })} formId="signin" onSubmit={onSubmit} />);
    fireEvent.click(await screen.findByRole("button", { name: /sign in/i }));
    expect(await screen.findByText(/invalid email or password/i)).toBeInTheDocument();
  });
});
