import { AreaChart, BarList, Card, DonutChart, Flex, Grid, Metric, Tab, TabGroup, TabList, TabPanel, TabPanels, Text } from "@tremor/react";

import { PageHeader } from "../../components/common/PageHeader";
import { QueryState } from "../../components/common/QueryState";
import { safeArray, summarizeCoverage, toNumber } from "../../lib/adapters";
import type { AgentInfo, DailyUsageResponse, SessionSummaryResponse, UsageResponse } from "../../lib/adapters";
import { useApiQuery } from "../../lib/api";

export const DashboardPage = () => {
  const usageQuery = useApiQuery<UsageResponse>("/api/v1/billing/usage");
  const dailyQuery = useApiQuery<DailyUsageResponse>("/api/v1/billing/usage/daily");
  const agentsQuery = useApiQuery<AgentInfo[]>("/api/v1/agents");
  const sessionsQuery = useApiQuery<SessionSummaryResponse>("/api/v1/sessions/stats/summary");
  const openApiQuery = useApiQuery<{ paths?: Record<string, unknown> }>("/openapi.json");

  const usageData = usageQuery.data;
  const dailyData = safeArray<{ day: string; cost?: number; call_count?: number }>(dailyQuery.data?.days);
  const agentsList = safeArray<AgentInfo>(agentsQuery.data);
  const stats = sessionsQuery.data;
  const openApiPaths = openApiQuery.data?.paths ? Object.keys(openApiQuery.data.paths) : [];
  const coverage = summarizeCoverage(openApiPaths);

  const chartData = dailyData.map((d) => ({
    date: d.day,
    Cost: toNumber(d.cost),
    Sessions: toNumber(d.call_count),
  }));

  const modelCosts = Object.entries(usageData?.by_model ?? {}).map(([name, cost]) => ({
    name: name.split("/").pop() || name,
    value: Number(cost),
  }));

  const costByType = Object.entries(usageData?.by_cost_type ?? {}).map(([name, cost]) => ({
    name,
    value: Number(cost),
  }));

  const isLoading = usageQuery.loading || dailyQuery.loading || agentsQuery.loading || sessionsQuery.loading;
  const error = usageQuery.error ?? dailyQuery.error ?? agentsQuery.error ?? sessionsQuery.error;

  return (
    <div>
      <PageHeader
        title="Dashboard"
        subtitle="Control-plane overview for runs, cost, and endpoint surface"
      />

      <QueryState
        loading={isLoading}
        error={error}
        isEmpty={!usageData}
        emptyMessage="No dashboard data yet."
        onRetry={() => {
          void usageQuery.refetch();
          void dailyQuery.refetch();
          void agentsQuery.refetch();
          void sessionsQuery.refetch();
        }}
      >
        <Grid numItemsMd={2} numItemsLg={4} className="gap-4 mb-8">
          <Card>
            <Text>Total Cost</Text>
            <Metric>${toNumber(usageData?.total_cost_usd).toFixed(4)}</Metric>
            <Flex className="mt-2">
              <Text className="text-xs text-gray-500">Last 30 days</Text>
            </Flex>
          </Card>

          <Card>
            <Text>Sessions</Text>
            <Metric>{toNumber(stats?.total_sessions)}</Metric>
            <Flex className="mt-2">
              <Text className="text-xs text-gray-500">Avg {toNumber(stats?.avg_duration_seconds).toFixed(1)}s</Text>
            </Flex>
          </Card>

          <Card>
            <Text>Agents</Text>
            <Metric>{agentsList.length}</Metric>
            <Flex className="mt-2">
              <Text className="text-xs text-gray-500">Configured agents</Text>
            </Flex>
          </Card>

          <Card>
            <Text>Endpoint Coverage</Text>
            <Metric>{coverage.total}</Metric>
            <Flex className="mt-2">
              <Text className="text-xs text-gray-500">{coverage.v1} v1 + {coverage.legacy} legacy</Text>
            </Flex>
          </Card>
        </Grid>

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
                    valueFormatter={(v: number) => `$${v.toFixed(4)}`}
                  />
                ) : (
                  <Text className="mt-8 text-center text-gray-400">No usage data yet. Run some agents.</Text>
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
                    valueFormatter={(v: number) => `$${v.toFixed(4)}`}
                  />
                ) : (
                  <Text className="mt-8 text-center text-gray-400">No model data.</Text>
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
                    valueFormatter={(v: number) => `$${v.toFixed(4)}`}
                  />
                ) : (
                  <Text className="mt-8 text-center text-gray-400">No cost data.</Text>
                )}
              </Card>
            </TabPanel>
          </TabPanels>
        </TabGroup>
      </QueryState>
    </div>
  );
};
