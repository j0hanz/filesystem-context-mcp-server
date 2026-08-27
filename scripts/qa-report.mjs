const STATUS_ORDER = ['ERROR', 'MISMATCH', 'PARTIAL', 'UNCHECKED', 'MATCH', 'SKIPPED'];

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/** Pretty JSON, or a placeholder when there is nothing to show. */
function block(value, empty = 'none') {
  if (value === null || value === undefined || value === '') return `<em>${empty}</em>`;
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return `<pre translate="no" tabindex="0">${escapeHtml(text)}</pre>`;
}

function renderChecks(checks) {
  if (!checks?.length) return '';
  const rows = checks
    .map(
      (check) => `<tr class="${check.ok ? 'ok' : 'bad'}">
      <th scope="row"><code translate="no">${escapeHtml(check.path)}</code></th>
      <td>${escapeHtml(JSON.stringify(check.expected))}</td>
      <td>${escapeHtml(JSON.stringify(check.actual))}</td>
      <td>${check.ok ? 'ok' : 'FAILED'}</td>
    </tr>`,
    )
    .join('\n');
  return `<table class="checks">
    <thead><tr><th scope="col">Path</th><th scope="col">Expected</th>
      <th scope="col">Actual</th><th scope="col">Result</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function renderStep(step, index) {
  if (step.status === 'SKIPPED') {
    return `<details class="step skipped">
      <summary><span class="badge">SKIPPED</span> ${index}. ${escapeHtml(step.name)}</summary>
      <p class="reason">${escapeHtml(step.skipReason ?? 'no reason recorded')}</p>
    </details>`;
  }

  const meta = [
    step.method ? `method <code translate="no">${escapeHtml(step.method)}</code>` : '',
    step.tool ? `tool <code translate="no">${escapeHtml(step.tool)}</code>` : '',
    step.exitCode !== undefined ? `exit <code>${escapeHtml(step.exitCode)}</code>` : '',
    step.durationMs !== undefined ? `${escapeHtml(step.durationMs)}&nbsp;ms` : '',
  ]
    .filter(Boolean)
    .join(' · ');

  return `<details class="step ${step.status.toLowerCase()}"${step.status === 'MATCH' ? '' : ' open'}>
    <summary><span class="badge">${step.status}</span> ${index}. ${escapeHtml(step.name)}</summary>
    <p class="meta">${meta}</p>
    ${step.error ? `<p class="reason">${escapeHtml(step.error)}</p>` : ''}
    ${renderChecks(step.checks)}
    <div class="io">
      <section>
        <h4>Request</h4>
        ${block(step.request?.args, 'no arguments')}
        <h5>Argv</h5>
        ${block(step.request?.argv?.join(' '), 'not sent')}
      </section>
      <section>
        <h4>Response</h4>
        ${block(step.result, 'no result')}
        <h5>CLI Error Envelope</h5>
        ${block(step.cliError)}
        <h5>Server Stderr</h5>
        ${block(step.serverStderr, 'silent')}
      </section>
    </div>
  </details>`;
}

function renderCase(testCase) {
  const id = escapeHtml(testCase.caseId);
  return `<article class="case ${testCase.status.toLowerCase()}" id="${id}">
    <h2><span class="badge">${testCase.status}</span>
      <a class="anchor" href="#${id}" translate="no">${id}</a>
      <small>${escapeHtml(testCase.title)}</small></h2>
    <p class="meta">profile <code translate="no">${escapeHtml(testCase.profile)}</code>${
      testCase.traceability ? ` · traces to ${escapeHtml(testCase.traceability)}` : ''
    }</p>
    ${testCase.steps.map((step, i) => renderStep(step, i + 1)).join('\n')}
  </article>`;
}

function renderProfiles(profiles) {
  return Object.entries(profiles)
    .map(
      ([name, profile]) => `<details class="step">
      <summary><code translate="no">${escapeHtml(name)}</code> · port
        ${escapeHtml(profile.port)}</summary>
      <h4>Server Argv</h4>
      ${block(profile.args?.join(' '))}
      <h4>Startup Stderr</h4>
      ${block(profile.startupStderr, 'silent')}
    </details>`,
    )
    .join('\n');
}

const STYLE = `
:root { color-scheme: light dark; --fg: #16181d; --bg: #fff; --muted: #5b6270;
  --line: #d7dae0; --panel: #f6f7f9; --bad: #b3261e; --good: #1b6e3c; --warn: #8a5a00;
  --ring: #2f6feb; --status: var(--muted); }
@media (prefers-color-scheme: dark) { :root { --fg: #e6e8ec; --bg: #14161a;
  --muted: #99a1b0; --line: #2c313a; --panel: #1c1f25; --bad: #f2857c;
  --good: #6fd39b; --warn: #e0b055; --ring: #7aa2f7; } }
* { box-sizing: border-box; }
body { margin: 0; padding: 0 1.5rem 1.5rem; background: var(--bg); color: var(--fg);
  font: 15px/1.5 ui-sans-serif, system-ui, sans-serif; }
:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; border-radius: 3px; }
h1 { font-size: 1.4rem; margin: 0 0 .25rem; text-wrap: balance; }
h2 { font-size: 1.05rem; margin: 0 0 .35rem; text-wrap: pretty; }
h2 small { font-weight: 400; color: var(--muted); margin-left: .5rem; }
h4, h5 { margin: .75rem 0 .25rem; font-size: .8rem; text-transform: uppercase;
  letter-spacing: .04em; color: var(--muted); }
a { color: inherit; }
.anchor { text-decoration-color: var(--muted); text-underline-offset: 3px; }
.anchor:hover { text-decoration-color: currentColor; }
.meta, .reason { color: var(--muted); font-size: .85rem; margin: .2rem 0 .5rem;
  overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }
.reason { color: var(--bad); }
code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .85em; }
pre { background: var(--panel); border: 1px solid var(--line); border-radius: 6px;
  padding: .6rem .7rem; overflow: auto; overscroll-behavior: contain; font-size: .8rem;
  margin: 0; max-height: 22rem; }
.masthead { background: var(--bg); padding: 1.5rem 0 0;
  border-bottom: 1px solid var(--line); margin-bottom: 1.25rem; }
/* Sticky only where it costs little height — at 375px it ate a quarter of the screen. */
@media (min-width: 40rem) { .masthead { position: sticky; top: 0; z-index: 1; } }
.summary { display: flex; flex-wrap: wrap; gap: .5rem 1.25rem; margin: 0;
  padding: .75rem 0 1rem; font-size: .9rem; }
.summary div { display: flex; align-items: baseline; gap: .3rem; }
.summary dt { color: var(--muted); }
.summary dd { margin: 0; font-weight: 700; font-variant-numeric: tabular-nums; }
.case { border: 1px solid var(--line); border-radius: 8px; padding: .9rem 1rem;
  margin-bottom: 1rem; scroll-margin-top: 7rem;
  content-visibility: auto; contain-intrinsic-size: auto 12rem; }
.case.match { --status: var(--good); }
.case.partial { --status: var(--warn); }
.case.mismatch, .case.error { --status: var(--bad); border-color: var(--bad); }
.step { border-top: 1px solid var(--line); padding: .5rem 0; }
.step.match { --status: var(--good); }
.step.mismatch, .step.error { --status: var(--bad); }
.step summary { cursor: pointer; font-weight: 500; touch-action: manipulation;
  overflow-wrap: anywhere; }
.badge { display: inline-block; min-width: 5.5rem; font-size: .7rem; font-weight: 700;
  letter-spacing: .05em; color: var(--status); }
.io { display: grid; gap: 1rem; margin-top: .5rem; }
@media (min-width: 60rem) { .io { grid-template-columns: 1fr 1fr; } }
.checks { border-collapse: collapse; font-size: .8rem; margin-top: .5rem; width: 100%;
  font-variant-numeric: tabular-nums; }
.checks th, .checks td { border: 1px solid var(--line); padding: .25rem .45rem;
  text-align: left; vertical-align: top; font-weight: 400; }
.checks thead th { font-weight: 600; color: var(--muted); }
.checks tr.bad td, .checks tr.bad th { color: var(--bad); }
`;

export function render(transcript, runDir) {
  const durationMs = Date.parse(transcript.finishedAt) - Date.parse(transcript.startedAt);
  const ordered = [...transcript.cases].sort(
    (a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status),
  );

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#14161a" media="(prefers-color-scheme: dark)">
<title>QA transcript — ${escapeHtml(transcript.startedAt)}</title>
<style>${STYLE}</style>
</head>
<body>
<header class="masthead">
  <h1>filesystem-mcp QA Transcript</h1>
  <p class="meta"><span translate="no">${escapeHtml(runDir)}</span> · started
    <time datetime="${escapeHtml(transcript.startedAt)}">${escapeHtml(transcript.startedAt)}</time>
    · ${escapeHtml(Math.round(durationMs / 1000))}&nbsp;s</p>
  <dl class="summary">
  ${Object.entries(transcript.summary)
    .map(
      ([label, count]) => `<div><dd>${escapeHtml(count)}</dd><dt>${escapeHtml(label)}</dt></div>`,
    )
    .join('\n  ')}
  </dl>
</header>
<main>
<article class="case">
  <h2>Server Profiles</h2>
  <p class="meta">fixture <code translate="no">${escapeHtml(transcript.fixtureDir)}</code></p>
  ${renderProfiles(transcript.profiles)}
</article>
${ordered.length ? ordered.map(renderCase).join('\n') : '<p class="meta">No cases ran.</p>'}
</main>
</body>
</html>
`;
}
