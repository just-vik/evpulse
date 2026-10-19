FROM python:3.11-slim

WORKDIR /app

# Build deps for rasterio (GDAL bindings) — removed after install via multi-stage
RUN apt-get update && apt-get install -y --no-install-recommends \
      git \
      libgdal-dev \
      gdal-bin \
    && rm -rf /var/lib/apt/lists/*

# Clone opentopodata at a pinned commit (main, 2024-stable)
# Pin to a specific SHA before any future breaking changes:
#   git -C /tmp/otd log --oneline -3
ARG OTDATA_REF=master
RUN git clone --depth=1 --branch ${OTDATA_REF} \
      https://github.com/ajnisbet/opentopodata.git . && \
    pip install --no-cache-dir -r requirements.txt gunicorn==21.2.0 && \
    rm -rf .git

RUN mkdir -p /app/data

EXPOSE 5000

CMD ["gunicorn", "--bind", "0.0.0.0:5000", "--workers", "2", "--timeout", "30", \
     "opentopodata.api:app"]
