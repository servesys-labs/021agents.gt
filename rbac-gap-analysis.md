# oneshots.co Portal: RBAC & Tenant Scoping Gap Analysis

**Author**: Manus AI
**Date**: March 22, 2026

This document provides a detailed audit of the Role-Based Access Control (RBAC) and multi-tenant scoping mechanisms in the `oneshots.co` platform, comparing the backend capabilities against the current frontend portal implementation.

## 1. Executive Summary

The backend has a sophisticated, production-ready RBAC and multi-tenant architecture designed for B2B SaaS. It supports organizations, projects, environments, hierarchical user roles (`owner`, `admin`, `member`, `viewer`), and granular API key scopes. 

However, **the frontend portal currently has zero RBAC enforcement or tenant-switching UI.** The portal assumes a single-tenant, single-role ("god mode") experience. If a user belongs to multiple organizations, the portal has no way to switch between them, and it does not hide or disable destructive actions (like Delete) for users who only have `viewer` access.

## 2. Backend Architecture (What Exists)

The backend database (`agent.db`) and API layer (`agentos/api/deps.py`) fully enforce the following model:

### 2.1 Tenant Hierarchy
1. **Organizations (`orgs`)**: The top-level tenant. Billing, users, and global policies are tied here.
2. **Projects (`projects`)**: Sub-divisions within an org.
3. **Environments (`environments`)**: Execution contexts within a project (e.g., `development`, `staging`, `production`).

### 2.2 Role Hierarchy (`org_members`)
Users are granted roles per organization. The backend enforces strict hierarchy:
- `owner` (Level 4): Can delete the org.
- `admin` (Level 3): Can invite/remove members, change roles, manage billing.
- `member` (Level 2): Can create/edit agents, run workflows.
- `viewer` (Level 1): Read-only access to agents and logs.

**Enforcement:** Handled via the `require_role("admin")` FastAPI dependency.

### 2.3 Programmatic Scopes (`api_keys`)
API keys are scoped both by **Capability** and by **Tenant**:
- **Capabilities**: Fine-grained permissions like `agents:read`, `agents:write`, `eval:run`, `*`.
- **Tenant Scoping**: A key can be restricted to a specific `project_id` or `env` (e.g., a key that can only deploy to `production`).

**Enforcement:** Handled via the `require_scope("agents:write")` FastAPI dependency.

---

## 3. Frontend Gaps (What is Missing)

A review of the portal React codebase (`src/providers/authProvider.ts`, `src/pages/*`) reveals severe gaps in utilizing the backend's RBAC model.

### 3.1 No Organization Switcher
When a user logs in, the backend returns their default `org_id`. The portal stores this in `localStorage` but **never allows the user to change it**. 
- **Gap:** If a user is invited to a second organization, they cannot access it via the UI.
- **Fix Required:** Implement an Org Switcher dropdown in the top-left of the Sidebar (matching the E2B design reference). This must update the active `org_id` context and refetch all data.

### 3.2 No Project/Environment Context
While the Settings > Projects page lists projects, there is no global project or environment context switcher.
- **Gap:** Agents, runs, and secrets cannot be filtered or deployed to specific environments from the UI.
- **Fix Required:** Add a global "Environment" toggle (Dev / Staging / Prod) to the top header navigation, which appends `?env=...` to relevant API queries.

### 3.3 Missing Client-Side Role Enforcement
The `authProvider.ts` hardcodes a fallback to `"member"` and does not expose role-based rendering hooks.
- **Gap:** A user with the `viewer` role will see "Create Agent" and "Delete" buttons. Clicking them will result in a raw `403 Forbidden` API error rather than the UI gracefully hiding the buttons.
- **Fix Required:** Create a `usePermissions()` hook that checks the user's role in the current org. Wrap destructive buttons in a `<RequireRole minRole="admin">` component to hide or disable them for viewers.

### 3.4 Incomplete Member Management UI
The Settings page lists organizations but lacks the UI to actually manage the team.
- **Gap:** Users cannot invite new members (`POST /api/v1/orgs/{id}/members`), remove members, or change their roles.
- **Fix Required:** Build a dedicated "Team > Members" page (as seen in the E2B sidebar) that wires up the member CRUD endpoints.

## 4. Implementation Plan

To bring the portal up to parity with the backend RBAC system, we must execute the following phases:

### Phase 1: Core Context & Switching
1. **Update Auth State**: Modify `authProvider.ts` and `tokens.ts` to support an `activeOrgId` state.
2. **Build Org Switcher**: Add a dropdown to the Sidebar header fetching from `GET /api/v1/orgs`.
3. **API Interceptor**: Update `apiRequest` in `api.ts` to pass the `active-org-id` in a custom header (if supported by backend) or ensure all queries are properly scoped.

### Phase 2: Client-Side Role Enforcement
1. **Create RBAC Hooks**: Implement `useRole()` to get the current user's role level (1-4).
2. **Component Wrappers**: Build `<RequireRole>` and `<RequireScope>` wrapper components.
3. **Audit UI**: Go through all pages (Agents, Webhooks, Settings) and wrap action buttons (Create, Edit, Delete) in the appropriate RBAC wrappers to prevent 403 errors.

### Phase 3: Team Management UI
1. **Members Page**: Create `src/pages/members/index.tsx`.
2. **Invite Flow**: Build a modal to invite users by email and assign a role (`owner`, `admin`, `member`, `viewer`).
3. **Role Management**: Add a dropdown in the members table to upgrade/downgrade roles (restricted to admins/owners).

### Phase 4: Environment Scoping
1. **Global Env Toggle**: Add a "Dev | Staging | Prod" segmented control to the `PageHeader`.
2. **Scoped Resources**: Update the Agents, Sandboxes, and Deployments pages to filter data based on the selected environment.

## 5. Conclusion

The backend has done the heavy lifting for a secure, multi-tenant B2B SaaS architecture. The portal simply needs to catch up by implementing context switchers and conditional rendering based on the user's role. Implementing this plan is critical before onboarding external teams or enterprise customers.
