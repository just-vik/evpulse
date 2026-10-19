FROM python:3.11-slim

WORKDIR /app

# opentopodata 1.8.0 — pinned, last stable release
RUN pip install --no-cache-dir opentopodata==1.8.0 gunicorn==21.2.0

# Config is bind-mounted at runtime; create placeholder so image builds cleanly
RUN mkdir -p /app/data

EXPOSE 5000

CMD ["gunicorn", "--bind", "0.0.0.0:5000", "--workers", "2", "--timeout", "30", "opentopodata.api:app"]
