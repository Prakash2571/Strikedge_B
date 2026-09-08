#!/usr/bin/env bash
#
# CI defence-in-depth — STATIC scan for hardcoded LIVE broker hostnames in the
# tracked test tree. Node-independent (git + awk only), so it holds even if the
# runtime egress guard (.github/ci/no-egress-guard.mjs) were bypassed or removed.
#
# WHAT IT DOES
#   * Looks ONLY at tracked files under tests/ (git ls-files), so build output,
#     node_modules or local scratch cannot trip it.
#   * Flags any reference to a LIVE broker hostname:
#         images.dhan.co  api.dhan.co  auth.dhan.co  api.kite.trade  calspread.online
#   * Ignores matches inside a COMMENT — a `//` line comment, a line within a
#     `/* … */` block, or a line whose first non-space character is `*` (the JSDoc
#     banner style these suites use). A test that documents "never contacts
#     calspread.online" in prose is fine; a test that puts one in executable code
#     is not.
#   * Ignores Markdown entirely (prose by definition).
#   * Ignores the files on FILE_ALLOWLIST below.
#   * Exits non-zero (RED) if any non-comment, non-allow-listed reference remains.
#
# THE ALLOW-LIST — and why each entry is safe
#   These two files ARE the hermetic interception seam. They must NAME the live
#   hostnames in executable code, because that is how they recognise a request and
#   answer it from `tests/fixtures/dhan-scrip-master-detailed.sample.csv` instead of
#   letting it out. Banning the names outright is incompatible with an
#   interceptor-based design. Both also run under the armed runtime guard, so their
#   literals provably never dial out.
#
#   To add an allowed destination:
#     * loopback (127.0.0.0/8, ::1, localhost) needs nothing — already allowed;
#     * a broker-SHAPED endpoint should be served by a local mock or by the
#       hermetic helper's fixture table;
#     * a genuinely NEW interception seam gets its path added below, with a
#       justification. Never relax the hostname pattern itself.
#
# WHY THIS IS ONE awk PASS
#   The first version of this script ran `printf | grep` and `printf | sed`
#   pipelines PER LINE — up to six forks a line across roughly 40,000 lines of test
#   code, i.e. on the order of 240,000 process spawns. It took 4m55s in CI and
#   5m02s locally (3m22s of it in `sys`), making a text scan the slowest job in the
#   pipeline by two orders of magnitude. awk tracks block-comment state natively,
#   so the whole scan is one process and the semantics above are unchanged.

set -euo pipefail

ROOT="${1:-.}"
cd "$ROOT"

# Deliberately a plain ERE shared by the matcher and the reporter, so the hostname
# named in a failure is always one the scan actually matched.
#
# The dots are DOUBLE-escaped. `awk -v` processes escape sequences in the value it
# assigns, so a shell-side `\.` arrives at awk as a bare `.` — which both emits
# "escape sequence `\.' treated as plain `.'" on every run AND quietly loosens the
# pattern, since `.` matches any character (`imagesXdhanYco` would have matched).
# `\\.` in the shell arrives as `\.`, giving awk a literal dot.
HOSTS='images\\.dhan\\.co|api\\.dhan\\.co|auth\\.dhan\\.co|api\\.kite\\.trade|calspread\\.online'

FILE_ALLOWLIST=(
  "tests/helpers/hermeticNetwork.mjs"
  "tests/box/hermeticNetwork.test.mjs"
)

# Tracked, non-Markdown files under tests/. `git ls-files` means an untracked local
# scratch file cannot fail the build, and a deleted-but-tracked path is filtered by
# awk's own existence check via the shell test below.
mapfile -t FILES < <(git ls-files -- 'tests' | grep -v '\.md$' || true)

# Drop the allow-listed paths and anything no longer on disk.
SCAN=()
for f in "${FILES[@]}"; do
  [ -f "$f" ] || continue
  skip=0
  for entry in "${FILE_ALLOWLIST[@]}"; do
    [ "$entry" = "$f" ] && skip=1 && break
  done
  [ "$skip" -eq 0 ] && SCAN+=("$f")
done

if [ "${#SCAN[@]}" -eq 0 ]; then
  echo "OK: no tracked test files to scan."
  exit 0
fi

# One awk process for the entire tree.
#
#   FNR==1  resets the block-comment state per file, so an unterminated `/*` in one
#           file cannot silently blind the scan for every file after it.
#   in_block  suppresses lines inside `/* … */`.
#   The `//` strip is URL-safe: it requires the slashes NOT to be preceded by a
#           colon, so `https://host` survives and only a real line comment is cut.
#           (The original used a plain `s#//.*##`, which turned `https://` into
#           `https:` and could HIDE a violation.)
#   A line whose first non-space character is `*` is JSDoc continuation prose.
#
# The ORIGINAL line is printed in the report, not the stripped one, so the operator
# sees exactly what is in the file.
if awk -v hosts="$HOSTS" '
  FNR == 1 { in_block = 0 }
  {
    original = $0
    line = $0

    if (in_block) {
      if (line ~ /\*\//) { in_block = 0 }
      next
    }

    if (line ~ /\/\*/) {
      if (line !~ /\*\//) { in_block = 1 }
      sub(/\/\*.*$/, "", line)
    }

    # URL-safe // comment strip.
    line = gensub(/(^|[^:])\/\/.*$/, "\\1", 1, line)

    if (line ~ /^[[:space:]]*\*/) { next }

    if (match(line, hosts)) {
      host = substr(line, RSTART, RLENGTH)
      printf "FAIL: live broker hostname %c%s%c in executable code: %s:%d\n", 39, host, 39, FILENAME, FNR
      printf "      %s\n", original
      violations++
    }
  }
  END { exit (violations > 0 ? 1 : 0) }
' "${SCAN[@]}"; then
  echo "OK: no hardcoded live-broker hostnames in executable test code."
  echo "    (comments and Markdown prose are ignored; the hermetic interception seam"
  echo "     — ${FILE_ALLOWLIST[*]} — is allow-listed by path.)"
  exit 0
fi

cat <<'EOF'

Hardcoded live-broker hostname reference(s) found in executable test code.
Hermetic tests must drive the interceptor in tests/helpers/hermeticNetwork.mjs (which
serves a checked-in fixture) rather than dialling a broker. If a reference is legitimate
prose, keep it inside a comment; if a NEW file genuinely owns an interception seam, add
its path to FILE_ALLOWLIST in .github/ci/no-live-hostnames.sh with a justification.
EOF
exit 1
