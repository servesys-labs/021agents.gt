<script lang="ts">
  import { page } from "$app/stores";
  import { toast } from "svelte-sonner";
  import { api } from "$lib/services/api";
  import AgentNav from "$lib/components/agent/AgentNav.svelte";
  import Button from "$lib/components/ui/button.svelte";
  import Badge from "$lib/components/ui/badge.svelte";
  import Input from "$lib/components/ui/input.svelte";
  import Select from "$lib/components/ui/select.svelte";
  import Textarea from "$lib/components/ui/textarea.svelte";
  import Switch from "$lib/components/ui/switch.svelte";
  import StatCard from "$lib/components/ui/stat-card.svelte";
  import {
    listChannels,
    connectChannel,
    disconnectChannel,
    updateChannel,
    type ChannelConfig,
  } from "$lib/services/channels";
  import { authStore } from "$lib/stores/auth.svelte";

  let agentName = $derived($page.params.name ?? "");
  // Org-qualified email: my-assistant.d8ec4cf7@oneshots.co (unique per org)
  let orgShort = $derived(authStore.user?.org_id ? authStore.user.org_id.slice(-8) : "");
  let agentEmail = $derived(orgShort ? `${agentName}.${orgShort}@oneshots.co` : `${agentName}@oneshots.co`);

  // ── Channel definitions ────────────────────────────────────────────
  interface ChannelDef {
    id: string;
    name: string;
    description: string;
    iconPath: string;
    iconColor: string;
  }

  const channelDefs: ChannelDef[] = [
    {
      id: "web_widget",
      name: "Web Widget",
      description: "Embed a chat widget on your website",
      iconPath: "M3.055 11H5a2 2 0 012 2v1a2 2 0 002 2 2 2 0 012 2v2.945M8 3.935V5.5A2.5 2.5 0 0010.5 8h.5a2 2 0 012 2 2 2 0 104 0 2 2 0 012-2h1.064M15 20.488V18a2 2 0 012-2h3.064M21 12a9 9 0 11-18 0 9 9 0 0118 0z",
      iconColor: "text-sky-500",
    },
    {
      id: "telegram",
      name: "Telegram",
      description: "DM your assistant via Telegram bot",
      iconPath: "M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z",
      iconColor: "text-sky-500",
    },
    {
      id: "whatsapp",
      name: "WhatsApp",
      description: "Auto-reply to WhatsApp messages via Cloud API",
      iconPath: "M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z",
      iconColor: "text-emerald-500",
    },
    {
      id: "slack",
      name: "Slack",
      description: "Respond in Slack channels and DMs",
      iconPath: "M7 8h10M7 12h4m1 8l-4-4H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-3l-4 4z",
      iconColor: "text-violet-500",
    },
    {
      id: "email",
      name: "Email",
      description: "Auto-respond to support emails",
      iconPath: "M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z",
      iconColor: "text-amber-500",
    },
    // SMS removed from MVP — requires A2P 10DLC registration (weeks of compliance)
    // {
    //   id: "sms",
    //   name: "SMS / Twilio",
    //   description: "Handle customer texts via Twilio SMS",
    //   iconPath: "M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z",
    //   iconColor: "text-violet-500",
    // },
    {
      id: "tiktok",
      name: "TikTok DM",
      description: "Auto-reply to TikTok direct messages",
      iconPath: "M9 12a4 4 0 108 0 4 4 0 00-8 0zM19.5 3h-2.25a2.25 2.25 0 00-2.25 2.25V9M12 3v6m0 0a3 3 0 003 3h3",
      iconColor: "text-foreground",
    },
    {
      id: "api",
      name: "API",
      description: "Integrate your agent into any custom application",
      iconPath: "M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4",
      iconColor: "text-muted-foreground",
    },
  ];

  // ── State ──────────────────────────────────────────────────────────
  let loading = $state(true);
  let saving = $state(false);
  let expandedChannel = $state<string | null>(null);
  let copied = $state<string | null>(null);

  // Channel statuses from API
  let channelStatuses = $state<Record<string, { is_active: boolean; config: Record<string, unknown> }>>({});

  // Per-channel form state
  // Web Widget
  let widgetPosition = $state("bottom-right");
  let widgetColor = $state("#2563eb");
  let widgetGreeting = $state("Hi! How can I help you today?");

  // Telegram
  let telegramBotToken = $state("");

  // WhatsApp
  let waAccessToken = $state("");
  let waPhoneNumberId = $state("");

  // Slack
  let slackBotToken = $state("");
  let slackTeamId = $state("");

  // Email
  let emailAddress = $state("");
  let emailProvider = $state("default");
  let emailSetupStatus = $state<{ status: string; message: string; dns?: any[] } | null>(null);

  // SMS (Twilio)
  let smsPhone = $state("");
  let smsProvider = $state("twilio");
  let smsAccountSid = $state("");
  let smsAuthToken = $state("");
  let smsShowSid = $state(false);
  let smsShowToken = $state(false);

  // TikTok DM
  let tiktokClientKey = $state("");
  let tiktokClientSecret = $state("");
  let tiktokAccessToken = $state("");
  let tiktokShowSecret = $state(false);
  let tiktokShowToken = $state(false);

  // ── Derived ────────────────────────────────────────────────────────
  let activeCount = $derived(
    Object.values(channelStatuses).filter((c) => c.is_active).length
  );
  let availableCount = $derived(channelDefs.length);

  function isConnected(id: string): boolean {
    return !!channelStatuses[id]?.is_active;
  }

  function hasConfig(id: string): boolean {
    return !!channelStatuses[id];
  }

  let widgetSnippet = $derived(
    `<script src="https://api.oneshots.co/widget.js" data-agent="${agentName}" data-color="${widgetColor}"><\/script>`
  );

  let webhookUrl = $derived(`https://api.oneshots.co/api/v1/chat/${agentName}/webhook`);

  let apiEndpoint = $derived(`POST https://api.oneshots.co/v1/agents/${agentName}/run`);

  let curlExample = $derived(
    `curl -X POST https://api.oneshots.co/v1/agents/${agentName}/run \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"message": "Hello", "session_id": "optional"}'`
  );

  // ── Load ───────────────────────────────────────────────────────────
  async function loadChannels() {
    loading = true;
    try {
      const data = await listChannels(agentName);
      const statuses: typeof channelStatuses = {};
      for (const ch of data.channels ?? []) {
        statuses[ch.channel] = {
          is_active: ch.is_active,
          config: (ch.config as Record<string, unknown>) ?? {},
        };
        // Pre-fill form fields from saved config
        if (ch.channel === "web_widget" && ch.config) {
          const c = ch.config as Record<string, string>;
          if (c.position) widgetPosition = c.position;
          if (c.color) widgetColor = c.color;
          if (c.greeting) widgetGreeting = c.greeting;
        }
        if (ch.channel === "email" && ch.config) {
          const c = ch.config as Record<string, string>;
          if (c.address) emailAddress = c.address;
          if (c.provider) emailProvider = c.provider;
        }
        if (ch.channel === "sms" && ch.config) {
          const c = ch.config as Record<string, string>;
          if (c.phone_number) smsPhone = c.phone_number;
          if (c.phone) smsPhone = c.phone;
          if (c.provider) smsProvider = c.provider;
        }
        if (ch.channel === "tiktok" && ch.config) {
          const c = ch.config as Record<string, string>;
          if (c.client_key) tiktokClientKey = c.client_key;
        }
      }
      channelStatuses = statuses;
    } catch {
      // channels table may not exist yet
    } finally {
      loading = false;
    }
  }

  // ── Save / toggle ──────────────────────────────────────────────────
  async function saveChannel(channelId: string, config: Record<string, unknown>) {
    saving = true;
    try {
      if (hasConfig(channelId)) {
        await updateChannel(agentName, channelId, config);
      } else {
        await connectChannel(agentName, channelId, config);
      }
      channelStatuses = {
        ...channelStatuses,
        [channelId]: { is_active: true, config },
      };
      expandedChannel = null;
      toast.success("Channel configured and activated!");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save channel");
    } finally {
      saving = false;
    }
  }

  async function toggleChannel(channelId: string) {
    const current = channelStatuses[channelId];
    if (!current) {
      // No config yet — open configure panel
      expandedChannel = channelId;
      return;
    }
    const newActive = !current.is_active;
    channelStatuses = {
      ...channelStatuses,
      [channelId]: { ...current, is_active: newActive },
    };
    try {
      await updateChannel(agentName, channelId, {
        ...current.config,
        is_active: newActive,
      });
      toast.success(newActive ? "Channel enabled" : "Channel disabled");
    } catch {
      // Revert on failure
      channelStatuses = {
        ...channelStatuses,
        [channelId]: { ...current, is_active: !newActive },
      };
    }
  }

  function handleCopy(text: string, label: string) {
    navigator.clipboard.writeText(text);
    copied = label;
    setTimeout(() => (copied = null), 2000);
    toast.success("Copied to clipboard");
  }

  $effect(() => {
    if (agentName) loadChannels();
  });
</script>

<div class="flex h-full flex-col">
  <AgentNav {agentName} activePath={$page.url.pathname} />

  <div class="flex-1 overflow-y-auto">
    <div class="w-full px-6 py-8 lg:px-8">
      {#if loading}
        <div class="flex items-center justify-center py-24">
          <div class="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent"></div>
        </div>
      {:else}
        <!-- Header -->
        <div class="mb-8">
          <h1>Channels</h1>
          <p class="mt-1.5 text-sm text-muted-foreground">
            Deploy your agent across messaging platforms, email, and web
          </p>
        </div>

        <!-- Stats -->
        <div class="mb-8 grid gap-4 sm:grid-cols-3">
          <StatCard value={String(activeCount)} label="Active Channels" accentColor="chart-1" />
          <StatCard value="0" label="Total Conversations" accentColor="chart-2" />
          <StatCard value={String(availableCount)} label="Available Channels" accentColor="chart-3" />
        </div>

        <!-- Channel Cards -->
        <div class="space-y-3">
          {#each channelDefs as ch}
            <div class="rounded-lg border border-border bg-card shadow-sm">
              <!-- Card header -->
              <div class="flex items-center gap-4 p-5">
                <div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-muted">
                  <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5 {ch.iconColor}" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
                    <path stroke-linecap="round" stroke-linejoin="round" d={ch.iconPath} />
                  </svg>
                </div>
                <div class="min-w-0 flex-1">
                  <div class="flex items-center gap-2">
                    <h3 class="text-sm font-semibold text-foreground">{ch.name}</h3>
                    {#if isConnected(ch.id)}
                      <Badge variant="default">Connected</Badge>
                    {:else if hasConfig(ch.id)}
                      <Badge variant="secondary">Inactive</Badge>
                    {:else}
                      <Badge variant="outline">Not configured</Badge>
                    {/if}
                  </div>
                  <p class="mt-0.5 text-xs text-muted-foreground">{ch.description}</p>
                </div>
                <div class="flex shrink-0 items-center gap-3">
                  {#if ch.id !== "api"}
                    <Button
                      size="sm"
                      variant={expandedChannel === ch.id ? "secondary" : "outline"}
                      onclick={() => (expandedChannel = expandedChannel === ch.id ? null : ch.id)}
                    >
                      {isConnected(ch.id) ? "Configure" : "Set Up"}
                    </Button>
                    {#if hasConfig(ch.id)}
                      <!-- Use a wrapper that calls toggleChannel on click -->
                      <button
                        type="button"
                        role="switch"
                        aria-checked={isConnected(ch.id)}
                        aria-label="Toggle {ch.name}"
                        class="relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 {isConnected(ch.id) ? 'bg-primary' : 'bg-input'}"
                        onclick={() => toggleChannel(ch.id)}
                      >
                        <span class="pointer-events-none block h-5 w-5 rounded-full bg-background shadow-lg ring-0 transition-transform {isConnected(ch.id) ? 'translate-x-5' : 'translate-x-0'}"></span>
                      </button>
                    {/if}
                  {:else}
                    <Button
                      size="sm"
                      variant={expandedChannel === "api" ? "secondary" : "outline"}
                      onclick={() => (expandedChannel = expandedChannel === "api" ? null : "api")}
                    >
                      View Details
                    </Button>
                  {/if}
                </div>
              </div>

              <!-- Expanded config panel -->
              {#if expandedChannel === ch.id}
                <div class="border-t border-border p-5">
                  <!-- Web Widget -->
                  {#if ch.id === "web_widget"}
                    <div class="space-y-4">
                      <div class="grid gap-4 sm:grid-cols-2">
                        <div>
                          <label for="widget-pos" class="mb-2 block text-sm font-medium text-foreground">Position</label>
                          <Select
                            id="widget-pos"
                            options={[
                              { value: "bottom-right", label: "Bottom Right" },
                              { value: "bottom-left", label: "Bottom Left" },
                            ]}
                            bind:value={widgetPosition}
                          />
                        </div>
                        <div>
                          <label for="widget-color" class="mb-2 block text-sm font-medium text-foreground">Brand Color</label>
                          <Input id="widget-color" type="color" bind:value={widgetColor} />
                        </div>
                      </div>
                      <div>
                        <label for="widget-greeting" class="mb-2 block text-sm font-medium text-foreground">Greeting Message</label>
                        <Textarea id="widget-greeting" rows={2} bind:value={widgetGreeting} placeholder="Hi! How can I help you today?" />
                      </div>
                      <div>
                        <p class="mb-2 text-sm font-medium text-foreground">Embed Code</p>
                        <div class="relative">
                          <pre class="overflow-x-auto rounded-lg bg-muted p-4 font-mono text-xs text-foreground">{widgetSnippet}</pre>
                          <button
                            class="absolute right-2 top-2 rounded-md bg-secondary p-1.5 text-secondary-foreground hover:bg-secondary/80"
                            onclick={() => handleCopy(widgetSnippet, "widget")}
                          >
                            {#if copied === "widget"}
                              <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7" /></svg>
                            {:else}
                              <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" /></svg>
                            {/if}
                          </button>
                        </div>
                        <p class="mt-2 text-xs text-muted-foreground">Paste before the closing &lt;/body&gt; tag on your website.</p>
                      </div>
                      <div class="flex justify-end gap-3 pt-2">
                        <Button variant="outline" onclick={() => (expandedChannel = null)}>Cancel</Button>
                        <Button disabled={saving} onclick={() => saveChannel("web_widget", { position: widgetPosition, color: widgetColor, greeting: widgetGreeting })}>
                          {#if saving}<span class="mr-2 h-4 w-4 animate-spin rounded-full border-2 border-primary-foreground border-t-transparent"></span>{/if}
                          Save
                        </Button>
                      </div>
                    </div>

                  <!-- Telegram -->
                  {:else if ch.id === "telegram"}
                    <div class="space-y-4">
                      <p class="text-sm leading-relaxed text-muted-foreground">
                        Create a bot in <strong class="text-foreground">@BotFather</strong>, copy the HTTP API token, and paste it below. We will register the webhook automatically.
                      </p>
                      <div>
                        <label for="tg-token" class="mb-2 block text-sm font-medium text-foreground">Bot Token</label>
                        <Input id="tg-token" type="password" placeholder="Paste token from BotFather" bind:value={telegramBotToken} />
                      </div>
                      <div>
                        <p class="mb-2 text-sm font-medium text-foreground">Webhook URL</p>
                        <div class="flex items-center gap-2">
                          <code class="flex-1 rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground">{webhookUrl}/telegram</code>
                          <button class="rounded-md bg-secondary p-2 text-secondary-foreground hover:bg-secondary/80" onclick={() => handleCopy(`${webhookUrl}/telegram`, "tg-wh")}>
                            <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" /></svg>
                          </button>
                        </div>
                      </div>
                      <div class="rounded-lg bg-muted/50 p-4">
                        <p class="text-xs text-muted-foreground">Deep link: <code class="text-foreground">https://t.me/{agentName}_bot</code></p>
                        <div class="mt-2 flex h-32 w-32 items-center justify-center rounded-lg border border-border bg-card text-xs text-muted-foreground">QR Code</div>
                      </div>
                      <div class="flex justify-end gap-3 pt-2">
                        <Button variant="outline" onclick={() => (expandedChannel = null)}>Cancel</Button>
                        <Button
                          disabled={saving || !telegramBotToken.trim()}
                          onclick={() => saveChannel("telegram", { bot_token: telegramBotToken })}
                        >
                          {#if saving}<span class="mr-2 h-4 w-4 animate-spin rounded-full border-2 border-primary-foreground border-t-transparent"></span>{/if}
                          Connect Telegram
                        </Button>
                      </div>
                    </div>

                  <!-- WhatsApp -->
                  {:else if ch.id === "whatsapp"}
                    <div class="space-y-4">
                      <p class="text-sm leading-relaxed text-muted-foreground">
                        Connect via Meta's <strong class="text-foreground">Cloud API</strong>. You need an access token and phone number ID from the Meta Business dashboard.
                      </p>
                      <div>
                        <label for="wa-token" class="mb-2 block text-sm font-medium text-foreground">Access Token</label>
                        <Input id="wa-token" type="password" placeholder="Paste WhatsApp Cloud API access token" bind:value={waAccessToken} />
                      </div>
                      <div>
                        <label for="wa-phone-id" class="mb-2 block text-sm font-medium text-foreground">Phone Number ID</label>
                        <Input id="wa-phone-id" placeholder="From Meta Business dashboard" bind:value={waPhoneNumberId} />
                      </div>
                      <div>
                        <p class="mb-2 text-sm font-medium text-foreground">Webhook URL</p>
                        <div class="flex items-center gap-2">
                          <code class="flex-1 rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground">{webhookUrl}/whatsapp</code>
                          <button class="rounded-md bg-secondary p-2 text-secondary-foreground hover:bg-secondary/80" onclick={() => handleCopy(`${webhookUrl}/whatsapp`, "wa-wh")}>
                            <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" /></svg>
                          </button>
                        </div>
                      </div>
                      <div class="flex justify-end gap-3 pt-2">
                        <Button variant="outline" onclick={() => (expandedChannel = null)}>Cancel</Button>
                        <Button
                          disabled={saving || !waAccessToken.trim() || !waPhoneNumberId.trim()}
                          onclick={() => saveChannel("whatsapp", { access_token: waAccessToken, phone_number_id: waPhoneNumberId })}
                        >
                          {#if saving}<span class="mr-2 h-4 w-4 animate-spin rounded-full border-2 border-primary-foreground border-t-transparent"></span>{/if}
                          Connect WhatsApp
                        </Button>
                      </div>
                    </div>

                  <!-- Slack -->
                  {:else if ch.id === "slack"}
                    <div class="space-y-4">
                      <p class="text-sm leading-relaxed text-muted-foreground">
                        Create a <strong class="text-foreground">Slack App</strong> at
                        <a href="https://api.slack.com/apps" target="_blank" rel="noreferrer" class="text-primary hover:underline">api.slack.com/apps</a>,
                        enable Event Subscriptions and Bot Token Scopes (<code class="text-xs">chat:write</code>, <code class="text-xs">app_mentions:read</code>, <code class="text-xs">im:history</code>).
                      </p>
                      <div>
                        <label for="slack-token" class="mb-2 block text-sm font-medium text-foreground">Bot User OAuth Token</label>
                        <Input id="slack-token" type="password" placeholder="xoxb-..." bind:value={slackBotToken} />
                      </div>
                      <div>
                        <label for="slack-team" class="mb-2 block text-sm font-medium text-foreground">Team ID</label>
                        <Input id="slack-team" placeholder="T01ABC123" bind:value={slackTeamId} />
                      </div>
                      <div>
                        <p class="mb-2 text-sm font-medium text-foreground">Webhook URL</p>
                        <div class="flex items-center gap-2">
                          <code class="flex-1 rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground">{webhookUrl}/slack</code>
                          <button class="rounded-md bg-secondary p-2 text-secondary-foreground hover:bg-secondary/80" onclick={() => handleCopy(`${webhookUrl}/slack`, "slack-wh")}>
                            <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" /></svg>
                          </button>
                        </div>
                      </div>
                      <div class="flex justify-end gap-3 pt-2">
                        <Button variant="outline" onclick={() => (expandedChannel = null)}>Cancel</Button>
                        <Button
                          disabled={saving || !slackBotToken.trim() || !slackTeamId.trim()}
                          onclick={() => saveChannel("slack", { bot_token: slackBotToken, team_id: slackTeamId })}
                        >
                          {#if saving}<span class="mr-2 h-4 w-4 animate-spin rounded-full border-2 border-primary-foreground border-t-transparent"></span>{/if}
                          Connect Slack
                        </Button>
                      </div>
                    </div>

                  <!-- Email -->
                  {:else if ch.id === "email"}
                    <div class="space-y-4">
                      <!-- Default email (always works) -->
                      <div>
                        <p class="mb-1 text-sm font-medium text-foreground">Default email address</p>
                        <div class="flex items-center gap-2">
                          <code class="flex-1 rounded-lg bg-muted px-3 py-2 font-mono text-sm text-foreground">{agentEmail}</code>
                          <Button variant="secondary" size="sm" onclick={() => { navigator.clipboard.writeText(agentEmail); toast.success("Copied!"); }}>Copy</Button>
                        </div>
                        <p class="mt-1 text-xs text-muted-foreground">This address works automatically — no setup needed.</p>
                      </div>

                      <!-- How it works -->
                      <div class="rounded-lg bg-muted/50 p-4">
                        <p class="text-sm font-medium text-foreground">How it works</p>
                        <ol class="mt-2 space-y-1.5 text-xs text-muted-foreground">
                          <li>1. Someone sends an email to the address above</li>
                          <li>2. Your agent reads the email and processes it with its tools</li>
                          <li>3. The agent auto-replies to the sender</li>
                          <li>4. Conversations appear in the Activity tab</li>
                        </ol>
                      </div>

                      <!-- Custom domain -->
                      <div>
                        <p class="mb-1 text-sm font-medium text-foreground">Custom domain (optional)</p>
                        <p class="mb-2 text-xs text-muted-foreground">Use your own email like support@yourcompany.com. We'll auto-configure the routing.</p>
                        <div class="flex items-center gap-2">
                          <Input type="email" placeholder="support@yourcompany.com" bind:value={emailAddress} class="flex-1" />
                          {#if emailAddress.trim()}
                            <Button variant="secondary" size="sm" onclick={async () => {
                              saving = true;
                              try {
                                const res = await api.post("/chat/email/remove", { agent_name: agentName, custom_email: emailAddress });
                                toast.success("Custom email removed");
                                emailAddress = "";
                              } catch { /* ignore if no rule exists */ }
                              finally { saving = false; }
                            }}>Remove</Button>
                          {/if}
                        </div>
                      </div>

                      <!-- Email setup status -->
                      {#if emailSetupStatus}
                        <div class="rounded-lg p-3 text-xs {emailSetupStatus.status === 'active' ? 'bg-success/10 text-success' : emailSetupStatus.status === 'error' ? 'bg-destructive/10 text-destructive' : 'bg-chart-4/10 text-chart-4'}">
                          <p class="font-medium">{emailSetupStatus.message}</p>
                          {#if emailSetupStatus.dns}
                            <div class="mt-2 space-y-1">
                              {#each emailSetupStatus.dns as record}
                                <code class="block rounded bg-background/50 px-2 py-1">{record.type} {record.name} → {record.content} {record.priority ? `(priority: ${record.priority})` : ""}</code>
                              {/each}
                            </div>
                          {/if}
                        </div>
                      {/if}

                      <div class="flex justify-end gap-3 pt-2">
                        <Button variant="outline" onclick={() => (expandedChannel = null)}>Cancel</Button>
                        <Button
                          disabled={saving}
                          onclick={async () => {
                            saving = true;
                            emailSetupStatus = null;
                            try {
                              const res = await api.post("/chat/email/setup", {
                                agent_name: agentName,
                                custom_email: emailAddress.trim() || undefined,
                              });
                              const data = res as any;
                              if (data.custom_domain_status) {
                                emailSetupStatus = data.custom_domain_status;
                              }
                              toast.success(emailAddress.trim() ? "Email routing configured!" : "Email channel enabled!");
                            } catch (err) {
                              toast.error(err instanceof Error ? err.message : "Failed to set up email");
                            } finally { saving = false; }
                          }}
                        >
                          {#if saving}<span class="mr-2 h-4 w-4 animate-spin rounded-full border-2 border-primary-foreground border-t-transparent"></span>{/if}
                          {emailAddress.trim() ? "Set Up Custom Email" : "Enable Email"}
                        </Button>
                      </div>
                    </div>

                  <!-- SMS (Twilio) -->
                  {:else if ch.id === "sms"}
                    <div class="space-y-4">
                      <p class="text-sm leading-relaxed text-muted-foreground">
                        Connect a <strong class="text-foreground">Twilio</strong> phone number to receive and reply to SMS messages.
                        Get your credentials from the <a href="https://console.twilio.com/" target="_blank" rel="noreferrer" class="text-primary hover:underline">Twilio Console</a>.
                      </p>
                      <div>
                        <label for="sms-sid" class="mb-2 block text-sm font-medium text-foreground">Account SID</label>
                        <div class="relative">
                          <Input id="sms-sid" type={smsShowSid ? "text" : "password"} placeholder="ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" bind:value={smsAccountSid} />
                          <button
                            type="button"
                            class="absolute inset-y-0 right-2 flex items-center px-1 text-muted-foreground hover:text-foreground"
                            onclick={() => (smsShowSid = !smsShowSid)}
                          >
                            <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                              {#if smsShowSid}
                                <path stroke-linecap="round" stroke-linejoin="round" d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M3 3l18 18" />
                              {:else}
                                <path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                                <path stroke-linecap="round" stroke-linejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                              {/if}
                            </svg>
                          </button>
                        </div>
                      </div>
                      <div>
                        <label for="sms-token" class="mb-2 block text-sm font-medium text-foreground">Auth Token</label>
                        <div class="relative">
                          <Input id="sms-token" type={smsShowToken ? "text" : "password"} placeholder="Paste your Twilio Auth Token" bind:value={smsAuthToken} />
                          <button
                            type="button"
                            class="absolute inset-y-0 right-2 flex items-center px-1 text-muted-foreground hover:text-foreground"
                            onclick={() => (smsShowToken = !smsShowToken)}
                          >
                            <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                              {#if smsShowToken}
                                <path stroke-linecap="round" stroke-linejoin="round" d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M3 3l18 18" />
                              {:else}
                                <path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                                <path stroke-linecap="round" stroke-linejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                              {/if}
                            </svg>
                          </button>
                        </div>
                      </div>
                      <div>
                        <label for="sms-phone" class="mb-2 block text-sm font-medium text-foreground">Phone Number</label>
                        <Input id="sms-phone" type="tel" placeholder="+15550000000" bind:value={smsPhone} />
                        <p class="mt-1 text-xs text-muted-foreground">E.164 format (e.g. +15551234567). Must be a Twilio number you own.</p>
                      </div>
                      <div>
                        <p class="mb-2 text-sm font-medium text-foreground">Webhook URL</p>
                        <div class="flex items-center gap-2">
                          <code class="flex-1 rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground">{webhookUrl}/sms</code>
                          <button class="rounded-md bg-secondary p-2 text-secondary-foreground hover:bg-secondary/80" onclick={() => handleCopy(`${webhookUrl}/sms`, "sms-wh")}>
                            <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" /></svg>
                          </button>
                        </div>
                        <p class="mt-1 text-xs text-muted-foreground">We'll configure this webhook automatically on your Twilio number.</p>
                      </div>
                      {#if isConnected("sms")}
                        <div class="rounded-lg bg-muted/50 p-4">
                          <p class="text-xs text-muted-foreground">Connected: <strong class="text-foreground">{smsPhone}</strong></p>
                        </div>
                      {/if}
                      <div class="flex justify-end gap-3 pt-2">
                        <Button variant="outline" onclick={() => (expandedChannel = null)}>Cancel</Button>
                        {#if isConnected("sms")}
                          <Button
                            variant="destructive"
                            disabled={saving}
                            onclick={async () => {
                              saving = true;
                              try {
                                await api.post("/chat/sms/disconnect", { agent_name: agentName });
                                channelStatuses = { ...channelStatuses, sms: { is_active: false, config: {} } };
                                smsAccountSid = "";
                                smsAuthToken = "";
                                smsPhone = "";
                                expandedChannel = null;
                                toast.success("SMS disconnected");
                              } catch (err) {
                                toast.error(err instanceof Error ? err.message : "Failed to disconnect");
                              } finally { saving = false; }
                            }}
                          >
                            {#if saving}<span class="mr-2 h-4 w-4 animate-spin rounded-full border-2 border-primary-foreground border-t-transparent"></span>{/if}
                            Disconnect
                          </Button>
                        {:else}
                          <Button
                            disabled={saving || !smsAccountSid.trim() || !smsAuthToken.trim() || !smsPhone.trim()}
                            onclick={async () => {
                              saving = true;
                              try {
                                const res = await api.post("/chat/sms/connect", {
                                  agent_name: agentName,
                                  account_sid: smsAccountSid,
                                  auth_token: smsAuthToken,
                                  phone_number: smsPhone,
                                });
                                channelStatuses = {
                                  ...channelStatuses,
                                  sms: { is_active: true, config: { phone_number: smsPhone } },
                                };
                                expandedChannel = null;
                                toast.success("SMS connected via Twilio!");
                              } catch (err) {
                                toast.error(err instanceof Error ? err.message : "Failed to connect SMS");
                              } finally { saving = false; }
                            }}
                          >
                            {#if saving}<span class="mr-2 h-4 w-4 animate-spin rounded-full border-2 border-primary-foreground border-t-transparent"></span>{/if}
                            Connect SMS
                          </Button>
                        {/if}
                      </div>
                    </div>

                  <!-- TikTok DM -->
                  {:else if ch.id === "tiktok"}
                    <div class="space-y-4">
                      <p class="text-sm leading-relaxed text-muted-foreground">
                        Connect your <strong class="text-foreground">TikTok</strong> app to auto-reply to direct messages.
                        Get credentials from the <a href="https://developers.tiktok.com/" target="_blank" rel="noreferrer" class="text-primary hover:underline">TikTok Developer Portal</a> &rarr; App &rarr; Credentials.
                      </p>
                      <div>
                        <label for="tt-key" class="mb-2 block text-sm font-medium text-foreground">Client Key</label>
                        <Input id="tt-key" placeholder="Your TikTok app client key" bind:value={tiktokClientKey} />
                      </div>
                      <div>
                        <label for="tt-secret" class="mb-2 block text-sm font-medium text-foreground">Client Secret</label>
                        <div class="relative">
                          <Input id="tt-secret" type={tiktokShowSecret ? "text" : "password"} placeholder="Your TikTok app client secret" bind:value={tiktokClientSecret} />
                          <button
                            type="button"
                            class="absolute inset-y-0 right-2 flex items-center px-1 text-muted-foreground hover:text-foreground"
                            onclick={() => (tiktokShowSecret = !tiktokShowSecret)}
                          >
                            <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                              {#if tiktokShowSecret}
                                <path stroke-linecap="round" stroke-linejoin="round" d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M3 3l18 18" />
                              {:else}
                                <path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                                <path stroke-linecap="round" stroke-linejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                              {/if}
                            </svg>
                          </button>
                        </div>
                      </div>
                      <div>
                        <label for="tt-token" class="mb-2 block text-sm font-medium text-foreground">Access Token</label>
                        <div class="relative">
                          <Input id="tt-token" type={tiktokShowToken ? "text" : "password"} placeholder="User access token with dm.read + dm.write scopes" bind:value={tiktokAccessToken} />
                          <button
                            type="button"
                            class="absolute inset-y-0 right-2 flex items-center px-1 text-muted-foreground hover:text-foreground"
                            onclick={() => (tiktokShowToken = !tiktokShowToken)}
                          >
                            <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                              {#if tiktokShowToken}
                                <path stroke-linecap="round" stroke-linejoin="round" d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M3 3l18 18" />
                              {:else}
                                <path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                                <path stroke-linecap="round" stroke-linejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                              {/if}
                            </svg>
                          </button>
                        </div>
                        <p class="mt-1 text-xs text-muted-foreground">Get from TikTok Developer Portal. Requires <code class="text-foreground">dm.read</code> and <code class="text-foreground">dm.write</code> scopes.</p>
                      </div>
                      <div>
                        <p class="mb-2 text-sm font-medium text-foreground">Webhook URL</p>
                        <div class="flex items-center gap-2">
                          <code class="flex-1 rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground">{webhookUrl}/tiktok</code>
                          <button class="rounded-md bg-secondary p-2 text-secondary-foreground hover:bg-secondary/80" onclick={() => handleCopy(`${webhookUrl}/tiktok`, "tt-wh")}>
                            <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" /></svg>
                          </button>
                        </div>
                        <p class="mt-1 text-xs text-muted-foreground">We'll register this webhook automatically with TikTok.</p>
                      </div>
                      <div class="flex justify-end gap-3 pt-2">
                        <Button variant="outline" onclick={() => (expandedChannel = null)}>Cancel</Button>
                        {#if isConnected("tiktok")}
                          <Button
                            variant="destructive"
                            disabled={saving}
                            onclick={async () => {
                              saving = true;
                              try {
                                await api.post("/chat/tiktok/disconnect", { agent_name: agentName });
                                channelStatuses = { ...channelStatuses, tiktok: { is_active: false, config: {} } };
                                tiktokClientKey = "";
                                tiktokClientSecret = "";
                                tiktokAccessToken = "";
                                expandedChannel = null;
                                toast.success("TikTok disconnected");
                              } catch (err) {
                                toast.error(err instanceof Error ? err.message : "Failed to disconnect");
                              } finally { saving = false; }
                            }}
                          >
                            {#if saving}<span class="mr-2 h-4 w-4 animate-spin rounded-full border-2 border-primary-foreground border-t-transparent"></span>{/if}
                            Disconnect
                          </Button>
                        {:else}
                          <Button
                            disabled={saving || !tiktokClientKey.trim() || !tiktokClientSecret.trim() || !tiktokAccessToken.trim()}
                            onclick={async () => {
                              saving = true;
                              try {
                                const res = await api.post("/chat/tiktok/connect", {
                                  agent_name: agentName,
                                  client_key: tiktokClientKey,
                                  client_secret: tiktokClientSecret,
                                  access_token: tiktokAccessToken,
                                });
                                channelStatuses = {
                                  ...channelStatuses,
                                  tiktok: { is_active: true, config: { client_key: tiktokClientKey } },
                                };
                                expandedChannel = null;
                                toast.success("TikTok DM connected!");
                              } catch (err) {
                                toast.error(err instanceof Error ? err.message : "Failed to connect TikTok");
                              } finally { saving = false; }
                            }}
                          >
                            {#if saving}<span class="mr-2 h-4 w-4 animate-spin rounded-full border-2 border-primary-foreground border-t-transparent"></span>{/if}
                            Connect TikTok
                          </Button>
                        {/if}
                      </div>
                    </div>

                  <!-- API -->
                  {:else if ch.id === "api"}
                    <div class="space-y-4">
                      <div>
                        <p class="mb-2 text-sm font-medium text-foreground">API Endpoint</p>
                        <div class="flex items-center gap-2">
                          <code class="flex-1 rounded-lg bg-muted px-3 py-2 text-sm font-mono text-foreground">{apiEndpoint}</code>
                          <button class="rounded-md bg-secondary p-2 text-secondary-foreground hover:bg-secondary/80" onclick={() => handleCopy(apiEndpoint, "api-ep")}>
                            <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" /></svg>
                          </button>
                        </div>
                      </div>
                      <div>
                        <p class="mb-2 text-sm font-medium text-foreground">cURL Example</p>
                        <div class="relative">
                          <pre class="overflow-x-auto rounded-lg bg-muted p-4 font-mono text-xs text-foreground">{curlExample}</pre>
                          <button
                            class="absolute right-2 top-2 rounded-md bg-secondary p-1.5 text-secondary-foreground hover:bg-secondary/80"
                            onclick={() => handleCopy(curlExample, "curl")}
                          >
                            {#if copied === "curl"}
                              <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7" /></svg>
                            {:else}
                              <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" /></svg>
                            {/if}
                          </button>
                        </div>
                      </div>
                      <div class="flex items-center gap-2 text-sm text-muted-foreground">
                        <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" /></svg>
                        <span>Generate API keys in <a href="/settings/api-keys" class="text-primary hover:underline">Settings &rarr; API Keys</a></span>
                      </div>
                    </div>
                  {/if}
                </div>
              {/if}
            </div>
          {/each}
        </div>
      {/if}
    </div>
  </div>
</div>
