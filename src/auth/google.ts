/**
 * google.ts — Google Identity Services (GIS) auto-login provider.
 * Covers: One Tap, auto_select, Federated Credential Management (FedCM),
 * silent Credential Management API retrieval, and server-side ID-token
 * verification with the `hd` (hosted domain) tenant gate.
 */
import { verifyJwt } from "./verify.ts";
import type { Provider, VerifyOptions, VerifyResult } from "./types.ts";

export const GOOGLE_ISSUERS = ["accounts.google.com", "https://accounts.google.com"];

export const google: Provider = {
  id: "google",

  clientBootstrap({ clientId, loginUri, domain }) {
    return {
      // Drop-in <div id="g_id_onload"> attributes:
      attributes: {
        "data-client_id": clientId,
        "data-auto_select": "true",            // automatic sign-in for returning consented users
        "data-itp_support": "true",            // required for auto_select under ITP
        "data-context": "signin",
        ...(domain ? { "data-hd": domain } : { "data-hd": "*" }), // Workspace-only account chooser
        ...(loginUri ? { "data-login_uri": loginUri } : {}),
      },
      // JS-API equivalent (preferred for "prompt after user action" UX):
      jsSnippet: [
        `const c = document.createElement('script');`,
        `c.src = 'https://accounts.google.com/gsi/client'; c.async = true; c.defer = true;`,
        `document.head.appendChild(c);`,
        `c.onload = () => { google.accounts.id.initialize({ client_id: '${clientId}', auto_select: true, itp_support: true, use_fedcm_for_prompt: true, callback: handleCredentialResponse }); google.accounts.id.prompt(); };`,
      ].join("\n"),
      // Silent FedCM / Credential Management retrieval (no UI, no password):
      silentSnippet: [
        `const controller = new AbortController();`,
        `try {`,
        `  const cred = await navigator.credentials.get({`,
        `    identity: { providers: [{ configURL: 'https://accounts.google.com/gsi/fedcm.json', clientId: '${clientId}' }] },`,
        `    mediation: 'silent', signal: controller.signal,`,
        `  });`,
        `  if (cred) await fetch('/auth/google', { method: 'POST', headers: {'content-type':'application/json','accept':'application/json'}, body: JSON.stringify({ credential: cred.token }) });`,
        `} catch { /* fall back to explicit button */ }`,
      ].join("\n"),
      csp: "script-src 'self' https://accounts.google.com; frame-src https://accounts.google.com; connect-src 'self' https://accounts.google.com",
    };
  },

  verify(idToken, opts) {
    return verifyJwt(idToken, {
      ...opts,
      provider: "google",
      jwksUri: "https://www.googleapis.com/oauth2/v3/certs",
      issuer: opts.issuer ?? GOOGLE_ISSUERS,
      domainClaim: opts.domainClaim ?? { claim: "hd", allowWorkspaceAny: false },
    }) as Promise<VerifyResult>;
  },

  endpoints() {
    return {
      issuer: "https://accounts.google.com",
      jwksUri: "https://www.googleapis.com/oauth2/v3/certs",
      authUri: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUri: "https://oauth2.googleapis.com/token",
    };
  },
};

/** Server-side "Sign in with Google" redirect flow (for offline/refresh-token agent access). */
export function googleAuthUrl(opts: {
  clientId: string; redirectUri: string; scope?: string; state?: string; domain?: string; accessType?: "offline" | "online";
}): string {
  const q = new URLSearchParams({
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
    response_type: "code",
    scope: opts.scope ?? "openid email profile",
    access_type: opts.accessType ?? "offline",
    include_granted_scopes: "true",
    prompt: "consent",
    ...(opts.domain ? { hd: opts.domain } : {}),
    ...(opts.state ? { state: opts.state } : {}),
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
}

/** Default tenant policy for UnicornsMap internal HNWI/UHNWI access. */
export const GOOGLE_UM_POLICY: VerifyOptions = {
  issuer: GOOGLE_ISSUERS,
  audience: "", // set to your OAuth Client ID
  domainClaim: { claim: "hd", equals: "unicornsmap.com" },
};
