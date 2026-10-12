import { sha256, stableJSON } from '../../scripts/stats-cache.mjs';

const patch = value => typeof value === 'string' && /^\d+\.\d+[a-z]?$/.test(value);
const parseJSON = value => typeof value === 'string' ? JSON.parse(value) : value;
const supported = new Set(['tft_list_meta_decks', 'tft_get_champion_item_build', 'tft_list_champions_for_item']);
export function effectiveSnapshotPatch(record) {
  // A declared upstream patch always takes precedence over an inferred archive label.
  if (patch(record?.sourcePatch)) return record.sourcePatch;
  const attribution = record?.patchAssignment;
  return patch(record?.assignedPatch) && attribution?.assignedPatch === record.assignedPatch
    && ['manual_calendar', 'source_page'].includes(attribution.method)
    && attribution.contentHash === record.contentHash && /^[a-f0-9]{64}$/.test(record.contentHash || '')
    ? record.assignedPatch : null;
}
export function snapshotPatchEvidence(record) {
  const full = record.patchAssignment;
  const publicAttribution = full ? Object.fromEntries(['method','label','note','checkedAt','evidenceUrls','transitionWindow','hotfix'].map(key => [key,full[key] ?? null])) : null;
  return { sourcePatch: record.sourcePatch ?? null, assignedPatch: record.assignedPatch ?? null,
    effectivePatch: effectiveSnapshotPatch(record), patchAssignment: publicAttribution,
    currentPatch: record.release.currentPatch, delivery: 'mysql', releaseId: record.release.id };
}
export function validatePatchPolicy(policy) {
  const validDate = value => typeof value === 'string' && /Z$/.test(value) && Number.isFinite(Date.parse(value));
  if (!policy || !/^[a-f0-9]{64}$/.test(policy.releaseId || '') || !patch(policy.assignedPatch)
    || !['manual_calendar', 'source_page'].includes(policy.method) || !Number.isInteger(policy.season)
    || !validDate(policy.captureStart) || !validDate(policy.captureEnd) || !validDate(policy.checkedAt)
    || Date.parse(policy.captureStart) >= Date.parse(policy.captureEnd) || !policy.note
    || !Array.isArray(policy.evidenceUrls) || !policy.evidenceUrls.length
    || policy.evidenceUrls.some(value => { try { const url = new URL(value); return url.protocol !== 'https:' || !!url.username || !!url.password; } catch { return true; } })) {
    throw Object.assign(new Error('Invalid patch attribution policy.'), { code: 'PATCH_ATTRIBUTION_INVALID' });
  }
  return policy;
}
// MySQL binary JSON can re-emit a floating value a few ULPs away from the
// original JSON. Only compare against a separately checksum-verified payload;
// structural, string, integer and material numeric changes remain forbidden.
export function sameJSONAfterNumericRoundTrip(left, right) {
  if (left === right) return true;
  if (typeof left === 'number' && typeof right === 'number') {
    return Number.isFinite(left) && Number.isFinite(right) && !Number.isInteger(left) && !Number.isInteger(right)
      && Math.abs(left-right) <= Number.EPSILON * Math.max(Math.abs(left),Math.abs(right)) * 4;
  }
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object' || Array.isArray(left)!==Array.isArray(right)) return false;
  const keys=Object.keys(left);
  return keys.length===Object.keys(right).length && keys.every(key=>Object.hasOwn(right,key)&&sameJSONAfterNumericRoundTrip(left[key],right[key]));
}
export function planPatchAssignments(rows, release, policy, referenceSnapshots = new Map()) {
  validatePatchPolicy(policy);
  if (release.id !== policy.releaseId || release.season !== policy.season || release.currentPatch !== policy.assignedPatch) return [];
  return rows.flatMap(row => {
    const payload = parseJSON(row.payload), evidence = payload?.evidence;
    if (row.source_patch || row.evidence_kind !== 'statistics' || !row.snapshot_key.startsWith('opgg:')
      || !supported.has(evidence?.tool) || payload.status !== 'live' || evidence.set !== policy.season) return [];
    let validation='payload_hash';
    if(sha256(payload)!==row.content_hash) {
      const reference=referenceSnapshots.get(row.snapshot_key);
      if(!reference || sha256(reference)!==row.content_hash || !sameJSONAfterNumericRoundTrip(reference,payload)) return [];
      validation='seed_hash_and_mysql_numeric_roundtrip';
    }
    const captured = Date.parse(evidence.fetchedAt);
    if (!Number.isFinite(captured) || captured < Date.parse(policy.captureStart) || captured >= Date.parse(policy.captureEnd)) return [];
    const attribution = { ...policy, policyHash: sha256(policy), contentHash: row.content_hash,
      fetchedAt: evidence.fetchedAt, sourceTime: evidence.sourceTime ?? null, sourcePatch: null,
      label: policy.method === 'manual_calendar' ? '按采集时间推定' : '按来源页面推定', validation, hotfix: null };
    return [{ key: row.snapshot_key, contentHash: row.content_hash, assignedPatch: policy.assignedPatch, attribution }];
  });
}
export async function applyPatchAssignments(db, release, policy, { apply = false, referenceSnapshots = new Map() } = {}) {
  validatePatchPolicy(policy);
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const [active] = await connection.query('SELECT active_release,current_patch FROM runtime_state WHERE id=1 FOR UPDATE');
    if (active[0]?.active_release !== release.id || active[0]?.current_patch !== release.currentPatch) throw new Error('Active release changed; retry attribution.');
    const [rows] = await connection.execute('SELECT snapshot_key,source_patch,evidence_kind,content_hash,payload FROM source_snapshots WHERE release_id=?',[release.id]);
    const assignments = planPatchAssignments(rows, release, policy, referenceSnapshots);
    let changed = 0; const changes = [];
    if (apply) for (const row of assignments) {
      const [previous] = await connection.execute('SELECT content_hash,assigned_patch,attribution FROM snapshot_patch_assignments WHERE release_id=? AND snapshot_key=?',[release.id,row.key]);
      if (previous.length && previous[0].content_hash === row.contentHash && previous[0].assigned_patch === row.assignedPatch
        && parseJSON(previous[0].attribution).policyHash === row.attribution.policyHash) continue;
      await connection.execute('INSERT INTO snapshot_patch_assignments(release_id,snapshot_key,content_hash,assigned_patch,attribution) VALUES(?,?,?,?,?) ON DUPLICATE KEY UPDATE content_hash=VALUES(content_hash),assigned_patch=VALUES(assigned_patch),attribution=VALUES(attribution),updated_at=CURRENT_TIMESTAMP(3)',
        [release.id,row.key,row.contentHash,row.assignedPatch,stableJSON(row.attribution)]);
      changes.push({snapshotKey:row.key,contentHash:row.contentHash,previous:previous.length?{assignedPatch:previous[0].assigned_patch,attribution:parseJSON(previous[0].attribution)}:null});
      changed++;
    }
    if (changed) await connection.execute("INSERT INTO change_log(release_id,kind,detail) VALUES(?,'statistics_patch_assigned',?)",[release.id,stableJSON({ policy, assigned: changed, sourcePatchPreserved: true, changes })]);
    await connection.commit();
    return { status: apply ? changed ? 'assigned' : 'unchanged' : 'dry_run', eligible: assignments.length, changed,
      releaseId: release.id, assignedPatch: policy.assignedPatch, method: policy.method, sourcePatchPreserved: true };
  } catch (error) { await connection.rollback(); throw error; }
  finally { connection.release(); }
}
