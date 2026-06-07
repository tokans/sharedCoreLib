# CLAUDE.md — @form-engine/react

## What this library is

A **pure rendering library**. It takes a YAML/JSON manifest and renders a fully
interactive form (or a YAML-driven UI layout). It has **no backend of its own**.
All network I/O — form submission, draft persistence, fetching manifest files
from a server — is delegated to the consuming application via callbacks.

## Non-negotiable constraints

1. **No `fetch` calls to app-controlled APIs inside this library.**
   The only allowed `fetch` inside the library is in `FieldRenderers.tsx` for
   loading dynamic choice options whose URL is declared _inside the YAML manifest
   itself_. Everything else (form submission, draft saves, manifest CRUD) must go
   through callbacks.

2. **`src/libs/api.ts` does NOT belong here.**
   That file is the application's API client. If you see it re-added to this
   repo, move it back to the consuming app.

3. **`FormEngineConfig` must stay lean.**
   It contains only: `localManifests`, `onSubmit`, `onDraftSave`.
   Do NOT add `apiBase`, `headers`, `auth`, or any other backend-routing concern.

4. **The submission contract is a plain callback.**
   Both layouts (`SinglePageLayout`, `WizardLayout`) and `useFormEngine` resolve
   the submit handler using the same priority chain:
   `onSubmit prop` → `getConfig().onSubmit` → mark submitted locally.
   Never short-circuit this chain by calling a hardcoded URL.

## Directory structure

```
src/
├── components/
│   ├── FormEngine/           # Form rendering engine
│   │   ├── indexx.tsx        # <FormEngine> + <FieldRouter> components
│   │   ├── index.ts          # Re-exports indexx.tsx
│   │   ├── safe.ts / safex.tsx   # Error-boundary wrapped variants
│   │   ├── FormErrorBoundary.ts  # React error boundary
│   │   ├── CollectionRenderer.tsx
│   │   ├── fields/
│   │   │   └── FieldRenderers.tsx   # Per-type field components
│   │   └── layouts/
│   │       ├── SinglePageLayout.tsx  # Flat / section-based form layout
│   │       └── WizardLayout.tsx      # Multi-page wizard layout
│   ├── FormEngineProvider.tsx    # React context + module-level config sync
│   └── UIEngine/             # YAML-driven UI layout engine (non-form screens)
│       ├── context.ts        # UIEngineProvider, hooks, reducer
│       ├── renderers.tsx     # Component renderers
│       ├── layout.tsx        # Layout containers
│       ├── types.ts          # UIDesignManifest types
│       └── index.ts          # Barrel export
├── hooks/
│   └── useFormEngine.ts      # Convenience hook — no direct API calls
├── libs/
│   ├── condition-evaluator.ts  # Pure logic: conditions, computed fields, validation
│   ├── config.ts               # FormEngineConfig — library-side only
│   ├── manifest-loader.ts      # Load manifest from URL, YAML string, or object
│   ├── types.ts                # All TypeScript types (FormManifest, FormDef, …)
│   └── utils.ts                # cn(), formatDate(), debounce()
├── store/
│   └── form-engine-store.ts    # Zustand store — answers, errors, navigation
└── index.ts                    # Public library entry point
```

## Files that live in the APP (not here)

| File | Why it belongs in the app |
|---|---|
| `libs/api.ts` | Backend REST client — app-specific base URLs, auth headers, route paths |
| Any auth provider / token store | App-level concern |
| Manifest fetching logic | App calls `api.getManifest()` then passes the result to `<FormEngine manifest={…}>` |

## Key patterns

### Wiring in backend calls

```tsx
// app/providers.tsx
import { FormEngineProvider } from "@form-engine/react";
import { myApi } from "@/libs/api";          // lives in YOUR app

export function Providers({ children }) {
  return (
    <FormEngineProvider
      config={{
        localManifests: { auth: authManifest },
        onSubmit: async (manifestId, formId, answers) => {
          await myApi.submitForm(manifestId, formId, answers);
        },
        onDraftSave: async (manifestId, formId, answers) => {
          await myApi.saveDraft(manifestId, formId, answers);
        },
      }}
    >
      {children}
    </FormEngineProvider>
  );
}
```

### Per-form override (takes precedence over Provider config)

```tsx
<FormEngine
  manifest={manifest}
  formId="checkout"
  onSubmit={async (payload) => {
    // This overrides the global onSubmit for this form only
    await checkoutApi.place(payload);
    router.push("/confirmation");
  }}
/>
```

### Loading a manifest at runtime

```tsx
// app/page.tsx — fetch in the app, pass result to the library
const manifest = await myApi.getManifest("onboarding");
return <FormEngine manifest={manifest} formId="step1" onSubmit={handleSubmit} />;
```

### Using `useFormEngine` imperatively

```tsx
const { submit, answers, errors } = useFormEngine();

const handleCustomSubmit = async () => {
  const result = await submit({
    onSubmit: async (mid, fid, payload) => {
      await myApi.post("/submissions", payload);
    },
  });
  if (result.ok) router.push("/done");
};
```

## Adding a new field type

1. Add the type definition to `src/libs/types.ts`.
2. Add a renderer component to `src/components/FormEngine/fields/FieldRenderers.tsx`.
3. Add a `case` in the `FieldRouter` switch in `src/components/FormEngine/indexx.tsx`.
4. Add validation rules to `src/libs/condition-evaluator.ts` if needed.

## Adding a new layout type

1. Create `src/components/FormEngine/layouts/<Name>Layout.tsx`.
2. Follow the `LayoutProps` interface (manifest, form, formId, onSubmit, onDraftSave, readOnly).
3. Use `getConfig()` for the submit handler chain — **do not import api.ts**.
4. Register it in `src/components/FormEngine/indexx.tsx`.

## Running checks locally

```bash
# Type check
npx tsc --noEmit

# Build
npx tsup src/index.ts --format esm,cjs --dts

# Unit tests (condition evaluator, store)
npx vitest run
```

## Common mistakes

| Mistake | Fix |
|---|---|
| Importing `api.ts` in a layout or hook | Use `getConfig().onSubmit` instead |
| Adding `apiBase` back to `FormEngineConfig` | It belongs in the app's `api.ts` |
| Calling `fetch("/api/submissions")` directly | Pass an `onSubmit` prop; let the app handle it |
| Exporting `api` or `categoryApi` from `index.ts` | Those are app-level exports |
