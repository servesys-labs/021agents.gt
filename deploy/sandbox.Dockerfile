FROM docker.io/cloudflare/sandbox:0.7.0-python

# Base image includes: Ubuntu 22.04, Node.js 20, Python 3.11, pip, venv
# Pre-installed Python packages: matplotlib, numpy, pandas, ipython

ENV DEBIAN_FRONTEND=noninteractive

# Assistant-office profile: document generation/conversion + media/file utilities.
RUN apt-get update && apt-get install -y --no-install-recommends \
    libreoffice \
    pandoc \
    ghostscript \
    poppler-utils \
    tesseract-ocr \
    tesseract-ocr-eng \
    ffmpeg \
    jq \
    ripgrep \
    unzip \
    zip \
    fonts-noto-core \
    fonts-noto-cjk \
    fonts-noto-color-emoji \
    fonts-dejavu-core && \
    rm -rf /var/lib/apt/lists/*

# Pinned Python packages for common personal-assistant workloads.
COPY sandbox.requirements.assistant-office.txt /tmp/sandbox.requirements.assistant-office.txt
RUN pip3 install --no-cache-dir -r /tmp/sandbox.requirements.assistant-office.txt

# Required during local development
EXPOSE 8080
