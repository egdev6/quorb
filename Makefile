# Quorb Makefile — shortcuts over the M0 devcontainer.
#
# Requires the official devcontainer CLI:
#   brew install devcontainer/tap/devcontainer   # macOS
#   sudo apt-get install -y devcontainer-cli     # Debian/Ubuntu
#   or: npm i -g @devcontainers/cli
# (VS Code with the Dev Containers extension works as an alternative, but the
# targets below assume the CLI is on PATH.)
#
# Usage:
#   make up        # builds the image and opens the container (postCreate
#                  # installs Node 22, Rust stable and the Tauri Linux deps)
#   make shell     # opens bash inside the container
#   make test      # runs cargo test --locked + npm test
#   make exec CMD="cargo run --example"   # runs a command inside
#   make stop      # stops the container (keeps state)
#   make nuke      # stops the container and removes images/volumes (DESTRUCTIVE)
#   make help      # lists the targets

WORKSPACE := .devcontainer/devcontainer.json
LABEL     := quorb-linux-dev
PROJECT   := $(notdir $(CURDIR))

DC   := devcontainer
DOCKER := docker

.PHONY: help up shell down stop nuke test exec lint fmt

help: ## Lists the targets
	@awk 'BEGIN {FS = ":.*?## "} /^[a-zA-Z_-]+:.*?## / {printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)

up: build run ## Builds the image and opens the container (alias of up)

build: ## Builds the devcontainer image (pulls the base + installs features)
	$(DC) build --workspace-folder $(WORKSPACE) --image-name $(LABEL):latest

run: ## Opens the container with the devcontainer CLI (creates if missing)
	$(DC) up --workspace-folder $(WORKSPACE)

shell: ## Opens an interactive shell inside the container
	$(DC) exec --workspace-folder $(WORKSPACE) bash

exec: ## Runs a command inside the container — make exec CMD="cargo build"
	@test -n "$(CMD)" || { echo "usage: make exec CMD=\"...\""; exit 2; }
	$(DC) exec --workspace-folder $(WORKSPACE) bash -c "$(CMD)"

test: ## Runs the Rust tests and the frontend tests
	$(DC) exec --workspace-folder $(WORKSPACE) bash -c 'set -e; \
		(cd src-tauri && cargo test --locked) && npm test'

lint: ## Runs clippy (Rust) and typecheck (TS) in the container
	$(DC) exec --workspace-folder $(WORKSPACE) bash -c 'set -e; \
		(cd src-tauri && cargo clippy --all-targets -- -D warnings) && npm run typecheck'

fmt: ## Autoformats (rustfmt in Rust, prettier in the frontend) inside the container
	$(DC) exec --workspace-folder $(WORKSPACE) bash -c 'set -e; \
		(cd src-tauri && cargo fmt --all) && npx --yes prettier --write .'

down: ## Stops the container (alias of stop)
	$(DC) down --workspace-folder $(WORKSPACE)

stop: ## Stops the container (keeps the cargo/npm cache volumes)
	$(DC) down --workspace-folder $(WORKSPACE)

nuke: ## Stops the container and removes images, volumes and cache (DESTRUCTIVE)
	$(DC) down --workspace-folder $(WORKSPACE) --force || true
	$(DOCKER) rmi -f $(LABEL):latest 2>/dev/null || true
	$(DOCKER) volume rm quorb-cargo-home quorb-npm-cache 2>/dev/null || true
	@echo "Cache and volumes removed. The next \`make up\` will rebuild from scratch."