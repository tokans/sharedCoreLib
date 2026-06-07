# @form-engine/react

A **zero-backend rendering library** that turns a YAML manifest into a fully interactive React form or UI screen. It handles field rendering, multi-page wizards, conditional visibility, validation, computed fields, and collection (repeating group) layouts — but it never touches your backend directly.

---

## Contents

- [Installation](#installation)
- [Quick start](#quick-start)
- [How submission works](#how-submission-works)
- [FormEngineProvider config](#formenggineprovider-config)
- [Local manifests (offline / bundled forms)](#local-manifests)
- [Wizard (multi-page) forms](#wizard-multi-page-forms)
- [useFormEngine hook](#useformengine-hook)
- [UIEngine — non-form screens](#uiengine--non-form-screens)
- [Loading a manifest at runtime](#loading-a-manifest-at-runtime)
- [TypeScript types](#typescript-types)
- [What lives in your app, not here](#what-lives-in-your-app-not-here)

---

## Installation

```bash
npm install @form-engine/react
# peer dependencies
npm install react react-dom zustand yaml clsx tailwind-merge
```

---

## Quick start

```tsx
import { FormEngineProvider, FormEngine } from "@form-engine/react";
import type { FormManifest } from "@form-engine/react";

const manifest: FormManifest = {
  manifest_id: "onboarding",
  forms: {
    step1: {
      title: "Tell us about yourself",
      version: "1.0",
      layout: { type: "single-page" },
      sections: [
        {
          id: "basics",
          title: "Basic info",
          fields: [
            { id: "name",  type: "text",  label: "Full name",  required: true },
            { id: "email", type: "text",  label: "Email",      required: true },
          ],
        },
      ],
    },
  },
};

export default function Page() {
  return (
    <FormEngineProvider
      config={{
        localManifests: { onboarding: manifest },
        onSubmit: async (manifestId, formId, answers) => {
          // Send to YOUR backend — the library never does this for you
          await fetch("/api/submissions", {
            method: "POST",
            body: JSON.stringify({ manifestId, formId, answers }),
          });
        },
      }}
    >
      <FormEngine manifest={manifest} formId="step1" />
    </FormEngineProvider>
  );
}
```

---

## How submission works

The library **never calls a backend**. When the user submits a form it calls, in priority order:

1. The `onSubmit` prop passed directly to `<FormEngine>` ← highest priority
2. `config.onSubmit` from `<FormEngineProvider>` ← global fallback
3. No handler found → marks the form as locally submitted (useful in tests or demos)

The payload passed to your handler is the **filtered, validated answer set** — hidden fields, computed fields, and fields that are conditionally invisible are excluded automatically.

```tsx
// Per-form override (takes precedence over Provider config)
<FormEngine
  manifest={manifest}
  formId="checkout"
  onSubmit={async (payload) => {
    await checkoutApi.place(payload);
    router.push("/confirmation");   // navigate after success
  }}
/>
```

**Throw to surface an error to the user:**

```tsx
onSubmit={async (payload) => {
  const res = await fetch("/api/submit", { method: "POST", body: JSON.stringify(payload) });
  if (!res.ok) throw new Error(await res.text()); // shown inline in the form
}}
```

### Draft saves

The same priority chain applies to `onDraftSave`:

```tsx
<FormEngineProvider
  config={{
    onDraftSave: async (manifestId, formId, answers) => {
      localStorage.setItem(`draft:${formId}`, JSON.stringify(answers));
    },
  }}
>
  ...
</FormEngineProvider>
```

The "Save Draft" button only appears in the form UI when an `onDraftSave` handler is wired up.

---

## FormEngineProvider config

```ts
interface FormEngineConfig {
  /** Pre-loaded manifests — no network call needed to render these forms. */
  localManifests?: Record<string, FormManifest>;

  /**
   * Global submit handler. Called with (manifestId, formId, validatedAnswers).
   * Throw to display an error inside the form.
   */
  onSubmit?: (
    manifestId: string,
    formId: string,
    answers: FieldAnswers,
  ) => Promise<unknown>;

  /**
   * Global draft-save handler. Called with (manifestId, formId, currentAnswers).
   * When absent, the "Save Draft" button is hidden.
   */
  onDraftSave?: (
    manifestId: string,
    formId: string,
    answers: FieldAnswers,
  ) => Promise<void> | void;
}
```

> **Not in config:** `apiBase`, `headers`, auth tokens. Those belong in your app's API client, not here.

---

## Local manifests

Ship a form alongside your frontend bundle — zero backend dependency:

```tsx
import onboardingManifest from "@/forms/onboarding.yaml";  // via yaml-loader

<FormEngineProvider config={{ localManifests: { onboarding: onboardingManifest } }}>
  <FormEngine manifest={onboardingManifest} formId="welcome" onSubmit={…} />
</FormEngineProvider>
```

Or load at startup and bypass the manifest registry entirely — just pass the object straight to `<FormEngine manifest={…}>`.

---

## Wizard (multi-page) forms

Set `layout.type: wizard` in your YAML and add `pages`:

```yaml
layout:
  type: wizard
pages:
  - id: personal
    title: Personal info
    sections: …
  - id: address
    title: Address
    sections: …
  - id: review
    title: Review & submit
    sections: …
```

The library renders a step indicator, Back/Continue navigation, and per-page validation automatically. `onSubmit` is called only on the final page.

---

## useFormEngine hook

For custom submit buttons, multi-step flows, or reading form state outside the form component:

```tsx
import { useFormEngine } from "@form-engine/react";

function CustomFooter() {
  const { answers, errors, submitting, submit } = useFormEngine();

  const handleSave = async () => {
    const result = await submit({
      onSubmit: async (mid, fid, payload) => {
        await myApi.post("/submissions", payload);
      },
    });

    if (result.ok) {
      console.log("Submitted payload:", result.payload);
    } else if (result.error) {
      console.error("Failed:", result.error.message);
    }
  };

  return (
    <button onClick={handleSave} disabled={submitting}>
      Save
    </button>
  );
}
```

The `submit()` call validates, filters the payload, and calls your handler. The `SubmitResult` it returns has:

| Field | Type | Meaning |
|---|---|---|
| `ok` | `boolean` | `true` if valid and handler resolved |
| `payload` | `FieldAnswers` | The filtered answer set |
| `data` | `unknown` | Whatever your `onSubmit` returned |
| `error` | `Error \| undefined` | Set if your handler threw |

---

## UIEngine — non-form screens

For YAML-driven UI layouts (dashboards, nav screens, data displays):

```tsx
import { UIEngineProvider, ScreenLayout } from "@form-engine/react";
import uiManifest from "@/ui/app.yaml";

<UIEngineProvider
  manifest={uiManifest}
  handlers={{
    onNavigate: (screenKey) => router.push(`/${screenKey}`),
    onAction: (actionId, params) => dispatch({ type: actionId, payload: params }),
  }}
>
  <ScreenLayout screenKey="dashboard" />
</UIEngineProvider>
```

---

## Loading a manifest at runtime

Use `loadManifest` to parse a manifest from a URL, YAML string, or plain object:

```ts
import { loadManifest } from "@form-engine/react";

// From a URL (absolute or relative)
const manifest = await loadManifest("https://cdn.example.com/forms/onboarding.yaml");

// From a raw YAML string
const manifest = await loadManifest(`
  manifest_id: onboarding
  forms:
    step1:
      title: Welcome
      version: "1.0"
      layout:
        type: single-page
      sections: []
`);

// From a plain object (no-op, returned as-is)
const manifest = await loadManifest(rawObject);
```

> `loadManifest` validates the protocol for URL sources (https/http only) to prevent SSRF.

---

## TypeScript types

All types are exported from the package root:

```ts
import type {
  FormManifest, FormDef, FormField,
  FieldAnswers, FormErrors, FormContext,
  Page, Section, Collection,
  ConditionOrRef, StaticChoice,
  FormEngineConfig, SubmitResult,
} from "@form-engine/react";
```

---

## What lives in your app, not here

| Concern | Where it lives |
|---|---|
| **REST API client** (`listForms`, `getManifest`, `submitForm`, `saveDraft`) | `app/libs/api.ts` — your code |
| **Auth tokens / headers** | Your API client or a request interceptor |
| **Manifest CRUD** (create, update, delete via admin UI) | Your app's admin pages |
| **Backend URL config** (`apiBase`) | Your API client, env vars |
| **Submission routing / redirect after success** | Your `onSubmit` handler |

A minimal example of the app-side API client that pairs with this library:

```ts
// app/libs/api.ts  — NOT part of @form-engine/react
const BASE = process.env.NEXT_PUBLIC_API_URL ?? "";

export const formsApi = {
  getManifest: (id: string) =>
    fetch(`${BASE}/api/forms/${id}`).then(r => r.json()),

  submitForm: (manifestId: string, formId: string, answers: Record<string, unknown>) =>
    fetch(`${BASE}/api/submissions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ manifest_id: manifestId, form_id: formId, answers }),
    }).then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); }),

  saveDraft: (manifestId: string, formId: string, answers: Record<string, unknown>) =>
    fetch(`${BASE}/api/drafts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ manifest_id: manifestId, form_id: formId, answers, draft: true }),
    }).then(r => r.json()),
};
```

Then wire it into the library:

```tsx
<FormEngineProvider
  config={{
    onSubmit: formsApi.submitForm,
    onDraftSave: formsApi.saveDraft,
  }}
>
  <App />
</FormEngineProvider>
```
