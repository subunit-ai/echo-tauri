import { prettyName } from "./format";

// Subunit central SSO for the host — 1:1 port of the vanilla ssoLogin / handleSsoCallback.
// Guests need no login; only the host authenticates. The Echo desktop embed will provide
// the token directly (adapter) instead of the redirect flow.
export const AUTH = "https://auth.subunit.ai";

/** Decode a JWT payload (base64url) → object, or {} on any failure. */
export function decodeJwt(token: string): Record<string, unknown> {
  try {
    const payload = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const json = decodeURIComponent(
      atob(payload)
        .split("")
        .map((c) => "%" + ("00" + c.charCodeAt(0).toString(16)).slice(-2))
        .join(""),
    );
    return JSON.parse(json);
  } catch {
    return {};
  }
}

function ssoState(): string {
  try {
    return crypto.randomUUID().replace(/-/g, "");
  } catch {
    return (Date.now().toString(36) + Math.random().toString(36).slice(2)).padEnd(16, "0");
  }
}

/** Redirect the browser to the SSO authorize endpoint (host login). */
export function ssoLogin(redirectUri = "https://meet.subunit.ai/"): void {
  const st = ssoState();
  try {
    sessionStorage.setItem("meet_sso_state", st);
  } catch {
    /* ignore */
  }
  const u = new URL(AUTH + "/sso/authorize");
  u.searchParams.set("app", "meet");
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("state", st);
  location.href = u.toString();
}

export interface Identity {
  jwt: string;
  email: string;
  name: string;
}

/**
 * Handle a returning SSO callback (?code&state). Verifies the CSRF state, exchanges the
 * code for an access token, and returns the identity — or null if there's no callback /
 * it failed. Strips the query from the URL exactly like the vanilla flow.
 */
export async function handleSsoCallback(
  redirectUri = "https://meet.subunit.ai/",
): Promise<Identity | null> {
  const q = new URLSearchParams(location.search);
  const code = q.get("code");
  const state = q.get("state");
  const aerr = q.get("auth_error");
  if (aerr) {
    history.replaceState({}, "", location.pathname);
    return null;
  }
  if (!code || !state) return null;
  let exp: string | null = null;
  try {
    exp = sessionStorage.getItem("meet_sso_state");
    sessionStorage.removeItem("meet_sso_state");
  } catch {
    /* ignore */
  }
  history.replaceState({}, "", location.pathname);
  if (!exp || exp !== state) return null;
  try {
    const r = await fetch(AUTH + "/sso/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, app: "meet", redirect_uri: redirectUri }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.access_token) return null;
    const c = decodeJwt(d.access_token);
    return {
      jwt: d.access_token,
      email: (c.email as string) || "",
      name: prettyName((c.name as string) || (c.email as string) || ""),
    };
  } catch {
    return null;
  }
}

/** Build the identity from an externally-provided access token (Echo desktop embed). */
export function identityFromToken(token: string): Identity {
  const c = decodeJwt(token);
  return {
    jwt: token,
    email: (c.email as string) || "",
    name: prettyName((c.name as string) || (c.email as string) || ""),
  };
}
