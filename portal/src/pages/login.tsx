import { useLogin, useRegister } from "@refinedev/core";
import { useState } from "react";
import { Card, TextInput, Button, Text } from "@tremor/react";

export const LoginPage = () => {
  const { mutate: login, isLoading: loginLoading } = useLogin();
  const { mutate: register, isLoading: registerLoading } = useRegister();
  const [isRegister, setIsRegister] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (isRegister) {
      register({ email, password, name });
    } else {
      login({ email, password });
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <Card className="w-full max-w-md">
        <div className="text-center mb-6">
          <h1 className="text-2xl font-bold">AgentOS</h1>
          <Text className="text-gray-500">Agent Control Plane</Text>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {isRegister && (
            <div>
              <Text className="mb-1">Name</Text>
              <TextInput value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name" />
            </div>
          )}
          <div>
            <Text className="mb-1">Email</Text>
            <TextInput type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" required />
          </div>
          <div>
            <Text className="mb-1">Password</Text>
            <TextInput type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" required />
          </div>
          <Button type="submit" className="w-full" loading={loginLoading || registerLoading}>
            {isRegister ? "Create Account" : "Sign In"}
          </Button>
        </form>

        <div className="text-center mt-4">
          <button
            onClick={() => setIsRegister(!isRegister)}
            className="text-sm text-blue-600 hover:underline"
          >
            {isRegister ? "Already have an account? Sign in" : "Don't have an account? Register"}
          </button>
        </div>
      </Card>
    </div>
  );
};
