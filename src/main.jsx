import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { AuthProvider } from "./context/AuthContext";
import App from "./App";
import RootErrorBoundary from "./components/RootErrorBoundary";
import { captureAttribution } from "./lib/attribution";
// Self-hosted variable font (weight 100–900 + width 62–125%) — the app's typographic
// signature. Imported before index.css so @font-face is registered when styles apply.
import "@fontsource-variable/archivo/wdth.css";
// Bebas Neue was loaded here as the coach-home display face for tenants with
// tenant_config.type_key = 'condensed'. That page now uses the app's own .display
// treatment (Archivo, weight 900, width 118%) like every other screen, so nothing
// referenced the second family any more and it was a font download for no glyphs.
// One family, two voices — see .display in index.css.
import "./index.css";

try { sessionStorage.removeItem("coachapp-chunk-reload"); } catch { /* private mode */ }

// Read the tagged link the visitor arrived on (?src=…&med=…&camp=…&cnt=…) before anything
// renders, and keep it first-party for 30 days so the checkout that follows — today or three
// weeks from now — can tell Stripe which post produced the sale. First touch wins; an untagged
// visit stores nothing. Never throws. See src/lib/attribution.js.
captureAttribution();

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {});
  });
}

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <RootErrorBoundary>
      <BrowserRouter>
        <AuthProvider>
          <App />
        </AuthProvider>
      </BrowserRouter>
    </RootErrorBoundary>
  </React.StrictMode>
);
