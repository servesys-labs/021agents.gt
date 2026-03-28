import { useState } from "react";
import { Input } from "../components/ui/Input";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { Badge } from "../components/ui/Badge";
import { useToast } from "../components/ui/Toast";
import { useAuth } from "../lib/auth";

type Tab = "account" | "organization" | "billing";

export default function SettingsPage() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [tab, setTab] = useState<Tab>("account");

  // Account
  const [name, setName] = useState(user?.name || "Sarah Johnson");
  const [email, setEmail] = useState(user?.email || "sarah@sarahsflowers.com");

  // Organization
  const [orgName, setOrgName] = useState("Sarah's Flower Shop");
  const [industry, setIndustry] = useState("Retail / E-commerce");
  const [timezone, setTimezone] = useState("America/New_York");

  const tabs: { key: Tab; label: string }[] = [
    { key: "account", label: "Account" },
    { key: "organization", label: "Organization" },
    { key: "billing", label: "Billing" },
  ];

  return (
    <div>
      <h1 className="text-xl font-semibold text-text mb-1">Settings</h1>
      <p className="text-sm text-text-secondary mb-6">Manage your account and organization</p>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-border mb-6">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
              tab === t.key ? "border-primary text-primary" : "border-transparent text-text-secondary hover:text-text"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "account" && (
        <div className="space-y-4 max-w-lg">
          <Input label="Full name" value={name} onChange={(e) => setName(e.target.value)} />
          <Input label="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          <Card>
            <p className="text-sm font-medium text-text mb-1">Password</p>
            <p className="text-xs text-text-secondary mb-3">Change your account password</p>
            <Button size="sm" variant="secondary" onClick={() => toast("Password reset email sent")}>
              Change Password
            </Button>
          </Card>
          <div className="pt-2">
            <Button onClick={() => toast("Account settings saved")}>Save Changes</Button>
          </div>
        </div>
      )}

      {tab === "organization" && (
        <div className="space-y-4 max-w-lg">
          <Input label="Organization name" value={orgName} onChange={(e) => setOrgName(e.target.value)} />
          <Input label="Industry" value={industry} onChange={(e) => setIndustry(e.target.value)} />
          <Input label="Timezone" value={timezone} onChange={(e) => setTimezone(e.target.value)} />
          <Card>
            <p className="text-sm font-medium text-text mb-1">API Keys</p>
            <p className="text-xs text-text-secondary mb-3">Manage API keys for integrations</p>
            <div className="flex items-center gap-2">
              <code className="bg-surface-alt rounded px-3 py-1.5 text-xs text-text-secondary flex-1">sk-••••••••••••••••3f2a</code>
              <Button size="sm" variant="secondary" onClick={() => toast("API key copied")}>Copy</Button>
            </div>
          </Card>
          <div className="pt-2">
            <Button onClick={() => toast("Organization settings saved")}>Save Changes</Button>
          </div>
        </div>
      )}

      {tab === "billing" && (
        <div className="space-y-4 max-w-lg">
          <Card>
            <div className="flex items-center justify-between mb-3">
              <div>
                <p className="text-sm font-medium text-text">Current Plan</p>
                <p className="text-xs text-text-secondary mt-0.5">You're on the Starter plan</p>
              </div>
              <Badge variant="info">Starter</Badge>
            </div>
            <div className="grid grid-cols-3 gap-3 text-center text-xs">
              <div className="bg-surface-alt rounded-lg p-3">
                <p className="text-lg font-semibold text-text">3</p>
                <p className="text-text-muted">Agents</p>
              </div>
              <div className="bg-surface-alt rounded-lg p-3">
                <p className="text-lg font-semibold text-text">1,000</p>
                <p className="text-text-muted">Messages/mo</p>
              </div>
              <div className="bg-surface-alt rounded-lg p-3">
                <p className="text-lg font-semibold text-text">5</p>
                <p className="text-text-muted">Integrations</p>
              </div>
            </div>
          </Card>
          <Card>
            <p className="text-sm font-medium text-text mb-1">Upgrade</p>
            <p className="text-xs text-text-secondary mb-3">Get unlimited agents, 10K messages/mo, and priority support</p>
            <Button size="sm" onClick={() => toast("Upgrade flow coming soon!")}>Upgrade to Pro — $49/mo</Button>
          </Card>
          <Card>
            <p className="text-sm font-medium text-text mb-1">Payment Method</p>
            <p className="text-xs text-text-secondary">No payment method on file</p>
          </Card>
        </div>
      )}
    </div>
  );
}
