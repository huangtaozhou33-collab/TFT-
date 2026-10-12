import test from 'node:test';
import assert from 'node:assert/strict';
import { localRequest, publicPort } from '../server/http-access.mjs';

test('Docker public port accepts only configured loopback hosts and same-authority origins', () => {
  const config = { port: 3000, externalPort: 3001 };
  for (const host of ['localhost:3000', '127.0.0.1:3000', '[::1]:3000', 'localhost:3001', '127.0.0.1:3001']) {
    assert.equal(localRequest({ headers: { host } }, config), true);
    assert.equal(localRequest({ headers: { host, origin: `http://${host}` } }, config), true);
  }
  for (const host of ['localhost:3002', '127.0.0.1:3002', 'evil.test:3001', 'localhost.evil.test:3001', '0.0.0.0:3001', '192.168.1.2:3001']) {
    assert.equal(localRequest({ headers: { host, 'x-forwarded-host': 'localhost:3001' } }, config), false);
  }
  for (const origin of ['https://localhost:3001', 'http://localhost:3000', 'http://evil.test:3001', 'http://name:password@localhost:3001', 'null']) {
    assert.equal(localRequest({ headers: { host: 'localhost:3001', origin } }, config), false);
  }
});

test('unconfigured public ports stay closed and invalid PUBLIC_PORT fails before serving', () => {
  assert.equal(publicPort('', 3000), 3000);
  assert.equal(publicPort('3001', 3000), 3001);
  for (const value of ['0', '65536', '3001,3002', 'host:3001', '3e3', '-1', '3001.5']) assert.throws(() => publicPort(value, 3000));
  assert.equal(localRequest({ headers: { host: 'localhost:3001' } }, { port: 3000 }), false);
});
