import { useState, useCallback } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { Info } from "lucide-react";
import { ChatInterface, type Message } from "../components/ChatInterface";
import { InfoBox } from "../components/ui/InfoBox";
import { AgentNav } from "../components/AgentNav";
import { AgentNotFound } from "../components/AgentNotFound";
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

  if (!agent) return <AgentNotFound />;

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)]">
      <AgentNav agentName={agent.name} />

      {/* Info bar */}
      <InfoBox variant="info" icon={<Info size={14} />} className="mt-3">
        This is a test environment. Messages here are not visible to your customers.
      </InfoBox>

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
