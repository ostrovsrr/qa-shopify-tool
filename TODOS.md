# TODOS

Deferred work, with enough context to pick it up cold.

---

## 1. Store busy-lock — ✅ PROMOTED TO P1, BUILD IT (2026-07-14)

**No longer a TODO.** Q1 came back "isolation not required," so the tool is a shared workspace
with a shared store pool. **The busy-lock is now the only thing keeping two colleagues off the
same store.** It is task 9 in the v4 build order. Left here for the reasoning trail.

**What:** A lock so only one operation runs against a given Shopify store at a time.

**Why (original framing, when stores were per-user):** Per-user store ownership stops Josh
colliding with Rodion. Nothing stops Rodion colliding with himself. Firing `/cleanup` while his
own batch is mid-flight either hits Shopify's per-shop bulk-operation limit or deletes the
records his own run is about to reconcile against.

**Context:** `/cleanup-qa` and `/cleanup-qa-products` delete **by tag across an entire
store** (`productImport.service.ts:529-549`). They are the highest-blast-radius routes in
the app. Shopify already enforces one bulk op per shop (`shopifyBulk.ts:112`) but returns a
confusing "already in progress" error rather than queueing.

**Pros:** Small and self-contained. It is the only thing protecting the store-wide
destructive cleanup routes from a concurrent run against the same store.

**Cons:** Needs a lock table or a Postgres advisory lock, plus a stale-lock story (same
class of problem as the job `claimedAt` lease).

**Depends on / blocked by:** Nothing. **The tenancy decision landed on shared-workspace, so this
is now P1 and in the build.** Build it alongside the job `claimedAt` lease in the async fix — same
problem shape (a claim plus a stale-claim reaper), so they share machinery.

Raised by: /plan-eng-review 2026-07-14 (outside voice). Promoted same day.

---

## 2. CPU-bound validation blocks the event loop

**What:** Move validation and the template-dataset rebuild off the request thread (worker
thread, or chunk it with yields).

**Why:** The hosting plan sized the container against **memory**. Nobody sized it against
**CPU**. Node runs one event loop, and validation plus the template-dataset rebuild run
synchronously across the entire row set. While one colleague validates a 100 MB CSV, every
other colleague's status poll, page load and button click waits behind it. Hosted, they will
conclude the tool is broken and go back to messaging Rodion — which is the exact outcome the
whole project exists to prevent.

**Context:** Invisible single-user-local: you are the one waiting, and you know why. It does
not crash anything. It just makes the app unresponsive for everyone else for the duration.

**Pros:** The difference between "the tool is slow" and "the tool is hung."

**Cons:** Worker threads mean serializing rows across the boundary, which has its own memory
cost. Chunking with yields is simpler but slower overall.

**Depends on / blocked by:** Nothing. Independent of the tenancy decision. **Measure first** —
nobody has seen a colleague's real file yet, so file size and overlap frequency are both
assumptions. Trivially detectable once hosted (slow status polls during someone else's
validation).

Raised by: /plan-eng-review 2026-07-14 (outside voice).

---

## 3. ⚠ Partial bulk results would silently misattribute every row

**What:** `fetchAndParseBulkResults` (`shopifyBulk.ts:198-202`) infers whether Shopify's
`__lineNumber` is 0- or 1-based by folding over the **minimum line number in the file**. Pass it
the true base explicitly instead of inferring it.

**Why:** the inference is correct only when the result file starts at the **first** line. That
holds for a COMPLETED operation's `url`. It does **not** hold for `partialDataUrl` on a
FAILED/CANCELED op, whose first line can be any line number. Feed partial data through and `base`
collapses to that first line, shifting **every** ref — results get attributed to the **wrong source
rows**. No throw, no warning. The Excel report would blame the wrong customers, which is the
worst possible failure for a tool whose entire product is "tell me which rows Shopify rejected."

**Context:** **Cannot fire today.** `partialDataUrl` is selected in the poll query
(`shopifyBulk.ts:143`) but never parsed anywhere. Found while writing the characterization tests
and pinned as a passing test that documents the WRONG behavior on purpose
(`test/shopifyBulk.test.ts`, "MISALIGNS refs ... partial data"). A warning comment sits at the
code site.

**Pros:** cheap to fix (pass `base` in rather than infer it). Removes a trap that only fires when
someone does a reasonable thing.

**Cons:** none, beyond touching a hot path that currently works.

**Depends on / blocked by:** Nothing — but **read this BEFORE the async fix**. "The op failed, let's
salvage the partial results" is exactly the move that makes this live, and it is a natural thing to
reach for while making imports crash-resilient.

Raised by: /plan-eng-review 2026-07-14 (found while writing characterization tests).
