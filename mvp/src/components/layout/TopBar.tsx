import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { CreditCard, Plus, Loader2 } from "lucide-react";
import { api } from "../../lib/api";

export function TopBar() {
  const navigate = useNavigate();
  const [balance, setBalance] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);

  const fetchBalance = useCallback(async () => {
    try {
      const data = await api.get<{ balance_usd: number }>("/credits/balance");
      setBalance(Number(data.balance_usd) || 0);
    } catch {
      setBalance(null);
    }
  }, []);

  useEffect(() => {
    fetchBalance();
  }, [fetchBalance]);

  const handleTopUp = async () => {
    setLoading(true);
    try {
      // Use the default/popular package — backend picks the $50 Growth package
      const { checkout_url } = await api.post<{ checkout_url: string }>("/credits/checkout", {
        package_id: "growth",
        success_url: `${window.location.origin}/settings?tab=billing&credit_purchase=success`,
        cancel_url: `${window.location.origin}/settings?tab=billing&credit_purchase=canceled`,
      });
      if (checkout_url) {
        window.location.href = checkout_url;
      } else {
        // Fallback: send to billing settings
        navigate("/settings?tab=billing");
      }
    } catch {
      navigate("/settings?tab=billing");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex items-center justify-end gap-3 px-6 md:px-10 py-2.5 border-b border-border bg-surface">
      {balance !== null && (
        <button
          onClick={() => navigate("/settings?tab=billing")}
          className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm hover:bg-surface-alt transition-colors"
          title="Credit balance — click to view billing"
        >
          <CreditCard size={14} className="text-text-muted" />
          <span className="font-semibold text-text">${balance.toFixed(2)}</span>
          <span className="text-xs text-text-muted hidden sm:inline">credits</span>
        </button>
      )}
      <button
        onClick={handleTopUp}
        disabled={loading}
        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-primary text-white hover:bg-primary-hover transition-colors disabled:opacity-50"
      >
        {loading ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />}
        Top up
      </button>
    </div>
  );
}
