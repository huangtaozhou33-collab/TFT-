import test from 'node:test';
import assert from 'node:assert/strict';
import { OPGG_PATCH_URL, RIOT_SCHEDULE_URL, parseOPGGPatch, parseRiotSchedule, fetchPatchPage, probeOPGGPatch } from '../scripts/probe-opgg-patch.mjs';

// Structure observed in the public OP.GG default comps page on 2026-10-10.
const PAGE = '<select name="version" id="version"><option value="18.4" selected="">18.4</option><option value="18.5">18.5</option></select><label for="version"><span><div>版本<!-- -->: <!-- -->18.4</div></span></label>';
const SCHEDULE = '<table><thead><tr><th>Patch</th><th>Scheduled Date (Pacific Time)</th></tr></thead><tbody><tr><td>TFT 18.3</td><td>September 23, 2026 (Thursday)</td></tr><tr><td>TFT 18.4</td><td>October 7, 2026</td></tr><tr><td>TFT 18.5</td><td>October 21, 2026</td></tr><tr><td>TFT 18.6B</td><td>November 11, 2026</td></tr></tbody></table>';
const NOW = new Date('2026-10-09T20:00:00Z');

test('OP.GG selected version and visible Chinese label agree; future options and scripts are ignored', () => {
  const result = parseOPGGPatch(`${PAGE}<script>{"version":"19.1"}</script><a href="?version=19.2">19.2</a>`);
  assert.equal(result.status, 'known');
  assert.equal(result.patch, '18.4');
  assert.deepEqual(result.candidates, ['18.4']);
});

test('English label fallback parses nested markup and non-breaking space', () => {
  assert.equal(parseOPGGPatch('<label for="version"><span>Version</span>:&nbsp;<b>18.4</b></label>').patch, '18.4');
});

test('conflicting or invalid current controls are unknown instead of picking highest', () => {
  assert.equal(parseOPGGPatch(PAGE.replace('<!-- -->18.4', '<!-- -->18.3')).status, 'unknown');
  assert.equal(parseOPGGPatch('<select name="version"><option selected value="18.4">18.4</option><option selected value="18.5">18.5</option></select>').status, 'unknown');
  assert.equal(parseOPGGPatch('<select name="version"><option selected value="PBE">PBE</option></select>').status, 'unknown');
});

test('unselected options, unrelated labels and hydration content cannot establish version', () => {
  assert.equal(parseOPGGPatch('<select name="version"><option value="18.5">18.5</option></select><script>Version: 18.5</script><label for="rank">Version:18.4</label>').patch, null);
});

test('schedule uses latest elapsed date in Pacific time, never maximum future patch', () => {
  const result = parseRiotSchedule(SCHEDULE, NOW);
  assert.equal(result.scheduledPatch, '18.4');
  assert.equal(result.scheduledDate, '2026-10-07');
  assert.equal(result.effectiveAt, null);
  assert.equal(result.transitionDay, false);
  const beforePacificMidnight = parseRiotSchedule(SCHEDULE, new Date('2026-10-07T06:59:59Z'));
  assert.equal(beforePacificMidnight.scheduledPatch, '18.3');
  const onDate = parseRiotSchedule(SCHEDULE, new Date('2026-10-07T07:00:00Z'));
  assert.equal(onDate.scheduledPatch, '18.4');
  assert.equal(onDate.transitionDay, true);
});

test('schedule retains B patch separately and reports same-date conflicts as unknown', () => {
  const bPatch = parseRiotSchedule(SCHEDULE, new Date('2026-11-12T12:00:00Z'));
  assert.equal(bPatch.scheduledPatch, '18.6B');
  assert.equal(bPatch.mainPatch, '18.6');
  assert.equal(parseRiotSchedule(SCHEDULE.replace('</tbody>', '<tr><td>TFT 19.1</td><td>October 7, 2026</td></tr></tbody>'), NOW).status, 'unknown');
  assert.equal(parseRiotSchedule(SCHEDULE, new Date('2026-01-01T12:00:00Z')).status, 'unknown');
});

test('probe produces source-page attribution, evidence hashes and exactly two fixed public requests', async () => {
  const calls = [];
  const report = await probeOPGGPatch({ now: NOW, fetchImpl: async (url, options) => {
    calls.push(url);
    assert.equal(options.redirect, 'error');
    return new Response(url === OPGG_PATCH_URL ? PAGE : SCHEDULE, { headers: { 'content-type': 'text/html;charset=utf-8' } });
  } });
  assert.deepEqual(calls, [OPGG_PATCH_URL, RIOT_SCHEDULE_URL]);
  assert.equal(report.readOnly, true);
  assert.equal(report.sourcePatch, null);
  assert.equal(report.assignedPatch, '18.4');
  assert.equal(report.method, 'source_page');
  assert.equal(report.checkedAt, NOW.toISOString());
  assert.match(report.pageHash, /^[a-f0-9]{64}$/);
  assert.equal(report.evidence.length, 2);
});

test('source page is primary even if planned calendar disagrees; disagreement remains visible', async () => {
  const report = await probeOPGGPatch({ now: NOW, fetchImpl: async url => new Response(url === OPGG_PATCH_URL ? PAGE.replaceAll('18.4', '18.3') : SCHEDULE, { headers: { 'content-type': 'text/html' } }) });
  assert.equal(report.assignedPatch, '18.3');
  assert.deepEqual(report.warnings, ['source_page_differs_from_planned_calendar']);
});

test('network/source ambiguity returns unknown and does not promote calendar to API patch', async () => {
  const report = await probeOPGGPatch({ now: NOW, fetchImpl: async url => {
    if (url === OPGG_PATCH_URL) throw new Error('Source unavailable');
    return new Response(SCHEDULE, { headers: { 'content-type': 'text/html' } });
  } });
  assert.equal(report.status, 'unknown');
  assert.equal(report.assignedPatch, null);
  assert.equal(report.sourcePatch, null);
  assert.equal(report.calendar.scheduledPatch, '18.4');
});

test('page requests reject arbitrary URLs, non-HTML, HTTP failure and oversized bodies', async () => {
  await assert.rejects(fetchPatchPage('https://op.gg/zh-cn/tft/meta-trends/comps?version=18.5'), /fixed public/);
  await assert.rejects(fetchPatchPage(OPGG_PATCH_URL, { fetchImpl: async () => new Response('{}', { headers: { 'content-type': 'application/json' } }) }), /HTML/);
  await assert.rejects(fetchPatchPage(OPGG_PATCH_URL, { fetchImpl: async () => new Response('blocked', { status: 403 }) }), /HTTP 403/);
  await assert.rejects(fetchPatchPage(OPGG_PATCH_URL, { fetchImpl: async () => new Response('x', { headers: { 'content-type': 'text/html', 'content-length': '5000001' } }) }), /size limit/);
});
