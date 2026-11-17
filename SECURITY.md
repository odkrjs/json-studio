# Security Policy

## Supported versions

| Version | Supported |
| --- | --- |
| 1.x | ✅ |
| < 1.0 | ❌ |

## Reporting a vulnerability

Please **do not open a public issue** for a security vulnerability.

Use GitHub's private vulnerability reporting for this repository:

1. Open the **Security** tab.
2. Choose **Advisories** or **Report a vulnerability**.
3. Include the app version, macOS version, reproduction steps, and a minimal proof of concept.

If private reporting is not available, open a minimal public issue asking the maintainers for a private contact channel. Do not include exploit details or sensitive data in that issue.

You can expect an initial acknowledgement within three business days. We will investigate, keep you informed of the remediation plan, and credit you in the advisory unless you prefer otherwise. This is a volunteer-maintained project, so please allow reasonable time for a fix.

## Scope

JSON Studio is a local, offline macOS application. The highest-value areas to review are:

- The custom JSON parser in `Resources/core.js`, including deeply nested input, malformed numbers, surrogate pairs, duplicate keys, and oversized documents.
- The Unescape String transformations and nested JSON expansion.
- HTML escaping in tree, diff, and error rendering.
- File import through the native shell and the local `WKWebView` boundary.
- The ad-hoc signed packaging and release archive.

Out of scope:

- Vulnerabilities requiring a compromised local account or debugger access.
- Issues that only affect macOS versions below the documented minimum.
- Denial of service caused solely by deliberately opening an extremely large file that exceeds the documented import limit.

## Security model

- The app does not include analytics, telemetry, auto-update, or remote code loading.
- All HTML, CSS, and JavaScript assets are bundled with the app. There are no third-party runtime dependencies.
- Imported files are read locally and rendered in a local `WKWebView`.
- External `http`/`https` links are opened in the user's browser rather than inside the app.

## Release integrity

Release archives include a SHA-256 checksum. The app is ad-hoc signed and not notarized. If you distribute a build broadly, re-sign it with your own Developer ID and notarize it with Apple.

## Safe harbor

We will not pursue legal action against security researchers who follow this policy, act in good faith, and avoid privacy violations, service disruption, or data destruction while investigating.
