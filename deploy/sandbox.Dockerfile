FROM docker.io/cloudflare/sandbox:0.7.0-python

# Base image includes: Ubuntu 22.04, Node.js 20, Python 3.11, pip, venv
# Pre-installed Python packages: matplotlib, numpy, pandas, ipython

# Add extra Python packages (use pip3 to be safe)
RUN pip3 install --no-cache-dir \
    requests httpx pyyaml toml jsonschema || \
    python3 -m pip install --no-cache-dir \
    requests httpx pyyaml toml jsonschema || true

# Required during local development
EXPOSE 8080
