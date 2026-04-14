<script lang="ts">
  import { cn } from "$lib/utils";

  interface Props {
    agentName: string;
    activePath?: string;
  }

  let { agentName, activePath }: Props = $props();

  const tabs = [
    { label: "Chat", href: (n: string) => `/chat/${n}`, match: "/chat/" },
    { label: "Canvas", href: (n: string) => `/agent/${n}/canvas`, match: "/canvas" },
    { label: "Settings", href: (n: string) => `/agent/${n}/settings`, match: "/settings" },
    { label: "Tests", href: (n: string) => `/agent/${n}/tests`, match: "/tests" },
    { label: "Runs", href: (n: string) => `/agent/${n}/runs`, match: "/runs" },
    { label: "Activity", href: (n: string) => `/agent/${n}/activity`, match: "/activity" },
    { label: "Knowledge", href: (n: string) => `/agent/${n}/knowledge`, match: "/knowledge" },
    { label: "Skills", href: (n: string) => `/agent/${n}/skills`, match: "/skills" },
    { label: "Files", href: (n: string) => `/agent/${n}/workspace`, match: "/workspace" },
    { label: "Channels", href: (n: string) => `/agent/${n}/channels`, match: "/channels" },
    { label: "Voice", href: (n: string) => `/agent/${n}/voice`, match: "/voice" },
  ];

  function isActive(match: string): boolean {
    const path = activePath ?? "";
    if (match === "/chat/") return path.startsWith("/chat/");
    return path.endsWith(match);
  }
</script>

<nav class="sticky top-0 z-10 w-full bg-background shadow-sm">
  <div class="flex items-center px-4 lg:px-6">
    <span class="mr-4 shrink-0 text-sm font-semibold text-foreground">{agentName}</span>
    <div class="scrollbar-hide flex flex-1 overflow-x-auto">
      {#each tabs as tab}
        <a
          href={tab.href(agentName)}
          class={cn(
            "shrink-0 whitespace-nowrap border-b-2 px-3 py-2.5 text-[13px] font-medium transition-colors",
            isActive(tab.match)
              ? "border-primary text-foreground"
              : "border-transparent text-muted-foreground hover:text-foreground"
          )}
        >
          {tab.label}
        </a>
      {/each}
    </div>
  </div>
</nav>
