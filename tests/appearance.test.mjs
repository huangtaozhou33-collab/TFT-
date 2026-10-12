import test from 'node:test';
import assert from 'node:assert/strict';
import {versionContext} from '../public/appearance.js';

test('version banner separates app, season, source rules, asset and actual game patches', () => {
  const result=versionContext({health:{version:'4.0.0'},catalog:{context:{set:18,assetVersion:'16.20',source_patch:'18.3'}},library:{status:'ready',rulesSource:{sourcePatch:'18.4'}}});
  assert.deepEqual(result,{appVersion:'4.0.0',season:18,rulePatch:'18.4',gamePatch:null,statPatch:'18.3',assetVersion:'16.20'});
  assert.equal(versionContext({catalog:{context:{gamePatch:'18.4b',assetVersion:'16.20'}},library:{status:'not_cached',rulesSource:{sourcePatch:'18.3'}}}).gamePatch,'18.4b');
  assert.equal(versionContext({library:{status:'not_cached',rulesSource:{sourcePatch:'18.3'}}}).rulePatch,null);
});

test('missing or placeholder patch metadata never appears as a confirmed current patch', () => {
  assert.equal(versionContext().gamePatch,null);
  assert.equal(versionContext({catalog:{context:{gamePatch:'latest',statPatch:'unknown',assetVersion:'18.4'}}}).gamePatch,null);
  assert.equal(versionContext({health:{version:'not-connected'}}).appVersion,'4.0.0');
});
