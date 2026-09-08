#!/usr/bin/env bash
#
# CI defence-in-depth — STATIC scan for hardcoded LIVE broker hostnames in the
# tracked test tree. Node-independent (pure git + grep + sed), so it holds even
# if the runtime egress guard (.github/ci/no-egress-guard.mjs) were ever bypassed
# or removed.
#
# WHY A PATH ALLOW-LIST AND NOT "ban every mention in code"
#   The suite is made hermetic by an INTERCEPTOR (tests/helpers/hermeticNetwork.mjs)
#   that recognises the live broker hostnames and serves a checked-in fixture INSTEAD
#   of dialling them. That interceptor — and the regression test that drives it — must,
#   by construction, contain the hostnames as executable string literals. So "no live
#   hostname anywhere in executable code" is not a property this codebase can satisfy:
#   the very mechanism that keeps it hermetic names those hosts on purpose.
#
#   The provable invariant is therefore narrower and honest:
#     * The hermetic-infrastructure files (the interceptor + its own regression test)
#       are the ONLY places a live broker hostname may appear as executable code. They
#       are named on FILE_ALLOWLIST below. They run under the runtime egress guard, so
#       even their literals never reach the network.
#     * EVERY OTHER tracked test file must not reference a live broker hostname in
#       executable (non-comment) code. A new suite that hardcodes images.dhan.co in a
#       fetch — i.e. re-introduces a real dial-out path — is flagged RED.
#
# WHAT IT DOES
#   * Looks ONLY at tracked files under tests/ (git ls-files), so build output,
#     node_modules or local scratch cannot trip it.
#   * Skips the FILE_ALLOWLIST entries entirely (they are the interception seam).
#   * For every other test file, ignores matches inside comments (a `//` line comment,
#     a line inside a `/* … */` block, or a JSDoc `*` continuation line) and inside
#     Markdown prose (`.md` files are documentation, never executable), then flags any
#     remaining reference to a LIVE broker hostname.
#   * Exits non-zero (RED) if any such reference remains.
#
# Live broker hostnames a hermetic test must never dial:
#     images.dhan.co  api.dhan.co  auth.dhan.co  api.kite.trade  calspread.online
#
# TO ADD AN ALLOWED DESTINATION
#   If a NEW file must legitimately reference a broker host as executable code (e.g. a
#   second interceptor), add its repo-relative path to FILE_ALLOWLIST below with a
#   one-line justification. Do NOT relax the hostname pattern — narrow the allowance to
#   the specific file that owns the interception, so the blast radius stays visible.
#
# Usage:  no-live-hostnames.sh [root]     (root defaults to the repo cwd)

set -euo pipefail

ROOT="${1:-.}"
cd "$ROOT"

# Live broker hostnames that a hermetic test must never reach.
HOSTS='images\.dhan\.co|api\.dhan\.co|auth\.dhan\.co|api\.kite\.trade|calspread\.online'

# Files that ARE the hermetic interception seam and therefore MUST name these hosts as
# executable code. Each is exercised under the runtime egress guard, so its literals are
# served from fixtures and never dial out. Keep this list minimal and justified.
FILE_ALLOWLIST=(
  # The fetch interceptor: matches the live hostnames to serve checked-in fixtures.
  "tests/helpers/hermeticNetwork.mjs"
  # The interceptor's own regression test: drives fetch() at those hosts to prove the
  # interceptor serves the fixture rather than the network.
  "tests/box/hermeticNetwork.test.mjs"
)

is_allowlisted_file() {
  local file="$1" entry
  for entry in "${FILE_ALLOWLIST[@]}"; do
    [ "$entry" = "$file" ] && return 0
  done
  return 1
}

# All tracked test files.
mapfile -t FILES < <(git ls-files 'tests/**' 2>/dev/null || git ls-files | grep '^tests/')

violations=0
for f in "${FILES[@]}"; do
  [ -f "$f" ] || continue
  if is_allowlisted_file "$f"; then
    continue
  fi
  # Markdown is documentation, never executable — skip it wholesale.
  case "$f" in
    *.md) continue ;;
  esac

  # Track whether we are inside a /* … */ block so multi-line banners are ignored.
  in_block=0
  lineno=0
  while IFS= read -r line || [ -n "$line" ]; do
    lineno=$((lineno + 1))
    stripped="$line"

    # Handle block-comment state transitions (coarse but sufficient for these
    # single-purpose test files, which only use banner-style /** … */ blocks).
    if [ "$in_block" -eq 1 ]; then
      if printf '%s' "$line" | grep -q '\*/'; then in_block=0; fi
      continue
    fi
    if printf '%s' "$line" | grep -qE '/\*'; then
      # A block opens on this line; if it does not also close, enter block state.
      printf '%s' "$line" | grep -qE '\*/' || in_block=1
      # Drop the block-comment portion before scanning the rest of the line.
      stripped="$(printf '%s' "$line" | sed -E 's#/\*.*$##')"
    fi

    # Drop `//` line comments, but NOT the `//` inside a URL scheme (`https://`,
    # `http://`). Only a `//` that is at line start or preceded by whitespace or a
    # non-`:` character begins a comment; `://` never does. This keeps a real
    # `fetch("https://images.dhan.co/…")` intact so it is still scanned, while a
    # trailing `// … images.dhan.co …` comment is dropped.
    stripped="$(printf '%s' "$stripped" | sed -E 's#(^|[^:])//.*$#\1#')"
    # Drop JSDoc `*` continuation lines.
    if printf '%s' "$stripped" | grep -qE '^[[:space:]]*\*'; then
      continue
    fi

    # Now test only the executable remainder of the line.
    if printf '%s' "$stripped" | grep -qE "$HOSTS"; then
      host="$(printf '%s' "$stripped" | grep -oE "$HOSTS" | head -n1)"
      echo "FAIL: live broker hostname '${host}' in executable code: ${f}:${lineno}"
      echo "      ${line}"
      violations=$((violations + 1))
    fi
  done < "$f"
done

if [ "$violations" -ne 0 ]; then
  echo ""
  echo "${violations} hardcoded live-broker hostname reference(s) found in executable test code."
  echo "Hermetic tests must drive the interceptor in tests/helpers/hermeticNetwork.mjs (which"
  echo "serves a checked-in fixture) rather than dialling a broker. If a reference is legitimate"
  echo "prose, keep it inside a comment; if a NEW file genuinely owns an interception seam, add"
  echo "its path to FILE_ALLOWLIST in .github/ci/no-live-hostnames.sh with a justification."
  exit 1
fi

echo "OK: no hardcoded live-broker hostnames in executable test code."
echo "    (comments and Markdown prose are ignored; the hermetic interception seam"
echo "     — ${FILE_ALLOWLIST[*]} — is allow-listed by path.)"
