import * as Sentry from "@sentry/react";
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./i18n"; // initialize translations before first render
import "./styles/tokens.css";
import "./styles/app.css";

// Crash reporting. No-op unless VITE_SENTRY_DSN is set at build time.
// We never send audio or transcript content.
const dsn = import.meta.env.VITE_SENTRY_DSN as string | undefined;
if (dsn) {
  Sentry.init({ dsn, tracesSampleRate: 0 });
}

// Last-resort UI for an otherwise-fatal render error — without this a single
// thrown error blanks the whole window (white screen) with no way out.
function CrashScreen({ error }: { error: unknown }) {
  const msg = error instanceof Error ? error.message : String(error);
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        height: "100vh",
        gap: 16,
        padding: 24,
        textAlign: "center",
        fontFamily: "-apple-system, system-ui, sans-serif",
        background: "#0f172a",
        color: "#e2e8f0",
      }}
    >
      <h2 style={{ color: "#22d3ee", margin: 0 }}>Etwas ist schiefgelaufen</h2>
      <p style={{ maxWidth: 420, opacity: 0.85, margin: 0 }}>
        Echo ist auf einen unerwarteten Fehler gestoßen. Ein Neustart der Ansicht
        behebt das meist.
      </p>
      <code style={{ fontSize: "0.75rem", opacity: 0.6, maxWidth: 460, wordBreak: "break-word" }}>
        {msg}
      </code>
      <button
        type="button"
        onClick={() => window.location.reload()}
        style={{
          marginTop: 8,
          padding: "10px 22px",
          borderRadius: 10,
          border: "1px solid rgba(34,211,238,0.45)",
          background: "rgba(34,211,238,0.12)",
          color: "#22d3ee",
          fontWeight: 700,
          cursor: "pointer",
        }}
      >
        Neu laden
      </button>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Sentry.ErrorBoundary fallback={({ error }) => <CrashScreen error={error} />}>
      <App />
    </Sentry.ErrorBoundary>
  </React.StrictMode>,
);
