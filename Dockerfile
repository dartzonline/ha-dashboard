FROM node:22-alpine AS frontend-build
WORKDIR /build/frontend

COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci

COPY frontend/ ./
RUN npm run build

FROM python:3.12-slim AS runtime
ARG BUILD_VERSION=0.1.0
ARG BUILD_ARCH=amd64
LABEL io.hass.version="${BUILD_VERSION}" \
      io.hass.type="app" \
      io.hass.arch="${BUILD_ARCH}"
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1
WORKDIR /app

COPY backend/requirements.txt ./backend/requirements.txt
RUN pip install --no-cache-dir -r backend/requirements.txt

COPY backend/app ./backend/app
COPY backend/addon_entrypoint.py ./backend/addon_entrypoint.py
COPY --from=frontend-build /build/frontend/dist ./frontend/dist

RUN mkdir -p backend/data
# Supervisor writes /data/options.json (this add-on's OpenSky/AirLabs credentials among other
# things) as root-only (0600) since it can hold secrets. A non-root USER here could never read
# it -- addon_entrypoint.py would silently fail with EACCES and the add-on would run with those
# options unset, which is exactly what happened. Home Assistant add-ons default to running as
# root for this reason; this container follows that default rather than fighting it.
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/api/health', timeout=2)"]

CMD ["python", "backend/addon_entrypoint.py"]
