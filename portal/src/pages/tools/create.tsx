import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowLeft, Save } from "lucide-react";

import { PageHeader } from "../../components/common/PageHeader";
import { FormField } from "../../components/common/FormField";
import { useApiMutation } from "../../lib/api";
import { useToast } from "../../components/common/ToastProvider";

/* ── Types ──────────────────────────────────────────────────────── */

type ToolCreateRequest = {
  name: string;
  description?: string;
  type?: string;
  category?: string;
  schema?: Record<string, unknown>;
};

type ToolCreateResponse = {
  name: string;
  [key: string]: unknown;
};

/* ── Create Tool Page ───────────────────────────────────────────── */

export function CreateToolPage() {
  const navigate = useNavigate();
  const { showToast } = useToast();

  const [form, setForm] = useState<ToolCreateRequest>({
    name: "",
    description: "",
    type: "function",
    category: "",
  });
  const [schemaText, setSchemaText] = useState("{}");
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});

  const createMutation = useApiMutation<ToolCreateResponse, ToolCreateRequest>(
    "/api/v1/tools",
    "POST",
  );

  const updateField = <K extends keyof ToolCreateRequest>(
    key: K,
    value: ToolCreateRequest[K],
  ) => {
    setForm((prev) => ({ ...prev, [key]: value }));
    setFormErrors((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  };

  const validateForm = (): boolean => {
    const errors: Record<string, string> = {};
    if (!form.name?.trim()) errors.name = "Name is required";
    else if (!/^[a-z0-9_-]+$/.test(form.name))
      errors.name = "Use lowercase letters, numbers, hyphens, underscores";

    try {
      JSON.parse(schemaText);
    } catch {
      errors.schema = "Invalid JSON";
    }

    setFormErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const handleSubmit = async () => {
    if (!validateForm()) return;

    try {
      const body: ToolCreateRequest = {
        ...form,
        schema: JSON.parse(schemaText),
      };
      await createMutation.mutate(body);
      showToast(`Tool "${form.name}" created`, "success");
      navigate("/tools");
    } catch (err) {
      showToast(
        err instanceof Error ? err.message : "Failed to create tool",
        "error",
      );
    }
  };

  return (
    <div>
      <div className="mb-4">
        <button
          className="btn btn-secondary text-xs"
          onClick={() => navigate("/tools")}
        >
          <ArrowLeft size={14} />
          Back to Tools
        </button>
      </div>

      <PageHeader
        title="Register Tool"
        subtitle="Add a new tool to the registry"
      />

      <div className="card max-w-2xl">
        {/* Basic Info */}
        <div className="mb-6">
          <h4 className="text-xs font-semibold text-text-muted uppercase tracking-wide mb-3">
            Basic Info
          </h4>
          <FormField
            label="Name"
            htmlFor="tool-name"
            required
            error={formErrors.name}
            hint="Lowercase slug: my-tool-name"
          >
            <input
              id="tool-name"
              type="text"
              value={form.name}
              onChange={(e) => updateField("name", e.target.value)}
              placeholder="web-search"
              className="text-sm"
            />
          </FormField>

          <FormField label="Description" htmlFor="tool-desc">
            <input
              id="tool-desc"
              type="text"
              value={form.description || ""}
              onChange={(e) => updateField("description", e.target.value)}
              placeholder="Search the web for information..."
              className="text-sm"
            />
          </FormField>

          <FormField label="Type" htmlFor="tool-type">
            <select
              id="tool-type"
              value={form.type || "function"}
              onChange={(e) => updateField("type", e.target.value)}
              className="text-sm"
            >
              <option value="function">Function</option>
              <option value="api">API</option>
              <option value="mcp">MCP</option>
              <option value="webhook">Webhook</option>
            </select>
          </FormField>

          <FormField label="Category" htmlFor="tool-category">
            <input
              id="tool-category"
              type="text"
              value={form.category || ""}
              onChange={(e) => updateField("category", e.target.value)}
              placeholder="search, data, communication..."
              className="text-sm"
            />
          </FormField>
        </div>

        {/* Schema */}
        <div className="mb-6">
          <h4 className="text-xs font-semibold text-text-muted uppercase tracking-wide mb-3">
            Schema
          </h4>
          <FormField
            label="JSON Schema"
            htmlFor="tool-schema"
            error={formErrors.schema}
            hint="Define the tool's input parameters as JSON schema"
          >
            <textarea
              id="tool-schema"
              value={schemaText}
              onChange={(e) => {
                setSchemaText(e.target.value);
                setFormErrors((prev) => {
                  const next = { ...prev };
                  delete next.schema;
                  return next;
                });
              }}
              rows={8}
              className="text-sm font-mono"
              placeholder='{"type": "object", "properties": {}}'
            />
          </FormField>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-3">
          <button
            className="btn btn-secondary text-xs"
            onClick={() => navigate("/tools")}
          >
            Cancel
          </button>
          <button
            className="btn btn-primary text-xs"
            onClick={() => void handleSubmit()}
            disabled={createMutation.loading}
          >
            {createMutation.loading ? (
              "Creating..."
            ) : (
              <>
                <Save size={14} />
                Create Tool
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

export { CreateToolPage as default };
