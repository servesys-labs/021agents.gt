<script lang="ts">
  import { toast } from "svelte-sonner";
  import Badge from "$lib/components/ui/badge.svelte";
  import Table from "$lib/components/ui/table.svelte";
  import Button from "$lib/components/ui/button.svelte";
  import StatCard from "$lib/components/ui/stat-card.svelte";
  import {
    getCreditBalance,
    getCreditTransactions,
    getBillingUsage,
    getCreditPackages,
    createCheckout,
    type CreditBalance,
    type CreditTransaction,
    type BillingUsage,
    type CreditPackage,
  } from "$lib/services/settings";
  import { timeAgo, formatCost } from "$lib/utils/time";

  let balance = $state<CreditBalance | null>(null);
  let usage = $state<BillingUsage | null>(null);
  let transactions = $state<CreditTransaction[]>([]);
  let packages = $state<CreditPackage[]>([]);
  let loading = $state(true);
  let showPackages = $state(false);
  let purchasing = $state<string | null>(null);

  async function load() {
    loading = true;
    try {
      const [b, u, t, p] = await Promise.all([
        getCreditBalance(),
        getBillingUsage(),
        getCreditTransactions(50),
        getCreditPackages().catch(() => []),
      ]);
      balance = b;
      usage = u;
      transactions = t;
      packages = p.filter(pkg => pkg.is_active);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load billing data");
    } finally {
      loading = false;
    }
  }

  // Check URL for purchase result
  $effect(() => {
    const params = new URLSearchParams(window.location.search);
    const result = params.get("credit_purchase");
    if (result === "success") {
      toast.success("Credits added successfully!");
      window.history.replaceState({}, "", window.location.pathname);
      load(); // Refresh balance
    } else if (result === "canceled") {
      toast.info("Purchase canceled.");
      window.history.replaceState({}, "", window.location.pathname);
    }
  });

  async function handlePurchase(pkg: CreditPackage) {
    purchasing = pkg.id;
    try {
      const { url } = await createCheckout(pkg.id);
      if (url) {
        window.location.href = url;
      } else {
        toast.error("Failed to create checkout session");
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to start checkout");
    } finally {
      purchasing = null;
    }
  }

  type TxType = CreditTransaction["type"];

  const txBadgeVariant: Record<TxType, "standard" | "destructive" | "secondary" | "free" | "basic"> = {
    purchase: "standard",
    burn: "destructive",
    refund: "secondary",
    bonus: "free",
  };

  function txSign(type: TxType): string {
    return type === "burn" ? "-" : "+";
  }

  $effect(() => {
    load();
  });
</script>

<div class="w-full px-6 py-8 lg:px-8">
  <!-- Header -->
  <div class="mb-8 flex flex-wrap items-start justify-between gap-4">
    <div>
      <h1>Billing</h1>
      <p class="mt-1.5 text-sm text-muted-foreground">
        Credit balance, usage, and transaction history.
      </p>
    </div>
    <Button onclick={() => (showPackages = !showPackages)}>
      <svg xmlns="http://www.w3.org/2000/svg" class="mr-1.5 h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
        <path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4" />
      </svg>
      Add Credits
    </Button>
  </div>

  {#if loading}
    <div class="flex items-center justify-center py-24">
      <div class="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent"></div>
    </div>
  {:else}
    <!-- Credit packages -->
    {#if showPackages}
      <div class="mb-8">
        <h2 class="mb-4">Choose a Credit Package</h2>
        {#if packages.length === 0}
          <div class="rounded-lg border border-dashed border-border py-12 text-center">
            <p class="text-sm text-muted-foreground">No credit packages available yet.</p>
            <p class="mt-1 text-xs text-muted-foreground">Contact support@021agents.ai to add credits.</p>
          </div>
        {:else}
          <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {#each packages as pkg}
              <div class="rounded-xl border border-border bg-card p-6 transition-all hover:border-primary/50 hover:shadow-sm">
                <h3 class="text-lg font-semibold text-foreground">{pkg.name}</h3>
                <div class="mt-2">
                  <span class="text-3xl font-bold text-foreground">${pkg.price_usd.toFixed(2)}</span>
                </div>
                <p class="mt-1 text-sm text-muted-foreground">
                  {formatCost(pkg.credits_usd)} in credits
                  {#if pkg.credits_usd > pkg.price_usd}
                    <Badge variant="free" class="ml-2">
                      {Math.round(((pkg.credits_usd - pkg.price_usd) / pkg.price_usd) * 100)}% bonus
                    </Badge>
                  {/if}
                </p>
                <Button
                  class="mt-4 w-full"
                  disabled={purchasing === pkg.id}
                  onclick={() => handlePurchase(pkg)}
                >
                  {purchasing === pkg.id ? "Redirecting to Stripe..." : "Purchase"}
                </Button>
              </div>
            {/each}
          </div>
        {/if}
      </div>
    {/if}

    <!-- Stat cards -->
    <div class="mb-8 grid gap-4 sm:grid-cols-3">
      <StatCard
        value={balance ? formatCost(balance.balance_usd) : "$0.00"}
        label="Credit Balance"
        accentColor="chart-2"
      />
      <StatCard
        value={usage ? formatCost(usage.total_spent_usd) : "$0.00"}
        label="Total Spent"
        subtitle={usage?.period ?? ""}
        accentColor="chart-1"
      />
      <StatCard
        value={usage ? String(usage.sessions_count) : "0"}
        label="Sessions This Month"
        accentColor="chart-3"
      />
    </div>

    <!-- Transaction history -->
    <div>
      <h2 class="mb-4">Transaction History</h2>
      {#if transactions.length === 0}
        <div class="rounded-lg border border-dashed border-border py-16 text-center">
          <svg xmlns="http://www.w3.org/2000/svg" class="mx-auto h-12 w-12 text-muted-foreground/40" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1">
            <path stroke-linecap="round" stroke-linejoin="round" d="M9 14l6-6m-5.5.5h.01m4.99 5h.01M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16l3.5-2 3.5 2 3.5-2 3.5 2z" />
          </svg>
          <h3 class="mt-4 text-foreground">No transactions yet</h3>
          <p class="mt-1.5 text-sm text-muted-foreground">Transactions will appear here once you start using agents.</p>
        </div>
      {:else}
        <Table>
          {#snippet thead()}
            <tr>
              <th class="px-4 py-3">Date</th>
              <th class="px-4 py-3">Type</th>
              <th class="px-4 py-3">Amount</th>
              <th class="px-4 py-3">Description</th>
            </tr>
          {/snippet}
          {#snippet tbody()}
            {#each transactions as tx}
              <tr class="hover:bg-muted/30">
                <td class="px-4 py-3 text-muted-foreground">{timeAgo(tx.created_at)}</td>
                <td class="px-4 py-3">
                  <Badge variant={txBadgeVariant[tx.type]}>
                    {tx.type}
                  </Badge>
                </td>
                <td class="px-4 py-3 font-medium {tx.type === 'burn' ? 'text-destructive' : 'text-success'}">
                  {txSign(tx.type)}{formatCost(Math.abs(tx.amount_usd))}
                </td>
                <td class="px-4 py-3 text-muted-foreground">{tx.description}</td>
              </tr>
            {/each}
          {/snippet}
        </Table>
      {/if}
    </div>
  {/if}
</div>
