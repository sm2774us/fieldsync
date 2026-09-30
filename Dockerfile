# syntax=docker/dockerfile:1.7
FROM python:3.13-slim AS build
ENV PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1
WORKDIR /src
COPY pyproject.toml README.md constraints.txt ./
COPY src ./src
RUN pip wheel --wheel-dir /wheels -c constraints.txt "."

FROM python:3.13-slim AS runtime
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 SYNC_DATA_DIR=/var/lib/fieldsync
RUN useradd --system --uid 10001 --no-create-home --shell /usr/sbin/nologin fieldsync \
 && mkdir -p /var/lib/fieldsync && chown fieldsync /var/lib/fieldsync
COPY --from=build /wheels /wheels
RUN pip install --no-index --find-links=/wheels "fieldsync" && rm -rf /wheels
USER 10001
EXPOSE 8080
VOLUME ["/var/lib/fieldsync"]
HEALTHCHECK --interval=15s --timeout=3s --retries=3 \
  CMD python -c "import urllib.request as u; u.urlopen('http://127.0.0.1:8080/healthz', timeout=2)"
CMD ["python", "-m", "fieldsync.app"]
