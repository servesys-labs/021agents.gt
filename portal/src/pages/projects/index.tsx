import { Button, Card, Table, TableBody, TableCell, TableHead, TableHeaderCell, TableRow, Text, TextInput } from "@tremor/react";
import { useMemo, useState } from "react";

import { PageHeader } from "../../components/common/PageHeader";
import { QueryState } from "../../components/common/QueryState";
import { useToast } from "../../components/common/ToastProvider";
import { apiRequest, useApiQuery } from "../../lib/api";
import { isRequired } from "../../lib/validation";

type Project = { project_id: string; name: string; slug: string; description?: string; default_plan?: string };
type Env = { env_id: string; name: string; plan?: string };

export const ProjectsPage = () => {
  const { showToast } = useToast();
  const projectsQuery = useApiQuery<{ projects: Project[] }>("/api/v1/projects");
  const projects = useMemo(() => projectsQuery.data?.projects ?? [], [projectsQuery.data]);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [plan, setPlan] = useState("standard");
  const [selectedProject, setSelectedProject] = useState("");
  const envsQuery = useApiQuery<{ environments: Env[] }>(
    `/api/v1/projects/${encodeURIComponent(selectedProject)}/envs`,
    Boolean(selectedProject),
  );
  const [actionError, setActionError] = useState("");

  const createProject = async () => {
    if (!isRequired(name)) {
      const message = "Project name is required.";
      setActionError(message);
      showToast(message, "error");
      return;
    }
    if (!["starter", "standard", "pro", "enterprise"].includes(plan)) {
      const message = "Plan must be one of starter, standard, pro, enterprise.";
      setActionError(message);
      showToast(message, "error");
      return;
    }
    setActionError("");
    try {
      await apiRequest(`/api/v1/projects?name=${encodeURIComponent(name)}&description=${encodeURIComponent(description)}&plan=${encodeURIComponent(plan)}`, "POST");
      setName("");
      setDescription("");
      await projectsQuery.refetch();
      showToast("Project created.", "success");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to create project";
      setActionError(message);
      showToast(message, "error");
    }
  };

  const updateEnvPlan = async (envName: string) => {
    const nextPlan = window.prompt(`New plan for ${envName}`, "standard");
    if (!nextPlan) {
      return;
    }
    try {
      await apiRequest(
        `/api/v1/projects/${encodeURIComponent(selectedProject)}/envs/${encodeURIComponent(envName)}?plan=${encodeURIComponent(nextPlan)}`,
        "PUT",
      );
      await envsQuery.refetch();
      showToast(`Updated ${envName} environment plan.`, "success");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to update environment";
      setActionError(message);
      showToast(message, "error");
    }
  };

  return (
    <div>
      <PageHeader title="Projects & Environments" subtitle="Manage project hierarchy and environment plans" />
      <Card className="mb-6">
        <div className="grid gap-2 md:grid-cols-4">
          <TextInput value={name} onChange={(event) => setName(event.target.value)} placeholder="Project name" />
          <TextInput value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Description" />
          <TextInput value={plan} onChange={(event) => setPlan(event.target.value)} placeholder="starter|standard|pro|enterprise" />
          <Button onClick={() => void createProject()}>Create Project</Button>
        </div>
        {actionError ? <Text className="mt-2 text-red-600">{actionError}</Text> : null}
      </Card>
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <Text className="font-semibold mb-3">Projects</Text>
          <QueryState
            loading={projectsQuery.loading}
            error={projectsQuery.error}
            isEmpty={projects.length === 0}
            emptyMessage="No projects created."
            onRetry={() => void projectsQuery.refetch()}
          >
            <Table>
              <TableHead>
                <TableRow>
                  <TableHeaderCell>Name</TableHeaderCell>
                  <TableHeaderCell>Plan</TableHeaderCell>
                  <TableHeaderCell></TableHeaderCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {projects.map((project) => (
                  <TableRow key={project.project_id}>
                    <TableCell><Text>{project.name}</Text></TableCell>
                    <TableCell><Text>{project.default_plan ?? "standard"}</Text></TableCell>
                    <TableCell>
                      <Button size="xs" onClick={() => setSelectedProject(project.project_id)}>Environments</Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </QueryState>
        </Card>
        <Card>
          <Text className="font-semibold mb-3">Environments</Text>
          {!selectedProject ? (
            <Text className="text-gray-500">Select a project to view environments.</Text>
          ) : (
            <QueryState
              loading={envsQuery.loading}
              error={envsQuery.error}
              isEmpty={(envsQuery.data?.environments ?? []).length === 0}
              emptyMessage="No environments found."
              onRetry={() => void envsQuery.refetch()}
            >
              <Table>
                <TableHead>
                  <TableRow>
                    <TableHeaderCell>Name</TableHeaderCell>
                    <TableHeaderCell>Plan</TableHeaderCell>
                    <TableHeaderCell></TableHeaderCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {(envsQuery.data?.environments ?? []).map((env) => (
                    <TableRow key={env.env_id}>
                      <TableCell><Text>{env.name}</Text></TableCell>
                      <TableCell><Text>{env.plan || "default"}</Text></TableCell>
                      <TableCell>
                        <Button size="xs" variant="secondary" onClick={() => void updateEnvPlan(env.name)}>Edit Plan</Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </QueryState>
          )}
        </Card>
      </div>
    </div>
  );
};
