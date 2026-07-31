# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

This repository is Streamlit's "blank app template" — a minimal starting point for a Streamlit application, not yet built out into a specific product. `streamlit_app.py` is currently just the placeholder scaffold. Treat existing content as disposable boilerplate to build on, not established convention to preserve.

## Commands

Dependency management and running use [`uv`](https://docs.astral.sh/uv/) (not pip/venv directly).

```
uv sync                              # install dependencies from pyproject.toml / uv.lock
uv run streamlit run streamlit_app.py   # run the app locally (serves on port 8501)
```

There is no test suite, linter, or formatter configured in this repo yet. If you add one, wire it up via `uv run <tool>` and update this section.

## Architecture

- `streamlit_app.py` is the entry point Streamlit executes; it currently defines the entire app inline. As the app grows, keep `streamlit_app.py` as the top-level entry point and factor logic into additional modules rather than letting it become a monolith.
- `pyproject.toml` declares the dependency set and requires Python >=3.14 (`.python-version` pins local dev to 3.14). `[tool.uv] package = false` — this project is an app, not a distributable package, so don't add packaging metadata (`build-system`, entry points, etc.) unless the project's purpose changes.
- `uv.lock` is committed and kept fresh by Dependabot (`.github/dependabot.yml`), which opens a daily batched PR for `uv`-ecosystem updates grouped under `python-dependencies`. This lockfile is also what the Streamlit Community Cloud deployment installs from — don't let it drift from `pyproject.toml`.
- No secrets are committed; `.streamlit/secrets.toml` is gitignored, which is the expected place for local Streamlit secrets (API keys, etc.) per Streamlit convention.
- `.devcontainer/devcontainer.json` defines a Codespaces/VS Code dev container (Python 3.14) that runs `uv sync` on creation and auto-launches `streamlit run streamlit_app.py` (CORS/XSRF protections disabled for the container preview) with port 8501 forwarded.
