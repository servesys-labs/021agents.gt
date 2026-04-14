<script lang="ts">
  import { page } from "$app/stores";
  import { toast } from "svelte-sonner";
  import Badge from "$lib/components/ui/badge.svelte";
  import Table from "$lib/components/ui/table.svelte";
  import SessionDetail from "$lib/components/activity/SessionDetail.svelte";
  import {
    listSessions,
    getSessionTurns,
    submitFeedback,
    type Session,
    type Turn,
  } from "$lib/services/sessions";
  import { timeAgo, formatDuration, formatCost } from "$lib/utils/time";
  import Select from "$lib/components/ui/select.svelte";
  import Textarea from "$lib/components/ui/textarea.svelte";
  import Button from "$lib/components/ui/button.svelte";
  import AgentNav from "$lib/components/agent/AgentNav.svelte";

  let agentName = $derived($page.params.name ?? "");

  let sessions = $state<Session[]>([]);
  let loading = $state(true);
  let statusFilter = $state<"all" | "success" | "error">("all");
  let limit = $state(25);

  // Selected session detail
  let selectedSession = $state<Session | null>(null);
  let selectedTurns = $state<Turn[]>([]);
  let loadingDetail = $state(false);

  // Feedback
  let feedbackRating = $state<"up" | "down" | null>(null);
  let feedbackComment = $state("");
  let submittingFeedback = $state(false);

  async function fetchSessions() {
    loading = true;
    try {
      sessions = await listSessions({ agent_name: agentName, limit, status: statusFilter === "all" ? undefined : statusFilter });
    } catch (err) {
      console.error("Failed to fetch sessions:", err);
      toast.error("Failed to load sessions");
      sessions = [];
    } finally {
      loading = false;
    }
  }

  async function selectSession(session: Session) {
    selectedSession = session;
    loadingDetail = true;
    feedbackRating = null;
    feedbackComment = "";
    try {
      selectedTurns = await getSessionTurns(session.session_id);
    } catch (err) {
      console.error("Failed to fetch turns:", err);
      toast.error("Failed to load session details");
      selectedTurns = [];
    } finally {
      loadingDetail = false;
    }
  }

  async function handleFeedbackSubmit() {
    if (!selectedSession || !feedbackRating) return;
    submittingFeedback = true;
    try {
      const ratingNum = feedbackRating === "up" ? 5 : 1;
      await submitFeedback(selectedSession.session_id, ratingNum, feedbackComment || undefined);
      toast.success("Feedback submitted");
      feedbackRating = null;
      feedbackComment = "";
    } catch (err) {
      toast.error("Failed to submit feedback");
    } finally {
      submittingFeedback = false;
    }
  }

  function closeDetail() {
    selectedSession = null;
    selectedTurns = [];
  }

  // Fetch on mount and when filter changes
  $effect(() => {
    // Reading these triggers re-fetch
    agentName;
    statusFilter;
    limit;
    fetchSessions();
  });
</script>

<div class="flex h-full flex-col">
  <AgentNav {agentName} activePath={$page.url.pathname} />

  <div class="flex-1 overflow-y-auto">
    <div class="w-full px-6 py-8 lg:px-8">
      <!-- Header -->
      <div class="mb-8 flex items-center justify-between">
        <div>
          <h1>Session Activity</h1>
          <p class="mt-1.5 text-sm text-muted-foreground">Session history and feedback</p>
        </div>
        <div class="flex items-center gap-2">
          <Select
            bind:value={statusFilter}
            options={[
              { value: "all", label: "All" },
              { value: "success", label: "Success" },
              { value: "error", label: "Error" },
            ]}
            class="w-auto"
          />
        </div>
      </div>

      {#if loading && sessions.length === 0}
        <div class="flex items-center justify-center py-24">
          <div class="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent"></div>
        </div>
      {:else if sessions.length === 0}
        <div class="flex flex-col items-center justify-center rounded-lg border border-dashed border-border py-16">
          <svg xmlns="http://www.w3.org/2000/svg" class="mb-3 h-10 w-10 text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
            <path stroke-linecap="round" stroke-linejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <p class="text-sm text-muted-foreground">No sessions found</p>
        </div>
      {:else}
        <div class="flex gap-6">
          <!-- Session list -->
          <div class={selectedSession ? "hidden w-full lg:block lg:w-2/5" : "w-full"}>
            <Table>
              {#snippet thead()}
                <tr>
                  <th class="px-4 py-2.5">Session</th>
                  <th class="px-4 py-2.5">Status</th>
                  <th class="px-4 py-2.5 text-right">Cost</th>
                  <th class="px-4 py-2.5 text-right">Duration</th>
                  <th class="hidden px-4 py-2.5 text-right sm:table-cell">Steps</th>
                  <th class="px-4 py-2.5 text-right">Time</th>
                </tr>
              {/snippet}
              {#snippet tbody()}
                {#each sessions as session (session.session_id)}
                  <tr
                    class="cursor-pointer transition-colors hover:bg-muted/50 {selectedSession?.session_id === session.session_id ? 'bg-muted/70' : ''}"
                    onclick={() => selectSession(session)}
                  >
                    <td class="px-4 py-3">
                      <code class="font-mono text-xs">{session.session_id.slice(0, 10)}</code>
                    </td>
                    <td class="px-4 py-3">
                      <Badge variant={session.status === "error" ? "destructive" : session.status === "running" ? "outline" : "default"}>
                        {session.status}
                      </Badge>
                    </td>
                    <td class="px-4 py-3 text-right font-mono text-xs">{formatCost(session.cost_total_usd)}</td>
                    <td class="px-4 py-3 text-right text-xs text-muted-foreground">{formatDuration(session.wall_clock_seconds)}</td>
                    <td class="hidden px-4 py-3 text-right text-xs text-muted-foreground sm:table-cell">{session.step_count}</td>
                    <td class="px-4 py-3 text-right text-xs text-muted-foreground">{timeAgo(session.created_at)}</td>
                  </tr>
                {/each}
              {/snippet}
            </Table>

            {#if sessions.length >= limit}
              <div class="mt-4 flex justify-center">
                <Button
                  variant="outline"
                  onclick={() => { limit += 25; }}
                >
                  Load more
                </Button>
              </div>
            {/if}
          </div>

          <!-- Session detail panel -->
          {#if selectedSession}
            <div class="w-full lg:w-3/5">
              <div class="mb-4 flex items-center justify-between">
                <button
                  class="flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground lg:hidden"
                  onclick={closeDetail}
                >
                  <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M15 19l-7-7 7-7" />
                  </svg>
                  Back to list
                </button>
                <button
                  class="hidden items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground lg:flex"
                  onclick={closeDetail}
                >
                  <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                  Close
                </button>
              </div>

              {#if loadingDetail}
                <div class="flex items-center justify-center py-16">
                  <div class="h-6 w-6 animate-spin rounded-full border-4 border-primary border-t-transparent"></div>
                </div>
              {:else}
                <SessionDetail session={selectedSession} turns={selectedTurns} />

                <!-- Feedback section -->
                <div class="mt-6 rounded-lg border border-border bg-card p-5">
                  <h4 class="mb-3">Session Feedback</h4>
                  <div class="flex items-center gap-3">
                    <button
                      class="flex h-10 w-10 items-center justify-center rounded-lg border transition-colors {feedbackRating === 'up' ? 'border-success bg-success/10 text-success' : 'border-border text-muted-foreground hover:border-success hover:text-success'}"
                      onclick={() => { feedbackRating = feedbackRating === "up" ? null : "up"; }}
                      type="button"
                      aria-label="Thumbs up"
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                        <path stroke-linecap="round" stroke-linejoin="round" d="M14 10h4.764a2 2 0 011.789 2.894l-3.5 7A2 2 0 0115.263 21H7V10l4-8 1 1v4a1 1 0 001 1h1z" />
                      </svg>
                    </button>
                    <button
                      class="flex h-10 w-10 items-center justify-center rounded-lg border transition-colors {feedbackRating === 'down' ? 'border-destructive bg-destructive/10 text-destructive' : 'border-border text-muted-foreground hover:border-destructive hover:text-destructive'}"
                      onclick={() => { feedbackRating = feedbackRating === "down" ? null : "down"; }}
                      type="button"
                      aria-label="Thumbs down"
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5 rotate-180" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                        <path stroke-linecap="round" stroke-linejoin="round" d="M14 10h4.764a2 2 0 011.789 2.894l-3.5 7A2 2 0 0115.263 21H7V10l4-8 1 1v4a1 1 0 001 1h1z" />
                      </svg>
                    </button>
                  </div>
                  {#if feedbackRating}
                    <Textarea
                      class="mt-3"
                      rows={3}
                      placeholder="Optional comment..."
                      bind:value={feedbackComment}
                    />
                    <Button
                      class="mt-2"
                      onclick={handleFeedbackSubmit}
                      disabled={submittingFeedback}
                    >
                      {submittingFeedback ? "Submitting..." : "Submit Feedback"}
                    </Button>
                  {/if}
                </div>
              {/if}
            </div>
          {/if}
        </div>
      {/if}
    </div>
  </div>
</div>
