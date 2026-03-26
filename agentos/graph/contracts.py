"""Graph contract validators for skills and state management."""

from __future__ import annotations

from typing import Any

from agentos.graph.validate import GraphValidationIssue

_ALLOWED_SKILL_SIDE_EFFECTS = {"none", "read", "write", "external"}
_ALLOWED_REDUCERS = {"append", "last_write_wins", "set_union", "scored_merge"}


def _as_non_empty_str_list(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    out: list[str] = []
    for item in value:
        if isinstance(item, str) and item.strip():
            out.append(item.strip())
    return out


def validate_skill_manifest(
    manifest: Any,
    *,
    path_prefix: str = "skill_manifest",
) -> tuple[list[GraphValidationIssue], list[GraphValidationIssue]]:
    """Validate a declarative skill manifest object."""
    errors: list[GraphValidationIssue] = []
    warnings: list[GraphValidationIssue] = []
    if manifest is None:
        return errors, warnings
    if not isinstance(manifest, dict):
        errors.append(
            GraphValidationIssue(
                code="INVALID_SKILL_MANIFEST",
                message="skill_manifest must be an object",
                path=path_prefix,
            ),
        )
        return errors, warnings
    sid = manifest.get("id")
    if not isinstance(sid, str) or not sid.strip():
        errors.append(
            GraphValidationIssue(
                code="MISSING_SKILL_ID",
                message="skill_manifest.id is required",
                path=f"{path_prefix}.id",
            ),
        )
    side_effects = manifest.get("side_effects", "none")
    if not isinstance(side_effects, str) or side_effects.strip() not in _ALLOWED_SKILL_SIDE_EFFECTS:
        errors.append(
            GraphValidationIssue(
                code="INVALID_SKILL_SIDE_EFFECTS",
                message="skill_manifest.side_effects must be one of: none, read, write, external",
                path=f"{path_prefix}.side_effects",
            ),
        )
    allowed_tools = manifest.get("allowed_tools")
    if allowed_tools is not None and not isinstance(allowed_tools, list):
        errors.append(
            GraphValidationIssue(
                code="INVALID_SKILL_ALLOWED_TOOLS",
                message="skill_manifest.allowed_tools must be a list of strings",
                path=f"{path_prefix}.allowed_tools",
            ),
        )
    if isinstance(allowed_tools, list):
        for i, tool in enumerate(allowed_tools):
            if not isinstance(tool, str) or not tool.strip():
                errors.append(
                    GraphValidationIssue(
                        code="INVALID_SKILL_ALLOWED_TOOLS",
                        message="skill_manifest.allowed_tools must contain non-empty strings",
                        path=f"{path_prefix}.allowed_tools[{i}]",
                    ),
                )
    writes = _as_non_empty_str_list(manifest.get("state_writes"))
    if manifest.get("side_effects") in {"write", "external"} and not writes:
        warnings.append(
            GraphValidationIssue(
                code="SKILL_WRITE_WITHOUT_STATE_WRITES",
                message="Skill declares write/external side effects but no state_writes keys.",
                path=path_prefix,
            ),
        )
    return errors, warnings


def validate_state_contract(
    state_contract: Any,
    *,
    path_prefix: str = "state_contract",
) -> tuple[list[GraphValidationIssue], list[GraphValidationIssue]]:
    """Validate graph-level state management contract."""
    errors: list[GraphValidationIssue] = []
    warnings: list[GraphValidationIssue] = []
    if state_contract is None:
        return errors, warnings
    if not isinstance(state_contract, dict):
        errors.append(
            GraphValidationIssue(
                code="INVALID_STATE_CONTRACT",
                message="state_contract must be an object",
                path=path_prefix,
            ),
        )
        return errors, warnings
    reducers = state_contract.get("reducers", {})
    if reducers is not None and not isinstance(reducers, dict):
        errors.append(
            GraphValidationIssue(
                code="INVALID_STATE_REDUCERS",
                message="state_contract.reducers must be an object map of key -> reducer",
                path=f"{path_prefix}.reducers",
            ),
        )
    if isinstance(reducers, dict):
        for key, reducer in reducers.items():
            if not isinstance(key, str) or not key.strip():
                errors.append(
                    GraphValidationIssue(
                        code="INVALID_STATE_REDUCER_KEY",
                        message="Reducer keys must be non-empty strings",
                        path=f"{path_prefix}.reducers",
                    ),
                )
                continue
            if not isinstance(reducer, str) or reducer.strip() not in _ALLOWED_REDUCERS:
                errors.append(
                    GraphValidationIssue(
                        code="INVALID_STATE_REDUCER",
                        message=f"Reducer for '{key}' must be one of: {', '.join(sorted(_ALLOWED_REDUCERS))}",
                        path=f"{path_prefix}.reducers[{key}]",
                    ),
                )
    required_keys = state_contract.get("required_keys")
    if required_keys is not None and not isinstance(required_keys, list):
        errors.append(
            GraphValidationIssue(
                code="INVALID_STATE_REQUIRED_KEYS",
                message="state_contract.required_keys must be a list",
                path=f"{path_prefix}.required_keys",
            ),
        )
    return errors, warnings


def lint_graph_contracts(
    raw: dict[str, Any],
    *,
    node_ids: set[str],
    node_map: dict[str, dict[str, Any]],
    async_node_ids: set[str],
) -> tuple[list[GraphValidationIssue], list[GraphValidationIssue]]:
    """Lint graph-level skill + state contracts and node-level usage."""
    errors: list[GraphValidationIssue] = []
    warnings: list[GraphValidationIssue] = []
    se, sw = validate_state_contract(raw.get("state_contract"))
    errors.extend(se)
    warnings.extend(sw)
    reducers: dict[str, str] = {}
    state_contract = raw.get("state_contract")
    if isinstance(state_contract, dict) and isinstance(state_contract.get("reducers"), dict):
        reducers = {
            str(k).strip(): str(v).strip()
            for k, v in state_contract.get("reducers", {}).items()
            if isinstance(k, str) and k.strip() and isinstance(v, str) and v.strip()
        }

    for nid in sorted(node_ids):
        node = node_map.get(nid, {})
        manifests = node.get("skills")
        if isinstance(manifests, list):
            for i, manifest in enumerate(manifests):
                me, mw = validate_skill_manifest(manifest, path_prefix=f"nodes[{nid}].skills[{i}]")
                errors.extend(me)
                warnings.extend(mw)
        elif manifests is not None:
            errors.append(
                GraphValidationIssue(
                    code="INVALID_NODE_SKILLS",
                    message="Node skills must be a list of skill_manifest objects",
                    path=f"nodes[{nid}].skills",
                ),
            )

        state_writes = _as_non_empty_str_list(node.get("state_writes"))
        state_reads = _as_non_empty_str_list(node.get("state_reads"))
        if state_writes:
            for key in state_writes:
                reducer = reducers.get(key)
                if reducer is None:
                    warnings.append(
                        GraphValidationIssue(
                            code="STATE_WRITE_WITHOUT_REDUCER",
                            message=f"Node '{nid}' writes state key '{key}' without an explicit reducer.",
                            path=f"nodes[{nid}].state_writes",
                            details={"node_id": nid, "state_key": key},
                        ),
                    )
            if nid in async_node_ids and not (
                isinstance(node.get("idempotency_key"), str) and node.get("idempotency_key", "").strip()
            ):
                errors.append(
                    GraphValidationIssue(
                        code="ASYNC_STATE_WRITE_MISSING_IDEMPOTENCY",
                        message=f"Async node '{nid}' writes state and requires idempotency_key.",
                        path=f"nodes[{nid}]",
                        details={"node_id": nid},
                    ),
                )
        if state_reads and not state_writes and nid in async_node_ids:
            warnings.append(
                GraphValidationIssue(
                    code="ASYNC_STATE_READ_ONLY_NODE",
                    message=f"Async node '{nid}' reads state but does not write state; verify ordering assumptions.",
                    path=f"nodes[{nid}]",
                    details={"node_id": nid},
                ),
            )
    return errors, warnings


def summarize_graph_contracts(raw: dict[str, Any]) -> dict[str, Any]:
    """Build lightweight contract summary metrics for UI/approval gates."""
    nodes_raw = raw.get("nodes")
    nodes = nodes_raw if isinstance(nodes_raw, list) else []
    skill_manifest_count = 0
    state_read_refs = 0
    state_write_refs = 0
    for node in nodes:
        if not isinstance(node, dict):
            continue
        skills = node.get("skills")
        if isinstance(skills, list):
            skill_manifest_count += sum(1 for s in skills if isinstance(s, dict))
        reads = node.get("state_reads")
        if isinstance(reads, list):
            state_read_refs += sum(1 for r in reads if isinstance(r, str) and r.strip())
        writes = node.get("state_writes")
        if isinstance(writes, list):
            state_write_refs += sum(1 for w in writes if isinstance(w, str) and w.strip())
    return {
        "state_contract_present": isinstance(raw.get("state_contract"), dict),
        "skill_manifest_count": skill_manifest_count,
        "state_read_refs": state_read_refs,
        "state_write_refs": state_write_refs,
    }

