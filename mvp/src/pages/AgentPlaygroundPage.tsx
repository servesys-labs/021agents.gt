import { useState, useCallback } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { ArrowLeft, Info, GitBranch, FlaskConical, BookOpen, Phone, ShoppingBag, Share2, Lightbulb, Settings, BarChart3 } from "lucide-react";
import { ChatInterface, type Message } from "../components/ChatInterface";
import { Button } from "../components/ui/Button";
import { Badge } from "../components/ui/Badge";
import { MOCK_AGENTS } from "../lib/mock-data";

let msgId = 0;

const SAMPLE_RESPONSES = [
  "Thanks for reaching out! I'd be happy to help with that. We deliver Monday through Friday, 9am to 6pm, and Saturdays 10am to 4pm. Would you like to schedule a delivery?",
  "Great question! Our most popular arrangements for that occasion are the Classic Rose Bouquet ($49) and the Seasonal Garden Mix ($39). Both come with free same-day delivery if ordered before 2pm.",
  "I understand your frustration, and I'm sorry about that experience. Let me look into your order right away. Could you share your order number or the email you used?",
  "Absolutely! We have a beautiful selection of wedding flowers. For centerpieces, roses and peonies are very popular in June. Would you like to book a free 30-minute consultation with our wedding specialist?",
];

export default function AgentPlaygroundPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const agent = MOCK_AGENTS.find((a) => a.id === id);
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(false);

  const handleSend = useCallback((text: string) => {
    const userMsg: Message = { id: String(++msgId), role: "user", content: text, timestamp: new Date().toISOString() };
    setMessages((prev) => [...prev, userMsg]);
    setLoading(true);

    // Simulate agent response
    setTimeout(() => {
      const response = SAMPLE_RESPONSES[msgId % SAMPLE_RESPONSES.length];
      const assistantMsg: Message = { id: String(++msgId), role: "assistant", content: response, timestamp: new Date().toISOString() };
      setMessages((prev) => [...prev, assistantMsg]);
      setLoading(false);
    }, 800 + Math.random() * 600);
  }, []);

  if (!agent) {
    return <p className="text-text-secondary">Agent not found. <Link to="/" className="text-primary">Go back</Link></p>;
  }

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)]">
      {/* Header */}
      <div className="flex items-center gap-3 pb-4 border-b border-border">
        <button onClick={() => navigate(-1)} className="p-1.5 rounded-lg hover:bg-surface-alt text-text-secondary">
          <ArrowLeft size={18} />
        </button>
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <h1 className="text-lg font-semibold text-text">{agent.name}</h1>
            <Badge variant="info">Playground</Badge>
          </div>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="secondary" onClick={() => navigate(`/agents/${id}/activity`)}><BarChart3 size={14} /> Activity</Button>
          <Button size="sm" variant="secondary" onClick={() => navigate(`/agents/${id}/flow`)}><GitBranch size={14} /> Flow</Button>
          <Button size="sm" variant="secondary" onClick={() => navigate(`/agents/${id}/tests`)}><FlaskConical size={14} /> Evals</Button>
          <Button size="sm" variant="secondary" onClick={() => navigate(`/agents/${id}/knowledge`)}><BookOpen size={14} /> Knowledge</Button>
          <Button size="sm" variant="secondary" onClick={() => navigate(`/agents/${id}/voice`)}><Phone size={14} /> Voice</Button>
          <Button size="sm" variant="secondary" onClick={() => navigate(`/agents/${id}/integrations`)}><ShoppingBag size={14} /> Integrations</Button>
          <Button size="sm" variant="secondary" onClick={() => navigate(`/agents/${id}/channels`)}><Share2 size={14} /> Channels</Button>
          <Button size="sm" variant="secondary" onClick={() => navigate(`/agents/${id}/insights`)}><Lightbulb size={14} /> Insights</Button>
          <Button size="sm" variant="ghost" onClick={() => navigate(`/agents/${id}/settings`)}><Settings size={14} /></Button>
        </div>
      </div>

      {/* Info bar */}
      <div className="flex items-center gap-2 px-4 py-2 bg-blue-50 text-blue-700 text-xs rounded-lg mt-3">
        <Info size={14} />
        This is a test environment. Messages here are not visible to your customers.
      </div>

      {/* Chat */}
      <div className="flex-1 min-h-0 mt-2">
        <ChatInterface
          messages={messages}
          onSend={handleSend}
          loading={loading}
          placeholder={`Message ${agent.name}...`}
        />
      </div>
    </div>
  );
}
