from __future__ import annotations

from agentos.graph.state_patch import apply_state_patch


def test_apply_state_patch_with_reducers() -> None:
    state = {"facts": ["a"], "winner": {"value": "x", "score": 0.5}}
    patch = {
        "ops": [
            {"op": "merge", "key": "facts", "value": "b", "reducer": "append"},
            {"op": "merge", "key": "tags", "value": "core", "reducer": "set_union"},
            {"op": "merge", "key": "tags", "value": "core", "reducer": "set_union"},
            {"op": "merge", "key": "winner", "value": "y", "reducer": "scored_merge", "score": 0.9},
        ],
    }
    out = apply_state_patch(state, patch)
    assert out["facts"] == ["a", "b"]
    assert out["tags"] == ["core"]
    assert out["winner"]["value"] == "y"
    assert out["winner"]["score"] == 0.9


def test_apply_state_patch_uses_default_reducer_map() -> None:
    state = {"mem": ["x"]}
    patch = {"ops": [{"op": "merge", "key": "mem", "value": "y"}]}
    out = apply_state_patch(state, patch, reducers={"mem": "append"})
    assert out["mem"] == ["x", "y"]

