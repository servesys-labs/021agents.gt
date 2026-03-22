
import { PageHeader } from "../../components/common/PageHeader";
import { QueryState } from "../../components/common/QueryState";
import { toNumber, type DailyUsageResponse, type UsageResponse } from "../../lib/adapters";
import { useApiQuery } from "../../lib/api";

export const BillingPage = () => {
  const usageQuery = useApiQuery<UsageResponse>("/api/v1/billing/usage");
  const dailyQuery = useApiQuery<DailyUsageResponse>("/api/v1/billing/usage/daily");

  const usage = usageQuery.data;
  const chartData = (dailyQuery.data?.days ?? []).map((d) => ({
    date: d.day,
    Cost: toNumber(d.cost),
  }));

  const agentCosts = Object.entries(usage?.by_agent ?? {}).map(([name, cost]) => ({
    name,
    value: Number(cost),
  }));

  return (
    <div>
      <PageHeader title="Billing" subtitle="Spend analytics and cost breakdown" />
      <QueryState
        loading={usageQuery.loading || dailyQuery.loading}
        error={usageQuery.error ?? dailyQuery.error}
        isEmpty={!usage}
        onRetry={() => {
          void usageQuery.refetch();
          void dailyQuery.refetch();
        }}
      >
        <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
          <div className="card">
            <span className="text-gray-400">Total Spend</span>
            <p className="text-3xl font-bold text-white">${toNumber(usage?.total_cost_usd).toFixed(4)}</p>
          </div>
          <div className="card">
            <span className="text-gray-400">Inference</span>
            <p className="text-3xl font-bold text-white">${toNumber(usage?.inference_cost_usd).toFixed(4)}</p>
          </div>
          <div className="card">
            <span className="text-gray-400">Connectors</span>
            <p className="text-3xl font-bold text-white">${toNumber(usage?.connector_cost_usd).toFixed(4)}</p>
          </div>
          <div className="card">
            <span className="text-gray-400">GPU Compute</span>
            <p className="text-3xl font-bold text-white">${toNumber(usage?.gpu_compute_cost_usd).toFixed(4)}</p>
          </div>
        </div>

        <div className="grid md:grid-cols-2 gap-6">
          <div className="card">
            <p className="font-bold text-white">Daily Cost</p>
            {chartData.length > 0 ? (
              <p className="text-gray-500 text-center py-8">Chart visualization</p>
            ) : (
              <span className="mt-8 text-center text-gray-400">No usage data.</span>
            )}
          </div>

          <div className="card">
            <p className="font-bold text-white">Cost by Agent</p>
            {agentCosts.length > 0 ? (
              <p className="text-gray-500 text-center py-8">Bar chart</p>
            ) : (
              <span className="mt-8 text-center text-gray-400">No agent cost data.</span>
            )}
          </div>
        </div>
      </QueryState>
    </div>
  );
};
