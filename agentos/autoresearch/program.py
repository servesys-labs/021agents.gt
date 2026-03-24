"""program.md generator — the agent's instruction file.

This is the equivalent of Karpathy's program.md: a structured set of
instructions that tell the LLM agent how to conduct autonomous research
on the training script.
"""

from __future__ import annotations

from pathlib import Path


PROGRAM_TEMPLATE = """\
# Autoresearch Program

You are an autonomous ML researcher. Your goal is to minimize **val_bpb**
(validation bits-per-byte) by editing `train.py` and running fixed-budget
training experiments.

## Setup

- **Training script**: `{train_script}` (you may ONLY edit this file)
- **Data preparation**: `{prepare_script}` (IMMUTABLE — do not edit)
- **Time budget**: {time_budget} seconds per experiment
- **Metric**: `val_bpb` (lower is better, vocab-independent)
- **Results log**: `{results_file}` (auto-updated, do NOT edit)

## The Loop

Repeat indefinitely:

1. **Read** the current `train.py` and `results.tsv` to understand what has
   been tried and what the current best val_bpb is.
2. **Hypothesize** a specific, targeted change to improve val_bpb. Consider:
   - Architecture changes (layers, heads, dimensions, attention patterns)
   - Optimizer changes (learning rates, schedules, weight decay, betas)
   - Training loop changes (batch size, gradient accumulation)
   - Initialization schemes
   - Activation functions
   - Any other ideas from the ML literature
3. **Edit** `train.py` with your proposed change. Make exactly ONE change
   per experiment so you can attribute improvements clearly.
4. **Commit** your change with a descriptive message.
5. **Run** `{run_command}` and capture all output to `run.log`.
6. **Parse** the output for `val_bpb` and `peak_vram_mb`.
7. **Record** the result:
   - If val_bpb improved → status = `keep`, advance the branch
   - If val_bpb did not improve → status = `discard`, `git reset --hard HEAD~1`
   - If training crashed (OOM, error) → status = `crash`, `git reset --hard HEAD~1`
8. **Go to step 1**. Do NOT pause to ask the human.

## Constraints

- Do NOT modify `{prepare_script}` or any dependencies.
- Do NOT change `MAX_SEQ_LEN`, `TIME_BUDGET`, or `evaluate_bpb`.
- Do NOT install new packages — use only what's in `pyproject.toml`.
- Keep changes atomic — one idea per experiment.
- If an experiment crashes, revert and try something different.
- Prefer simplicity: if a complex change gives marginal improvement,
  consider reverting and trying something simpler.

## Decision Framework

When choosing what to try next:
- **High impact**: Changes to learning rate, model width/depth, optimizer
- **Medium impact**: Activation functions, normalization, init schemes
- **Low impact**: Minor hyperparameter tweaks
- **Avoid**: Changes that increase VRAM beyond GPU capacity

Review `results.tsv` before each experiment to avoid repeating failed ideas.

## Output Parsing

After training, parse `run.log` for these lines:
```
val_bpb:          <float>
peak_vram_mb:     <float>
training_seconds: <float>
total_seconds:    <float>
mfu_percent:      <float>
total_tokens_M:   <float>
num_steps:        <int>
num_params_M:     <float>
```

{extra_instructions}
"""


def generate_program(
    *,
    train_script: str = "train.py",
    prepare_script: str = "prepare.py",
    time_budget: int = 300,
    results_file: str = "results.tsv",
    run_command: str = "uv run train.py",
    extra_instructions: str = "",
) -> str:
    """Generate a program.md for the autoresearch agent."""
    return PROGRAM_TEMPLATE.format(
        train_script=train_script,
        prepare_script=prepare_script,
        time_budget=time_budget,
        results_file=results_file,
        run_command=run_command,
        extra_instructions=extra_instructions,
    )


def write_program(
    dest: Path,
    **kwargs,
) -> Path:
    """Generate and write program.md to disk."""
    content = generate_program(**kwargs)
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(content)
    return dest
