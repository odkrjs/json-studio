# Contributing to JSON Studio

Thanks for taking the time to contribute. Bug reports, feature ideas, documentation fixes, and pull requests are all welcome.

By participating, you agree to follow our [Code of Conduct](CODE_OF_CONDUCT.md).

## Ways to contribute

- **Report a bug** with the bug report issue form. Include your macOS version, app version, steps to reproduce, and a minimal JSON sample when possible.
- **Request a feature** with the feature request form. Explain the workflow you are trying to improve.
- **Improve documentation** in `README.md`, `README.zh.md`, or `docs/`.
- **Help with localization.** The current interface is Simplified Chinese; an English or additional locale is a welcome contribution.
- **Send a pull request** for a focused fix or feature.

For large behavior changes, open an issue before writing the implementation. It is easier to agree on the approach first.

Please do not paste secrets, tokens, or private customer data into issues, pull requests, examples, or screenshots. Redact JSON fixtures.

## Development setup

### Requirements

- macOS 13 or later
- Xcode Command Line Tools: `xcode-select --install`
- Node.js 20 or later for tests
- Google Chrome only for the optional headless UI checks

No package installation or third-party runtime dependency is required.

### Build and test

```bash
# Core parser, serializer, diff, and unescape tests
node --test tests/core.test.js

# Optional UI integration checks (Google Chrome required)
node tests/ui-check.mjs

# Build build/JSON Studio.app
./build.sh

# Build a signed distribution ZIP in dist/
./make-release.sh
```

You can also use `make test`, `make build`, and `make release`.

`build.sh` produces a universal `arm64 + x86_64` app. The release script stages the app outside the repository, re-signs it, verifies the signature, and packages it with the documentation and screenshots.

### Repository map

| Path | Purpose |
| --- | --- |
| `Native/main.m` | AppKit window, menus, file import, WKWebView host |
| `Resources/index.html` | App layout |
| `Resources/styles.css` | Light/dark visual design |
| `Resources/core.js` | JSON parser, serializer, diff, unescape, highlighting |
| `Resources/app.js` | Editor, tree view, compare view, modal and file interactions |
| `tests/core.test.js` | Node unit and property tests |
| `tests/ui-check.mjs` | Optional end-to-end UI checks through Chrome DevTools Protocol |
| `scripts/make-icon.py` | Reproducible app icon generation |
| `docs/` | Architecture and screenshots |

Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) before making changes to the parser or diff engine.

## Coding guidelines

### JavaScript and CSS

- Keep `Resources/core.js` dependency-free, synchronous, and independent of the DOM. It is the public core used by tests.
- Use modern JavaScript supported by macOS 13 WebKit; do not add a build step or transpiler.
- Use two-space indentation, single quotes, and semicolons in JavaScript. Keep CSS custom properties in `:root` for theme colors.
- Avoid runtime dependencies. The app must remain offline and self-contained.
- Escape user-controlled JSON before inserting it into HTML. `core.escapeHTML` is available for this.
- Keep large-input behavior bounded. Tree and diff rendering is capped at 8,000 rows; preserve that cap or add an equivalent guard.

### Objective-C

- Use ARC (`-fobjc-arc` is already set in `build.sh`).
- Keep the native shell small. UI behavior belongs in the web resources unless it needs AppKit or WebKit.
- Use four-space indentation.
- Do not add private WebKit APIs.

### Tests

- Add a unit test for every parser, serializer, diff, or unescape behavior change.
- Include malformed-input cases when changing error handling.
- For UI changes, run the optional UI checks and verify both format and compare modes in light and dark appearance.
- New sample fixtures should be small and contain no personal or confidential data.

## Commit and pull request guidelines

- Keep pull requests focused. Separate refactors from behavior changes when practical.
- Write commit messages in the imperative mood, for example `Fix duplicate key error position`.
- Describe the user-visible change, the reason for it, and how you tested it.
- Include before/after screenshots for visual changes.
- Update `CHANGELOG.md` under `[Unreleased]` for user-visible changes.
- Link the relevant issue when one exists.

The pull request template includes a checklist to help with this.

## Release process

1. Update the version in `Info.plist` and `package.json`.
2. Move the changelog entries from `[Unreleased]` into a new version section.
3. Run `node --test tests/core.test.js` and `./make-release.sh`.
4. Inspect the generated ZIP and its `.sha256` file.
5. Create a git tag such as `v1.0.0` and publish a GitHub Release with the ZIP and checksum.
6. If you have a Developer ID certificate, sign and notarize the app before distributing it broadly.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
