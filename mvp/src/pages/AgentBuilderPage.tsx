import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "../components/ui/Button";
import { Input } from "../components/ui/Input";
import { Textarea } from "../components/ui/Textarea";
import { StepWizard } from "../components/StepWizard";
import { Card } from "../components/ui/Card";
import { USE_CASES, TOOLS } from "../lib/mock-data";
import { Mail, Calendar, CreditCard, MessageSquare, Table, Users, Phone, Camera, Check } from "lucide-react";

const iconMap: Record<string, React.ComponentType<any>> = {
  Mail, Calendar, CreditCard, MessageSquare, Table, Users, Phone, Camera,
};

const steps = ["Basics", "Behavior", "Tools", "Review"];

export default function AgentBuilderPage() {
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const [agentName, setAgentName] = useState("");
  const [description, setDescription] = useState("");
  const [useCase, setUseCase] = useState("");
  const [persona, setPersona] = useState("");
  const [tone, setTone] = useState("friendly");
  const [responseLength, setResponseLength] = useState("medium");
  const [selectedTools, setSelectedTools] = useState<string[]>([]);

  const toggleTool = (id: string) =>
    setSelectedTools((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const handleCreate = () => {
    // TODO: POST to /api/v1/agents — use returned agent ID
    const newAgentId = "agent-1"; // will be dynamic from API
    navigate(`/agents/${newAgentId}/activity`);
  };

  return (
    <div>
      <h1 className="text-xl font-semibold text-text mb-6">Create New Agent</h1>

      <div className="bg-white rounded-xl border border-border p-6">
        <StepWizard steps={steps} currentStep={step}>
          {/* Step 1: Basics */}
          {step === 0 && (
            <div className="space-y-4">
              <Input label="Agent name" placeholder="e.g. Customer Support Assistant" value={agentName} onChange={(e) => setAgentName(e.target.value)} />
              <Input label="Description" placeholder="What does this agent do?" value={description} onChange={(e) => setDescription(e.target.value)} />
              <div className="space-y-1.5">
                <label className="block text-sm font-medium text-text">Use case</label>
                <div className="grid grid-cols-2 gap-2">
                  {USE_CASES.map((uc) => (
                    <button
                      key={uc.id}
                      onClick={() => setUseCase(uc.id)}
                      className={`text-left p-3 rounded-lg border text-sm transition-colors ${
                        useCase === uc.id ? "border-primary bg-primary-light" : "border-border hover:border-gray-300"
                      }`}
                    >
                      <p className="font-medium text-text">{uc.label}</p>
                      <p className="text-xs text-text-muted mt-0.5">{uc.description}</p>
                    </button>
                  ))}
                </div>
              </div>
              <div className="flex justify-end pt-4">
                <Button onClick={() => setStep(1)} disabled={!agentName}>Continue</Button>
              </div>
            </div>
          )}

          {/* Step 2: Behavior */}
          {step === 1 && (
            <div className="space-y-4">
              <Textarea
                label="Persona / System prompt"
                placeholder="You are a helpful assistant for a flower shop. You help customers with questions about flowers, delivery, and orders..."
                value={persona}
                onChange={(e) => setPersona(e.target.value)}
                rows={5}
              />
              <div className="space-y-1.5">
                <label className="block text-sm font-medium text-text">Tone</label>
                <div className="flex gap-2">
                  {["friendly", "professional", "casual"].map((t) => (
                    <button
                      key={t}
                      onClick={() => setTone(t)}
                      className={`px-4 py-2 rounded-lg border text-sm font-medium capitalize transition-colors ${
                        tone === t ? "border-primary bg-primary-light text-primary" : "border-border text-text-secondary hover:border-gray-300"
                      }`}
                    >
                      {t}
                    </button>
                  ))}
                </div>
              </div>
              <div className="space-y-1.5">
                <label className="block text-sm font-medium text-text">Response length</label>
                <div className="flex gap-2">
                  {["short", "medium", "detailed"].map((l) => (
                    <button
                      key={l}
                      onClick={() => setResponseLength(l)}
                      className={`px-4 py-2 rounded-lg border text-sm font-medium capitalize transition-colors ${
                        responseLength === l ? "border-primary bg-primary-light text-primary" : "border-border text-text-secondary hover:border-gray-300"
                      }`}
                    >
                      {l}
                    </button>
                  ))}
                </div>
              </div>
              <div className="flex justify-between pt-4">
                <Button variant="ghost" onClick={() => setStep(0)}>Back</Button>
                <Button onClick={() => setStep(2)}>Continue</Button>
              </div>
            </div>
          )}

          {/* Step 3: Tools */}
          {step === 2 && (
            <div>
              <p className="text-sm text-text-secondary mb-4">Pick the tools your agent can use.</p>
              <div className="grid grid-cols-2 gap-3">
                {TOOLS.map((tool) => {
                  const Icon = iconMap[tool.icon];
                  const selected = selectedTools.includes(tool.id);
                  return (
                    <button
                      key={tool.id}
                      onClick={() => toggleTool(tool.id)}
                      className={`flex items-center gap-3 p-3 rounded-lg border text-left transition-colors ${
                        selected ? "border-primary bg-primary-light" : "border-border hover:border-gray-300"
                      }`}
                    >
                      {Icon && <Icon size={18} />}
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-text">{tool.label}</p>
                        <p className="text-xs text-text-muted truncate">{tool.description}</p>
                      </div>
                      {selected && <Check size={16} className="text-primary shrink-0" />}
                    </button>
                  );
                })}
              </div>
              <div className="flex justify-between pt-6">
                <Button variant="ghost" onClick={() => setStep(1)}>Back</Button>
                <Button onClick={() => setStep(3)}>Review</Button>
              </div>
            </div>
          )}

          {/* Step 4: Review */}
          {step === 3 && (
            <div className="space-y-4">
              <Card>
                <dl className="space-y-3 text-sm">
                  <div className="flex justify-between">
                    <dt className="text-text-secondary">Name</dt>
                    <dd className="font-medium text-text">{agentName || "—"}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-text-secondary">Use case</dt>
                    <dd className="font-medium text-text capitalize">{useCase.replace("_", " ") || "—"}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-text-secondary">Tone</dt>
                    <dd className="font-medium text-text capitalize">{tone}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-text-secondary">Response length</dt>
                    <dd className="font-medium text-text capitalize">{responseLength}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-text-secondary">Tools</dt>
                    <dd className="font-medium text-text">{selectedTools.length > 0 ? selectedTools.join(", ") : "None"}</dd>
                  </div>
                  {persona && (
                    <div>
                      <dt className="text-text-secondary mb-1">Persona</dt>
                      <dd className="text-text bg-surface-alt rounded-lg p-3 text-xs">{persona}</dd>
                    </div>
                  )}
                </dl>
              </Card>
              <div className="flex justify-between pt-2">
                <Button variant="ghost" onClick={() => setStep(2)}>Back</Button>
                <Button onClick={handleCreate}>Create Agent</Button>
              </div>
            </div>
          )}
        </StepWizard>
      </div>
    </div>
  );
}
