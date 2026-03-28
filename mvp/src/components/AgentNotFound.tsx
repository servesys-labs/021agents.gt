import { Link } from "react-router-dom";

export function AgentNotFound() {
  return (
    <p className="text-text-secondary">
      Agent not found. <Link to="/" className="text-primary hover:underline">Go back to dashboard</Link>
    </p>
  );
}
