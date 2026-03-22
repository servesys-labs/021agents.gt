import { useCustom, useApiUrl } from "@refinedev/core";
import { Card, Metric, Text, Flex, ProgressBar, AreaChart, BarList, DonutChart, TabGroup, TabList, Tab, TabPanels, TabPanel, Grid } from "@tremor/react";

const API_URL = "/api/v1";
const authHeaders = () => {
  const token = localStorage.getItem("token");
  return token ? { Authorization: `Bearer ${token}` } : {};
};

export const DashboardPage = () => {
  // Fetch billing usage
  const { data: usage } = useCustom({
    url: `${API_URL}/billing/usage`,
    method: "get",
    config: { headers: authHeaders() },
  });

  // Fetch daily usage for chart
  const { data: daily } = useCustom({
    url: `${API_URL}/billing/usage/daily`,
    method: "get",
    config: { headers: authHeaders() },
  });

  // Fetch agents
  const { data: agents } = useCustom({
    url: `${API_URL}/agents`,
    method: "get",
    config: { headers: authHeaders() },
  });

  // Fetch session stats
  const { data: sessionStats } = useCustom({
    url: `${API_URL}/sessions/stats/summary`,
    method: "get",
    config: { headers: authHeaders() },
  });

  const usageData = usage?.data as any;
  const dailyData = daily?.data?.days || [];
  const agentsList = (agents?.data || []) as any[];
  const stats = sessionStats?.data as any;

  // Transform for charts
  const chartData = dailyData.map((d: any) => ({
    date: d.day,
    Cost: d.cost || 0,
    Sessions: d.call_count || 0,
  }));

  const modelCosts = Object.entries(usageData?.by_model || {}).map(([name, cost]) => ({
    name: name.split("/").pop() || name,
    value: Number(cost),
  }));

  const costByType = Object.entries(usageData?.by_cost_type || {}).map(([name, cost]) => ({
    name,
    value: Number(cost),
  }));

  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-900 mb-6">Dashboard</h1>

      {/* KPI Cards */}
      <Grid numItemsMd={2} numItemsLg={4} className="gap-4 mb-8">
        <Card>
          <Text>Total Cost</Text>
          <Metric>${(usageData?.total_cost_usd || 0).toFixed(4)}</Metric>
          <Flex className="mt-2">
            <Text className="text-xs text-gray-500">Last 30 days</Text>
          </Flex>
        </Card>

        <Card>
          <Text>Sessions</Text>
          <Metric>{stats?.total_sessions || 0}</Metric>
          <Flex className="mt-2">
            <Text className="text-xs text-gray-500">
              Avg {(stats?.avg_duration_seconds || 0).toFixed(1)}s
            </Text>
          </Flex>
        </Card>

        <Card>
          <Text>Agents</Text>
          <Metric>{agentsList.length}</Metric>
          <Flex className="mt-2">
            <Text className="text-xs text-gray-500">Active</Text>
          </Flex>
        </Card>

        <Card>
          <Text>Tokens</Text>
          <Metric>
            {((usageData?.total_input_tokens || 0) + (usageData?.total_output_tokens || 0)).toLocaleString()}
          </Metric>
          <Flex className="mt-2">
            <Text className="text-xs text-gray-500">
              {(usageData?.total_input_tokens || 0).toLocaleString()} in / {(usageData?.total_output_tokens || 0).toLocaleString()} out
            </Text>
          </Flex>
        </Card>
      </Grid>

      {/* Charts */}
      <TabGroup>
        <TabList>
          <Tab>Cost Over Time</Tab>
          <Tab>By Model</Tab>
          <Tab>By Type</Tab>
        </TabList>
        <TabPanels>
          <TabPanel>
            <Card className="mt-4">
              <Text>Daily Cost (USD)</Text>
              {chartData.length > 0 ? (
                <AreaChart
                  className="h-72 mt-4"
                  data={chartData}
                  index="date"
                  categories={["Cost"]}
                  colors={["blue"]}
                  valueFormatter={(v) => `$${v.toFixed(4)}`}
                />
              ) : (
                <Text className="mt-8 text-center text-gray-400">No usage data yet. Run some agents!</Text>
              )}
            </Card>
          </TabPanel>
          <TabPanel>
            <Card className="mt-4">
              <Text>Cost by Model</Text>
              {modelCosts.length > 0 ? (
                <BarList
                  data={modelCosts}
                  className="mt-4"
                  valueFormatter={(v) => `$${v.toFixed(4)}`}
                />
              ) : (
                <Text className="mt-8 text-center text-gray-400">No model data</Text>
              )}
            </Card>
          </TabPanel>
          <TabPanel>
            <Card className="mt-4">
              <Text>Cost by Type</Text>
              {costByType.length > 0 ? (
                <DonutChart
                  className="mt-4"
                  data={costByType}
                  category="value"
                  index="name"
                  valueFormatter={(v) => `$${v.toFixed(4)}`}
                />
              ) : (
                <Text className="mt-8 text-center text-gray-400">No cost data</Text>
              )}
            </Card>
          </TabPanel>
        </TabPanels>
      </TabGroup>
    </div>
  );
};
