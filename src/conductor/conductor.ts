/**
 * conductor.ts — the Agentic Swarm Orchestra Conductor.
 *
 * One orchestration core for the whole swarm. It owns:
 *   - the agent registry (who exists, on which OSI layer),
 *   - a per-agent LRU with single-flight (identical work anywhere in the swarm
 *     collapses to ONE execution — the property that makes 10^8 nodes cheap),
 *   - fair concurrency per agent and a token bucket per upstream host,
 *   - a DAG runner (`after:` edges) so dependent stages fan out in parallel and
 *     join deterministically,
 *   - one metrics/dashboard surface so QAA can gate on cache hit rate and
 *     per-layer throughput.
 *
 * The conductor is transport-agnostic: run it in Bun, in a Worker, in a cron
 * container, or in a test. It never talks to a paid GIS provider itself — that
 * is decided by each agent's declared `spec.network.host`.
 */
import { LruCache } from "../cache/lru.ts";
import { register, dashboard, allCaches, resetAll, clearAll } from "../cache/stats.ts";
import type { Agent, AgentCtx, AgentSpec } from "../agents/base.ts";
import { makeCtx, type MakeCtxOptions } from "../agents/base.ts";
import { pMap, RateLimiter, Semaphore, retry } from "./scheduler.ts";

export interface Task<Q = unknown> {
  id: string;
  agent: string;
  input: Q;
  /** ids of tasks that must complete before this one starts */
  after?: string[];
}

export interface TaskResult<R = unknown> {
  id: string;
  agent: string;
  ok: boolean;
  result?: R;
  error?: string;
  ms: number;
  cached: boolean;
  attempts: number;
}

export interface ConductorEvent {
  type: "start" | "end" | "cache-hit" | "retry" | "error" | "dag-start" | "dag-end";
  taskId?: string;
  agent?: string;
  ms?: number;
  detail?: unknown;
}

export interface ConductorOptions extends MakeCtxOptions {
  defaultConcurrency?: number;
  ratePerMin?: number;
  onEvent?: (e: ConductorEvent) => void;
  /** extra retry attempts for network agents */
  networkAttempts?: number;
}

export class Conductor {
  private agents = new Map<string, Agent<any, any>>();
  private caches = new Map<string, LruCache<any>>();
  private sems = new Map<string, Semaphore>();
  private opts: Required<Pick<ConductorOptions, "defaultConcurrency" | "ratePerMin" | "networkAttempts">> & ConductorOptions;
  limiter: RateLimiter;
  readonly metrics = {
    tasks: 0, ok: 0, failed: 0, cached: 0, ms: 0, retries: 0,
    perAgent: {} as Record<string, { runs: number; ok: number; failed: number; ms: number; cached: number }>,
    perLayer: {} as Record<number, { runs: number; ms: number }>,
  };

  constructor(opts: ConductorOptions = {}) {
    this.opts = { defaultConcurrency: 8, ratePerMin: 120, networkAttempts: 4, ...opts };
    this.limiter = new RateLimiter({ ratePerMin: this.opts.ratePerMin });
  }

  /** Register an agent; its cache is registered globally for the dashboard. */
  register<Q, R>(agent: Agent<Q, R>): Agent<Q, R> {
    if (this.agents.has(agent.spec.name)) throw new Error(`agent already registered: ${agent.spec.name}`);
    this.agents.set(agent.spec.name, agent);
    this.caches.set(agent.spec.name, register(`agent:${agent.spec.name}`, new LruCache<R>({ max: 20_000, ttlMs: agent.spec.ttlMs }), { kind: agent.spec.kind, note: `L${agent.spec.layer}` }));
    this.sems.set(agent.spec.name, new Semaphore(agent.spec.concurrency ?? this.opts.defaultConcurrency));
    return agent;
  }

  get<Q, R>(name: string): Agent<Q, R> {
    const a = this.agents.get(name);
    if (!a) throw new Error(`unknown agent: ${name}`);
    return a as Agent<Q, R>;
  }

  specs(): AgentSpec<unknown, unknown>[] {
    return [...this.agents.values()].map((a) => a.spec as AgentSpec<unknown, unknown>);
  }

  private emit(e: ConductorEvent) { this.opts.onEvent?.(e); }

  private touch(agent: string, ok: boolean, ms: number, cached: boolean, layer: number) {
    const m = this.metrics;
    m.tasks++;
    if (ok) m.ok++; else m.failed++;
    if (cached) m.cached++;
    m.ms += ms;
    const pa = (m.perAgent[agent] ??= { runs: 0, ok: 0, failed: 0, ms: 0, cached: 0 });
    pa.runs++; pa.ms += ms; pa.cached += cached ? 1 : 0;
    if (ok) pa.ok++; else pa.failed++;
    const pl = (m.perLayer[layer] ??= { runs: 0, ms: 0 });
    pl.runs++; pl.ms += ms;
  }

  /** Execute one task: rate-limit → concurrency gate → cache/single-flight → run. */
  async run<Q, R>(task: Task<Q>): Promise<TaskResult<R>> {
    const agent = this.get<Q, R>(task.agent);
    const t0 = this.now();
    const key = `${agent.spec.name}:${agent.spec.keyOf(task.input)}`;
    const cache = this.caches.get(agent.spec.name)!;
    const wasHot = cache.peek(key) !== undefined;

    const execute = async (): Promise<TaskResult<R>> => {
      const sem = this.sems.get(agent.spec.name)!;
      return sem.run(async () => {
        let attempts = 0;
        try {
          const value = await cache.fetch(key, async () => {
            attempts++;
            if (agent.spec.kind === "network") {
              const host = agent.spec.network!.host;
              await this.limiter.bucket(host).take();
              return retry(() => agent.run(task.input, this.ctx), {
                attempts: this.opts.networkAttempts,
                isRetryable: (e) => !/40[0-4]/.test(String((e as Error)?.message ?? e)),
                sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
              });
            }
            return agent.run(task.input, this.ctx);
          }, agent.spec.ttlMs);
          const ms = this.now() - t0;
          this.touch(agent.spec.name, true, ms, wasHot, agent.spec.layer);
          this.emit({ type: "end", taskId: task.id, agent: agent.spec.name, ms });
          return { id: task.id, agent: agent.spec.name, ok: true, result: value, ms, cached: wasHot, attempts };
        } catch (e) {
          const ms = this.now() - t0;
          this.touch(agent.spec.name, false, ms, false, agent.spec.layer);
          this.emit({ type: "error", taskId: task.id, agent: agent.spec.name, detail: String(e) });
          return { id: task.id, agent: agent.spec.name, ok: false, error: String((e as Error)?.message ?? e), ms, cached: false, attempts };
        }
      });
    };

    if (wasHot) this.emit({ type: "cache-hit", taskId: task.id, agent: agent.spec.name });
    else this.emit({ type: "start", taskId: task.id, agent: agent.spec.name });
    return execute();
  }

  /** Run many independent tasks with bounded parallelism. */
  async runAll<Q, R>(tasks: Task<Q>[], concurrency = this.opts.defaultConcurrency): Promise<TaskResult<R>[]> {
    return pMap(tasks, (t) => this.run<Q, R>(t), concurrency);
  }

  /**
   * DAG execution: topological levels; each level fans out in parallel, joins,
   * then feeds `ctx.bag.upstream` for the next level. Detects cycles.
   */
  async runDag<Q, R>(tasks: Task<Q>[], concurrency = this.opts.defaultConcurrency): Promise<TaskResult<R>[]> {
    const byId = new Map(tasks.map((t) => [t.id, t]));
    const indeg = new Map<string, number>();
    const children = new Map<string, string[]>();
    for (const t of tasks) { indeg.set(t.id, (t.after ?? []).length); for (const a of t.after ?? []) (children.get(a) ?? children.set(a, []).get(a)!).push(t.id); }
    for (const t of tasks) for (const a of t.after ?? []) if (!byId.has(a)) throw new Error(`task ${t.id} depends on unknown ${a}`);

    this.emit({ type: "dag-start", detail: { tasks: tasks.length } });
    const results = new Map<string, TaskResult<R>>();
    let level = [...indeg.entries()].filter(([id, d]) => d === 0 && byId.has(id)).map(([id]) => id);
    let seen = 0;
    while (level.length) {
      const batch = level.map((id) => byId.get(id)!);
      const out = await this.runAll<Q, R>(batch, concurrency);
      out.forEach((r, i) => results.set(batch[i].id, r));
      seen += batch.length;
      const next: string[] = [];
      for (const id of level) for (const c of children.get(id) ?? []) {
        const d = (indeg.get(c) ?? 0) - 1; indeg.set(c, d); if (d === 0) next.push(c);
      }
      level = next;
    }
    if (seen !== tasks.length) throw new Error("cycle detected in task DAG");
    const ordered = tasks.map((t) => results.get(t.id)!);
    this.emit({ type: "dag-end", detail: { tasks: tasks.length, ok: ordered.filter((r) => r.ok).length } });
    return ordered;
  }

  get ctx(): AgentCtx {
    if (!this._ctx) this._ctx = makeCtx(this.opts);
    return this._ctx;
  }
  private _ctx?: AgentCtx;
  private now() { return (this.opts.now ?? (() => Date.now()))(); }

  cacheReport() { return dashboard(); }
  resetStats() { resetAll(); for (const k of Object.keys(this.metrics.perAgent)) delete this.metrics.perAgent[k]; for (const k of Object.keys(this.metrics.perLayer)) delete this.metrics.perLayer[+k]; Object.assign(this.metrics, { tasks: 0, ok: 0, failed: 0, cached: 0, ms: 0, retries: 0 }); }
  clearCaches() { clearAll(); }
  caches$() { return allCaches(); }
}
