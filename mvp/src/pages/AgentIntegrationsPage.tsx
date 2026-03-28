import { useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { Check, ExternalLink, ShoppingBag, CreditCard, Package, Search, RefreshCw, X, AlertCircle } from "lucide-react";
import { Button } from "../components/ui/Button";
import { AgentNav } from "../components/AgentNav";
import { AgentNotFound } from "../components/AgentNotFound";
import { Card } from "../components/ui/Card";
import { Badge } from "../components/ui/Badge";
import { Input } from "../components/ui/Input";
import { Modal } from "../components/ui/Modal";
import { useToast } from "../components/ui/Toast";
import { MOCK_AGENTS } from "../lib/mock-data";

interface Integration {
  id: string;
  name: string;
  icon: string;
  description: string;
  category: "ecommerce" | "payments" | "crm" | "messaging" | "productivity";
  connected: boolean;
  store_url?: string;
  capabilities: string[];
  color: string;
}

interface Order {
  id: string;
  number: string;
  customer: string;
  email: string;
  total: string;
  status: "fulfilled" | "unfulfilled" | "partially_fulfilled" | "cancelled";
  items: number;
  created_at: string;
}

const INTEGRATIONS: Integration[] = [
  {
    id: "shopify", name: "Shopify", icon: "🛍️", description: "Look up orders, products, inventory, and process returns",
    category: "ecommerce", connected: true, store_url: "sarahs-flowers.myshopify.com", color: "bg-green-50 border-green-200",
    capabilities: ["Order lookup by email or #", "Product search & pricing", "Inventory check", "Process returns/exchanges", "Track shipments"],
  },
  {
    id: "square", name: "Square", icon: "◻️", description: "POS transactions, appointments, customer directory",
    category: "ecommerce", connected: false, color: "bg-gray-50 border-gray-200",
    capabilities: ["Transaction lookup", "Appointment booking", "Customer directory", "Loyalty points"],
  },
  {
    id: "stripe", name: "Stripe", icon: "💳", description: "Payment processing, invoices, subscription management",
    category: "payments", connected: true, color: "bg-purple-50 border-purple-200",
    capabilities: ["Payment status", "Send invoices", "Refund processing", "Subscription management"],
  },
  {
    id: "hubspot", name: "HubSpot", icon: "🔶", description: "Contact management, deal tracking, email sequences",
    category: "crm", connected: false, color: "bg-orange-50 border-orange-200",
    capabilities: ["Create/update contacts", "Track deals", "Log interactions", "Email sequences"],
  },
  {
    id: "mailchimp", name: "Mailchimp", icon: "📧", description: "Email campaigns, audience management, automations",
    category: "messaging", connected: false, color: "bg-yellow-50 border-yellow-200",
    capabilities: ["Add to lists", "Trigger automations", "Campaign stats", "Audience segments"],
  },
  {
    id: "google_sheets", name: "Google Sheets", icon: "📊", description: "Read/write data, log conversations, sync records",
    category: "productivity", connected: true, color: "bg-green-50 border-green-200",
    capabilities: ["Read spreadsheet data", "Append rows", "Update cells", "Create new sheets"],
  },
  {
    id: "quickbooks", name: "QuickBooks", icon: "📒", description: "Invoicing, expense tracking, financial reports",
    category: "payments", connected: false, color: "bg-emerald-50 border-emerald-200",
    capabilities: ["Create invoices", "Track expenses", "Customer balances", "Payment reminders"],
  },
  {
    id: "calendly", name: "Calendly", icon: "📅", description: "Scheduling, availability, booking management",
    category: "productivity", connected: false, color: "bg-blue-50 border-blue-200",
    capabilities: ["Book appointments", "Check availability", "Reschedule/cancel", "Send reminders"],
  },
];

const MOCK_ORDERS: Order[] = [
  { id: "ord-1", number: "#1047", customer: "Emma Johnson", email: "emma@email.com", total: "$89.00", status: "fulfilled", items: 2, created_at: "2026-03-27T14:30:00Z" },
  { id: "ord-2", number: "#1048", customer: "Mike Rodriguez", email: "mike@email.com", total: "$145.00", status: "unfulfilled", items: 3, created_at: "2026-03-28T09:15:00Z" },
  { id: "ord-3", number: "#1049", customer: "Lisa Thompson", email: "lisa@email.com", total: "$52.00", status: "fulfilled", items: 1, created_at: "2026-03-28T10:00:00Z" },
  { id: "ord-4", number: "#1050", customer: "Carlos Martinez", email: "carlos@email.com", total: "$210.00", status: "partially_fulfilled", items: 4, created_at: "2026-03-28T10:45:00Z" },
];

const orderStatusVariant = {
  fulfilled: "success" as const,
  unfulfilled: "warning" as const,
  partially_fulfilled: "info" as const,
  cancelled: "danger" as const,
};

export default function AgentIntegrationsPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { toast } = useToast();
  const agent = MOCK_AGENTS.find((a) => a.id === id);

  const [integrations, setIntegrations] = useState(INTEGRATIONS);
  const [connectingId, setConnectingId] = useState<string | null>(null);
  const [selectedIntegration, setSelectedIntegration] = useState<Integration | null>(null);
  const [showOrders, setShowOrders] = useState(false);
  const [orderSearch, setOrderSearch] = useState("");
  const [connectUrl, setConnectUrl] = useState("");
  const [filter, setFilter] = useState<"all" | "connected">("all");

  const filtered = integrations.filter((i) =>
    filter === "all" ? true : i.connected,
  );

  const connected = integrations.filter((i) => i.connected);

  const handleConnect = (intId: string) => {
    setConnectingId(intId);
    setConnectUrl("");
  };

  const confirmConnect = () => {
    if (!connectingId) return;
    setIntegrations((prev) =>
      prev.map((i) => (i.id === connectingId ? { ...i, connected: true, store_url: connectUrl || undefined } : i)),
    );
    setConnectingId(null);
    toast("Integration connected!");
  };

  const disconnect = (intId: string) => {
    setIntegrations((prev) =>
      prev.map((i) => (i.id === intId ? { ...i, connected: false, store_url: undefined } : i)),
    );
    setSelectedIntegration(null);
    toast("Integration disconnected");
  };

  const filteredOrders = MOCK_ORDERS.filter(
    (o) =>
      o.number.toLowerCase().includes(orderSearch.toLowerCase()) ||
      o.customer.toLowerCase().includes(orderSearch.toLowerCase()) ||
      o.email.toLowerCase().includes(orderSearch.toLowerCase()),
  );

  if (!agent) return <AgentNotFound />;

  const connectingIntegration = integrations.find((i) => i.id === connectingId);

  return (
    <div>
      <AgentNav agentName={agent.name}>
        {connected.some((c) => c.id === "shopify") && (
          <Button size="sm" variant="secondary" onClick={() => setShowOrders(true)}>
            <ShoppingBag size={14} /> Orders
          </Button>
        )}
      </AgentNav>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-4 mb-6">
        <Card>
          <p className="text-xs text-text-secondary">Connected</p>
          <p className="text-xl font-semibold text-text">{connected.length}</p>
        </Card>
        <Card>
          <p className="text-xs text-text-secondary">Available</p>
          <p className="text-xl font-semibold text-text">{integrations.length}</p>
        </Card>
        <Card>
          <p className="text-xs text-text-secondary">Capabilities</p>
          <p className="text-xl font-semibold text-text">
            {connected.reduce((s, c) => s + c.capabilities.length, 0)}
          </p>
        </Card>
      </div>

      {/* Filter */}
      <div className="flex gap-2 mb-4">
        <button
          onClick={() => setFilter("all")}
          className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
            filter === "all" ? "bg-primary text-white" : "text-text-secondary hover:bg-surface-alt"
          }`}
        >
          All
        </button>
        <button
          onClick={() => setFilter("connected")}
          className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
            filter === "connected" ? "bg-primary text-white" : "text-text-secondary hover:bg-surface-alt"
          }`}
        >
          Connected ({connected.length})
        </button>
      </div>

      {/* Integration grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {filtered.map((integration) => (
          <Card key={integration.id} hover onClick={() => integration.connected ? setSelectedIntegration(integration) : handleConnect(integration.id)}>
            <div className="flex items-start gap-3">
              <div className={`w-10 h-10 rounded-lg flex items-center justify-center text-lg border ${integration.color}`}>
                {integration.icon}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <h3 className="text-sm font-semibold text-text">{integration.name}</h3>
                  {integration.connected && <Badge variant="success"><Check size={10} className="mr-0.5" /> Connected</Badge>}
                </div>
                <p className="text-xs text-text-secondary mt-0.5">{integration.description}</p>
                {integration.store_url && (
                  <p className="text-xs text-text-muted mt-1 font-mono">{integration.store_url}</p>
                )}
              </div>
              {!integration.connected && (
                <Button size="sm" variant="secondary" onClick={(e) => { e.stopPropagation(); handleConnect(integration.id); }}>
                  Connect
                </Button>
              )}
            </div>
            {integration.connected && (
              <div className="mt-3 flex flex-wrap gap-1.5">
                {integration.capabilities.map((cap) => (
                  <span key={cap} className="px-2 py-0.5 bg-surface-alt rounded text-xs text-text-secondary">
                    {cap}
                  </span>
                ))}
              </div>
            )}
          </Card>
        ))}
      </div>

      {/* Connect modal */}
      <Modal open={!!connectingId} onClose={() => setConnectingId(null)} title={`Connect ${connectingIntegration?.name || ""}`}>
        {connectingIntegration && (
          <div className="space-y-4">
            <div className="flex items-center gap-3">
              <div className={`w-12 h-12 rounded-lg flex items-center justify-center text-xl border ${connectingIntegration.color}`}>
                {connectingIntegration.icon}
              </div>
              <div>
                <p className="font-medium text-text">{connectingIntegration.name}</p>
                <p className="text-xs text-text-secondary">{connectingIntegration.description}</p>
              </div>
            </div>

            {connectingIntegration.id === "shopify" && (
              <Input
                label="Shopify store URL"
                placeholder="your-store.myshopify.com"
                value={connectUrl}
                onChange={(e) => setConnectUrl(e.target.value)}
              />
            )}
            {connectingIntegration.id === "square" && (
              <Input
                label="Square Application ID"
                placeholder="sq0idp-..."
                value={connectUrl}
                onChange={(e) => setConnectUrl(e.target.value)}
              />
            )}
            {!["shopify", "square"].includes(connectingIntegration.id) && (
              <p className="text-sm text-text-secondary">
                You'll be redirected to {connectingIntegration.name} to authorize access.
              </p>
            )}

            <div>
              <p className="text-xs font-medium text-text-secondary mb-2">Your agent will be able to:</p>
              <ul className="space-y-1">
                {connectingIntegration.capabilities.map((cap) => (
                  <li key={cap} className="flex items-center gap-2 text-xs text-text">
                    <Check size={12} className="text-success shrink-0" />
                    {cap}
                  </li>
                ))}
              </ul>
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <Button variant="ghost" onClick={() => setConnectingId(null)}>Cancel</Button>
              <Button onClick={confirmConnect}>
                <ExternalLink size={14} /> Connect {connectingIntegration.name}
              </Button>
            </div>
          </div>
        )}
      </Modal>

      {/* Integration detail modal */}
      <Modal open={!!selectedIntegration} onClose={() => setSelectedIntegration(null)} title={selectedIntegration?.name || ""} wide>
        {selectedIntegration && (
          <div className="space-y-4">
            <div className="flex items-center gap-3">
              <div className={`w-12 h-12 rounded-lg flex items-center justify-center text-xl border ${selectedIntegration.color}`}>
                {selectedIntegration.icon}
              </div>
              <div className="flex-1">
                <p className="font-medium text-text">{selectedIntegration.name}</p>
                {selectedIntegration.store_url && (
                  <p className="text-xs text-text-muted font-mono">{selectedIntegration.store_url}</p>
                )}
              </div>
              <Badge variant="success">Connected</Badge>
            </div>

            <div>
              <p className="text-xs font-medium text-text-secondary mb-2">Active capabilities</p>
              <div className="grid grid-cols-2 gap-2">
                {selectedIntegration.capabilities.map((cap) => (
                  <div key={cap} className="flex items-center gap-2 text-sm text-text bg-surface-alt rounded-lg px-3 py-2">
                    <Check size={14} className="text-success shrink-0" />
                    {cap}
                  </div>
                ))}
              </div>
            </div>

            <div className="flex items-center gap-2 px-3 py-2 bg-blue-50 text-blue-700 text-xs rounded-lg">
              <AlertCircle size={14} />
              Your agent automatically uses this integration when customers ask relevant questions.
            </div>

            <div className="flex justify-between pt-2">
              <Button variant="danger" size="sm" onClick={() => disconnect(selectedIntegration.id)}>
                Disconnect
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setSelectedIntegration(null)}>Close</Button>
            </div>
          </div>
        )}
      </Modal>

      {/* Orders modal (Shopify) */}
      <Modal open={showOrders} onClose={() => setShowOrders(false)} title="Shopify Orders" wide>
        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
              <input
                placeholder="Search by order #, name, or email..."
                value={orderSearch}
                onChange={(e) => setOrderSearch(e.target.value)}
                className="w-full pl-9 pr-3 py-2 rounded-lg border border-border text-sm bg-white placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent"
              />
            </div>
            <Button size="sm" variant="ghost"><RefreshCw size={14} /></Button>
          </div>

          <div className="divide-y divide-border rounded-lg border border-border">
            {filteredOrders.map((order) => (
              <div key={order.id} className="flex items-center gap-4 p-3 hover:bg-surface-alt">
                <div className="w-8 h-8 rounded-lg bg-gray-50 flex items-center justify-center">
                  <Package size={16} className="text-text-secondary" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-text">{order.number}</span>
                    <span className="text-xs text-text-secondary">· {order.customer}</span>
                  </div>
                  <p className="text-xs text-text-muted">{order.email} · {order.items} item{order.items > 1 ? "s" : ""}</p>
                </div>
                <span className="text-sm font-medium text-text">{order.total}</span>
                <Badge variant={orderStatusVariant[order.status]}>
                  {order.status.replace("_", " ")}
                </Badge>
              </div>
            ))}
          </div>

          <p className="text-xs text-text-muted text-center">
            Your agent can look up these orders when customers ask about their order status.
          </p>
        </div>
      </Modal>
    </div>
  );
}
