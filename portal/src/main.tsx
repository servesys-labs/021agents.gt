import { ClerkProvider } from "@clerk/clerk-react";
import { dark } from "@clerk/themes";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { CLERK_PUBLISHABLE_KEY, isClerkMode } from "./auth/config";
import App from "./App.tsx";
import { ErrorBoundary } from "./components/common/ErrorBoundary";
import "./index.css";

const app = (
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>
);

createRoot(document.getElementById("root")!).render(
  isClerkMode() && CLERK_PUBLISHABLE_KEY ? (
    <ClerkProvider
      publishableKey={CLERK_PUBLISHABLE_KEY}
      appearance={{
        baseTheme: dark,
      }}
    >
      {app}
    </ClerkProvider>
  ) : (
    app
  ),
);
