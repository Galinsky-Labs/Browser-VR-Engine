// Real PostgreSQL integration tests (F08). Requires TEST_DATABASE_URL pointing
// at a database the test may create/drop schemas in. Run: npm run test:integration
import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { createPostgresStores, migrateControl, CONTROL_MIGRATIONS, StoreError } from '@browser-vr-engine/control';
import { storeContract } from './shared.mjs';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is required for integration tests');

function sqlPool(schema) {
  const pool = new pg.Pool({ connectionString: url, max: 10, options: `-c search_path=${schema}` });
  return {
    pool,
    query: (text, params) => pool.query(text, params),
    async transaction(work) {
      const client = await pool.connect();
      try { await client.query('BEGIN'); const r = await work(client); await client.query('COMMIT'); return r; }
      catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
      finally { client.release(); }
    }
  };
}

const pools = [];
async function freshSchema() {
  const schema = `bvr_t_${Math.random().toString(36).slice(2, 10)}`;
  const admin = new pg.Client({ connectionString: url });
  await admin.connect(); await admin.query(`CREATE SCHEMA ${schema}`); await admin.end();
  const sql = sqlPool(schema);
  pools.push([sql, schema]);
  return sql;
}
test.after(async () => {
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  for (const [sql, schema] of pools) { await sql.pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); }
  await admin.end();
});

storeContract(test, async () => { const sql = await freshSchema(); await migrateControl(sql); return createPostgresStores(sql); });

test('migrations roll forward, roll back and recover predictably from a failed step', async () => {
  const sql = await freshSchema();
  assert.deepEqual((await migrateControl(sql)).applied, CONTROL_MIGRATIONS.map(m => m.id));
  assert.deepEqual((await migrateControl(sql)).applied, [], 'idempotent');
  assert.deepEqual((await migrateControl(sql, { target: '0001_documents' })).reverted, ['0003_jobs', '0002_objects']);
  assert.equal((await sql.query("SELECT to_regclass('bvr_jobs') AS t")).rows[0].t, null);
  const stores = createPostgresStores(sql);
  await stores.documents.put({ tenant: 'a', project: 'b' }, 'world', 'kept', { ok: true }, 0);
  const broken = [...CONTROL_MIGRATIONS, { id: '0004_broken', up: 'CREATE TABLE half (id int); SELECT * FROM missing_table;', down: 'DROP TABLE half;' }];
  await assert.rejects(migrateControl(sql, { migrations: broken }), e => e instanceof StoreError && /0004_broken failed and was rolled back/.test(e.message));
  const ids = (await sql.query('SELECT id FROM bvr_schema_migrations ORDER BY id')).rows.map(r => r.id);
  assert.deepEqual(ids, ['0001_documents'], 'a failed run leaves the schema exactly as before the run');
  assert.equal((await sql.query("SELECT to_regclass('half') AS t")).rows[0].t, null);
  assert.deepEqual((await stores.documents.get({ tenant: 'a', project: 'b' }, 'world', 'kept')).data, { ok: true }, 'data survives rollback');
  assert.deepEqual((await migrateControl(sql)).applied, ['0002_objects', '0003_jobs'], 'forward again after repair');
});

test('expired job leases are reclaimed by another worker', async () => {
  const sql = await freshSchema();
  await migrateControl(sql);
  const { jobs } = createPostgresStores(sql);
  const s = { tenant: 'acme', project: 'demo' };
  await jobs.submit(s, 'bake', 'k', {});
  const first = await jobs.claim(s, 'bake', 0.2);
  assert.equal(await jobs.claim(s, 'bake', 30), null);
  await new Promise(r => setTimeout(r, 300));
  const reclaimed = await jobs.claim(s, 'bake', 30);
  assert.equal(reclaimed.id, first.id);
  assert.equal(reclaimed.attempts, 2);
});

test('stored object corruption is detected', async () => {
  const sql = await freshSchema();
  await migrateControl(sql);
  const { objects } = createPostgresStores(sql);
  const s = { tenant: 'acme', project: 'demo' };
  await objects.put(s, 'x.bin', new Uint8Array([1, 2, 3]), 'application/octet-stream');
  await sql.query("UPDATE bvr_objects SET bytes = '\\x010204'");
  await assert.rejects(objects.get(s, 'x.bin'), e => e.code === 'integrity');
});
