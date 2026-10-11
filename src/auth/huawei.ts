/**
 * huawei.ts — Huawei HMS Account Kit provider (APAC / China coverage).
 * HMS Account Kit supports silent authorization and an ID token that is
 * verified against HMS's JWKS. Same identity contract as Google/Microsoft so
 * the swarm treats all three uniformly.
 */
import { verifyJwt } from "./verify.ts";
import type { Provider, VerifyResult } from "./types.ts";

export const huawei: Provider = {
  id: "huawei",

  clientBootstrap({ clientId, loginUri }) {
    return {
      jsSnippet: [
        `// HMS Core Account Kit JS SDK (build via Huawei AGC console)`,
        `HWAID.init({ clientId: '${clientId}' });`,
        `// Silent sign-in first (no UI):`,
        `HWAID.signIn({ forceLogin: false }).then((res) =>`,
        `  fetch('${loginUri ?? "/auth/huawei"}', { method:'POST', headers:{'content-type':'application/json','accept':'application/json'}, body: JSON.stringify({ idToken: res.idToken, accessToken: res.accessToken }) })`,
        `);`,
      ].join("\n"),
    };
  },

  verify(idToken, opts) {
    return verifyJwt(idToken, {
      ...opts,
      provider: "huawei",
      jwksUri: "https://oauth-login.cloud.huawei.com/oauth2/v3/certs",
      issuer: opts.issuer ?? "https://accounts.huawei.com",
      domainClaim: opts.domainClaim,
    }) as Promise<VerifyResult>;
  },

  endpoints() {
    return {
      issuer: "https://accounts.huawei.com",
      jwksUri: "https://oauth-login.cloud.huawei.com/oauth2/v3/certs",
      authUri: "https://oauth-login.cloud.huawei.com/oauth2/v3/authorize",
      tokenUri: "https://oauth-login.cloud.huawei.com/oauth2/v3/token",
    };
  },
};
