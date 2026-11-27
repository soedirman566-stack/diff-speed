[![make.fun bounty](https://make.fun/badge/diff-speed-01-run-20261126.svg)](https://make.fun/bounty/diff-speed-01-run-20261126?utm_source=github&utm_medium=readme&utm_campaign=badge)
[![rank](https://make.fun/badge/diff-speed-01-run-20261126/soedirman566-stack/diff-speed/rank.svg)](https://make.fun/bounty/diff-speed-01-run-20261126/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=badge)
[![reward](https://make.fun/badge/diff-speed-01-run-20261126/soedirman566-stack/diff-speed/reward.svg)](https://make.fun/bounty/diff-speed-01-run-20261126?utm_source=github&utm_medium=readme&utm_campaign=badge)

# Diff Speed

An exact diff, rebuilt for speed.

Given an old text and a new text, this entry produces exactly the patch the
reference implementation produces — byte for byte identical, including its
hunk grouping, context lines, and end-of-file newline handling — while
running roughly twice as fast.

The trick is to stop comparing strings. Each line of a text is interned to a
small integer id once per case, so every equality test inside the search is
a plain integer comparison. The greedy Myers search itself keeps its state
in flat typed arrays — one slot per diagonal, and the edit script stored as
index-linked records in growable arrays — instead of allocating an object
for every path it explores. The common prefix and suffix are trimmed before
the search starts, and the final patch is assembled directly from the split
line parts, with no per-line string rebuilding until the answer is printed.

`main.ts` is the driver: it reads the cases, answers each one with `run()`
from `solve.js`, and writes the answers out in order.
