<script lang="ts">
  /**
   * First-visit onboarding for the canvas. Three sequential tooltip bubbles
   * positioned over the key surfaces:
   *
   *   1. Core agent node       — "this is your agent"
   *   2. A runtime group       — "guards + routing run before every LLM call"
   *   3. Test run button       — "fire a real run to see the runtime light up"
   *
   * Persists dismissal in localStorage. Skippable via X or Skip link.
   * Renders nothing on the second visit. Doesn't gate any other interaction.
   */

  import { onMount } from "svelte";

  const STORAGE_KEY = "oneshots_canvas_onboarding_v1";

  interface Step {
    title: string;
    body: string;
    /** Anchor: "center" places near canvas center, "top-right" near Test run, "top-left-runtime" near Governance node */
    anchor: "center" | "top-right" | "top-left-runtime";
  }

  const STEPS: Step[] = [
    {
      title: "Your agent lives here",
      body:
        "The center card is your agent. Capability groups orbit around it. " +
        "Drag tools from the left into any category to wire them up.",
      anchor: "center",
    },
    {
      title: "The runtime is the wedge",
      body:
        "Governance, LLM Routing, and Codemode run before every model call. " +
        "Hover any card to see what it does. Click to inspect.",
      anchor: "top-left-runtime",
    },
    {
      title: "Run it and watch it light up",
      body:
        "Press Test run (or ⌘↵) to fire a real agent run. Every step of the " +
        "edge runtime lights up live — durable, checkpointed, and fully observable.",
      anchor: "top-right",
    },
  ];

  let visible = $state(false);
  let stepIndex = $state(0);

  onMount(() => {
    if (typeof localStorage === "undefined") return;
    if (localStorage.getItem(STORAGE_KEY) === "done") return;
    // Small delay so the canvas has time to render before the bubble pops
    setTimeout(() => (visible = true), 600);
  });

  function next() {
    if (stepIndex < STEPS.length - 1) {
      stepIndex++;
    } else {
      finish();
    }
  }

  function back() {
    if (stepIndex > 0) stepIndex--;
  }

  function finish() {
    visible = false;
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(STORAGE_KEY, "done");
    }
  }

  let step = $derived(STEPS[stepIndex]);

  // Anchor-specific positioning for the bubble. Tailwind classes only —
  // keeps positioning declarative and easy to tweak.
  let positionClass = $derived(
    step.anchor === "center"
      ? "left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2"
      : step.anchor === "top-right"
        ? "right-6 top-20"
        : "left-6 top-44",
  );
</script>

{#if visible}
  <!-- Backdrop — semi-transparent so the canvas is still visible behind -->
  <div
    class="pointer-events-auto fixed inset-0 z-[60] bg-background/40 backdrop-blur-[1px]"
  ></div>

  <div
    class="pointer-events-auto fixed z-[61] {positionClass} w-[320px] rounded-xl border border-primary/30 bg-card p-4 shadow-2xl"
    style="box-shadow: 0 20px 60px -20px hsl(var(--primary) / 0.4);"
  >
    <!-- Step indicator + close -->
    <div class="mb-2 flex items-center justify-between">
      <div class="flex items-center gap-1">
        {#each STEPS as _, i}
          <span
            class="h-1 rounded-full transition-all duration-200"
            class:w-6={i === stepIndex}
            class:w-1.5={i !== stepIndex}
            class:bg-primary={i === stepIndex}
            class:bg-muted-foreground={i !== stepIndex}
            class:opacity-30={i !== stepIndex}
          ></span>
        {/each}
      </div>
      <button
        type="button"
        class="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
        onclick={finish}
        aria-label="Skip onboarding"
      >
        <svg xmlns="http://www.w3.org/2000/svg" class="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>

    <h3 class="text-sm font-semibold text-foreground">{step.title}</h3>
    <p class="mt-1 text-xs leading-relaxed text-muted-foreground">{step.body}</p>

    <div class="mt-4 flex items-center justify-between">
      <button
        type="button"
        class="text-[10px] text-muted-foreground hover:text-foreground transition-colors"
        onclick={finish}
      >
        Skip
      </button>
      <div class="flex items-center gap-1.5">
        {#if stepIndex > 0}
          <button
            type="button"
            class="rounded-md border border-border bg-card px-2 py-1 text-[11px] text-foreground hover:bg-accent transition-colors"
            onclick={back}
          >
            Back
          </button>
        {/if}
        <button
          type="button"
          class="rounded-md bg-primary px-2.5 py-1 text-[11px] font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
          onclick={next}
        >
          {stepIndex === STEPS.length - 1 ? "Got it" : "Next"}
        </button>
      </div>
    </div>
  </div>
{/if}
