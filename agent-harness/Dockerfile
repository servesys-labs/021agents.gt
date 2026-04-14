# ╔═══════════════════════════════════════════════════════════════════════╗
# ║  Agent Harness — Thin Sandbox Image                                 ║
# ║                                                                     ║
# ║  Philosophy: The base image + build tools is enough. The agent      ║
# ║  installs what it needs at runtime via `uv pip install` or          ║
# ║  `apt-get install`. This keeps the image small and the instance     ║
# ║  type cheap.                                                        ║
# ║                                                                     ║
# ║  Base: cloudflare/sandbox:0.8.10-python (Ubuntu 22.04)             ║
# ║  Pre-installed by base image:                                       ║
# ║    • Python 3.11 + pip + venv + numpy + pandas + matplotlib        ║
# ║    • IPython                                                        ║
# ║    • Node.js 20 LTS + npm + Bun 1.x                               ║
# ║    • git, curl, wget, jq, zip/unzip, procps, ca-certificates      ║
# ║                                                                     ║
# ║  Instance: basic (1/4 vCPU, 1 GiB RAM, 4 GB disk)                 ║
# ╚═══════════════════════════════════════════════════════════════════════╝

FROM docker.io/cloudflare/sandbox:0.8.10-python

# ─── Build essentials (needed to compile C extensions at runtime) ─────
# Without these, `pip install scipy`, `scikit-learn`, etc. will fail.
# Also includes common system tools agents frequently need.
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    libssl-dev \
    libffi-dev \
    # Useful CLI tools that are small but annoying to wait for
    ripgrep \
    tree \
    sqlite3 \
    less \
    vim-tiny \
    && rm -rf /var/lib/apt/lists/*

# ─── UV (fast Python package manager) ────────────────────────────────
# Makes runtime installs near-instant: `uv pip install scipy` < 10s
RUN curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR="/usr/local/bin" sh

# ─── Environment ──────────────────────────────────────────────────────
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /workspace

# Base image sets ENTRYPOINT ["/sandbox"] — do NOT override
