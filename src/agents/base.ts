/**
 * base.ts — the one agent contract every swarm node implements.
 *
 * An agent is (spec, run). The spec carries the OSI layer, whether it is a
 * network or compute node, its cache TTL, and a deterministic keyOf() so the
 * conductor can coalesce identical work across millions of nodes. run() gets a
 * single ctx (fetch, env, offline flag, clock, logger) — no globals, no ambient
 * state — so the same agent runs in Bun, a Worker, a container, or a test.
 */

export type AgentKind = "network" | "compute" | "onchain";

export interface AgentSpec<Q, R> {
  name: string;
  /** 1-7, where the work really sits (physical/edge=1 … orchestration=5, monetize=7) */
  layer: number;
  kind: AgentKind;
  ttlMs: number;
  /** deterministic cache key for the input; must be pure */
  keyOf: (input: Q) => string;
  /** optional concurrency cap for this agent (default from scheduler) */
  concurrency?: number;
  /** required when kind === "network" — used by gates to forbid unmetered egress */
  network?: { host: string; budgetPerMin?: number };
  /** short human-readable note shown in the cache dashboard / agent listing */
  note?: string;
}

export interface AgentCtx {
  offline: boolean;
  env: Record<string, string | undefined>;
  fetchImpl: typeof fetch;
  now: () => number;
  log: (msg: string, extra?: Record<string, unknown>) => void;
  /** free-form bag the conductor fills (alpha sinks, metrics, etc.) */
  bag: Record<string, unknown>;
}

export interface Agent<Q, R> {
  spec: AgentSpec<Q, R>;
  run(input: Q, ctx: AgentCtx): Promise<R>;
}

export function defineAgent<Q, R>(
  spec: AgentSpec<Q, R>,
  run: (input: Q, ctx: AgentCtx) => Promise<R>,
): Agent<Q, R> {
  if (!spec.name) throw new Error("agent needs a name");
  if (spec.layer < 1 || spec.layer > 7) throw new Error(`agent ${spec.name}: layer must be 1..7`);
  if (spec.kind === "network" && !spec.network) {
    // Network agents must declare exactly which host they touch, so the QAA
    // egress gate can prove no unmetered/paid GIS provider is reachable.
    throw new Error(`agent ${spec.name}: network agents must declare spec.network.host`);
  }
  return { spec, run };
}

export interface MakeCtxOptions {
  offline?: boolean;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  now?: () => number;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

export function makeCtx(opts: MakeCtxOptions = {}): AgentCtx {
  return {
    offline: opts.offline ?? false,
    env: opts.env ?? (typeof process !== "undefined" ? (process.env as Record<string, string | undefined>) : {}),
    fetchImpl: opts.fetchImpl ?? fetch,
    now: opts.now ?? (() => Date.now()),
    log: opts.log ?? (() => {}),
    bag: {},
  };
}
