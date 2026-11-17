# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- English README and Chinese README translation.
- Open-source project documentation, issue forms, and CI/release workflows.

## [1.0.0] - 2026-11-17

### Added

- Native macOS app (AppKit + WKWebView) with light/dark appearance, menus, and window state.
- JSON parser and serializer that preserve object key order and numeric spelling.
- Syntax-highlighted editor with line numbers, error line/column reporting, and undo support.
- Collapsible tree view with value/path copy actions.
- Format (two-space indentation) and compress actions.
- Unescape String tool with whole-text and nested-JSON modes.
- Semantic JSON comparison that ignores object key order, compares arrays by index, and compares numbers numerically.
- Difference summary, only-differences filter, expandable diff tree, and equality banner.
- File import through the toolbar, drag-and-drop, and Finder's Open With.
- Universal `arm64 + x86_64` build and ad-hoc signed release packaging.
- Node test suite with deterministic property tests and optional headless-Chrome UI checks.
