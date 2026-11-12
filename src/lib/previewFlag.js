// ============================================================================
// PREVIEW-ROUTE FLAG — single source of truth.
//
// Controls whether fixture-backed previews (/__preview/coach-home,
// /__preview/coach-cockpit, and ?preview=) exist in a build at all. Consumers:
// the route table in App.jsx and the fixture loaders. They must agree, so the
// expression lives here rather than being written twice.
//
// THE PROPERTY THIS MUST KEEP: false in a production build.
// Both operands are statically analysable by Vite, so when this resolves to
// false the fixture module and the preview route tree-shake out entirely —
// the guarantee commit 6291841 established and verified against the bundle.
//
//   import.meta.env.DEV              true only under `vite dev`.
//   __COACHAPP_PREVIEW_ROUTES__         true only under `npm run build:preview`, so
//                                    the page can be reviewed on a real URL without
//                                    a coach login and without touching production.
//
// Never use the fixture-preview mode in the Netlify production context. Build it
// locally, then deploy the verified dist with `netlify deploy --no-build`; a normal
// Netlify deploy reruns `npm run build` and deliberately removes the fixtures.
// ============================================================================
export const PREVIEW_ROUTES_ENABLED =
  import.meta.env.DEV || globalThis.__COACHAPP_PREVIEW_ROUTES__;
