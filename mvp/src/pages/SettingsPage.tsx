import { useState, useEffect } from "react";
import { Input } from "../components/ui/Input";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { Badge } from "../components/ui/Badge";
import { TabNav } from "../components/ui/TabNav";
import { useToast } from "../components/ui/Toast";
import { useAuth } from "../lib/auth";
import { PRODUCT } from "../lib/product";

type Tab = "account" | "organization" | "billing";

export default function SettingsPage() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [tab, setTab] = useState<Tab>("account");

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");

  const [orgName, setOrgName] = useState("");
  const [industry, setIndustry] = useState("");
  const [timezone, setTimezone] = useState("");

  useEffect(() => {
    if (user?.name) setName(user.name);
    if (user?.email) setEmail(user.email);
  }, [user?.name, user?.email]);

  const tabs: { key: Tab; label: string }[] = [
    { key: "account", label: "Account" },
    { key: "organization", label: "Organization" },
    { key: "billing", label: "Billing" },
  ];

  return (
    <div className="max-w-2xl">
      <h1 className="text-2xl font-semibold text-text tracking-tight mb-1">Settings</h1>
      <p className="text-sm text-text-secondary mb-8">{PRODUCT.settingsSubtitle}</p>

      <TabNav tabs={tabs} active={tab} onChange={(k) => setTab(k as Tab)} />

      {tab === "account" && (
        <div className="space-y-4 mt-6">
          <Card className="p-5">
            <p className="text-sm font-medium text-text mb-4">Profile</p>
            <div className="space-y-4">
              <Input label="Full name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name" />
              <Input label="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@business.com" />
            </div>
          </Card>
          <Card className="p-5">
            <p className="text-sm font-medium text-text mb-1">Password</p>
            <p className="text-xs text-text-secondary mb-3">Change your account password</p>
            <Button size="sm" variant="secondary" onClick={() => toast("Password reset email sent")}>
              Change password
            </Button>
          </Card>
          <Button onClick={() => toast("Account settings saved")}>Save changes</Button>
        </div>
      )}

      {tab === "organization" && (
        <div className="space-y-4 mt-6">
          <Card className="p-5">
            <p className="text-sm font-medium text-text mb-4">Business</p>
            <div className="space-y-4">
              <Input label="Organization name" value={orgName} onChange={(e) => setOrgName(e.target.value)} placeholder="Your business name" />
              <Input label="Industry" value={industry} onChange={(e) => setIndustry(e.target.value)} placeholder="e.g. Retail, Services" />
              <Input label="Timezone" value={timezone} onChange={(e) => setTimezone(e.target.value)} placeholder="e.g. America/New_York" />
            </div>
          </Card>
          <Card className="p-5">
            <p className="text-sm font-medium text-text mb-1">API keys</p>
            <p className="text-xs text-text-secondary mb-3">Keys for integrations and automation appear here when enabled for your workspace.</p>
            <div className="flex items-center gap-2">
              <code className="bg-surface-alt rounded px-3 py-1.5 text-xs text-text-muted flex-1">Not configured</code>
              <Button size="sm" variant="secondary" disabled onClick={() => toast("No key to copy")}>
                Copy
              </Button>
            </div>
          </Card>
          <Button onClick={() => toast("Organization settings saved")}>Save changes</Button>
        </div>
      )}

      {tab === "billing" && (
        <div className="space-y-4 mt-6">
          <Card className="p-5">
            <div className="flex items-center justify-between mb-2">
              <div>
                <p className="text-sm font-medium text-text">Plan</p>
                <p className="text-xs text-text-secondary mt-0.5">Usage and invoices will show here when billing is connected to your workspace.</p>
              </div>
              <Badge variant="info">MVP</Badge>
            </div>
          </Card>
          <Card className="p-5">
            <p className="text-sm font-medium text-text mb-1">Payment method</p>
            <p className="text-xs text-text-secondary">No payment method on file.</p>
          </Card>
        </div>
      )}
    </div>
  );
}
