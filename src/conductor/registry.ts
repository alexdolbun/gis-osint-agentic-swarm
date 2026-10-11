/**
 * registry.ts — agent registry. Every agent declares its OSI layer, its cache
 * TTL, and its key function; the conductor reads that metadata to schedule and
 * to prove (in QAA) that no agent runs without a cache key.
 */
import type { Agent } from "../agents/base.ts";

const agents = new Map<string, Agent<any, any>>();

export function registerAgent<T, R>(agent: Agent<T, R>): Agent<T, R> {
  if (!agent.spec.keyOf) throw new Error(`agent ${agent.spec.name} has no cache key`);
  agents.set(agent.spec.name, agent);
  return agent;
}

export function getAgent(name: string): Agent<any, any> | undefined { return agents.get(name); }
export function listAgents(): Array<{ name: string; layer: number; ttlMs: number; note?: string }> {
  return [...agents.values()].map((a) => ({ name: a.spec.name, layer: a.spec.layer, ttlMs: a.spec.ttlMs, note: a.spec.note })).sort((a, b) => a.layer - b.layer || a.name.localeCompare(b.name));
}
export function agentsByLayer(): Record<number, string[]> {
  const out: Record<number, string[]> = {};
  for (const a of agents.values()) (out[a.spec.layer] ??= []).push(a.spec.name);
  return out;
}
