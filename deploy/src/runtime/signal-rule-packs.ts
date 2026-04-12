import type { SignalFeature } from "./signals";
import {
  evaluateMemorySignalRules,
  type EvaluateMemoryRulesInput,
  type MemorySignalAction,
  type MemorySignalCluster,
} from "./signal-rules-memory";

export type SignalCluster = MemorySignalCluster;
export type SignalRuleAction = MemorySignalAction;

export interface SignalRulePack<TCluster extends SignalCluster = SignalCluster> {
  feature: SignalFeature;
  evaluate(input: {
    nowMs: number;
    clusters: TCluster[];
    activeCooldowns: Set<string>;
  }): SignalRuleAction[];
}

export const memorySignalRulePack: SignalRulePack<MemorySignalCluster> = {
  feature: "memory",
  evaluate(input: EvaluateMemoryRulesInput) {
    return evaluateMemorySignalRules(input);
  },
};

export function getSignalRulePack(feature: SignalFeature | null): SignalRulePack | null {
  if (feature === "memory") return memorySignalRulePack;
  return null;
}
