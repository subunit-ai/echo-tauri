import { LangProvider } from "./lib/i18n";
import { MeetingProvider } from "./store";
import { App } from "./App";
import { ssoLogin } from "./lib/auth";

// Single mountable entry for the meet UI — consumed by BOTH the web shell (main.tsx) and
// the Echo desktop app (native "Meeting" section). The only platform difference is auth:
//  - web:   host logs in via the subunit SSO redirect (ssoLogin).
//  - embed: Echo already holds the subunit access token and provides it via getEmbedToken;
//           there's no redirect (the desktop window can't round-trip an OAuth redirect the
//           same way), so the host lands pre-authenticated.
// Everything else (screens, logic, backend calls) is identical — one source, no fork.
export type AuthMode = "web" | "embed";

export interface MeetAppProps {
  authMode?: AuthMode;
  /** Embed only: resolve the current subunit access token (or null). */
  getEmbedToken?: () => Promise<string | null>;
}

export function MeetApp({ authMode = "web", getEmbedToken }: MeetAppProps) {
  return (
    <LangProvider>
      <MeetingProvider onSsoLogin={authMode === "web" ? () => ssoLogin() : () => {}}>
        <App authMode={authMode} getEmbedToken={getEmbedToken} />
      </MeetingProvider>
    </LangProvider>
  );
}
