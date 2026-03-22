"""Codebase map generator for dependency and feature graphs.

Outputs:
- JSON graph for agent/tool consumption
- DOT graph for visualization
- Optional SVG (if graphviz `dot` is installed)
"""

from __future__ import annotations

import ast
import json
import re
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any


_PY_IMPORT_RE = re.compile(r"^\s*from\s+([a-zA-Z0-9_\.]+)\s+import|^\s*import\s+([a-zA-Z0-9_\.]+)")
_TS_IMPORT_RE = re.compile(r"""^\s*import\s+.*?\s+from\s+["'](.+?)["']""")
_API_DECORATOR_RE = re.compile(r"""@(?:router|app)\.(get|post|put|patch|delete)\(["']([^"']*)["']""")
_ROUTER_PREFIX_RE = re.compile(r"""APIRouter\(\s*prefix\s*=\s*["']([^"']*)["']""")
_ROUTE_PATH_RE = re.compile(r"""<Route\s+path=["']([^"']+)["']\s+element=\{<([A-Za-z0-9_]+)\s*/>\}""")
_ROUTE_INDEX_RE = re.compile(r"""<Route\s+index\s+element=\{<([A-Za-z0-9_]+)\s*/>\}""")
_LAZY_IMPORT_RE = re.compile(r"""const\s+([A-Za-z0-9_]+)\s*=\s*lazy\(\(\)\s*=>\s*import\(["'](.+?)["']\)""")
_API_LITERAL_RE = re.compile(r"""(?P<q>["'`])(?P<val>/api(?:/v[0-9]+)?(?:/[^"'`]*)?)(?P=q)""")
_GLOBAL_API_PREFIX = "/api/v1"


@dataclass
class GraphNode:
    id: str
    type: str
    label: str
    path: str = ""


@dataclass
class GraphEdge:
    source: str
    target: str
    type: str


class Graph:
    def __init__(self) -> None:
        self.nodes: dict[str, GraphNode] = {}
        self._edge_keys: set[tuple[str, str, str]] = set()
        self.edges: list[GraphEdge] = []

    def add_node(self, node_id: str, node_type: str, label: str, path: str = "") -> None:
        if node_id in self.nodes:
            return
        self.nodes[node_id] = GraphNode(id=node_id, type=node_type, label=label, path=path)

    def add_edge(self, source: str, target: str, edge_type: str) -> None:
        key = (source, target, edge_type)
        if key in self._edge_keys:
            return
        self._edge_keys.add(key)
        self.edges.append(GraphEdge(source=source, target=target, type=edge_type))

    def to_dict(self) -> dict[str, Any]:
        return {
            "nodes": [node.__dict__ for node in sorted(self.nodes.values(), key=lambda n: n.id)],
            "edges": [edge.__dict__ for edge in sorted(self.edges, key=lambda e: (e.source, e.target, e.type))],
        }


def _repo_rel(path: Path, root: Path) -> str:
    return str(path.relative_to(root))


def _discover_python_files(root: Path) -> list[Path]:
    return sorted((root / "agentos").rglob("*.py"))


def _discover_ts_files(root: Path) -> list[Path]:
    return sorted((root / "portal" / "src").rglob("*.ts")) + sorted((root / "portal" / "src").rglob("*.tsx"))


def _module_for_py(path: Path, root: Path) -> str:
    rel = path.relative_to(root).with_suffix("")
    parts = list(rel.parts)
    if parts[-1] == "__init__":
        parts = parts[:-1]
    return ".".join(parts)


def _build_py_module_index(py_files: list[Path], root: Path) -> dict[str, Path]:
    return {_module_for_py(path, root): path for path in py_files}


def _resolve_relative_import(base_module: str, module: str | None, level: int) -> str | None:
    if level <= 0:
        return module
    parts = base_module.split(".")
    if parts:
        parts = parts[:-1]
    if level > len(parts):
        parts = []
    else:
        parts = parts[: len(parts) - (level - 1)]
    if module:
        return ".".join(parts + [module]) if parts else module
    return ".".join(parts) if parts else None


def _extract_python_import_modules(path: Path, current_module: str) -> set[str]:
    text = path.read_text(encoding="utf-8", errors="replace")
    imported: set[str] = set()
    try:
        tree = ast.parse(text)
    except SyntaxError:
        for line in text.splitlines():
            match = _PY_IMPORT_RE.match(line)
            if not match:
                continue
            imported_mod = match.group(1) or match.group(2)
            if imported_mod:
                imported.add(imported_mod)
        return imported

    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                imported.add(alias.name)
        elif isinstance(node, ast.ImportFrom):
            absolute_module = _resolve_relative_import(current_module, node.module, node.level)
            if absolute_module:
                imported.add(absolute_module)
                for alias in node.names:
                    if alias.name == "*":
                        continue
                    imported.add(f"{absolute_module}.{alias.name}")
    return imported


def _resolve_local_py_target(module_name: str, index: dict[str, Path]) -> Path | None:
    parts = module_name.split(".")
    while parts:
        candidate = ".".join(parts)
        if candidate in index:
            return index[candidate]
        parts.pop()
    return None


def _resolve_ts_path(importer: Path, import_target: str) -> Path | None:
    if not import_target.startswith("."):
        return None
    base = (importer.parent / import_target).resolve()
    candidates = [
        base,
        base.with_suffix(".ts"),
        base.with_suffix(".tsx"),
        base / "index.ts",
        base / "index.tsx",
    ]
    for candidate in candidates:
        if candidate.exists():
            return candidate
    return None


def _extract_ts_imports(path: Path) -> set[str]:
    imports: set[str] = set()
    text = path.read_text(encoding="utf-8", errors="replace")
    for line in text.splitlines():
        match = _TS_IMPORT_RE.match(line)
        if match:
            imports.add(match.group(1))
    return imports


def _join_paths(prefix: str, leaf: str) -> str:
    if not leaf:
        return prefix or "/"
    if not prefix:
        return f"/{leaf.lstrip('/')}"
    return f"{prefix.rstrip('/')}/{leaf.lstrip('/')}"


def _normalize_api_path(path: str) -> str:
    normalized = path.strip()
    normalized = normalized.replace("//", "/")
    normalized = re.sub(r"\$\{[^}]+\}", "{var}", normalized)
    normalized = normalized.rstrip("/")
    return normalized or "/"


def _normalize_path_template(path: str) -> str:
    normalized = _normalize_api_path(path)
    normalized = re.sub(r"\{[^}/]+\}", "{var}", normalized)
    return normalized


def _extract_api_path_literals(text: str) -> set[str]:
    values: set[str] = set()
    for match in _API_LITERAL_RE.finditer(text):
        value = match.group("val")
        if not value:
            continue
        if not value.startswith("/api"):
            continue
        values.add(value)
    return values


def _template_paths_match(path_a: str, path_b: str) -> bool:
    seg_a = [s for s in path_a.strip("/").split("/") if s]
    seg_b = [s for s in path_b.strip("/").split("/") if s]
    if len(seg_a) != len(seg_b):
        return False
    for left, right in zip(seg_a, seg_b):
        if left == right:
            continue
        if left == "{var}" or right == "{var}":
            continue
        return False
    return True


def _extract_api_endpoints(graph: Graph, root: Path) -> set[str]:
    endpoints: set[str] = set()
    router_files = sorted((root / "agentos" / "api").rglob("*.py"))
    for file_path in router_files:
        rel = _repo_rel(file_path, root)
        file_node = f"file:{rel}"
        graph.add_node(file_node, "file", rel, rel)
        text = file_path.read_text(encoding="utf-8", errors="replace")
        prefixes = _ROUTER_PREFIX_RE.findall(text)
        prefix = prefixes[0] if prefixes else ""
        for method, leaf in _API_DECORATOR_RE.findall(text):
            full = _join_paths(prefix, leaf)
            if file_path.name == "app.py":
                full = leaf or "/"
            elif "agentos/api/routers/" in rel:
                full = _join_paths(_GLOBAL_API_PREFIX, full)
            if not full.startswith("/"):
                full = f"/{full}"
            endpoint_id = f"endpoint:{method.upper()} {full}"
            graph.add_node(endpoint_id, "endpoint", f"{method.upper()} {full}")
            graph.add_edge(file_node, endpoint_id, "defines_endpoint")
            endpoints.add(_normalize_path_template(full))
    return endpoints


def _extract_portal_routes(graph: Graph, root: Path) -> dict[str, str]:
    app_tsx = root / "portal" / "src" / "App.tsx"
    if not app_tsx.exists():
        return {}
    route_to_component: dict[str, str] = {}
    text = app_tsx.read_text(encoding="utf-8", errors="replace")

    lazy_imports = {name: module for name, module in _LAZY_IMPORT_RE.findall(text)}
    app_rel = _repo_rel(app_tsx, root)
    app_node = f"file:{app_rel}"
    graph.add_node(app_node, "file", app_rel, app_rel)

    for route, component in _ROUTE_PATH_RE.findall(text):
        route_id = f"route:{route}"
        graph.add_node(route_id, "route", route)
        graph.add_edge(app_node, route_id, "defines_route")
        module = lazy_imports.get(component, "")
        if module:
            route_to_component[route] = module
            module_file = (app_tsx.parent / module).resolve()
            if module_file.is_dir():
                module_file = module_file / "index.tsx"
            if not module_file.suffix:
                module_file = module_file.with_suffix(".tsx")
            if module_file.exists():
                rel = _repo_rel(module_file, root)
                comp_node = f"file:{rel}"
                graph.add_node(comp_node, "file", rel, rel)
                graph.add_edge(route_id, comp_node, "renders")

    for component in _ROUTE_INDEX_RE.findall(text):
        route = "/"
        route_id = f"route:{route}"
        graph.add_node(route_id, "route", route)
        graph.add_edge(app_node, route_id, "defines_route")
        module = lazy_imports.get(component, "")
        if module:
            route_to_component[route] = module
    return route_to_component


def _extract_ui_api_calls(graph: Graph, root: Path, endpoint_paths: set[str]) -> None:
    ts_files = _discover_ts_files(root)
    endpoint_lookup = {path.rstrip("/") for path in endpoint_paths}
    endpoint_ids_by_path: dict[str, list[str]] = {}
    for node_id, node in graph.nodes.items():
        if node.type != "endpoint":
            continue
        try:
            _method, path = node.label.split(" ", 1)
        except ValueError:
            continue
        key = _normalize_path_template(path).rstrip("/")
        endpoint_ids_by_path.setdefault(key, []).append(node_id)

    for path in ts_files:
        rel = _repo_rel(path, root)
        file_node = f"file:{rel}"
        graph.add_node(file_node, "file", rel, rel)
        text = path.read_text(encoding="utf-8", errors="replace")
        matches = _extract_api_path_literals(text)
        for raw in matches:
            normalized = _normalize_api_path(raw)
            if normalized in {"/api/v1", "/api/v1/"}:
                continue
            api_node = f"api_call:{normalized}"
            graph.add_node(api_node, "api_call", normalized)
            graph.add_edge(file_node, api_node, "calls_api")
            call_base = _normalize_path_template(normalized.split("?")[0]).rstrip("/")
            if call_base in endpoint_lookup:
                for endpoint_id in endpoint_ids_by_path.get(call_base, []):
                    graph.add_edge(api_node, endpoint_id, "targets_endpoint")
            else:
                for endpoint_path, endpoint_ids in endpoint_ids_by_path.items():
                    if _template_paths_match(call_base, endpoint_path):
                        for endpoint_id in endpoint_ids:
                            graph.add_edge(api_node, endpoint_id, "targets_endpoint")


def _extract_python_dependencies(graph: Graph, root: Path) -> None:
    py_files = _discover_python_files(root)
    module_index = _build_py_module_index(py_files, root)
    for path in py_files:
        rel = _repo_rel(path, root)
        src_node = f"file:{rel}"
        graph.add_node(src_node, "file", rel, rel)
        current_module = _module_for_py(path, root)
        imports = _extract_python_import_modules(path, current_module)
        for imported in imports:
            target_path = _resolve_local_py_target(imported, module_index)
            if not target_path:
                continue
            target_rel = _repo_rel(target_path, root)
            dst_node = f"file:{target_rel}"
            graph.add_node(dst_node, "file", target_rel, target_rel)
            graph.add_edge(src_node, dst_node, "imports")


def _extract_ts_dependencies(graph: Graph, root: Path) -> None:
    ts_files = _discover_ts_files(root)
    for path in ts_files:
        rel = _repo_rel(path, root)
        src_node = f"file:{rel}"
        graph.add_node(src_node, "file", rel, rel)
        imports = _extract_ts_imports(path)
        for imported in imports:
            target = _resolve_ts_path(path, imported)
            if not target:
                continue
            try:
                target_rel = _repo_rel(target, root)
            except ValueError:
                continue
            dst_node = f"file:{target_rel}"
            graph.add_node(dst_node, "file", target_rel, target_rel)
            graph.add_edge(src_node, dst_node, "imports")


def build_codemap(root: Path, include_portal: bool = True) -> dict[str, Any]:
    graph = Graph()
    _extract_python_dependencies(graph, root)
    endpoint_paths = _extract_api_endpoints(graph, root)
    if include_portal:
        _extract_ts_dependencies(graph, root)
        _extract_portal_routes(graph, root)
        _extract_ui_api_calls(graph, root, endpoint_paths)

    payload = graph.to_dict()
    payload["summary"] = {
        "node_count": len(payload["nodes"]),
        "edge_count": len(payload["edges"]),
        "by_type": _node_type_counts(payload["nodes"]),
    }
    return payload


def _node_type_counts(nodes: list[dict[str, Any]]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for node in nodes:
        node_type = str(node.get("type", "unknown"))
        counts[node_type] = counts.get(node_type, 0) + 1
    return counts


def _dot_color(node_type: str) -> str:
    return {
        "file": "#7aa2f7",
        "endpoint": "#9ece6a",
        "route": "#e0af68",
        "api_call": "#bb9af7",
    }.get(node_type, "#c0caf5")


def to_dot(payload: dict[str, Any]) -> str:
    lines = [
        "digraph codemap {",
        '  rankdir="LR";',
        '  graph [bgcolor="#0b0f14"];',
        '  node [shape="box" style="rounded,filled" color="#2e3440" fontname="Inter" fontsize=10];',
        '  edge [color="#4c566a" arrowsize=0.7];',
    ]
    for node in payload.get("nodes", []):
        node_id = str(node["id"]).replace('"', '\\"')
        label = str(node["label"]).replace('"', '\\"')
        fill = _dot_color(str(node.get("type", "")))
        lines.append(f'  "{node_id}" [label="{label}" fillcolor="{fill}" fontcolor="#0b0f14"];')
    for edge in payload.get("edges", []):
        src = str(edge["source"]).replace('"', '\\"')
        dst = str(edge["target"]).replace('"', '\\"')
        lines.append(f'  "{src}" -> "{dst}";')
    lines.append("}")
    return "\n".join(lines) + "\n"


def write_outputs(
    payload: dict[str, Any],
    json_path: Path,
    dot_path: Path,
    svg_path: Path | None = None,
) -> dict[str, str]:
    json_path.parent.mkdir(parents=True, exist_ok=True)
    dot_path.parent.mkdir(parents=True, exist_ok=True)
    json_path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    dot_path.write_text(to_dot(payload), encoding="utf-8")

    result = {
        "json": str(json_path),
        "dot": str(dot_path),
    }

    if svg_path is not None:
        svg_path.parent.mkdir(parents=True, exist_ok=True)
        try:
            subprocess.run(
                ["dot", "-Tsvg", str(dot_path), "-o", str(svg_path)],
                check=True,
                capture_output=True,
                text=True,
            )
            result["svg"] = str(svg_path)
        except Exception:
            result["svg"] = ""
    return result
