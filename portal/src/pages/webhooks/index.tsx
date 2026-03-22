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
        <div className="card">
          <p className="font-semibold text-white mb-3">Create Webhook</p>
          <span className="text-xs text-gray-500 mb-1">URL</span>
          <input className="input-field" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://example.com/webhook" />
          <span className="text-xs text-gray-500 mt-3 mb-1">Events (comma-separated)</span>
          <input className="input-field" value={events} onChange={(event) => setEvents(event.target.value)} placeholder="run.completed,run.failed" />
          <button className="btn-primary mt-4" onClick={() => void createWebhook()}>
            Create
          </button>
          {actionMessage ? <span className="mt-3 text-emerald-600 break-all">{actionMessage}</span> : null}
          {actionError ? <span className="mt-3 text-red-600">{actionError}</span> : null}
        </div>

        <div className="card">
          <p className="font-semibold text-white mb-3">Delivery Attempts</p>
          {!selectedWebhook ? (
            <span className="text-gray-500">Select a webhook below to load deliveries.</span>
          ) : (
            <QueryState
              loading={deliveriesQuery.loading}
              error={deliveriesQuery.error}
              isEmpty={(deliveriesQuery.data?.deliveries ?? []).length === 0}
              emptyMessage="No deliveries found."
              onRetry={() => void deliveriesQuery.refetch()}
            >
              <table className="os-table">
                <thead>
                  <tr>
                    <th>Event</th>
                    <th>Status</th>
                    <th>Duration</th>
                  </tr>
                </thead>
                <tbody>
                  {(deliveriesQuery.data?.deliveries ?? []).map((delivery, index) => (
                    <tr key={`${delivery.id ?? index}`}>
                      <td><span className="text-gray-400">{delivery.event_type ?? "unknown"}</span></td>
                      <td><span className="text-gray-400">{delivery.response_status ?? 0}</span></td>
                      <td><span className="text-gray-400">{delivery.duration_ms?.toFixed(1) ?? "0.0"}ms</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </QueryState>
          )}
        </div>
      </div>

      <div className="card mt-6">
        <p className="font-semibold text-white mb-3">Configured Webhooks</p>
        <QueryState
          loading={webhooksQuery.loading}
          error={webhooksQuery.error}
          isEmpty={webhooks.length === 0}
          emptyMessage="No webhooks configured."
          onRetry={() => void webhooksQuery.refetch()}
        >
          <table className="os-table">
            <thead>
              <tr>
                <th>ID</th>
                <th>URL</th>
                <th>Events</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {webhooks.map((webhook) => (
                <tr key={webhook.webhook_id}>
                  <td><span className="font-mono text-xs text-gray-300">{webhook.webhook_id}</span></td>
                  <td><span className="text-gray-400">{webhook.url}</span></td>
                  <td>
                    <span className="text-xs">{webhook.events.join(", ")}</span>
                  </td>
                  <td>
                    <span className="badge">
                      {webhook.is_active ? "active" : "disabled"}
                    </span>
                  </td>
                  <td>
                    <div className="flex flex-wrap gap-2">
                      <button className="btn-primary text-xs" onClick={() => void testWebhook(webhook)}>Test</button>
                      <button className="btn-secondary text-xs" onClick={() => void updateWebhook(webhook)}>Edit</button>
                      <button className="btn-secondary text-xs" onClick={() => void toggleWebhook(webhook)}>
                        {webhook.is_active ? "Disable" : "Enable"}
                      </button>
                      <button className="btn-secondary text-xs" onClick={() => setSelectedWebhook(webhook.webhook_id)}>
                        Deliveries
                      </button>
                      <button className="btn-secondary text-xs" onClick={() => void rotateSecret(webhook)}>
                        Rotate Secret
                      </button>
                      <button className="btn-danger text-xs" onClick={() => void deleteWebhook(webhook)}>Delete</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </QueryState>
      </div>
    </div>
  );
};
