# Checks every plugin in this marketplace with the Claude Code CLI.
PLUGINS := $(wildcard plugins/*)

.PHONY: check validate test test-plugins test-scripts dev

check: validate test

validate:
	claude plugin validate .
	@for p in $(PLUGINS); do claude plugin validate $$p || exit 1; done

test: test-plugins test-scripts

test-plugins:
	@for p in $(PLUGINS); do claude plugin test $$p || exit 1; done

# Node scripts a plugin ships beside its hooks module, tested with node --test.
SCRIPT_TESTS := $(wildcard plugins/*/scripts/*.test.mjs)
test-scripts:
	@if [ -n "$(SCRIPT_TESTS)" ]; then node --test $(SCRIPT_TESTS); fi

# Run a Claude Code session with one plugin loaded from this checkout, hot-reloading on save:
#   make dev PLUGIN=context-bar
dev:
	claude --plugin-dir plugins/$(PLUGIN)
