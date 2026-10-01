.PHONY: install check test lint type evals sdk web dev demo docker up down
install:
	pip install -c constraints.txt -e ".[dev,mcp]" && cd sdk-ts && npm ci && cd ../web && npm ci
lint:
	ruff check . && ruff format --check .
type:
	mypy src
test:
	pytest --cov=fieldsync --cov-report=term-missing
evals:
	python evals/run.py --rules-only
sdk:
	cd sdk-ts && npm run typecheck && npm test
web:
	cd web && npm run check
check: lint type test evals demo sdk web
dev:
	bash scripts/dev.sh
demo:
	fieldsync-admin demo
docker:
	docker build -t fieldsync:dev . && docker build -t fieldsync-console:dev web
up:
	docker compose up -d --build --wait
down:
	docker compose down
