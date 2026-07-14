# TODOS

Deferred work, with enough context to pick it up cold.

---

## 1. Store busy-lock — ✅ DONE (2026-07-14)

Built: `services/storeLock.service.ts` + the `store_locks` table. Keyed on the **store**, not the
run and not the entity — Shopify's limit is one bulk mutation per SHOP, so a customer import and a
product import aimed at one store really do collide, and a key of `(storeId, entity)` would have
waved that straight through. Taken in the same transaction as the pre-persist (so a refusal leaves
no orphan PENDING row); all-or-nothing across a batch (so a busy store cannot cause a partial
fan-out); one lock per store within a batch, so parallelism across DIFFERENT stores is untouched.
Refusal is a 409 naming the store and what is holding it. 14 tests in
`test/integration/storeLock.test.ts`.

Release is explicit at every terminal transition AND self-healing: an acquirer that finds a lock
held by an already-terminal or deleted row simply takes it, so a missed release cannot wedge a
store. A TTL (30 min, renewed on every poll) is the backstop for a run nobody is polling — those
can never reach terminal on their own.

**Remaining follow-up (small):** the store picker does not yet SHOW which stores are busy — a
colleague only finds out by trying and getting the 409. `busyStores()` is already implemented and
tested; it just needs a route and the two store-picker components. Worth doing before real users
arrive, since "pick a store, get rejected, pick again" is a bad first impression.

Raised by: /plan-eng-review 2026-07-14 (outside voice). Promoted and built same day.

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

**Update 2026-07-14 (B4):** uploads now stream to disk, so the RAW bytes are no longer held in
the heap. That removed the pure waste. It did NOT make the pipeline constant-memory: parsing
still builds one JS object per row (a 5-10x blowup over the file), and for a large CSV that is
what now dominates. So this TODO is both the CPU stall AND the remaining memory ceiling — the
same synchronous parse is responsible for both, and chunking or moving it off-thread addresses
both at once.

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
