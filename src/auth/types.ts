/** Auth-swarm shared types. Provider-agnostic: one identity shape for all IdPs. */

export type ProviderId = "google" | "microsoft" | "huawei";

export interface Identity {
  provider: ProviderId;
  /** Stable provider subject (NOT email) — primary key. */
  sub: string;
  email?: string;
  emailVerified?: boolean;
  name?: string;
  picture?: string;
  /** Hosted/tenant domain, when the provider asserts one (hd / tid / domain). */
  domain?: string;
  locale?: string;
  issuedAt?: number;
  expiresAt?: number;
  claims?: Record<string, unknown>;
}

export interface JwkSet { keys: JsonWebKey[] }

export interface VerifyOptions {
  issuer: string | string[];
  audience: string;
  /** Enforce this value against the domain claim (Google `hd`, MS `tid`, HMS `domain`). */
  domainClaim?: { claim: string; equals?: string; allowWorkspaceAny?: boolean };
  /** Clock skew tolerance in seconds (default 120). */
  skewSec?: number;
  jwks?: JwkSet;
  now?: () => number;
}

export interface VerifyResult {
  ok: boolean;
  identity?: Identity;
  reason?: string;
  /** which check failed, for QAA telemetry */
  failedCheck?: "signature" | "iss" | "aud" | "exp" | "nbf" | "domain" | "malformed";
}

export interface TokenRecord {
  identity: Identity;
  accessToken?: string;
  refreshToken?: string;
  /** absolute ms */
  expiresAt: number;
  scopes?: string[];
  /** for offline/server-side agent access */
  offline?: boolean;
}

export interface Provider {
  id: ProviderId;
  /** Browser-side silent auth descriptor (fed to a client integrator). */
  clientBootstrap(opts: { clientId: string; loginUri?: string; domain?: string }): Record<string, unknown>;
  /** Server-side verification of an ID token. */
  verify(idToken: string, opts: VerifyOptions): Promise<VerifyResult>;
  /** OIDC discovery endpoints. */
  endpoints(tenant?: string): { issuer: string; jwksUri: string; authUri: string; tokenUri: string };
}
