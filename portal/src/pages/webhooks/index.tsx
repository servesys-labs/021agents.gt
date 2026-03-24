import { useMemo, useState } from "react";
import {
  Plus,
  Webhook,
  Send,
  Trash2,
  Pencil,
  Eye,
  Search,
  ToggleLeft,
  ToggleRight,
  KeyRound,
  RotateCcw,
} from "lucide-react";

import { PageHeader } from "../../components/common/PageHeader";
import { QueryState } from "../../components/common/QueryState";
import { FormField } from "../../components/common/FormField";
import { SlidePanel } from "../../components/common/SlidePanel";
import { StatusBadge } from "../../components/common/StatusBadge";
import { EmptyState } from "../../components/common/EmptyState";
import { ActionMenu, type ActionMenuItem } from "../../components/common/ActionMenu";
import { ConfirmDialog } from "../../components/common/ConfirmDialog";
import { TagInput } from "../../components/common/TagInput";
import { useToast } from "../../components/common/ToastProvider";
import { apiRequest, useApiQuery } from "../../lib/api";

type WebhookInfo = {
  webhook_id: string;
  url: string;
  events: string[];
  is_active: boolean;
  secret?: string;
  created_at?: string;
};
type Delivery = {
  id?: string;
  event_type?: string;
  response_status?: number;
  duration_ms?: number;
  delivered_at?: string;
  success?: boolean;
};

export const WebhooksPage = () => {
  const { showToast } = useToast();

  /* ── Queries ──────────────────────────────────────────────── */
  const webhooksQuery = useApiQuery<{ webhooks: WebhookInfo[] }>(
    "/api/v1/webhooks",
  );
  const webhooks = useMemo(
    () => webhooksQuery.data?.webhooks ?? [],
    [webhooksQuery.data],
  );

  /* ── Search ───────────────────────────────────────────────── */
  const [search, setSearch] = useState("");
  const filtered = search
    ? webhooks.filter(
        (w) =>
          w.url.toLowerCase().includes(search.toLowerCase()) ||
          w.webhook_id.toLowerCase().includes(search.toLowerCase()),
      )
    : webhooks;

  /* ── Create/Edit panel ────────────────────────────────────── */
  const [panelOpen, setPanelOpen] = useState(false);
  const [panelMode, setPanelMode] = useState<"create" | "edit">("create");
  const [form, setForm] = useState({ url: "", events: [] as string[] });
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});

  /* ── Delivery drawer ──────────────────────────────────────── */
  const [deliveryOpen, setDeliveryOpen] = useState(false);
  const [selectedWebhookId, setSelectedWebhookId] = useState<string | null>(
    null,
  );
  const deliveriesQuery = useApiQuery<{ deliveries: Delivery[] }>(
    `/api/v1/webhooks/${selectedWebhookId}/deliveries`,
    selectedWebhookId !== null,
  );

  /* ── Confirm dialog ───────────────────────────────────────── */
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmAction, setConfirmAction] = useState<{
    title: string;
    desc: string;
    action: () => Promise<void>;
  } | null>(null);

  /* ── Create webhook ───────────────────────────────────────── */
  const handleSave = async () => {
    const errors: Record<string, string> = {};
    if (!form.url.trim()) errors.url = "URL is required";
    if (form.events.length === 0) errors.events = "At least one event required";
    setFormErrors(errors);
    if (Object.keys(errors).length > 0) return;

    try {
      if (panelMode === "create") {
        await apiRequest("/api/v1/webhooks", "POST", {
          url: form.url,
          events: form.events,
        });
        showToast("Webhook created", "success");
      } else {
        await apiRequest(`/api/v1/webhooks/${editingId}`, "PUT", {
          url: form.url,
          events: form.events,
        });
        showToast("Webhook updated", "success");
      }
      setPanelOpen(false);
      void webhooksQuery.refetch();
    } catch {
      showToast("Failed to save webhook", "error");
    }
  };

  /* ── Toggle active ────────────────────────────────────────── */
  const handleToggle = async (wh: WebhookInfo) => {
    try {
      await apiRequest(`/api/v1/webhooks/${wh.webhook_id}`, "PUT", {
        is_active: !wh.is_active,
      });
      showToast(
        wh.is_active ? "Webhook disabled" : "Webhook enabled",
        "success",
      );
      void webhooksQuery.refetch();
    } catch {
      showToast("Toggle failed", "error");
    }
  };

  /* ── Test delivery ────────────────────────────────────────── */
  const handleTest = async (wh: WebhookInfo) => {
    try {
      await apiRequest(`/api/v1/webhooks/${wh.webhook_id}/test`, "POST");
      showToast("Test delivery sent", "success");
    } catch {
      showToast("Test failed", "error");
    }
  };

  /* ── Rotate secret ────────────────────────────────────────── */
  const handleRotateSecret = (wh: WebhookInfo) => {
    setConfirmAction({
      title: "Rotate Secret",
      desc: `Rotate the signing secret for ${wh.url}? The old secret will be invalidated.`,
      action: async () => {
        await apiRequest(
          `/api/v1/webhooks/${wh.webhook_id}/rotate-secret`,
          "POST",
        );
        showToast("Secret rotated", "success");
        void webhooksQuery.refetch();
      },
    });
    setConfirmOpen(true);
  };

  /* ── Retry delivery ──────────────────────────────────────── */
  const handleRetryDelivery = async (webhookId: string, deliveryId: string) => {
    try {
      await apiRequest(
        `/api/v1/webhooks/${webhookId}/deliveries/${deliveryId}/replay`,
        "POST",
      );
      showToast("Delivery replayed", "success");
      void deliveriesQuery.refetch();
    } catch {
      showToast("Retry failed", "error");
    }
  };

  /* ── Delete ───────────────────────────────────────────────── */
  const handleDelete = (wh: WebhookInfo) => {
    setConfirmAction({
      title: "Delete Webhook",
      desc: `Delete webhook for ${wh.url}? This cannot be undone.`,
      action: async () => {
        await apiRequest(`/api/v1/webhooks/${wh.webhook_id}`, "DELETE");
        showToast("Webhook deleted", "success");
        void webhooksQuery.refetch();
      },
    });
    setConfirmOpen(true);
  };

  /* ── Row actions ──────────────────────────────────────────── */
  const getActions = (wh: WebhookInfo): ActionMenuItem[] => [
    {
      label: "Edit",
      icon: <Pencil size={12} />,
      onClick: () => {
        setForm({ url: wh.url, events: [...wh.events] });
        setEditingId(wh.webhook_id);
        setPanelMode("edit");
        setFormErrors({});
        setPanelOpen(true);
      },
    },
    {
      label: "Test Delivery",
      icon: <Send size={12} />,
      onClick: () => void handleTest(wh),
    },
    {
      label: "View Deliveries",
      icon: <Eye size={12} />,
      onClick: () => {
        setSelectedWebhookId(wh.webhook_id);
        setDeliveryOpen(true);
      },
    },
    {
      label: wh.is_active ? "Disable" : "Enable",
      icon: wh.is_active ? (
        <ToggleLeft size={12} />
      ) : (
        <ToggleRight size={12} />
      ),
      onClick: () => void handleToggle(wh),
    },
    {
      label: "Rotate Secret",
      icon: <KeyRound size={12} />,
      onClick: () => handleRotateSecret(wh),
    },
    {
      label: "Delete",
      icon: <Trash2 size={12} />,
      onClick: () => handleDelete(wh),
      danger: true,
    },
  ];

  const activeCount = webhooks.filter((w) => w.is_active).length;

  return (
    <div>
      <PageHeader
        title="Webhooks"
        subtitle="Manage webhook endpoints, test deliveries, and monitor status"
        liveCount={activeCount}
        liveLabel="Active"
        onRefresh={() => void webhooksQuery.refetch()}
        actions={
          <button
            className="btn btn-primary text-xs"
            onClick={() => {
              setForm({ url: "", events: [] });
              setEditingId(null);
              setPanelMode("create");
              setFormErrors({});
              setPanelOpen(true);
            }}
          >
            <Plus size={14} />
            New Webhook
          </button>
        }
      />

      {/* Stats */}
      <div className="grid grid-cols-2 gap-3 mb-4">
        <div className="card flex items-center gap-3 py-3">
          <div className="p-2 rounded-lg bg-chart-green/10">
            <Webhook size={14} className="text-chart-green" />
          </div>
          <div>
            <p className="text-lg font-bold text-text-primary font-mono">
              {webhooks.length}
            </p>
            <p className="text-[10px] text-text-muted uppercase">
              Total Webhooks
            </p>
          </div>
        </div>
        <div className="card flex items-center gap-3 py-3">
          <div className="p-2 rounded-lg bg-accent/10">
            <Send size={14} className="text-accent" />
          </div>
          <div>
            <p className="text-lg font-bold text-text-primary font-mono">
              {activeCount}
            </p>
            <p className="text-[10px] text-text-muted uppercase">Active</p>
          </div>
        </div>
      </div>

      {/* Search */}
      <div className="flex items-center justify-between mb-3">
        <div className="relative flex-1 max-w-xs">
          <Search
            size={14}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted"
          />
          <input
            type="text"
            placeholder="Search webhooks..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-8 text-xs"
          />
        </div>
      </div>

      <QueryState
        loading={webhooksQuery.loading}
        error={webhooksQuery.error}
        isEmpty={webhooks.length === 0}
        emptyMessage=""
        onRetry={() => void webhooksQuery.refetch()}
      >
        {filtered.length === 0 ? (
          <EmptyState
            icon={<Webhook size={40} />}
            title="No webhooks"
            description="Create a webhook to receive event notifications"
            action={
              <button
                className="btn btn-primary text-xs"
                onClick={() => {
                  setForm({ url: "", events: [] });
                  setPanelMode("create");
                  setPanelOpen(true);
                }}
              >
                <Plus size={14} />
                New Webhook
              </button>
            }
          />
        ) : (
          <div className="card p-0">
            <div className="overflow-x-auto">
              <table>
                <thead>
                  <tr>
                    <th>URL</th>
                    <th>Events</th>
                    <th>Status</th>
                    <th>ID</th>
                    <th style={{ width: "48px" }}></th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((wh) => (
                    <tr key={wh.webhook_id}>
                      <td>
                        <span className="text-text-primary text-sm font-mono">
                          {wh.url.length > 50
                            ? wh.url.slice(0, 50) + "..."
                            : wh.url}
                        </span>
                      </td>
                      <td>
                        <div className="flex flex-wrap gap-1">
                          {wh.events.slice(0, 3).map((ev) => (
                            <span
                              key={ev}
                              className="px-1.5 py-0.5 text-[10px] bg-surface-overlay text-text-muted rounded border border-border-default"
                            >
                              {ev}
                            </span>
                          ))}
                          {wh.events.length > 3 && (
                            <span className="text-[10px] text-text-muted">
                              +{wh.events.length - 3}
                            </span>
                          )}
                        </div>
                      </td>
                      <td>
                        <StatusBadge
                          status={wh.is_active ? "active" : "disabled"}
                        />
                      </td>
                      <td>
                        <span className="font-mono text-[10px] text-text-muted">
                          {wh.webhook_id.slice(0, 12)}
                        </span>
                      </td>
                      <td>
                        <ActionMenu items={getActions(wh)} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </QueryState>

      {/* Create/Edit panel */}
      <SlidePanel
        isOpen={panelOpen}
        onClose={() => setPanelOpen(false)}
        title={panelMode === "create" ? "Create Webhook" : "Edit Webhook"}
        subtitle="Configure endpoint URL and subscribed events"
        footer={
          <>
            <button
              className="btn btn-secondary text-xs"
              onClick={() => setPanelOpen(false)}
            >
              Cancel
            </button>
            <button
              className="btn btn-primary text-xs"
              onClick={() => void handleSave()}
            >
              {panelMode === "create" ? "Create" : "Update"}
            </button>
          </>
        }
      >
        <FormField label="Endpoint URL" required error={formErrors.url}>
          <input
            type="text"
            value={form.url}
            onChange={(e) => setForm({ ...form, url: e.target.value })}
            placeholder="https://example.com/webhook"
            className="text-sm"
          />
        </FormField>
        <FormField
          label="Events"
          required
          error={formErrors.events}
          hint="Press Enter to add"
        >
          <TagInput
            tags={form.events}
            onChange={(events) => setForm({ ...form, events })}
            placeholder="run.completed"
            suggestions={[
              "run.completed",
              "run.failed",
              "run.started",
              "agent.deployed",
              "agent.error",
              "session.created",
              "eval.completed",
            ]}
          />
        </FormField>
      </SlidePanel>

      {/* Delivery drawer */}
      <SlidePanel
        isOpen={deliveryOpen}
        onClose={() => {
          setDeliveryOpen(false);
          setSelectedWebhookId(null);
        }}
        title="Delivery Attempts"
        subtitle={`Webhook ${selectedWebhookId?.slice(0, 12) ?? ""}`}
        width="560px"
      >
        <QueryState
          loading={deliveriesQuery.loading}
          error={deliveriesQuery.error}
          isEmpty={
            (deliveriesQuery.data?.deliveries ?? []).length === 0
          }
          emptyMessage="No deliveries yet"
        >
          <div className="space-y-2">
            {(deliveriesQuery.data?.deliveries ?? []).map((d, i) => {
              const isFailed =
                d.success === false ||
                (d.response_status ?? 0) < 200 ||
                (d.response_status ?? 0) >= 300;
              return (
                <div
                  key={d.id ?? i}
                  className="flex items-center justify-between px-3 py-2 bg-surface-base border border-border-default rounded-lg"
                >
                  <div className="flex items-center gap-3">
                    <div
                      className={`w-2 h-2 rounded-full ${
                        isFailed ? "bg-status-error" : "bg-status-live"
                      }`}
                    />
                    <span className="text-xs text-text-secondary">
                      {d.event_type ?? "unknown"}
                    </span>
                  </div>
                  <div className="flex items-center gap-4">
                    <span className="text-[10px] text-text-muted font-mono">
                      {d.response_status ?? 0}
                    </span>
                    <span className="text-[10px] text-text-muted font-mono">
                      {(d.duration_ms ?? 0).toFixed(0)}ms
                    </span>
                    {isFailed && selectedWebhookId && d.id && (
                      <button
                        className="flex items-center gap-1 px-2 py-1 text-[10px] text-accent hover:bg-accent/10 rounded transition-colors"
                        onClick={() =>
                          void handleRetryDelivery(selectedWebhookId, d.id!)
                        }
                      >
                        <RotateCcw size={9} /> Retry
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </QueryState>
      </SlidePanel>

      {/* Confirm dialog */}
      {confirmOpen && confirmAction && (
        <ConfirmDialog
          title={confirmAction.title}
          description={confirmAction.desc}
          confirmLabel="Confirm"
          tone="danger"
          onConfirm={async () => {
            try {
              await confirmAction.action();
            } catch {
              showToast("Action failed", "error");
            }
            setConfirmOpen(false);
            setConfirmAction(null);
          }}
          onCancel={() => {
            setConfirmOpen(false);
            setConfirmAction(null);
          }}
        />
      )}
    </div>
  );
};
