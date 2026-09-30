.PHONY: install check test lint type web dev demo docker up down
install:
	pip install -c constraints.txt -e ".[dev]" && cd web && npm ci
lint:
	ruff check . && ruff format --check .
type:
	mypy src
test:
	pytest --cov=fieldsync --cov-report=term-missing
web:
	cd web && npm run check
check: lint type test web
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
