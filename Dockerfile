FROM python:3.13-slim

WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    git curl && rm -rf /var/lib/apt/lists/*

# Install Python dependencies (including sandbox/E2B support)
COPY pyproject.toml .
RUN pip install --no-cache-dir -e ".[dev,postgres,sandbox]" && pip install pyyaml python-multipart

# Copy source
COPY . .
RUN pip install --no-cache-dir -e ".[postgres,sandbox]"

# Initialize default project
RUN mkdir -p data agents tools eval sessions && \
    python -c "from agentos.core.database import create_database; create_database('data/agent.db').close()"

# Expose API port
EXPOSE 8080

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
    CMD sh -c 'curl -f "http://localhost:${PORT:-8080}/health" || exit 1'

# Run the API server
CMD ["sh", "-c", "python -m uvicorn agentos.api.app:create_app --host 0.0.0.0 --port ${PORT:-8080} --factory"]
