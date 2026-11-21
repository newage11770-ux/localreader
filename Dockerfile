# LocalReader Studio — Hugging Face Spaces (Docker SDK)
FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PORT=7860 \
    LOCALREADER_PORT=7860 \
    LOCALREADER_DOCKER=1 \
    TMPDIR=/tmp \
    HOME=/home/user

# Create non-root UID 1000 user required by Hugging Face Spaces
RUN useradd -m -u 1000 user

WORKDIR /app

# Install Python dependencies first for optimal Docker layer caching
COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir -r /app/requirements.txt

# Copy application backend and frontend
COPY backend/ /app/backend/
COPY frontend/ /app/frontend/

# Ensure /app and /tmp (including temporary exports) are writable by non-root UID 1000
RUN mkdir -p /tmp/localreader_exports && \
    chown -R 1000:1000 /app /tmp/localreader_exports && \
    chmod -R u+rwX /app && \
    chmod 1777 /tmp

USER 1000

EXPOSE 7860

CMD ["uvicorn", "backend.main:app", "--host", "0.0.0.0", "--port", "7860"]
