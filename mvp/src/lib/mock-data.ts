export interface Agent {
  id: string;
  name: string;
  description: string;
  status: "active" | "draft" | "paused";
  use_case: string;
  created_at: string;
  conversations_today: number;
  success_rate: number;
  tools: string[];
  persona: string;
  tone: string;
  response_length: string;
  nodes: FlowNode[];
  edges: FlowEdge[];
}

export interface FlowNode {
  id: string;
  type: "trigger" | "llm" | "tool" | "condition" | "response";
  label: string;
  config?: Record<string, string>;
  x: number;
  y: number;
}

export interface FlowEdge {
  id: string;
  from: string;
  to: string;
  label?: string;
}

export interface Conversation {
  id: string;
  agent_id: string;
  user_name: string;
  started_at: string;
  messages: number;
  status: "completed" | "active" | "escalated";
  preview: string;
}

export interface EvalScenario {
  id: string;
  name: string;
  input: string;
  expected: string;
  agent_id: string;
}

export interface EvalRun {
  id: string;
  agent_id: string;
  ran_at: string;
  scenarios_total: number;
  scenarios_passed: number;
  results: EvalResult[];
}

export interface EvalResult {
  scenario_id: string;
  scenario_name: string;
  input: string;
  expected: string;
  actual: string;
  passed: boolean;
  latency_ms: number;
  reasoning?: string;
}

export interface DailyMetric {
  date: string;
  conversations: number;
  messages: number;
  avg_response_ms: number;
  success_rate: number;
}

// ── Mock data ──────────────────────────────────────────────────────

const defaultNodes: FlowNode[] = [
  { id: "trigger", type: "trigger", label: "Customer message", x: 60, y: 40 },
  { id: "classify", type: "condition", label: "Intent classifier", x: 60, y: 140 },
  { id: "faq", type: "llm", label: "Answer from FAQ", x: -60, y: 260 },
  { id: "order", type: "tool", label: "Look up order", x: 180, y: 260 },
  { id: "respond", type: "response", label: "Send reply", x: 60, y: 380 },
];

const defaultEdges: FlowEdge[] = [
  { id: "e1", from: "trigger", to: "classify" },
  { id: "e2", from: "classify", to: "faq", label: "FAQ" },
  { id: "e3", from: "classify", to: "order", label: "Order" },
  { id: "e4", from: "faq", to: "respond" },
  { id: "e5", from: "order", to: "respond" },
];

export const MOCK_AGENTS: Agent[] = [
  {
    id: "agent-1",
    name: "Sarah's Shop Assistant",
    description: "Handles customer questions about flowers, delivery, and orders",
    status: "active",
    use_case: "customer_support",
    created_at: "2026-03-20T10:00:00Z",
    conversations_today: 47,
    success_rate: 0.94,
    tools: ["email", "calendar", "stripe"],
    persona: "You are a friendly and knowledgeable flower shop assistant. You help customers with flower selection, delivery questions, and order tracking. Always be warm and suggest complementary items when appropriate.",
    tone: "friendly",
    response_length: "medium",
    nodes: defaultNodes,
    edges: defaultEdges,
  },
  {
    id: "agent-2",
    name: "Lead Qualifier",
    description: "Qualifies inbound leads and books consultations for wedding flowers",
    status: "active",
    use_case: "sales",
    created_at: "2026-03-22T14:00:00Z",
    conversations_today: 12,
    success_rate: 0.88,
    tools: ["email", "calendar"],
    persona: "You are a wedding flower consultant assistant. Qualify leads by asking about their date, venue, budget range, and flower preferences. Book consultations for qualified leads.",
    tone: "professional",
    response_length: "short",
    nodes: [
      { id: "trigger", type: "trigger", label: "New inquiry", x: 60, y: 40 },
      { id: "qualify", type: "llm", label: "Qualify lead", x: 60, y: 140 },
      { id: "check", type: "condition", label: "Budget > $500?", x: 60, y: 260 },
      { id: "book", type: "tool", label: "Book consultation", x: -60, y: 380 },
      { id: "nurture", type: "response", label: "Send brochure", x: 180, y: 380 },
    ],
    edges: [
      { id: "e1", from: "trigger", to: "qualify" },
      { id: "e2", from: "qualify", to: "check" },
      { id: "e3", from: "check", to: "book", label: "Yes" },
      { id: "e4", from: "check", to: "nurture", label: "No" },
    ],
  },
  {
    id: "agent-3",
    name: "Order Tracker",
    description: "Provides real-time order status and delivery updates",
    status: "draft",
    use_case: "customer_support",
    created_at: "2026-03-25T09:00:00Z",
    conversations_today: 0,
    success_rate: 0,
    tools: ["stripe"],
    persona: "You help customers track their flower orders. Look up orders by email or order number and provide delivery status updates.",
    tone: "professional",
    response_length: "short",
    nodes: [
      { id: "trigger", type: "trigger", label: "Customer asks about order", x: 60, y: 40 },
      { id: "lookup", type: "tool", label: "Look up order", x: 60, y: 160 },
      { id: "respond", type: "response", label: "Reply with status", x: 60, y: 280 },
    ],
    edges: [
      { id: "e1", from: "trigger", to: "lookup" },
      { id: "e2", from: "lookup", to: "respond" },
    ],
  },
];

export const MOCK_CONVERSATIONS: Conversation[] = [
  { id: "conv-1", agent_id: "agent-1", user_name: "Emma J.", started_at: "2026-03-28T09:12:00Z", messages: 8, status: "completed", preview: "Do you deliver to the West Side on Sundays?" },
  { id: "conv-2", agent_id: "agent-1", user_name: "Mike R.", started_at: "2026-03-28T09:45:00Z", messages: 5, status: "completed", preview: "I need a sympathy arrangement for tomorrow" },
  { id: "conv-3", agent_id: "agent-1", user_name: "Lisa T.", started_at: "2026-03-28T10:03:00Z", messages: 3, status: "active", preview: "What's in season right now?" },
  { id: "conv-4", agent_id: "agent-1", user_name: "Carlos M.", started_at: "2026-03-28T10:20:00Z", messages: 12, status: "escalated", preview: "My order arrived damaged and I want a refund" },
  { id: "conv-5", agent_id: "agent-2", user_name: "Rachel K.", started_at: "2026-03-28T08:30:00Z", messages: 6, status: "completed", preview: "We're getting married in June and need centerpieces" },
];

export const MOCK_EVAL_SCENARIOS: EvalScenario[] = [
  { id: "eval-1", name: "Delivery hours", input: "What are your delivery hours?", expected: "Mention weekday and weekend hours", agent_id: "agent-1" },
  { id: "eval-2", name: "Out of area", input: "Do you deliver to Springfield?", expected: "Politely decline and suggest alternatives", agent_id: "agent-1" },
  { id: "eval-3", name: "Price inquiry", input: "How much is a dozen red roses?", expected: "Provide price range and mention seasonal variation", agent_id: "agent-1" },
  { id: "eval-4", name: "Refund request", input: "My flowers arrived dead. I want my money back.", expected: "Apologize, offer replacement or refund, escalate if needed", agent_id: "agent-1" },
  { id: "eval-5", name: "Wedding lead", input: "I'm getting married in August, do you do wedding flowers?", expected: "Express enthusiasm, ask about date/venue/budget, offer consultation", agent_id: "agent-1" },
];

export const MOCK_EVAL_RUNS: EvalRun[] = [
  {
    id: "run-1",
    agent_id: "agent-1",
    ran_at: "2026-03-28T08:00:00Z",
    scenarios_total: 5,
    scenarios_passed: 4,
    results: [
      { scenario_id: "eval-1", scenario_name: "Delivery hours", input: "What are your delivery hours?", expected: "Mention weekday and weekend hours", actual: "We deliver Monday through Friday from 9am to 6pm, and Saturdays from 10am to 4pm. We're closed on Sundays. Would you like to schedule a delivery?", passed: true, latency_ms: 820 },
      { scenario_id: "eval-2", scenario_name: "Out of area", input: "Do you deliver to Springfield?", expected: "Politely decline and suggest alternatives", actual: "I'm sorry, Springfield is outside our delivery area. We currently deliver within a 15-mile radius of downtown. I'd recommend checking with Springfield Flowers on Main Street. Would you like their contact info?", passed: true, latency_ms: 950 },
      { scenario_id: "eval-3", scenario_name: "Price inquiry", input: "How much is a dozen red roses?", expected: "Provide price range and mention seasonal variation", actual: "A dozen long-stem red roses runs between $45–$65 depending on the season. Around Valentine's Day prices go up a bit. Right now they're at $49. Want me to add them to a cart?", passed: true, latency_ms: 780 },
      { scenario_id: "eval-4", scenario_name: "Refund request", input: "My flowers arrived dead. I want my money back.", expected: "Apologize, offer replacement or refund, escalate if needed", actual: "Sure, I can help with a refund. What's your order number?", passed: false, latency_ms: 650, reasoning: "Did not apologize or offer replacement first" },
      { scenario_id: "eval-5", scenario_name: "Wedding lead", input: "I'm getting married in August, do you do wedding flowers?", expected: "Express enthusiasm, ask about date/venue/budget, offer consultation", actual: "Congratulations on your upcoming wedding! We'd love to help make your day beautiful. Could you tell me more about your venue and what kind of arrangements you're envisioning? We offer free 30-minute consultations — would you like to book one?", passed: true, latency_ms: 1100 },
    ],
  },
];

export const MOCK_DAILY_METRICS: DailyMetric[] = [
  { date: "2026-03-22", conversations: 32, messages: 156, avg_response_ms: 890, success_rate: 0.91 },
  { date: "2026-03-23", conversations: 28, messages: 134, avg_response_ms: 920, success_rate: 0.89 },
  { date: "2026-03-24", conversations: 41, messages: 198, avg_response_ms: 850, success_rate: 0.93 },
  { date: "2026-03-25", conversations: 38, messages: 180, avg_response_ms: 870, success_rate: 0.92 },
  { date: "2026-03-26", conversations: 45, messages: 220, avg_response_ms: 810, success_rate: 0.95 },
  { date: "2026-03-27", conversations: 43, messages: 205, avg_response_ms: 840, success_rate: 0.94 },
  { date: "2026-03-28", conversations: 47, messages: 112, avg_response_ms: 830, success_rate: 0.94 },
];

export const INDUSTRIES = [
  "Retail / E-commerce",
  "Food & Beverage",
  "Health & Wellness",
  "Professional Services",
  "Real Estate",
  "Education",
  "Home Services",
  "Automotive",
  "Travel & Hospitality",
  "Other",
];

export const USE_CASES = [
  { id: "customer_support", label: "Customer Support", description: "Answer questions, resolve issues, handle FAQs" },
  { id: "sales", label: "Sales & Lead Qualification", description: "Qualify leads, book meetings, follow up on inquiries" },
  { id: "scheduling", label: "Scheduling & Bookings", description: "Handle appointments, reservations, and calendar management" },
  { id: "order_management", label: "Order Management", description: "Track orders, process returns, update delivery status" },
  { id: "onboarding", label: "Client Onboarding", description: "Guide new customers through setup and first steps" },
  { id: "custom", label: "Custom", description: "Build a custom agent from scratch" },
];

export const TOOLS = [
  { id: "email", label: "Email", icon: "Mail", description: "Send and read emails" },
  { id: "calendar", label: "Calendar", icon: "Calendar", description: "Manage appointments and schedules" },
  { id: "stripe", label: "Stripe", icon: "CreditCard", description: "Process payments and manage orders" },
  { id: "slack", label: "Slack", icon: "MessageSquare", description: "Send messages and notifications" },
  { id: "sheets", label: "Google Sheets", icon: "Table", description: "Read and write spreadsheet data" },
  { id: "crm", label: "CRM", icon: "Users", description: "Manage contacts and deals" },
  { id: "whatsapp", label: "WhatsApp", icon: "Phone", description: "Message customers on WhatsApp" },
  { id: "instagram", label: "Instagram", icon: "Camera", description: "Respond to DMs and comments" },
];
