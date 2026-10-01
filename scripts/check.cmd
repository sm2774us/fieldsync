@echo off
REM Runs every check CI runs, inside Linux containers (no Python/Node needed on Windows).
REM Run from the repo root:  scripts\check.cmd
echo == Python: lint, types, tests, demo ==
docker run --rm -v "%cd%":/src:ro python:3.13-slim sh -c "cp -r /src /tmp/w && cd /tmp/w && pip install -q -c constraints.txt -e '.[dev,mcp]' && ruff check . && ruff format --check . && mypy src && pytest --cov=fieldsync --cov-report=term-missing && python evals/run.py --rules-only && fieldsync-admin demo"
if errorlevel 1 exit /b 1
echo == TypeScript SDK ==
docker run --rm -v "%cd%":/src:ro node:22-slim sh -c "cp -r /src /tmp/w && cd /tmp/w/sdk-ts && npm ci --ignore-scripts --no-audit --no-fund && npm run typecheck && npm test"
if errorlevel 1 exit /b 1
echo == Web console ==
docker run --rm -v "%cd%":/src:ro node:22-slim sh -c "cp -r /src /tmp/w && cd /tmp/w/web && npm ci --ignore-scripts --no-audit --no-fund && npm run check"
if errorlevel 1 exit /b 1
echo All checks passed.
