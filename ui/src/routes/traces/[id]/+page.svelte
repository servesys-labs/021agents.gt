<script lang="ts">
  import { page } from "$app/stores";
  import { goto } from "$app/navigation";

  // Traces don't have their own page — redirect to the dashboard.
  // The trace view is inline in the Activity tab's session detail.
  $effect(() => {
    goto("/", { replaceState: true });
  });
</script>

<div class="flex h-full items-center justify-center">
  <p class="text-sm text-muted-foreground">Redirecting...</p>
</div>
