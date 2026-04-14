<script lang="ts">
  import { goto } from "$app/navigation";
  import { page } from "$app/stores";
  import { authStore } from "$lib/stores/auth.svelte";
  import { agentStore } from "$lib/stores/agents.svelte";
  import { api } from "$lib/services/api";
  import Button from "$lib/components/ui/button.svelte";
  import Input from "$lib/components/ui/input.svelte";

  let mode = $state<"login" | "signup">("login");

  // Login fields
  let email = $state("");
  let password = $state("");
  let error = $state("");
  let submitting = $state(false);

  // Signup fields
  let signupName = $state("");
  let signupEmail = $state("");
  let signupPassword = $state("");
  let signupConfirm = $state("");
  let inviteCode = $state("");

  $effect(() => {
    const ref = ($page.url.searchParams.get("ref") || "").trim();
    if (!ref) return;
    inviteCode = ref;
    mode = "signup";
  });

  async function handleLogin(e: SubmitEvent) {
    e.preventDefault();
    error = "";
    submitting = true;

    try {
      await authStore.login(email, password);
      await agentStore.fetchAgents();
      goto("/");
    } catch (err: unknown) {
      error = err instanceof Error ? err.message : "Login failed";
    } finally {
      submitting = false;
    }
  }

  async function handleSignup(e: SubmitEvent) {
    e.preventDefault();
    error = "";

    if (signupPassword !== signupConfirm) {
      error = "Passwords do not match";
      return;
    }
    if (signupPassword.length < 8) {
      error = "Password must be at least 8 characters";
      return;
    }

    submitting = true;
    try {
      await api.signup(signupName, signupEmail, signupPassword, inviteCode || undefined);
      // Auto-login after signup
      await authStore.login(signupEmail, signupPassword);
      await agentStore.fetchAgents();
      goto("/");
    } catch (err: unknown) {
      error = err instanceof Error ? err.message : "Signup failed";
    } finally {
      submitting = false;
    }
  }
</script>

<div class="flex min-h-dvh items-center justify-center p-4">
  <div class="w-full max-w-sm space-y-6">
    <div class="text-center">
      <h1 class="text-3xl font-bold text-primary">OneShots</h1>
      <p class="mt-2 text-sm text-muted-foreground">
        {mode === "login" ? "Sign in to your account" : "Create your account"}
      </p>
    </div>

    {#if mode === "login"}
      <form onsubmit={handleLogin} class="space-y-4">
        {#if error}
          <div class="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
            {error}
          </div>
        {/if}

        <div class="space-y-2">
          <label for="email" class="text-sm font-medium">Email</label>
          <Input
            id="email"
            type="email"
            placeholder="you@example.com"
            bind:value={email}
            required
            autocomplete="email"
          />
        </div>

        <div class="space-y-2">
          <label for="password" class="text-sm font-medium">Password</label>
          <Input
            id="password"
            type="password"
            placeholder="Password"
            bind:value={password}
            required
            autocomplete="current-password"
          />
        </div>

        <Button type="submit" class="w-full" disabled={submitting}>
          {#if submitting}
            Signing in...
          {:else}
            Sign in
          {/if}
        </Button>
      </form>

      <p class="text-center text-sm text-muted-foreground">
        Don't have an account?
        <button
          type="button"
          class="font-medium text-primary transition-colors hover:text-primary/80"
          onclick={() => { mode = "signup"; error = ""; }}
        >
          Sign up
        </button>
      </p>
    {:else}
      <form onsubmit={handleSignup} class="space-y-4">
        {#if error}
          <div class="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
            {error}
          </div>
        {/if}

        <div class="space-y-2">
          <label for="signup-name" class="text-sm font-medium">Name</label>
          <Input
            id="signup-name"
            type="text"
            placeholder="Your name"
            bind:value={signupName}
            required
            autocomplete="name"
          />
        </div>

        <div class="space-y-2">
          <label for="signup-email" class="text-sm font-medium">Email</label>
          <Input
            id="signup-email"
            type="email"
            placeholder="you@example.com"
            bind:value={signupEmail}
            required
            autocomplete="email"
          />
        </div>

        <div class="space-y-2">
          <label for="signup-password" class="text-sm font-medium">Password</label>
          <Input
            id="signup-password"
            type="password"
            placeholder="Min. 8 characters"
            bind:value={signupPassword}
            required
            autocomplete="new-password"
          />
        </div>

        <div class="space-y-2">
          <label for="signup-confirm" class="text-sm font-medium">Confirm Password</label>
          <Input
            id="signup-confirm"
            type="password"
            placeholder="Confirm password"
            bind:value={signupConfirm}
            required
            autocomplete="new-password"
          />
        </div>

        <div class="space-y-2">
          <label for="invite-code" class="text-sm font-medium">
            Invite Code <span class="text-muted-foreground">(optional)</span>
          </label>
          <Input
            id="invite-code"
            type="text"
            placeholder="Invite code"
            bind:value={inviteCode}
          />
        </div>

        <Button type="submit" class="w-full" disabled={submitting}>
          {#if submitting}
            Creating account...
          {:else}
            Sign up
          {/if}
        </Button>
      </form>

      <p class="text-center text-sm text-muted-foreground">
        Already have an account?
        <button
          type="button"
          class="font-medium text-primary transition-colors hover:text-primary/80"
          onclick={() => { mode = "login"; error = ""; }}
        >
          Sign in
        </button>
      </p>
    {/if}
  </div>
</div>
