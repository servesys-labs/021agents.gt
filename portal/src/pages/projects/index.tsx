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
      <div className="card mb-6">
        <div className="grid gap-2 md:grid-cols-4">
          <input className="input-field" value={name} onChange={(event) => setName(event.target.value)} placeholder="Project name" />
          <input className="input-field" value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Description" />
          <input className="input-field" value={plan} onChange={(event) => setPlan(event.target.value)} placeholder="starter|standard|pro|enterprise" />
          <button className="btn-primary" onClick={() => void createProject()}>Create Project</button>
        </div>
        {actionError ? <span className="mt-2 text-red-600">{actionError}</span> : null}
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="card">
          <p className="font-semibold text-white mb-3">Projects</p>
          <QueryState
            loading={projectsQuery.loading}
            error={projectsQuery.error}
            isEmpty={projects.length === 0}
            emptyMessage="No projects created."
            onRetry={() => void projectsQuery.refetch()}
          >
            <table className="os-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Plan</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {projects.map((project) => (
                  <tr key={project.project_id}>
                    <td><span className="text-gray-400">{project.name}</span></td>
                    <td><span className="text-gray-400">{project.default_plan ?? "standard"}</span></td>
                    <td>
                      <button className="btn-primary text-xs" onClick={() => setSelectedProject(project.project_id)}>Environments</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </QueryState>
        </div>
        <div className="card">
          <p className="font-semibold text-white mb-3">Environments</p>
          {!selectedProject ? (
            <span className="text-gray-500">Select a project to view environments.</span>
          ) : (
            <QueryState
              loading={envsQuery.loading}
              error={envsQuery.error}
              isEmpty={(envsQuery.data?.environments ?? []).length === 0}
              emptyMessage="No environments found."
              onRetry={() => void envsQuery.refetch()}
            >
              <table className="os-table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Plan</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {(envsQuery.data?.environments ?? []).map((env) => (
                    <tr key={env.env_id}>
                      <td><span className="text-gray-400">{env.name}</span></td>
                      <td><span className="text-gray-400">{env.plan || "default"}</span></td>
                      <td>
                        <button className="btn-secondary text-xs" onClick={() => void updateEnvPlan(env.name)}>Edit Plan</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </QueryState>
          )}
        </div>
      </div>
    </div>
  );
};
