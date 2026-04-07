<script lang="ts">
  import { toast } from "svelte-sonner";
  import Badge from "$lib/components/ui/badge.svelte";
  import Input from "$lib/components/ui/input.svelte";
  import Button from "$lib/components/ui/button.svelte";
  import {
    searchMarketplace,
    getMarketplaceCategories,
    type MarketplaceListing,
  } from "$lib/services/marketplace";
  import { formatCost } from "$lib/utils/time";

  let listings = $state<MarketplaceListing[]>([]);
  let categories = $state<string[]>([]);
  let loading = $state(true);

  let searchQuery = $state("");
  let filterCategory = $state("");

  async function load() {
    loading = true;
    try {
      const [results, cats] = await Promise.all([
        searchMarketplace({ query: searchQuery || undefined, category: filterCategory || undefined, limit: 20 }),
        getMarketplaceCategories(),
      ]);
      listings = results.listings;
      categories = cats.categories;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load marketplace");
    } finally {
      loading = false;
    }
  }

  function handleSearch() {
    load();
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "Enter") handleSearch();
  }

  function qualityStars(score: number): string {
    const stars = Math.round(score * 5);
    return "\u2605".repeat(stars) + "\u2606".repeat(5 - stars);
  }

  $effect(() => {
    load();
  });
</script>

<div class="mx-auto w-full max-w-5xl px-6 py-8 lg:px-8">
  <!-- Header -->
  <div class="mb-8">
    <h1>Marketplace</h1>
    <p class="mt-1.5 text-sm text-muted-foreground">
      Discover and connect with agents published by the community.
    </p>
  </div>

  <!-- Search & Filter -->
  <div class="mb-6 flex flex-wrap items-center gap-3">
    <div class="flex-1 min-w-[200px]">
      <Input
        placeholder="Search agents..."
        bind:value={searchQuery}
        onkeydown={handleKeydown}
      />
    </div>
    <div class="w-44">
      <select
        class="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground"
        bind:value={filterCategory}
        onchange={handleSearch}
      >
        <option value="">All categories</option>
        {#each categories as cat}
          <option value={cat}>{cat}</option>
        {/each}
      </select>
    </div>
    <Button onclick={handleSearch}>Search</Button>
  </div>

  {#if loading}
    <div class="flex items-center justify-center py-24">
      <div class="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent"></div>
    </div>
  {:else if listings.length === 0}
    <div class="rounded-lg border border-dashed border-border py-16 text-center">
      <svg xmlns="http://www.w3.org/2000/svg" class="mx-auto h-12 w-12 text-muted-foreground/40" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1">
        <path stroke-linecap="round" stroke-linejoin="round" d="M16 11V7a4 4 0 00-8 0v4M5 9h14l1 12H4L5 9z" />
      </svg>
      <h3 class="mt-4 text-foreground">No agents found</h3>
      <p class="mt-1.5 text-sm text-muted-foreground">Try a different search query or browse all categories.</p>
    </div>
  {:else}
    <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {#each listings as listing}
        <div class="rounded-lg border border-border bg-card p-5 transition-colors hover:border-foreground/20">
          <div class="flex items-start justify-between gap-2">
            <h3 class="text-sm font-semibold text-foreground">{listing.display_name}</h3>
            <div class="flex shrink-0 gap-1">
              {#if listing.is_verified}
                <Badge variant="free">verified</Badge>
              {/if}
              {#if listing.is_featured}
                <Badge variant="standard">featured</Badge>
              {/if}
            </div>
          </div>
          <p class="mt-1.5 text-sm text-muted-foreground line-clamp-2">{listing.short_description}</p>

          <div class="mt-3 flex flex-wrap items-center gap-2">
            <Badge variant="secondary">{listing.category}</Badge>
            {#if listing.price_per_task_usd > 0}
              <span class="text-xs font-medium text-foreground">{formatCost(listing.price_per_task_usd)}/task</span>
            {:else}
              <span class="text-xs font-medium text-success">Free</span>
            {/if}
          </div>

          <div class="mt-3 flex items-center justify-between text-xs text-muted-foreground">
            <span class="text-chart-4">{qualityStars(listing.quality_score)}</span>
            <span>{listing.total_tasks_completed} tasks</span>
          </div>

          {#if listing.avg_rating > 0}
            <div class="mt-1 text-xs text-muted-foreground">
              {listing.avg_rating.toFixed(1)} avg ({listing.total_ratings} ratings)
            </div>
          {/if}
        </div>
      {/each}
    </div>
  {/if}
</div>
