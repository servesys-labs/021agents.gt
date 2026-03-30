import { useState, useEffect } from "react";
import { Input } from "../components/ui/Input";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { Badge } from "../components/ui/Badge";
import { TabNav } from "../components/ui/TabNav";
import { useToast } from "../components/ui/Toast";
import { useAuth } from "../lib/auth";
import { api } from "../lib/api";
import { PRODUCT } from "../lib/product";
import { Loader2, CreditCard, Sparkles, ExternalLink } from "lucide-react";

type Tab = "account" | "organization" | "billing";

interface BillingInfo {
  credits_remaining_usd?: number;
  total_spent_usd?: number;
  total_sessions?: number;
  plan?: string;
}

interface CreditPackage {
  id: string;
  name: string;
  credits_usd: string;
  price_usd: string;
  bonus_pct: number;
}

export default function SettingsPage() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [tab, setTab] = useState<Tab>("account");
  const [saving, setSaving] = useState(false);

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");

  const [orgName, setOrgName] = useState("");
  const [industry, setIndustry] = useState("");
  const [timezone, setTimezone] = useState("");

  const [billing, setBilling] = useState<BillingInfo | null>(null);
  const [billingLoading, setBillingLoading] = useState(false);
  const [packages, setPackages] = useState<CreditPackage[]>([]);
  const [checkoutLoading, setCheckoutLoading] = useState<string | null>(null);

  useEffect(() => {
    if (user?.name) setName(user.name);
    if (user?.email) setEmail(user.email);
  }, [user?.name, user?.email]);

  // Pre-populate org settings from backend
  useEffect(() => {
    if (tab === "organization" && !orgName) {
      api.get<any>("/org/settings").then((data) => {
        if (data.business_name) setOrgName(data.business_name);
        if (data.industry) setIndustry(data.industry);
        if (data.timezone) setTimezone(data.timezone);
      }).catch(() => {});
    }
  }, [tab]);

  useEffect(() => {
    if (tab === "billing" && !billing) {
      setBillingLoading(true);
      Promise.all([
        api.get<any>("/credits/balance").catch(() => ({})),
        api.get<any>("/billing/usage").catch(() => ({})),
        api.get<any>("/credits/packages").catch(() => ({ packages: [] })),
      ]).then(([credits, usage, pkgs]) => {
        setBilling({
          credits_remaining_usd: credits.balance_usd ?? credits.credits_remaining_usd ?? 0,
          total_spent_usd: usage.total_cost_usd ?? usage.total_spent_usd ?? 0,
          total_sessions: usage.total_sessions ?? 0,
          plan: credits.plan || "free",
        });
        setPackages(pkgs.packages || []);
      }).finally(() => setBillingLoading(false));
    }
  }, [tab]);

  const handleBuyCredits = async (packageId: string) => {
    setCheckoutLoading(packageId);
    try {
      const { checkout_url } = await api.post<{ checkout_url: string; session_id: string }>("/credits/checkout", {
        package_id: packageId,
        success_url: `${window.location.origin}/settings?tab=billing&credit_purchase=success`,
        cancel_url: `${window.location.origin}/settings?tab=billing&credit_purchase=canceled`,
      });
      if (checkout_url) {
        window.location.href = checkout_url;
      } else {
        toast("Failed to create checkout session", "error");
      }
    } catch (err: any) {
      toast(err.message || "Checkout failed", "error");
    } finally {
      setCheckoutLoading(null);
    }
  };

  // Handle return from Stripe checkout
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("credit_purchase") === "success") {
      toast("Credits purchased successfully!");
      setTab("billing");
      setBilling(null); // Force refresh
      window.history.replaceState({}, "", "/settings?tab=billing");
    } else if (params.get("credit_purchase") === "canceled") {
      toast("Credit purchase canceled", "error");
      window.history.replaceState({}, "", "/settings?tab=billing");
    }
    if (params.get("tab") === "billing") setTab("billing");
  }, []);

  const saveAccount = async () => {
    setSaving(true);
    try {
      // POST /org/settings accepts arbitrary fields — use it for profile updates too
      await api.post("/org/settings", { owner_display_name: name, contact_email: email });
      toast("Account settings saved");
    } catch (err: any) {
      toast(err.message || "Failed to save account settings");
    } finally {
      setSaving(false);
    }
  };

  const saveOrg = async () => {
    setSaving(true);
    try {
      await api.post("/org/settings", { business_name: orgName, industry, timezone });
      toast("Organization settings saved");
    } catch (err: any) {
      toast(err.message || "Failed to save organization settings");
    } finally {
      setSaving(false);
    }
  };

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
            <Button size="sm" variant="secondary" onClick={() => {
              api.post("/auth/reset-password", { email }).then(() => toast("Password reset email sent")).catch(() => toast("Failed to send reset email"));
            }}>
              Change password
            </Button>
          </Card>
          <Button onClick={saveAccount} disabled={saving}>
            {saving ? <><Loader2 size={14} className="animate-spin" /> Saving...</> : "Save changes"}
          </Button>
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
          <Button onClick={saveOrg} disabled={saving}>
            {saving ? <><Loader2 size={14} className="animate-spin" /> Saving...</> : "Save changes"}
          </Button>
        </div>
      )}

      {tab === "billing" && (
        <div className="space-y-4 mt-6">
          {billingLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 size={20} className="animate-spin text-text-muted" />
            </div>
          ) : billing ? (
            <>
              <div className="grid grid-cols-3 gap-4">
                <Card className="p-5 text-center">
                  <p className="text-2xl font-bold text-text">${(billing.credits_remaining_usd || 0).toFixed(2)}</p>
                  <p className="text-xs text-text-secondary mt-1">Credits remaining</p>
                </Card>
                <Card className="p-5 text-center">
                  <p className="text-2xl font-bold text-text">${(billing.total_spent_usd || 0).toFixed(2)}</p>
                  <p className="text-xs text-text-secondary mt-1">Total spent</p>
                </Card>
                <Card className="p-5 text-center">
                  <p className="text-2xl font-bold text-text">{billing.total_sessions || 0}</p>
                  <p className="text-xs text-text-secondary mt-1">Total sessions</p>
                </Card>
              </div>
              <Card className="p-5">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium text-text">Plan</p>
                    <p className="text-xs text-text-secondary mt-0.5">Your current billing plan</p>
                  </div>
                  <Badge variant="info" className="capitalize">{billing.plan}</Badge>
                </div>
              </Card>

              {/* Credit Packages */}
              {packages.length > 0 && (
                <div>
                  <p className="text-sm font-medium text-text mb-3 flex items-center gap-2">
                    <CreditCard size={16} /> Buy Credits
                  </p>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    {packages.map((pkg) => (
                      <Card key={pkg.id} className="p-5 relative">
                        {pkg.bonus_pct > 0 && (
                          <Badge variant="success" className="absolute top-3 right-3">
                            <Sparkles size={10} className="mr-1" /> +{pkg.bonus_pct}% bonus
                          </Badge>
                        )}
                        <p className="text-sm font-semibold text-text">{pkg.name}</p>
                        <p className="text-2xl font-bold text-text mt-2">${pkg.credits_usd}</p>
                        <p className="text-xs text-text-secondary">in credits</p>
                        <p className="text-sm text-text-secondary mt-3">
                          Pay <span className="font-medium text-text">${pkg.price_usd}</span>
                        </p>
                        <Button
                          className="w-full mt-4"
                          size="sm"
                          onClick={() => handleBuyCredits(pkg.id)}
                          disabled={checkoutLoading !== null}
                        >
                          {checkoutLoading === pkg.id ? (
                            <><Loader2 size={14} className="animate-spin" /> Redirecting...</>
                          ) : (
                            <><ExternalLink size={14} /> Buy now</>
                          )}
                        </Button>
                      </Card>
                    ))}
                  </div>
                </div>
              )}
            </>
          ) : (
            <Card className="p-5">
              <p className="text-sm text-text-secondary">Unable to load billing information.</p>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}
