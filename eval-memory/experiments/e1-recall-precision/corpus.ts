/**
 * E1 seeded corpus — 10 clusters × 20 notes per cluster = 200 entries.
 *
 * Design notes:
 *
 *  - Each cluster has its own topic vocabulary so BM25 has a fair shot
 *    at exact-token matches inside a cluster.
 *  - Across clusters the vocabularies overlap (e.g. "performance",
 *    "design", "edge case") so paraphrased queries that lean on
 *    abstract terms genuinely have to discriminate by **meaning**, not
 *    surface words — that is exactly the regime where embeddings
 *    earn their keep.
 *  - Each note is 1–3 sentences (~40–120 tokens) — close to the actual
 *    reflection note length distribution we observe in production
 *    traces.
 *  - Hand-written, not LLM-generated, to avoid baking a specific
 *    embedding model's affinities into the dataset. The same corpus
 *    will be used as a baseline once we add new embedding models.
 */

export interface CorpusNote {
  /** Stable per-cluster ordinal (0..19). Used by the link seeder. */
  index: number;
  /** Free-form body — what `MemoryStore.store()` will receive. */
  content: string;
  /** Optional shared tags inside the cluster. */
  tags: readonly string[];
}

export interface CorpusCluster {
  /** Numeric id `0..9` used by the queries dataset. */
  id: number;
  /** Short human-readable name for the report. */
  label: string;
  /** Tag every note in the cluster shares (also queryable, but the runner does NOT pass it as a filter — recall must work on content alone). */
  sharedTag: string;
  notes: readonly CorpusNote[];
}

const ASYNC_JS: readonly CorpusNote[] = [
  { index: 0, content: "Promises chain naturally; .then() returns a new promise so async work composes left-to-right without nesting.", tags: ["asyncjs"] },
  { index: 1, content: "await unwraps the resolved value but propagates rejections as thrown errors that bubble up the call stack.", tags: ["asyncjs"] },
  { index: 2, content: "Callback hell predates promises. Each step needs its own error path and you lose stack traces across boundaries.", tags: ["asyncjs"] },
  { index: 3, content: "The event loop processes the microtask queue (promise jobs) to completion before yielding to the macrotask queue.", tags: ["asyncjs"] },
  { index: 4, content: "Promise.all rejects on the first failure; Promise.allSettled inspects every outcome — pick based on whether one bad result poisons the batch.", tags: ["asyncjs"] },
  { index: 5, content: "Top-level await works in ES modules but blocks the module evaluator; a slow import stalls the whole import graph.", tags: ["asyncjs"] },
  { index: 6, content: "AbortController + signal is the canonical cancellation primitive; fetch() honours it and many DOM APIs accept it now.", tags: ["asyncjs"] },
  { index: 7, content: "Async iterators (for-await-of) consume streams lazily, useful when each chunk must be processed before the next is requested.", tags: ["asyncjs"] },
  { index: 8, content: "Unhandled promise rejections crash Node by default in v15+; always attach a .catch() or use a top-level handler.", tags: ["asyncjs"] },
  { index: 9, content: "Promise.race is rarely what you want — most timeout patterns are better expressed with AbortController plus a setTimeout that aborts.", tags: ["asyncjs"] },
  { index: 10, content: "Microtasks starve macrotasks; an infinite chain of resolved promises blocks the next setTimeout from ever firing.", tags: ["asyncjs"] },
  { index: 11, content: "queueMicrotask() schedules a microtask without creating a promise — handy when you need to defer just past the current job.", tags: ["asyncjs"] },
  { index: 12, content: "Sequential awaits inside a loop serialise work; if items are independent, fan out with Promise.all and process in parallel.", tags: ["asyncjs"] },
  { index: 13, content: "async functions always return a promise even when they appear to return synchronously — wrapping is automatic.", tags: ["asyncjs"] },
  { index: 14, content: "Returning a promise from .then() flattens; returning a thenable also works but with subtle assimilation rules.", tags: ["asyncjs"] },
  { index: 15, content: "Mixing callbacks and promises is fragile; util.promisify converts node-style (err, value) callbacks into promise-returning functions.", tags: ["asyncjs"] },
  { index: 16, content: "process.nextTick fires before any microtask; reserve it for low-level libraries — overusing it can starve I/O callbacks.", tags: ["asyncjs"] },
  { index: 17, content: "Catching an awaited rejection with try/catch is identical to .catch() in terms of error propagation but reads more naturally.", tags: ["asyncjs"] },
  { index: 18, content: "Promise constructor anti-pattern: wrapping an already-promise-returning call in new Promise just to handle errors loses stack context.", tags: ["asyncjs"] },
  { index: 19, content: "Error swallowing happens when a .then() chain is missing a final .catch(); always end chains with a handler or await them.", tags: ["asyncjs"] },
];

const SQL_OPTIMIZATION: readonly CorpusNote[] = [
  { index: 0, content: "EXPLAIN ANALYZE reveals the actual execution plan; the planner's estimates often diverge from reality after table growth.", tags: ["sqlopt"] },
  { index: 1, content: "Missing composite indexes show up as sequential scans on large joins; adding (a, b) is not the same as (b, a).", tags: ["sqlopt"] },
  { index: 2, content: "ORDER BY paired with LIMIT can switch from a top-N heap to a full sort if the matching index does not cover both clauses.", tags: ["sqlopt"] },
  { index: 3, content: "Filtered partial indexes shrink the index footprint when only a fraction of rows match a hot predicate (e.g. status='active').", tags: ["sqlopt"] },
  { index: 4, content: "SELECT * fetches columns the planner cannot prune; covering indexes only work when the query lists the exact stored columns.", tags: ["sqlopt"] },
  { index: 5, content: "Window functions can replace correlated subqueries for ranking patterns and usually beat them on planner cost.", tags: ["sqlopt"] },
  { index: 6, content: "VACUUM ANALYZE refreshes statistics; stale stats cause the planner to pick bad join orders on data that has skewed.", tags: ["sqlopt"] },
  { index: 7, content: "Bitmap index scans combine multiple non-selective predicates more cheaply than a single index can handle them.", tags: ["sqlopt"] },
  { index: 8, content: "Hash joins win on equality joins over large unsorted inputs; merge joins win when both sides are already sorted by the join key.", tags: ["sqlopt"] },
  { index: 9, content: "Materialized views amortise expensive joins; trade freshness for read latency, refresh on a schedule that matches SLA.", tags: ["sqlopt"] },
  { index: 10, content: "Statement-level caching does not help if every call binds different parameters; use prepared statements to reuse plans.", tags: ["sqlopt"] },
  { index: 11, content: "Watch for accidental cartesian products — a missing join condition silently multiplies row counts and can crater query speed.", tags: ["sqlopt"] },
  { index: 12, content: "EXPLAIN (BUFFERS) shows page reads vs cache hits; high disk reads on a small table usually mean missing or unused indexes.", tags: ["sqlopt"] },
  { index: 13, content: "LATERAL joins push correlated logic into the join itself; can replace UDF calls in SELECT lists for big speedups.", tags: ["sqlopt"] },
  { index: 14, content: "OR predicates often defeat single-column indexes; UNION of two range queries can be faster than ORing the same range twice.", tags: ["sqlopt"] },
  { index: 15, content: "Counting distinct values is expensive at scale; HyperLogLog approximations trade exactness for orders of magnitude speedup.", tags: ["sqlopt"] },
  { index: 16, content: "JSONB GIN indexes accelerate containment queries but bloat write throughput; index only the keys actually queried.", tags: ["sqlopt"] },
  { index: 17, content: "Subquery in SELECT list runs once per row by default; rewrite as a join or LATERAL when row counts grow.", tags: ["sqlopt"] },
  { index: 18, content: "Connection pool churn hides as planner overhead; long-lived connections amortise plan caching across requests.", tags: ["sqlopt"] },
  { index: 19, content: "Avoid functions on indexed columns in WHERE clauses; the index cannot be used unless an expression index matches exactly.", tags: ["sqlopt"] },
];

const COFFEE_BREWING: readonly CorpusNote[] = [
  { index: 0, content: "Pour-over methods rely on a slow, controlled bloom; let CO2 escape from freshly roasted beans before the main pour.", tags: ["coffee"] },
  { index: 1, content: "Espresso extraction is pressure-driven — temperature and grind size dictate flow rate more than dose alone.", tags: ["coffee"] },
  { index: 2, content: "Channeling in the puck causes uneven extraction; tamp evenly and distribute grounds before applying pressure.", tags: ["coffee"] },
  { index: 3, content: "French press leaves more soluble oils in the cup than paper-filtered methods, yielding a heavier body and lower clarity.", tags: ["coffee"] },
  { index: 4, content: "Aeropress is forgiving across grind sizes; inverted method gives full immersion before plunging through the filter.", tags: ["coffee"] },
  { index: 5, content: "Cold brew uses time instead of heat — long steeping at room temperature extracts caffeine without the bitter compounds high heat creates.", tags: ["coffee"] },
  { index: 6, content: "Burr grinders produce uniform particle size; blade grinders create dust and boulders that extract at different rates.", tags: ["coffee"] },
  { index: 7, content: "Water hardness affects extraction; ideal brewing water has moderate magnesium content and low chlorine.", tags: ["coffee"] },
  { index: 8, content: "Light roasts emphasise origin character; dark roasts mask varietal differences with caramelised sugar and roast tones.", tags: ["coffee"] },
  { index: 9, content: "TDS meters quantify extraction strength; pairing with extraction yield % puts you on the SCA brewing control chart.", tags: ["coffee"] },
  { index: 10, content: "Bloom time of 30-45 seconds is typical for medium-roast pour-over; longer for very fresh beans, shorter for aged.", tags: ["coffee"] },
  { index: 11, content: "Sour notes in espresso usually mean under-extraction — coarser grind, longer shot, hotter water, or all three.", tags: ["coffee"] },
  { index: 12, content: "Bitter, ashy notes signal over-extraction; tighten grind only after you have ruled out stale beans or too-hot water.", tags: ["coffee"] },
  { index: 13, content: "Decaf processing varies — Swiss water method preserves more origin flavour than CO2 or solvent-based decaffeination.", tags: ["coffee"] },
  { index: 14, content: "Milk steaming creates microfoam by entraining air during the stretch phase, then folding without bubbles forming.", tags: ["coffee"] },
  { index: 15, content: "Latte art depends on milk texture more than on pour technique; thin, glossy milk pours cleanly into a defined heart or rosetta.", tags: ["coffee"] },
  { index: 16, content: "Single-origin coffees showcase a region's processing and varietal; blends are engineered for consistency across crops.", tags: ["coffee"] },
  { index: 17, content: "Resting freshly roasted beans 5-10 days lets degassing settle; espresso pulled before then often gushers from CO2 disruption.", tags: ["coffee"] },
  { index: 18, content: "Refractometer readings near 1.35% TDS for filter coffee correlate with the sweet spot most palates prefer.", tags: ["coffee"] },
  { index: 19, content: "Storing beans in airtight containers away from light extends freshness; freezing in single-dose portions prevents repeated thaw cycles.", tags: ["coffee"] },
];

const PYTHON_TYPES: readonly CorpusNote[] = [
  { index: 0, content: "TypedDict captures dict shapes with named keys but does not enforce them at runtime — mypy/pyright checks at static time only.", tags: ["pytypes"] },
  { index: 1, content: "Protocol classes describe structural typing; any class with matching methods satisfies the protocol without an explicit base.", tags: ["pytypes"] },
  { index: 2, content: "Literal types pin parameter values to specific strings or numbers, useful for mode flags that should not accept arbitrary text.", tags: ["pytypes"] },
  { index: 3, content: "ParamSpec captures the parameter signature of one callable so a decorator can echo it back to the wrapped function.", tags: ["pytypes"] },
  { index: 4, content: "Generic[T] declares classes that take type parameters; the bound clause restricts what concrete types T can stand in for.", tags: ["pytypes"] },
  { index: 5, content: "TypeAlias lets you give a name to a complex Union or Callable signature without it being mistaken for a normal assignment.", tags: ["pytypes"] },
  { index: 6, content: "Optional[X] is sugar for Union[X, None]; PEP 604 lets you write X | None directly on Python 3.10+.", tags: ["pytypes"] },
  { index: 7, content: "NewType creates a distinct type at static-check time but is just an alias at runtime; no isinstance checks possible.", tags: ["pytypes"] },
  { index: 8, content: "overload decorators describe multiple call signatures of one function; the implementation must be a single concrete signature.", tags: ["pytypes"] },
  { index: 9, content: "Final stops reassignment of module-level constants; ClassVar pulls a class attribute out of the instance namespace.", tags: ["pytypes"] },
  { index: 10, content: "Self return type (3.11+) makes builder-style chaining work for subclasses without manually narrowing T at every step.", tags: ["pytypes"] },
  { index: 11, content: "TypeGuard returns a bool but tells the type checker that the input has narrowed type; replaces isinstance shenanigans.", tags: ["pytypes"] },
  { index: 12, content: "dataclass + slots reduces memory footprint and prevents typos in attribute names by disabling __dict__.", tags: ["pytypes"] },
  { index: 13, content: "Annotated lets you attach metadata to a type without changing it; libraries like pydantic and fastapi consume these tags.", tags: ["pytypes"] },
  { index: 14, content: "Mypy's strict mode catches missing annotations, untyped defs, and implicit Any — turn it on early in a project.", tags: ["pytypes"] },
  { index: 15, content: "Variance: covariant containers (Sequence) accept subtype substitution; mutable containers (list) are invariant for safety.", tags: ["pytypes"] },
  { index: 16, content: "Forward references as strings are needed when annotating a class with itself; PEP 563 made all annotations strings by default.", tags: ["pytypes"] },
  { index: 17, content: "typing.cast tells the checker to trust you about a type; it has no runtime effect, so use it sparingly.", tags: ["pytypes"] },
  { index: 18, content: "NamedTuple gives you a typed, immutable record with fixed-position iteration — dataclass(frozen=True) is more flexible at the cost of tuple semantics.", tags: ["pytypes"] },
  { index: 19, content: "Async functions return Coroutine[Any, Any, T] under the hood; annotating them with just T is the common shorthand.", tags: ["pytypes"] },
];

const LINUX_PERMS: readonly CorpusNote[] = [
  { index: 0, content: "Numeric chmod modes encode owner/group/other in three octal digits; setuid and sticky bits live in a fourth leading digit.", tags: ["linuxperms"] },
  { index: 1, content: "umask subtracts from default file creation permissions; 022 is typical, 002 is used in shared group workflows.", tags: ["linuxperms"] },
  { index: 2, content: "Capabilities split root privileges into bounded sets; setcap CAP_NET_BIND_SERVICE lets a binary bind low ports without full root.", tags: ["linuxperms"] },
  { index: 3, content: "ACLs extend the basic owner/group/other model with per-user and per-group entries; getfacl and setfacl manage them.", tags: ["linuxperms"] },
  { index: 4, content: "The sticky bit on /tmp lets anyone create files but only the owner can delete their own — prevents users from removing each other's work.", tags: ["linuxperms"] },
  { index: 5, content: "Symlinks have their own permissions but most operations follow the target; chmod on a symlink usually affects the target file.", tags: ["linuxperms"] },
  { index: 6, content: "setuid lets a binary run as its owner regardless of who launches it; auditing every setuid binary is a baseline security hygiene step.", tags: ["linuxperms"] },
  { index: 7, content: "rwxr-x--- as a string maps to 750 octal; reading the permission bits left-to-right is owner, group, other.", tags: ["linuxperms"] },
  { index: 8, content: "Bind mounts inherit permissions from the source; mount options like nosuid and nodev defang accidental exposure of dangerous bits.", tags: ["linuxperms"] },
  { index: 9, content: "AppArmor and SELinux layer mandatory access control on top of DAC; they confine processes regardless of the file's owner.", tags: ["linuxperms"] },
  { index: 10, content: "id and groups reveal a process's effective uid/gid set; sudo -u runs commands as another user without spawning a full shell.", tags: ["linuxperms"] },
  { index: 11, content: "Network namespaces isolate routing, firewall rules, and interfaces; unshare -n creates one for one-off testing.", tags: ["linuxperms"] },
  { index: 12, content: "Inodes carry permission metadata; hardlinks share an inode so changing one entry changes the access for every name pointing at it.", tags: ["linuxperms"] },
  { index: 13, content: "chown changes file ownership; only root can transfer ownership across user accounts in most distributions.", tags: ["linuxperms"] },
  { index: 14, content: "Octal permissions: read=4, write=2, execute=1; sum the bits per slot to get the digit (e.g. rwx=7, r-x=5).", tags: ["linuxperms"] },
  { index: 15, content: "Mount-time options like ro, noexec, nodev tighten a filesystem regardless of the underlying inode permissions.", tags: ["linuxperms"] },
  { index: 16, content: "Polkit (formerly PolicyKit) lets unprivileged GUI sessions request specific privileged actions without invoking sudo.", tags: ["linuxperms"] },
  { index: 17, content: "Directory execute bit means traversal — without it you cannot cd into the directory even if you can read its listing.", tags: ["linuxperms"] },
  { index: 18, content: "Audit subsystem (auditd) logs syscall-level access; useful for catching escalations even when DAC permissions allowed them.", tags: ["linuxperms"] },
  { index: 19, content: "POSIX file capabilities live in extended attributes; getcap shows them, setcap installs them on a binary.", tags: ["linuxperms"] },
];

const GIT_REBASE: readonly CorpusNote[] = [
  { index: 0, content: "Rebase rewrites commit hashes; pushing a rebased branch needs --force-with-lease so you do not stomp on someone else's parallel push.", tags: ["gitrebase"] },
  { index: 1, content: "Interactive rebase opens an editor where you reorder, squash, edit, or drop commits before they are rewritten onto the new base.", tags: ["gitrebase"] },
  { index: 2, content: "Merge commits preserve history shape; rebases produce a linear log at the cost of losing the original branching context.", tags: ["gitrebase"] },
  { index: 3, content: "git rebase --onto lets you transplant a range of commits onto an arbitrary branch tip; handy when you forked off the wrong base.", tags: ["gitrebase"] },
  { index: 4, content: "Conflict resolution mid-rebase pauses the operation; --continue resumes after staging, --abort throws away the in-progress state.", tags: ["gitrebase"] },
  { index: 5, content: "Squash merges in PRs collapse the feature branch into a single commit on main; preserves the PR record but loses intra-branch commits.", tags: ["gitrebase"] },
  { index: 6, content: "Rebase-and-merge keeps individual commits while linearising history; squash-and-merge produces one commit per PR.", tags: ["gitrebase"] },
  { index: 7, content: "fixup! commits autosquash on rebase; combined with --autosquash they let you keep WIP fixes near the commit they amend.", tags: ["gitrebase"] },
  { index: 8, content: "The reflog records HEAD movements for ~90 days; lost commits from a botched rebase are recoverable by hash from there.", tags: ["gitrebase"] },
  { index: 9, content: "Rewriting public history breaks downstream forks; never rebase the trunk branch others have based their work on.", tags: ["gitrebase"] },
  { index: 10, content: "Stash-pop after rebase merges your work into the rebased tip; conflicts here are normal if both edited the same hunk.", tags: ["gitrebase"] },
  { index: 11, content: "git pull --rebase replaces a merge commit from upstream with a clean replay of your local commits on top; keeps history tidy.", tags: ["gitrebase"] },
  { index: 12, content: "Rerere stores conflict resolutions; subsequent rebases with the same conflicts apply your earlier answers automatically.", tags: ["gitrebase"] },
  { index: 13, content: "Commit signing on rebased commits requires re-signing — the hashes change so the original signatures no longer apply.", tags: ["gitrebase"] },
  { index: 14, content: "Cherry-pick is a single-commit rebase by another name; useful for porting a fix to a release branch without taking the rest of trunk.", tags: ["gitrebase"] },
  { index: 15, content: "Empty commits left after a rebase (e.g. all changes were already on the base) can be kept with --keep-empty for record-keeping.", tags: ["gitrebase"] },
  { index: 16, content: "ORIG_HEAD records where HEAD was before a destructive operation; reset --hard ORIG_HEAD undoes a bad rebase in one step.", tags: ["gitrebase"] },
  { index: 17, content: "Bisect plays well with linear history from rebases; merge-heavy histories complicate the binary search across parents.", tags: ["gitrebase"] },
  { index: 18, content: "Range diffs (git range-diff) compare two versions of the same patch series; useful after rebasing to see what changed during conflict resolution.", tags: ["gitrebase"] },
  { index: 19, content: "Hooks (pre-rebase, post-rewrite) fire around rebase operations; CI agents use them to invalidate caches keyed on commit hash.", tags: ["gitrebase"] },
];

const DOCKER_NET: readonly CorpusNote[] = [
  { index: 0, content: "Bridge networks are the default Docker driver — each container gets an IP on a private subnet routed through a host-side bridge interface.", tags: ["dockernet"] },
  { index: 1, content: "Host networking skips the namespace and binds containers directly to the host's interfaces; trades isolation for raw performance.", tags: ["dockernet"] },
  { index: 2, content: "Overlay networks span multiple Docker hosts via VXLAN; required by Swarm services that schedule across a cluster.", tags: ["dockernet"] },
  { index: 3, content: "Macvlan assigns each container its own MAC and IP on the physical LAN; useful for legacy services that expect a real Layer 2 presence.", tags: ["dockernet"] },
  { index: 4, content: "Port publishing (-p) creates NAT rules in iptables that translate host ports to container ports on the bridge.", tags: ["dockernet"] },
  { index: 5, content: "User-defined bridges support service discovery by container name — the default bridge does not, only --link works there.", tags: ["dockernet"] },
  { index: 6, content: "Docker's internal DNS resolver answers on 127.0.0.11 inside the container namespace; it forwards external lookups to the host resolver.", tags: ["dockernet"] },
  { index: 7, content: "MTU mismatch between the overlay and the underlay leaks as silent TCP retransmits; set --opt com.docker.network.driver.mtu when the underlay is non-standard.", tags: ["dockernet"] },
  { index: 8, content: "Inspecting a network shows attached containers, their IPs, and the driver options in use; docker network inspect is the diagnostic entry point.", tags: ["dockernet"] },
  { index: 9, content: "Default bridge IP ranges live in /etc/docker/daemon.json; conflicts with corporate VPN subnets manifest as routing-table fights at boot.", tags: ["dockernet"] },
  { index: 10, content: "Docker Compose creates a project-scoped bridge per stack; services on it can reach each other by service name without explicit links.", tags: ["dockernet"] },
  { index: 11, content: "Ingress mesh on Swarm load-balances inbound traffic across replicas via the routing mesh — every node accepts traffic for every service.", tags: ["dockernet"] },
  { index: 12, content: "IPv6 support requires explicit enablement in daemon config plus per-network --ipv6 flags; not all overlay drivers support dual stack.", tags: ["dockernet"] },
  { index: 13, content: "Bind mounting /var/run/docker.sock into a container gives that container full daemon privileges — a privilege escalation risk.", tags: ["dockernet"] },
  { index: 14, content: "Network aliases let one container be reachable under multiple DNS names within a user-defined bridge.", tags: ["dockernet"] },
  { index: 15, content: "Docker disables ICMP redirects and rp_filter on bridges by default; some k8s CNIs flip these back, leading to surprising packet drops.", tags: ["dockernet"] },
  { index: 16, content: "iptables -t nat -L -n shows the NAT chains Docker installs; reading them is the fastest way to diagnose missing port forwards.", tags: ["dockernet"] },
  { index: 17, content: "Host-mode containers cannot publish ports — they share the host namespace, so port conflicts are real instead of namespaced away.", tags: ["dockernet"] },
  { index: 18, content: "Userland proxy (docker-proxy) takes over when iptables forwarding cannot satisfy a publish rule; disabling it (-userland-proxy=false) reduces overhead.", tags: ["dockernet"] },
  { index: 19, content: "Containers on different user-defined bridges cannot reach each other by default; attach a container to multiple bridges to bridge between them.", tags: ["dockernet"] },
];

const CSS_FLEX: readonly CorpusNote[] = [
  { index: 0, content: "display: flex turns a container into a flex parent; its children become flex items with axes you control via flex-direction.", tags: ["cssflex"] },
  { index: 1, content: "justify-content distributes free space along the main axis; align-items aligns items perpendicular to it on the cross axis.", tags: ["cssflex"] },
  { index: 2, content: "flex-wrap: wrap breaks items onto multiple lines once the main-axis content overflows; default is nowrap, leading to overflow.", tags: ["cssflex"] },
  { index: 3, content: "flex-grow distributes leftover space proportionally; flex-shrink decides which items give up space first when content overflows.", tags: ["cssflex"] },
  { index: 4, content: "flex-basis is the initial size before grow/shrink apply; setting it to 0 starts every item at zero before distributing space.", tags: ["cssflex"] },
  { index: 5, content: "The shorthand flex: 1 1 0 means grow=1, shrink=1, basis=0 — a common pattern for equally-sized fluid columns.", tags: ["cssflex"] },
  { index: 6, content: "align-self overrides align-items per item; useful when one tile in a row needs a different vertical alignment than its siblings.", tags: ["cssflex"] },
  { index: 7, content: "gap works inside flex containers in modern browsers; older support stories needed margins on items combined with negative-margin tricks.", tags: ["cssflex"] },
  { index: 8, content: "row-reverse and column-reverse flip the main-axis direction; useful for RTL layouts or visual stacks that should grow from the bottom.", tags: ["cssflex"] },
  { index: 9, content: "min-content / max-content are intrinsic sizes; combined with flex-basis: max-content you get items that demand their natural width.", tags: ["cssflex"] },
  { index: 10, content: "Setting min-width: 0 on a flex item lets it shrink below its content width — essential to prevent overflow of long text.", tags: ["cssflex"] },
  { index: 11, content: "align-content controls how multi-line content is stacked along the cross axis when wrap is active; meaningless on single-line layouts.", tags: ["cssflex"] },
  { index: 12, content: "order rearranges items visually without touching the DOM; accessibility tools still announce the source order, so use it sparingly.", tags: ["cssflex"] },
  { index: 13, content: "Auto margins inside a flex item consume free space along the main axis; margin-left: auto is a one-liner push-to-right.", tags: ["cssflex"] },
  { index: 14, content: "Flexbox aligns single rows or columns; grid is the better fit when both axes need coordination across many items.", tags: ["cssflex"] },
  { index: 15, content: "flex-basis: auto inspects the item's main-size property (width or height) before applying grow/shrink — different from basis: 0.", tags: ["cssflex"] },
  { index: 16, content: "place-items shorthand sets align-items and justify-items in one line; in flex it only takes the first value because justify-items is ignored.", tags: ["cssflex"] },
  { index: 17, content: "Nested flex containers compound — a flex parent inside a flex child works fine, but performance suffers at very deep nesting.", tags: ["cssflex"] },
  { index: 18, content: "Sticky positioning inside flex columns works only when the flex item is itself the scrolling context — otherwise the sticky element does not stick.", tags: ["cssflex"] },
  { index: 19, content: "Common flexbox bug: setting height on a column flex parent does not propagate to children unless they declare their own height or use align-items: stretch.", tags: ["cssflex"] },
];

const REST_API: readonly CorpusNote[] = [
  { index: 0, content: "Resource URLs identify entities; verbs come from the HTTP method (GET, POST, PUT, PATCH, DELETE) — keep nouns in the path.", tags: ["restapi"] },
  { index: 1, content: "Idempotency means repeating a request has the same effect as one call; PUT and DELETE are idempotent by convention, POST is not.", tags: ["restapi"] },
  { index: 2, content: "ETag + If-None-Match enables cheap conditional GETs; 304 Not Modified saves bandwidth when the client already has the fresh copy.", tags: ["restapi"] },
  { index: 3, content: "Pagination via cursor tokens beats offset/limit at scale; offsets force the server to scan past skipped rows on every page.", tags: ["restapi"] },
  { index: 4, content: "Versioning by URL (/v1/) is explicit but ugly; header-based versioning is cleaner but harder to discover from a browser bar.", tags: ["restapi"] },
  { index: 5, content: "HATEOAS embeds links to next actions in responses; rarely adopted in practice because clients usually hardcode URLs anyway.", tags: ["restapi"] },
  { index: 6, content: "Use 422 for valid request shape but invalid business state; reserve 400 for malformed requests the server cannot parse.", tags: ["restapi"] },
  { index: 7, content: "Authorization Bearer tokens travel in the Authorization header; cookies are easier for browsers but require CSRF protections.", tags: ["restapi"] },
  { index: 8, content: "Rate limiting headers (X-RateLimit-Remaining, Retry-After) let well-behaved clients back off before hitting hard 429s.", tags: ["restapi"] },
  { index: 9, content: "CORS preflights add latency; precaching with Access-Control-Max-Age on OPTIONS responses keeps client-side request floods cheap.", tags: ["restapi"] },
  { index: 10, content: "JSON over HTTPS is the lingua franca; protobufs win on internal microservice hops where schema and bandwidth matter more than tooling.", tags: ["restapi"] },
  { index: 11, content: "PATCH is for partial updates; JSON Patch (RFC 6902) and JSON Merge Patch (RFC 7396) are competing concrete formats.", tags: ["restapi"] },
  { index: 12, content: "Resource expansion via query params (?expand=author) cuts round trips but bloats responses; design with a budget per endpoint.", tags: ["restapi"] },
  { index: 13, content: "Soft deletes vs hard deletes shape your DELETE semantics; 204 is fine for either as long as you document which one you provide.", tags: ["restapi"] },
  { index: 14, content: "Bulk endpoints are easier to operate but harder to make idempotent; require client-supplied request ids when you accept batches.", tags: ["restapi"] },
  { index: 15, content: "Long-running operations should return 202 plus a status URL; polling the status URL beats blocking the original request for minutes.", tags: ["restapi"] },
  { index: 16, content: "Webhook deliveries should retry with exponential backoff and include a signature header so receivers can verify provenance.", tags: ["restapi"] },
  { index: 17, content: "Document your errors as schemas, not free-form strings; clients can dispatch on a known type field across all error responses.", tags: ["restapi"] },
  { index: 18, content: "OpenAPI specs power client generation and request validation; treat the spec as the source of truth and generate handlers from it.", tags: ["restapi"] },
  { index: 19, content: "GraphQL trades caching simplicity for shape flexibility; REST wins when CDN caching by URL is a hard constraint.", tags: ["restapi"] },
];

const FP_CONCEPTS: readonly CorpusNote[] = [
  { index: 0, content: "Pure functions return the same output for the same input and produce no side effects — easy to test and reason about.", tags: ["fp"] },
  { index: 1, content: "Immutability avoids the class of bugs where shared state mutates under your feet; copying is cheap with structural sharing.", tags: ["fp"] },
  { index: 2, content: "Higher-order functions take or return other functions; map, filter, and reduce are the canonical three on collections.", tags: ["fp"] },
  { index: 3, content: "Currying converts an N-arg function into a chain of single-arg functions; partial application produces a specialised version.", tags: ["fp"] },
  { index: 4, content: "Closures capture variables from the enclosing scope; the captured bindings persist for as long as the closure references them.", tags: ["fp"] },
  { index: 5, content: "Functors expose a map operation that respects identity and composition laws; lists, options, and promises are all functors.", tags: ["fp"] },
  { index: 6, content: "Monads chain effectful computations through a flatMap (bind) operation; option, result, and promise are everyday examples.", tags: ["fp"] },
  { index: 7, content: "Persistent data structures share structure across versions; updating a node creates a new tree that reuses unchanged subtrees.", tags: ["fp"] },
  { index: 8, content: "Recursion replaces explicit loops; tail-call optimisation matters for runtimes that lack a stack-friendly trampoline.", tags: ["fp"] },
  { index: 9, content: "Algebraic data types (ADTs) encode states as a union of variants; pattern matching exhaustively destructures them.", tags: ["fp"] },
  { index: 10, content: "Total functions handle every input; partial functions throw or return undefined on some inputs and resist composition.", tags: ["fp"] },
  { index: 11, content: "Type classes let you add behaviour to existing types externally; languages without them use traits or extension methods to fill the gap.", tags: ["fp"] },
  { index: 12, content: "Lazy evaluation defers computation until the result is needed; infinite streams work because only a finite prefix is actually computed.", tags: ["fp"] },
  { index: 13, content: "Referential transparency means an expression can be replaced by its value without changing program behaviour — the cornerstone of FP reasoning.", tags: ["fp"] },
  { index: 14, content: "Folds (reduce) generalise over recursion shapes; fold-left and fold-right differ in associativity, important for non-commutative ops.", tags: ["fp"] },
  { index: 15, content: "Side effects can be reified as data (free monads, effects systems) so business logic stays pure while interpretation happens at the edge.", tags: ["fp"] },
  { index: 16, content: "Composition over inheritance: small functions combined with andThen / compose build features without coupling to a class hierarchy.", tags: ["fp"] },
  { index: 17, content: "Equational reasoning lets you refactor by substituting equals for equals — works only when functions are pure.", tags: ["fp"] },
  { index: 18, content: "Defunctionalisation transforms higher-order programs into first-order ones by encoding closures as tagged data plus an interpreter.", tags: ["fp"] },
  { index: 19, content: "Effect handlers (algebraic effects) let you intercept and resume computations, generalising exceptions and async control flow.", tags: ["fp"] },
];

export const CORPUS_CLUSTERS: readonly CorpusCluster[] = [
  { id: 0, label: "async-js", sharedTag: "asyncjs", notes: ASYNC_JS },
  { id: 1, label: "sql-opt", sharedTag: "sqlopt", notes: SQL_OPTIMIZATION },
  { id: 2, label: "coffee", sharedTag: "coffee", notes: COFFEE_BREWING },
  { id: 3, label: "py-types", sharedTag: "pytypes", notes: PYTHON_TYPES },
  { id: 4, label: "linux-perms", sharedTag: "linuxperms", notes: LINUX_PERMS },
  { id: 5, label: "git-rebase", sharedTag: "gitrebase", notes: GIT_REBASE },
  { id: 6, label: "docker-net", sharedTag: "dockernet", notes: DOCKER_NET },
  { id: 7, label: "css-flex", sharedTag: "cssflex", notes: CSS_FLEX },
  { id: 8, label: "rest-api", sharedTag: "restapi", notes: REST_API },
  { id: 9, label: "fp", sharedTag: "fp", notes: FP_CONCEPTS },
];
