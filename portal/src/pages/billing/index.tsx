import { useCustom } from "@refinedev/core";
import { Card, Text, Metric, Flex, Grid, BarList, AreaChart } from "@tremor/react";

const API_URL = "/api/v1";
const authHeaders = () => {
  const token = localStorage.getItem("token");
  return token ? { Authorization: `Bearer ${token}` } : {};
};

export const BillingPage = () => {
  const { data: usage } = useCustom({
    url: `${API_URL}/billing/usage`,
    method: "get",
    config: { headers: authHeaders() },
  });

  const { data: daily } = useCustom({
    url: `${API_URL}/billing/usage/daily`,
    method: "get",
    config: { headers: authHeaders() },
  });

  const u = usage?.data as any;
  const chartData = (daily?.data?.days || []).map((d: any) => ({
    date: d.day,
    Cost: d.cost || 0,
  }));

  const agentCosts = Object.entries(u?.by_agent || {}).map(([name, cost]) => ({
    name,
    value: Number(cost),
  }));

  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-900 mb-6">Billing</h1>

      <Grid numItemsMd={2} numItemsLg={4} className="gap-4 mb-8">
        <Card>
          <Text>Total Spend</Text>
          <Metric>${(u?.total_cost_usd || 0).toFixed(4)}</Metric>
        </Card>
        <Card>
          <Text>Inference</Text>
          <Metric>${(u?.inference_cost_usd || 0).toFixed(4)}</Metric>
        </Card>
        <Card>
          <Text>Connectors</Text>
          <Metric>${(u?.connector_cost_usd || 0).toFixed(4)}</Metric>
        </Card>
        <Card>
          <Text>GPU Compute</Text>
          <Metric>${(u?.gpu_compute_cost_usd || 0).toFixed(4)}</Metric>
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
              valueFormatter={(v) => `$${v.toFixed(4)}`}
            />
          ) : (
            <Text className="mt-8 text-center text-gray-400">No data</Text>
          )}
        </Card>

        <Card>
          <Text className="font-bold">Cost by Agent</Text>
          {agentCosts.length > 0 ? (
            <BarList
              data={agentCosts}
              className="mt-4"
              valueFormatter={(v) => `$${v.toFixed(4)}`}
            />
          ) : (
            <Text className="mt-8 text-center text-gray-400">No agent data</Text>
          )}
        </Card>
      </Grid>
    </div>
  );
};
