/**
 * microsoft.ts — Microsoft Entra ID (Azure AD) / MSAL auto-login provider.
 * Client: msal-browser with ssoSilent + account hint (the Entra equivalent of
 * One Tap auto_select). Server: id-token verification with tenant gate.
 */
import { verifyJwt } from "./verify.ts";
import type { Provider, VerifyResult } from "./types.ts";

export const microsoft: Provider = {
  id: "microsoft",

  clientBootstrap({ clientId, loginUri, domain }) {
    return {
      msalConfig: {
        auth: {
          clientId,
          authority: `https://login.microsoftonline.com/${domain && domain.includes(".") ? domain : "common"}`,
          redirectUri: loginUri ?? "https://unicornsmap.com/auth/microsoft",
          navigateToLoginRequestUrl: false,
        },
        cache: { cacheLocation: "localStorage", storeAuthStateInCookie: false },
      },
      // Silent SSO = Entra's auto-login: reuses the Entra session cookie, no prompt.
      silentSnippet: [
        `const pca = new msal.PublicClientApplication(msalConfig);`,
        `await pca.initialize();`,
        `const accounts = pca.getAllAccounts();`,
        `const hint = accounts[0]?.username;`,
        `const res = await pca.ssoSilent({ scopes: ['openid','profile','email'], loginHint: hint, prompt: 'none' });`,
        `await fetch('/auth/microsoft', { method: 'POST', headers: {'content-type':'application/json','accept':'application/json'}, body: JSON.stringify({ idToken: res.idToken }) });`,
      ].join("\n"),
    };
  },

  verify(idToken, opts) {
    return verifyJwt(idToken, {
      ...opts,
      provider: "microsoft",
      jwksUri: `https://login.microsoftonline.com/${opts.issuer && !Array.isArray(opts.issuer) ? "common" : "common"}/discovery/v2.0/keys`,
      issuer: opts.issuer ?? "https://login.microsoftonline.com/common/v2.0",
      domainClaim: opts.domainClaim ?? { claim: "tid", allowWorkspaceAny: false },
    }) as Promise<VerifyResult>;
  },

  endpoints(tenant = "common") {
    return {
      issuer: `https://login.microsoftonline.com/${tenant}/v2.0`,
      jwksUri: `https://login.microsoftonline.com/${tenant}/discovery/v2.0/keys`,
      authUri: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`,
      tokenUri: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
    };
  },
};
