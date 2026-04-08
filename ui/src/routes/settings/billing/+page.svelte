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
    type CreditBalance,
    type CreditTransaction,
    type BillingUsage,
  } from "$lib/services/settings";
  import { timeAgo, formatCost } from "$lib/utils/time";

  let balance = $state<CreditBalance | null>(null);
  let usage = $state<BillingUsage | null>(null);
  let transactions = $state<CreditTransaction[]>([]);
  let loading = $state(true);

  async function load() {
    loading = true;
    try {
      const [b, u, t] = await Promise.all([
        getCreditBalance(),
        getBillingUsage(),
        getCreditTransactions(50),
      ]);
      balance = b;
      usage = u;
      transactions = t;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load billing data");
    } finally {
      loading = false;
    }
  }

  function handleAddCredits() {
    toast.info("Contact support@oneshots.co to add credits.");
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
    <Button onclick={handleAddCredits}>
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
