import { AreaChart, BarList, Card, Grid, Metric, Text } from "@tremor/react";

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
        <Grid numItemsMd={2} numItemsLg={4} className="gap-4 mb-8">
          <Card>
            <Text>Total Spend</Text>
            <Metric>${toNumber(usage?.total_cost_usd).toFixed(4)}</Metric>
          </Card>
          <Card>
            <Text>Inference</Text>
            <Metric>${toNumber(usage?.inference_cost_usd).toFixed(4)}</Metric>
          </Card>
          <Card>
            <Text>Connectors</Text>
            <Metric>${toNumber(usage?.connector_cost_usd).toFixed(4)}</Metric>
          </Card>
          <Card>
            <Text>GPU Compute</Text>
            <Metric>${toNumber(usage?.gpu_compute_cost_usd).toFixed(4)}</Metric>
          </Card>
        </Grid>

        <Grid numItemsMd={2} className="gap-6">
          <Card>
            <Text className="font-bold">Daily Cost</Text>
            {chartData.length > 0 ? (
              <AreaChart
                className="h-48 mt-4"
                data={chartData}
                index="date"
                categories={["Cost"]}
                colors={["emerald"]}
                valueFormatter={(v: number) => `$${v.toFixed(4)}`}
              />
            ) : (
              <Text className="mt-8 text-center text-gray-400">No usage data.</Text>
            )}
          </Card>

          <Card>
            <Text className="font-bold">Cost by Agent</Text>
            {agentCosts.length > 0 ? (
              <BarList
                data={agentCosts}
                className="mt-4"
                valueFormatter={(v: number) => `$${v.toFixed(4)}`}
              />
            ) : (
              <Text className="mt-8 text-center text-gray-400">No agent cost data.</Text>
            )}
          </Card>
        </Grid>
      </QueryState>
    </div>
  );
};
