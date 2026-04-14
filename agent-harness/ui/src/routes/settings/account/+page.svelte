<script lang="ts">
  import { toast } from "svelte-sonner";
  import Button from "$lib/components/ui/button.svelte";
  import Input from "$lib/components/ui/input.svelte";
  import {
    getMe,
    changePassword,
    getReferralStats,
    createReferralCode,
    type UserProfile,
    type ReferralStats,
  } from "$lib/services/settings";
  import { authStore } from "$lib/stores/auth.svelte";

  let profile = $state<UserProfile | null>(null);
  let referrals = $state<ReferralStats | null>(null);
  let loading = $state(true);

  // Password change
  let currentPassword = $state("");
  let newPassword = $state("");
  let confirmPassword = $state("");
  let changingPassword = $state(false);

  // Referral
  let creatingCode = $state(false);
  let copied = $state("");

  async function load() {
    loading = true;
    try {
      const [me, refs] = await Promise.all([
        getMe(),
        getReferralStats().catch(() => null),
      ]);
      profile = me;
      referrals = refs;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load account");
    } finally {
      loading = false;
    }
  }

  async function handleChangePassword(e: SubmitEvent) {
    e.preventDefault();
    if (newPassword !== confirmPassword) {
      toast.error("Passwords do not match");
      return;
    }
    if (newPassword.length < 8) {
      toast.error("Password must be at least 8 characters");
      return;
    }
    changingPassword = true;
    try {
      await changePassword(currentPassword, newPassword);
      toast.success("Password changed successfully");
      currentPassword = "";
      newPassword = "";
      confirmPassword = "";
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to change password");
    } finally {
      changingPassword = false;
    }
  }

  async function handleCreateCode() {
    creatingCode = true;
    try {
      await createReferralCode("Invite link");
      referrals = await getReferralStats();
      toast.success("Invite code created");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to create code");
    } finally {
      creatingCode = false;
    }
  }

  async function copyCode(code: string) {
    await navigator.clipboard.writeText(`https://app.021agents.ai/login?ref=${code}`);
    copied = code;
    toast.success("Invite link copied");
    setTimeout(() => (copied = ""), 2000);
  }

  $effect(() => {
    load();
  });
</script>

<div class="w-full px-6 py-8 lg:px-8">
  <div class="mb-8">
    <h1>Account</h1>
    <p class="mt-1.5 text-sm text-muted-foreground">
      Manage your profile, password, and invite codes.
    </p>
  </div>

  {#if loading}
    <div class="flex items-center justify-center py-24">
      <div class="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent"></div>
    </div>
  {:else}
    <!-- Profile -->
    <section class="mb-10">
      <h2 class="mb-4">Profile</h2>
      <div class="rounded-lg border border-border bg-card p-6 space-y-3">
        <div class="flex items-center justify-between">
          <span class="text-sm text-muted-foreground">Email</span>
          <span class="text-sm font-medium">{profile?.email ?? ""}</span>
        </div>
        <div class="flex items-center justify-between">
          <span class="text-sm text-muted-foreground">Name</span>
          <span class="text-sm font-medium">{profile?.name ?? ""}</span>
        </div>
        <div class="flex items-center justify-between">
          <span class="text-sm text-muted-foreground">Provider</span>
          <span class="text-sm font-medium capitalize">{profile?.provider ?? "local"}</span>
        </div>
        <div class="flex items-center justify-between">
          <span class="text-sm text-muted-foreground">Org ID</span>
          <span class="font-mono text-xs text-muted-foreground">{profile?.org_id ?? ""}</span>
        </div>
      </div>
    </section>

    <!-- Change Password -->
    {#if profile?.provider === "local"}
      <section class="mb-10">
        <h2 class="mb-4">Change Password</h2>
        <form onsubmit={handleChangePassword} class="rounded-lg border border-border bg-card p-6 space-y-4">
          <div class="space-y-2">
            <label for="current-pw" class="text-sm font-medium">Current Password</label>
            <Input id="current-pw" type="password" bind:value={currentPassword} required autocomplete="current-password" />
          </div>
          <div class="space-y-2">
            <label for="new-pw" class="text-sm font-medium">New Password</label>
            <Input id="new-pw" type="password" bind:value={newPassword} required autocomplete="new-password" placeholder="Min. 8 characters" />
          </div>
          <div class="space-y-2">
            <label for="confirm-pw" class="text-sm font-medium">Confirm New Password</label>
            <Input id="confirm-pw" type="password" bind:value={confirmPassword} required autocomplete="new-password" />
          </div>
          <Button type="submit" disabled={changingPassword}>
            {changingPassword ? "Changing..." : "Change Password"}
          </Button>
        </form>
      </section>
    {/if}

    <!-- Invite Codes -->
    <section class="mb-10">
      <div class="mb-4 flex items-center justify-between">
        <h2>Invite Codes</h2>
        <Button variant="outline" size="sm" onclick={handleCreateCode} disabled={creatingCode}>
          {creatingCode ? "Creating..." : "+ New Code"}
        </Button>
      </div>

      {#if referrals && referrals.codes.length > 0}
        <div class="rounded-lg border border-border bg-card divide-y divide-border">
          {#each referrals.codes as code}
            <div class="flex items-center justify-between px-6 py-4">
              <div>
                <span class="font-mono text-sm font-medium">{code.code}</span>
                <span class="ml-3 text-xs text-muted-foreground">
                  {code.uses}/{code.max_uses ?? "\u221e"} used
                </span>
              </div>
              <Button variant="ghost" size="sm" onclick={() => copyCode(code.code)}>
                {copied === code.code ? "Copied!" : "Copy Link"}
              </Button>
            </div>
          {/each}
        </div>
      {:else}
        <div class="rounded-lg border border-dashed border-border py-12 text-center">
          <p class="text-sm text-muted-foreground">No invite codes yet.</p>
          <Button variant="outline" size="sm" class="mt-3" onclick={handleCreateCode}>
            Create Your First Invite Code
          </Button>
        </div>
      {/if}

      {#if referrals && referrals.total_referrals > 0}
        <div class="mt-4 rounded-lg border border-border bg-card p-6">
          <h3 class="text-sm font-medium mb-3">Referral Earnings</h3>
          <div class="grid gap-4 sm:grid-cols-3">
            <div>
              <p class="text-2xl font-bold">{referrals.total_referrals}</p>
              <p class="text-xs text-muted-foreground">Users Referred</p>
            </div>
            <div>
              <p class="text-2xl font-bold">${Number(referrals.earnings?.total_earned_usd || 0).toFixed(2)}</p>
              <p class="text-xs text-muted-foreground">Total Earned (credits)</p>
            </div>
            <div>
              <p class="text-2xl font-bold">{referrals.earnings.total_transactions}</p>
              <p class="text-xs text-muted-foreground">Earning Transactions</p>
            </div>
          </div>
          <div class="mt-4 rounded-md border border-border bg-muted/40 px-4 py-3">
            <p class="text-xs text-muted-foreground">
              <span class="font-medium text-foreground">Cash payouts coming soon.</span>
              Referral earnings currently accrue as platform credits and are
              applied automatically to your usage. Bank transfers will be
              available once our payout infrastructure goes live.
            </p>
          </div>
        </div>
      {/if}
    </section>

    <!-- Danger Zone -->
    <section>
      <h2 class="mb-4 text-destructive">Danger Zone</h2>
      <div class="rounded-lg border border-destructive/30 bg-card p-6">
        <div class="flex items-center justify-between">
          <div>
            <p class="text-sm font-medium">Log out</p>
            <p class="text-xs text-muted-foreground">Sign out of your account on this device.</p>
          </div>
          <Button variant="destructive" size="sm" onclick={() => authStore.logout()}>
            Log Out
          </Button>
        </div>
      </div>
    </section>
  {/if}
</div>
