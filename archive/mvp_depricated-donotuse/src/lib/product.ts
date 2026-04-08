/**
 * MVP positioning: small businesses plus a personal-assistant path (chat apps first).
 * Edit here to retone the whole shell without hunting strings.
 */
export const PRODUCT = {
  name: "OneShots",
  /** Shown next to the logo and in the browser title */
  edition: "Business & personal",
  documentTitle: "OneShots — Business & personal",
  /** One line under the logo on auth screens */
  editionTagline: "Assistants for your business—and a private one in your pocket.",
  /** Dashboard hero */
  dashboardTitle: "Dashboard",
  dashboardSubtitle: "Business assistants for customers—or your private one in chat apps.",
  /** Agent list heading */
  agentsSectionTitle: "Your assistants",
  /** Empty dashboard */
  emptyAgentsTitle: "No assistants yet",
  emptyAgentsBody: "Add one to answer FAQs, qualify leads, or track orders—even when you are busy on the floor.",
  emptyAgentsCta: "Create your first assistant",
  /** Primary create action (matches sidebar) */
  newAgentCta: "New assistant",
  /** Builder */
  createAgentTitle: "Create a new assistant",
  createAgentIntro:
    "Give it a name and job—perfect for reception, bookings, or order questions without hiring another person.",
  /** Onboarding */
  onboardingHeadline: "How will you use OneShots?",
  onboardingSub: "Pick a path—you can add the other kind of assistant anytime.",
  onboardingBusinessHeadline: "Set up your business workspace",
  onboardingBusinessSub: "We’ll match templates and tools to how your team works.",
  onboardingPersonalHeadline: "Set up your personal assistant",
  onboardingPersonalSub:
    "A private AI in Telegram, WhatsApp, or Slack—similar idea to self-hosted tools like OpenClaw, without running your own server.",
  /** Personal agent builder */
  createPersonalAgentTitle: "Create your personal assistant",
  createPersonalAgentIntro:
    "For one user: tasks, calendar, reminders, and quick answers. Connect chat apps on the next screen with QR codes after you create them.",
  /** Settings */
  settingsSubtitle: "Your account, shop details, and billing in one place.",
  /** Dashboard stat labels */
  statAssistants: "Assistants",
  statSessions: "Sessions",
  statLatency: "Avg response time",
  latencyEmpty: "No data yet",
} as const;
