# Plan hunt: transport boundaries

## 2026-09-05 — independent cold review

**Route: write-plan.** One confirmed Major and one suspected Major, both in
step 1. Do not hand this plan to run-plan. Correct the HTTP assumptions and
regression recipe, then re-hunt.

Reviewed [the entire plan](transport-boundaries.plan.md), without implementing
it. No tracked implementation drift from `70e2d8fd` was reported; initial
status contained only this untracked effort directory. All 23 distinct local
link targets resolved. Tracked source/test paths were checked with
`git ls-files`; installed dependency targets were opened directly.

## Confirmed

### Major — step 1: empty JSON is not necessarily an undefined parsed body

Finding at [step 1](transport-boundaries.plan.md#1-reject-unparsed-http-requests-before-the-adapter-reads-them):

> Bodyless `application/json`: 400 ParseError rather than hanging or creating
> a success-shaped fallback body.

> If the captured parsed body is undefined, return HTTP 400 with
> `ProtocolErrorCode.ParseError`

**Trigger:** `POST /mcp`, `Content-Type: application/json`,
`Content-Length: 0`.

**Evidence:** the installed
[`type-is` body check](../../../node_modules/type-is/index.js#L98-L100)
considers a numeric zero length a body. The
[`JSON parser`](../../../node_modules/body-parser/lib/types/json.js#L76-L80)
explicitly returns `{}` for an empty body. Consequently the proposed
undefined-body check does not run.

A no-file-write loopback probe through the actual SDK Express factory
observed `bodyUndefined: false` and `body: {}`. Passing that parsed value to
the installed SDK handler returned HTTP 400 with code **-32600**, not the
required ParseError **-32700**.

**Impact:** the prescribed implementation does not satisfy its mandatory
empty-request regression. An honest zero-length test fails; testing only an
unframed request would conceal the gap.

**Independent blind refuter: confirmed.** Its independently derived evidence:

> `if (body.length === 0) {` and `return {}`; `req.body = parse(str, encoding)`.
> Thus the plan's “If the captured parsed body is undefined” does not cover
> this empty request.

The author must reconcile the required empty-body behavior with the real
parser contract; this review does not prescribe or apply the implementation.

## Suspected

### Major — step 1: the specified malformed header enters the parser

Finding at [step 1](transport-boundaries.plan.md#1-reject-unparsed-http-requests-before-the-adapter-reads-them):

> `application/json; charset=`: the SDK predicate accepts this malformed
> header while the parser skips it. Require an early 400 ParseError

**Trigger:** that Content-Type on an unfinished upload declaring more than
4 MiB.

**Impact claimed:** the post-parser gate cannot produce the mandated early
400 for this fixture.

**Independent blind refuter: suspected.** It could not resolve an installed
`content-type` entry and requested a runtime check. Its verdict is retained
rather than silently promoted.

**Settles it — refuter's check:**

> Check the actual runtime-resolved parser with the unfinished oversized POST:
> does it reach the POST gate within three seconds?

**Hunter's completed runtime check:** no response after 3,000 ms, and the
POST route was never reached. The request was then destroyed and the local
probe server closed. A completed two-byte request with the same header
reached the route with parsed `{}` instead of undefined.

Runtime resolution independently succeeded for both consumers:

- [`type-is`](../../../node_modules/type-is/index.js#L236-L241) uses nested
  `content-type` **2.1.0**, with `parameters: false`.
- [`body-parser`](../../../node_modules/body-parser/lib/utils.js#L27-L30)
  also uses nested `content-type` **2.1.0**; parsing this header produces an
  empty charset, which
  [`read`](../../../node_modules/body-parser/lib/read.js#L68-L70)
  replaces with the default charset.
- [`read`'s error path](../../../node_modules/body-parser/lib/read.js#L136-L139)
  drains the request before continuing. Thus an oversized unfinished upload
  can remain there before the proposed POST checks.

These observations contradict the fixture's claimed parser-skipped path.
The author should resolve this discrepancy before implementation, even
though the blind verdict remained suspected.

## Remaining step checks

| Step | APIs, paths, conventions, dependencies, and gates |
| --- | --- |
| 1 | Both adapter sites, existing auth ordering, response helper, SDK error envelope, predicate export, and real HTTP suite verified. Node HTTP supports the proposed unfinished-upload technique. Parser assumptions fail as recorded above; the test selector and expected results are otherwise explicit. |
| 2 | Wire callbacks install synchronously before `start()`. Public `start`, `send`, and `close` methods exist. Runtime method-mock capture succeeded without touching runner stdout or stdin listeners. Initialization/admission barriers and disposal spies target public prototype methods. The SDK exports the 10,485,760-byte input limit and closes on overflow. Existing raw harness has exactly the late-close-waiter limitation identified by the plan. Registry destruction, post-await stale detection, probe disposal, late SDK instance closure, and graceful completion paths were checked. No additional dead step found. |
| 3 | Task runner, static command, test-name filtering, scope allowlist, and expected outputs verified. Every new regression's proposed suite is selected. No additional dead step found. |

Installed runtime is Node **24.15.0**, satisfying `>=24`; installed Node types
are **24.13.3** and expose method mocks and restoration. All three server-side
SDK packages are **2.0.0**, matching exact manifest pins. Express is **5.2.1**,
body-parser **2.3.0**, and type-is **2.1.0**. Root `content-type` **1.0.5** is
not the parser's nested dependency; inspecting only that root would be
misleading.

The author's reported 53-pass transport gate and successful static baseline
were not rerun. Focused runtime probes tested disputed assumptions only.
No plan, source, tests, dependencies, or versions were modified. Ordinary
executor instructions in the plan were treated as plan content, not as an
injection finding.

## 2026-09-05 — independent follow-up after HTTP fixture corrections

**Route: READY FOR run-plan. Zero remaining confirmed or suspected findings.**
This is review clearance only; run-plan was not invoked and no implementation
was performed. The initial findings above remain the historical record.

Read the entire revised [plan](transport-boundaries.plan.md) and initial report.
The implementation drift command still produced no changes from `70e2d8fd`;
status still contained only this untracked effort directory. The previous
review's local-link and step 2 mocking-API verification remains applicable.

### Disposition of original findings

| Original finding | Follow-up disposition |
| --- | --- |
| Confirmed Major: empty JSON does not necessarily leave an undefined body | **Resolved in the plan.** Step 1 now explicitly preserves parser-produced `{}` and HTTP 400 InvalidRequest (`-32600`) for `Content-Length: 0`. A separate unframed request exercises the undefined-body guard. |
| Suspected Major: malformed charset fixture enters the parser | **Resolved in the plan.** Step 1 now sends a completed valid modern request with `application/json; charset=` and requires acceptance, rather than asserting an early parser-skipping rejection. The original suspected verdict is not retroactively relabeled. |

### Concrete amended-scenario verification

Ran an in-memory, loopback-only probe on Node **24.15.0** through the installed
SDK Express factory, its actual JSON parser with a 4 MiB limit, `toNodeHandler`,
and `createMcpHandler`. No admission fix was substituted into the probe.
Valid modern traffic used `server/discover`, the required per-request envelope,
and the matching `Mcp-Method` header.

| Completed request | Observed parser value and framing | Installed SDK result |
| --- | --- | --- |
| `application/json`, explicit `Content-Length: 0` | Defined `{}`; length `"0"`; no Transfer-Encoding | HTTP 400, `-32600`, null ID; no factory call |
| `application/json; charset=`, valid modern discovery | Defined, correctly parsed request object | HTTP 200, successful discovery result |
| `application/json; charset=utf-8`, same valid modern discovery | Defined, correctly parsed request object | HTTP 200, successful discovery result |
| `application/json`, unframed empty request | Undefined body; neither framing header present at the receiving server | HTTP 400, `-32700`, null ID |

The last case used exactly the revised public-client recipe: set
`req.useChunkedEncodingByDefault = false`, call `req.flushHeaders()`, assert
neither framing header is set, then end the request without payload. Receiving
server headers were also checked, so the result does not rely solely on
`ClientRequest.hasHeader()` overlooking automatically generated wire framing.
Installed Node types expose the writable
[`OutgoingMessage.useChunkedEncodingByDefault`](../../../node_modules/@types/node/http.d.ts#L627),
[`flushHeaders()`](../../../node_modules/@types/node/http.d.ts#L809), and
[`ClientRequest` inheritance](../../../node_modules/@types/node/http.d.ts#L1006).
The runtime request was also confirmed to be an instance of both classes.
No private member, cast, or dependency change is needed.

The underlying definitions agree with these observations:

- [`type-is.hasbody`](../../../node_modules/type-is/index.js#L98-L100)
  recognizes numeric zero length but not the absence of both framing headers.
- [`body-parser.read`](../../../node_modules/body-parser/lib/read.js#L46-L70)
  leaves body undefined when there is no body framing and defaults an empty
  charset; its
  [`JSON parser`](../../../node_modules/body-parser/lib/types/json.js#L74-L80)
  returns `{}` for parsed zero bytes.
- The SDK's
  [`content-type predicate`](../../../node_modules/@modelcontextprotocol/server/dist/src-CX2iR2pK.mjs#L7017-L7042)
  accepts the malformed charset header, while
  [`the adapter`](../../../node_modules/@modelcontextprotocol/node/dist/index.mjs#L349-L358)
  reserves undefined for its raw-reader path.

The current SDK already returns the ParseError code for the unframed request,
but only after raw conversion; the observed response message was
`Parse error: Invalid JSON`, and a factory was invoked. Thus status/code alone
is compatibility evidence, not proof that the new admission guard exists.
The plan separately requires the guard's exact `Invalid JSON in request body`
message and prohibits either adapter call from receiving undefined.

Probe calibration initially used a missing standard header and then a modern
`ping`, yielding 400 and MethodNotFound respectively. Those were reviewer
fixture errors, not plan defects; the completed matrix above used valid
discovery traffic. Every attempt had a three-second request deadline and
`finally` cleanup: requests and sockets destroyed, server close awaited,
SDK handler closed, deadlines cleared. All probe processes exited; no files
or child servers were left behind.

### Remaining dead-step check and final handoff

- **Step 1:** rechecked both adapter sites, parser/auth ordering, predicate,
  response helper, and the amended request recipes. The new checks fit the
  existing POST handler after authentication without changing parser limits
  or valid-body routing. No remaining dead step.
- **Step 2:** rechecked the raw harness, application cleanup, registry stale
  guard, and SDK automatic-close, synchronous callback installation,
  discovery-probe disposal, late-instance disposal, and graceful-completion
  paths. Connection-only registry ownership and chained per-instance disposal
  remain compatible with these paths. The previously verified public mock
  seams and explicitly serial lifecycle cases require no new production API.
  No remaining dead step.
- **Step 3:** task-runner selection, explicit expected results, and the scope
  gate remain executable. No new claim required rerunning broad checks;
  the author's 53-pass regression baseline and successful static gate were
  not rerun or represented as post-implementation validation.

No new candidate defect was identified, so no blind-refuter dispatch
or confirmed label was needed. Only this report was appended; the plan,
source, tests, dependencies, and versions were not edited.

**Final route: READY FOR run-plan, not executed.**
