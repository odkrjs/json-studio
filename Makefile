SHELL := /bin/bash

.PHONY: help check test test-ui build release run clean

help:
	@printf "JSON Studio\n\n"
	@printf "  make check      Run JavaScript syntax checks and core tests\n"
	@printf "  make test       Run core parser/diff/unescape tests\n"
	@printf "  make test-ui    Run optional headless-Chrome UI checks\n"
	@printf "  make build      Build build/JSON Studio.app\n"
	@printf "  make release    Build dist/JSONStudio-<version>-macOS.zip\n"
	@printf "  make run        Build and open the app\n"
	@printf "  make clean      Remove build/ and dist/\n"

check:
	node --check Resources/core.js
	node --check Resources/app.js
	node --test tests/core.test.js

test:
	node --test tests/core.test.js

test-ui:
	node tests/ui-check.mjs

build:
	./build.sh

release:
	./make-release.sh

run: build
	open "build/JSON Studio.app"

clean:
	rm -rf build dist
