import { Badge, Button, Card, Table, TableBody, TableCell, TableHead, TableHeaderCell, TableRow, Text, TextInput } from "@tremor/react";
import { useMemo, useState } from "react";

import { PageHeader } from "../../components/common/PageHeader";
import { QueryState } from "../../components/common/QueryState";
import { apiRequest, useApiQuery } from "../../lib/api";

type Webhook = {
  webhook_id: string;
  url: string;
  events: string[];
  is_active: boolean;
  failure_count: number;
  last_triggered_at?: number | null;
};

type Delivery = {
  id?: number;
  event_type?: string;
  response_status?: number;
  success?: number;
  duration_ms?: number;
  created_at?: number;
};

export const WebhooksPage = () => {
  const webhooksQuery = useApiQuery<Webhook[]>("/api/v1/webhooks");
  const webhooks = useMemo(() => webhooksQuery.data ?? [], [webhooksQuery.data]);

  const [url, setUrl] = useState("");
  const [events, setEvents] = useState("*");
  const [selectedWebhook, setSelectedWebhook] = useState<string>("");
  const deliveriesQuery = useApiQuery<{ deliveries: Delivery[] }>(
    `/api/v1/webhooks/${encodeURIComponent(selectedWebhook)}/deliveries?limit=50`,
    Boolean(selectedWebhook),
  );
  const [actionMessage, setActionMessage] = useState("");
  const [actionError, setActionError] = useState("");

  const refresh = async () => {
    await webhooksQuery.refetch();
    if (selectedWebhook) {
      await deliveriesQuery.refetch();
    }
  };

  const createWebhook = async () => {
    if (!url.trim()) {
      setActionError("Webhook URL is required.");
      return;
    }
    setActionError("");
    try {
      await apiRequest("/api/v1/webhooks", "POST", {
        url,
        events: events.split(",").map((e) => e.trim()).filter(Boolean),
      });
      setUrl("");
      setEvents("*");
      await refresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to create webhook");
    }
  };

  const testWebhook = async (webhook: Webhook) => {
    try {
      const result = await apiRequest<{ success: boolean; status?: number; duration_ms?: number }>(
        `/api/v1/webhooks/${encodeURIComponent(webhook.webhook_id)}/test`,
        "POST",
      );
      setActionMessage(`Test ${result.success ? "succeeded" : "failed"} (status ${result.status ?? 0}, ${result.duration_ms ?? 0}ms)`);
      await refresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to test webhook");
    }
  };

  const updateWebhook = async (webhook: Webhook) => {
    const nextUrl = window.prompt("Webhook URL", webhook.url);
    const nextEvents = window.prompt("Comma-separated events", webhook.events.join(","));
    if (nextUrl === null && nextEvents === null) {
      return;
    }
    const params = new URLSearchParams();
    if (nextUrl && nextUrl !== webhook.url) {
      params.set("url", nextUrl);
    }
    if (nextEvents !== null) {
      const normalized = nextEvents.split(",").map((e) => e.trim()).filter(Boolean);
      for (const event of normalized) {
        params.append("events", event);
      }
    }
    if (!params.toString()) {
      return;
    }
    try {
      await apiRequest(`/api/v1/webhooks/${encodeURIComponent(webhook.webhook_id)}?${params.toString()}`, "PUT");
      await refresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to update webhook");
    }
  };

  const toggleWebhook = async (webhook: Webhook) => {
    const params = new URLSearchParams();
    params.set("is_active", String(!webhook.is_active));
    try {
      await apiRequest(`/api/v1/webhooks/${encodeURIComponent(webhook.webhook_id)}?${params.toString()}`, "PUT");
      await refresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to toggle webhook");
    }
  };

  const rotateSecret = async (webhook: Webhook) => {
    try {
      const result = await apiRequest<{ secret: string }>(
        `/api/v1/webhooks/${encodeURIComponent(webhook.webhook_id)}/rotate-secret`,
        "POST",
      );
      setActionMessage(`Secret rotated for ${webhook.webhook_id}: ${result.secret}`);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to rotate secret");
    }
  };

  const deleteWebhook = async (webhook: Webhook) => {
    if (!window.confirm(`Delete webhook ${webhook.webhook_id}?`)) {
      return;
    }
    try {
      await apiRequest(`/api/v1/webhooks/${encodeURIComponent(webhook.webhook_id)}`, "DELETE");
      if (selectedWebhook === webhook.webhook_id) {
        setSelectedWebhook("");
      }
      await refresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to delete webhook");
    }
  };

  return (
    <div>
      <PageHeader title="Webhooks" subtitle="Create, test, update, and manage webhook endpoints" />

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <Text className="font-semibold mb-3">Create Webhook</Text>
          <Text className="text-xs text-gray-500 mb-1">URL</Text>
          <TextInput value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://example.com/webhook" />
          <Text className="text-xs text-gray-500 mt-3 mb-1">Events (comma-separated)</Text>
          <TextInput value={events} onChange={(event) => setEvents(event.target.value)} placeholder="run.completed,run.failed" />
          <Button className="mt-4" onClick={() => void createWebhook()}>
            Create
          </Button>
          {actionMessage ? <Text className="mt-3 text-emerald-600 break-all">{actionMessage}</Text> : null}
          {actionError ? <Text className="mt-3 text-red-600">{actionError}</Text> : null}
        </Card>

        <Card>
          <Text className="font-semibold mb-3">Delivery Attempts</Text>
          {!selectedWebhook ? (
            <Text className="text-gray-500">Select a webhook below to load deliveries.</Text>
          ) : (
            <QueryState
              loading={deliveriesQuery.loading}
              error={deliveriesQuery.error}
              isEmpty={(deliveriesQuery.data?.deliveries ?? []).length === 0}
              emptyMessage="No deliveries found."
              onRetry={() => void deliveriesQuery.refetch()}
            >
              <Table>
                <TableHead>
                  <TableRow>
                    <TableHeaderCell>Event</TableHeaderCell>
                    <TableHeaderCell>Status</TableHeaderCell>
                    <TableHeaderCell>Duration</TableHeaderCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {(deliveriesQuery.data?.deliveries ?? []).map((delivery, index) => (
                    <TableRow key={`${delivery.id ?? index}`}>
                      <TableCell><Text>{delivery.event_type ?? "unknown"}</Text></TableCell>
                      <TableCell><Text>{delivery.response_status ?? 0}</Text></TableCell>
                      <TableCell><Text>{delivery.duration_ms?.toFixed(1) ?? "0.0"}ms</Text></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </QueryState>
          )}
        </Card>
      </div>

      <Card className="mt-6">
        <Text className="font-semibold mb-3">Configured Webhooks</Text>
        <QueryState
          loading={webhooksQuery.loading}
          error={webhooksQuery.error}
          isEmpty={webhooks.length === 0}
          emptyMessage="No webhooks configured."
          onRetry={() => void webhooksQuery.refetch()}
        >
          <Table>
            <TableHead>
              <TableRow>
                <TableHeaderCell>ID</TableHeaderCell>
                <TableHeaderCell>URL</TableHeaderCell>
                <TableHeaderCell>Events</TableHeaderCell>
                <TableHeaderCell>Status</TableHeaderCell>
                <TableHeaderCell>Actions</TableHeaderCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {webhooks.map((webhook) => (
                <TableRow key={webhook.webhook_id}>
                  <TableCell><Text className="font-mono text-xs">{webhook.webhook_id}</Text></TableCell>
                  <TableCell><Text>{webhook.url}</Text></TableCell>
                  <TableCell>
                    <Text className="text-xs">{webhook.events.join(", ")}</Text>
                  </TableCell>
                  <TableCell>
                    <Badge color={webhook.is_active ? "green" : "gray"}>
                      {webhook.is_active ? "active" : "disabled"}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-2">
                      <Button size="xs" onClick={() => void testWebhook(webhook)}>Test</Button>
                      <Button size="xs" variant="secondary" onClick={() => void updateWebhook(webhook)}>Edit</Button>
                      <Button size="xs" variant="secondary" onClick={() => void toggleWebhook(webhook)}>
                        {webhook.is_active ? "Disable" : "Enable"}
                      </Button>
                      <Button size="xs" variant="secondary" onClick={() => setSelectedWebhook(webhook.webhook_id)}>
                        Deliveries
                      </Button>
                      <Button size="xs" variant="secondary" onClick={() => void rotateSecret(webhook)}>
                        Rotate Secret
                      </Button>
                      <Button size="xs" color="red" onClick={() => void deleteWebhook(webhook)}>Delete</Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </QueryState>
      </Card>
    </div>
  );
};
