/**
 * Runnable composition helpers (LangChain-style primitives, edge-native).
 *
 * These helpers are intentionally lightweight and runtime-agnostic:
 * - `pipe` composes stages left-to-right.
 * - `mapInputs` applies a stage over an input array.
 * - `branch` routes to one of two stages by predicate.
 * - `parseOutput` supports "text", "json", and "lines" output parsing.
 */

export type RunnableStage<I, O> = (input: I) => O | Promise<O>;

export function pipe<A, B>(ab: RunnableStage<A, B>): RunnableStage<A, B>;
export function pipe<A, B, C>(
  ab: RunnableStage<A, B>,
  bc: RunnableStage<B, C>,
): RunnableStage<A, C>;
export function pipe<A, B, C, D>(
  ab: RunnableStage<A, B>,
  bc: RunnableStage<B, C>,
  cd: RunnableStage<C, D>,
): RunnableStage<A, D>;
export function pipe(...stages: Array<RunnableStage<any, any>>): RunnableStage<any, any> {
  if (stages.length === 0) {
    return async (input: unknown) => input;
  }
  return async (input: unknown) => {
    let value = input;
    for (const stage of stages) {
      value = await stage(value);
    }
    return value;
  };
}

export async function mapInputs<I, O>(
  inputs: I[],
  stage: RunnableStage<I, O>,
): Promise<O[]> {
  return Promise.all(inputs.map((input) => stage(input)));
}

export function branch<I, O>(
  predicate: (input: I) => boolean,
  onTrue: RunnableStage<I, O>,
  onFalse: RunnableStage<I, O>,
): RunnableStage<I, O> {
  return async (input: I) => (predicate(input) ? onTrue(input) : onFalse(input));
}

export type OutputParseKind = "text" | "json" | "lines";

export function parseOutput(kind: OutputParseKind, raw: string): unknown {
  const value = raw.trim();
  if (kind === "text") return value;
  if (kind === "lines") return value.split("\n").map((line) => line.trim()).filter(Boolean);
  // kind === "json"
  const unfenced = value.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  return JSON.parse(unfenced);
}
