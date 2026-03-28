import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "../components/ui/Button";
import { Input } from "../components/ui/Input";
import { Select } from "../components/ui/Select";
import { StepWizard } from "../components/StepWizard";
import { INDUSTRIES, USE_CASES, TOOLS } from "../lib/mock-data";
import { Mail, Calendar, CreditCard, MessageSquare, Table, Users, Phone, Camera } from "lucide-react";

const iconMap: Record<string, React.ComponentType<any>> = {
  Mail, Calendar, CreditCard, MessageSquare, Table, Users, Phone, Camera,
};

const steps = ["Your Business", "Use Case", "Connect Tools"];

export default function OnboardingPage() {
  const [step, setStep] = useState(0);
  const [bizName, setBizName] = useState("");
  const [industry, setIndustry] = useState("");
  const [teamSize, setTeamSize] = useState("");
  const [selectedUseCases, setSelectedUseCases] = useState<string[]>([]);
  const [connectedTools, setConnectedTools] = useState<string[]>([]);
  const navigate = useNavigate();

  const toggleUseCase = (id: string) =>
    setSelectedUseCases((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const toggleTool = (id: string) =>
    setConnectedTools((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const handleComplete = () => {
    // TODO: POST to /api/v1/org/settings
    navigate("/");
  };

  return (
    <div className="min-h-screen bg-surface-alt flex items-center justify-center px-4 py-12">
      <div className="w-full max-w-lg">
        <h1 className="text-2xl font-semibold text-text text-center mb-2">Set up your workspace</h1>
        <p className="text-text-secondary text-center mb-8">Takes about 2 minutes</p>

        <div className="bg-white rounded-xl border border-border p-6">
          <StepWizard steps={steps} currentStep={step}>
            {/* Step 1: Business Info */}
            {step === 0 && (
              <div className="space-y-4">
                <Input label="Business name" placeholder="Sarah's Flower Shop" value={bizName} onChange={(e) => setBizName(e.target.value)} />
                <Select
                  label="Industry"
                  placeholder="Select your industry"
                  value={industry}
                  onChange={(e) => setIndustry(e.target.value)}
                  options={INDUSTRIES.map((i) => ({ value: i, label: i }))}
                />
                <div className="space-y-1.5">
                  <label className="block text-sm font-medium text-text">Team size</label>
                  <div className="grid grid-cols-3 gap-2">
                    {["Just me", "2-10", "11-50"].map((size) => (
                      <button
                        key={size}
                        onClick={() => setTeamSize(size)}
                        className={`py-2 px-3 rounded-lg border text-sm font-medium transition-colors ${
                          teamSize === size
                            ? "border-primary bg-primary-light text-primary"
                            : "border-border text-text-secondary hover:border-gray-300"
                        }`}
                      >
                        {size}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="flex justify-between pt-4">
                  <Button variant="ghost" onClick={() => navigate("/agents/new")}>Skip — go build an agent</Button>
                  <Button onClick={() => setStep(1)}>Continue</Button>
                </div>
              </div>
            )}

            {/* Step 2: Use Case */}
            {step === 1 && (
              <div className="space-y-3">
                <p className="text-sm text-text-secondary mb-4">What do you want your agent to help with? Select all that apply.</p>
                {USE_CASES.map((uc) => (
                  <button
                    key={uc.id}
                    onClick={() => toggleUseCase(uc.id)}
                    className={`w-full text-left p-4 rounded-lg border transition-colors ${
                      selectedUseCases.includes(uc.id)
                        ? "border-primary bg-primary-light"
                        : "border-border hover:border-gray-300"
                    }`}
                  >
                    <p className="text-sm font-medium text-text">{uc.label}</p>
                    <p className="text-xs text-text-secondary mt-0.5">{uc.description}</p>
                  </button>
                ))}
                <div className="flex justify-between pt-4">
                  <Button variant="ghost" onClick={() => setStep(0)}>Back</Button>
                  <Button onClick={() => setStep(2)}>Continue</Button>
                </div>
              </div>
            )}

            {/* Step 3: Connect Tools */}
            {step === 2 && (
              <div>
                <p className="text-sm text-text-secondary mb-4">Connect the tools your agent will use. You can add more later.</p>
                <div className="grid grid-cols-2 gap-3">
                  {TOOLS.map((tool) => {
                    const Icon = iconMap[tool.icon];
                    const connected = connectedTools.includes(tool.id);
                    return (
                      <button
                        key={tool.id}
                        onClick={() => toggleTool(tool.id)}
                        className={`flex items-center gap-3 p-3 rounded-lg border text-left transition-colors ${
                          connected
                            ? "border-primary bg-primary-light"
                            : "border-border hover:border-gray-300"
                        }`}
                      >
                        {Icon && <Icon size={18} />}
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-text">{tool.label}</p>
                          <p className="text-xs text-text-muted truncate">{tool.description}</p>
                        </div>
                      </button>
                    );
                  })}
                </div>
                <div className="flex justify-between pt-6">
                  <Button variant="ghost" onClick={() => setStep(1)}>Back</Button>
                  <Button onClick={handleComplete}>Complete Setup</Button>
                </div>
              </div>
            )}
          </StepWizard>
        </div>
      </div>
    </div>
  );
}
