# Checks every plugin in this marketplace with the Claude Code CLI.
PLUGINS := $(wildcard plugins/*)

.PHONY: check validate test dev

check: validate test

validate:
	claude plugin validate .
	@for p in $(PLUGINS); do claude plugin validate $$p || exit 1; done

test:
	@for p in $(PLUGINS); do claude plugin test $$p || exit 1; done

# Run a Claude Code session with one plugin loaded from this checkout, hot-reloading on save:
#   make dev PLUGIN=context-bar
dev:
	claude --plugin-dir plugins/$(PLUGIN)
