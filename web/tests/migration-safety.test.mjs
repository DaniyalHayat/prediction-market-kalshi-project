import test from 'node:test';
import assert from 'node:assert/strict';
import {assertAdditiveMigration,migrationHash} from '../lib/migration-safety.mjs';
test('normal migration path rejects destructive and disguised maintenance statements',()=>{
  for(const sql of ['DROP TABLE records','DROP /*comment*/ SCHEMA market_lab CASCADE','TRUNCATE TABLE market_lab.archives CASCADE','DELETE\nFROM market_lab.records',"DO $$ BEGIN EXECUTE 'DROP TABLE archives'; END $$;"])
    assert.throws(()=>assertAdditiveMigration(sql),/Destructive|destructive/);
  assert.equal(assertAdditiveMigration('CREATE TABLE example(id int); ALTER TABLE example ADD COLUMN name text;'),true);
  assert.equal(assertAdditiveMigration('CREATE TRIGGER evidence_guard BEFORE TRUNCATE ON archives EXECUTE FUNCTION guard();'),true);
  assert.equal(assertAdditiveMigration("SELECT 'DROP TABLE example';"),true);
  assert.equal(migrationHash('SELECT 1;\r\n'),migrationHash('SELECT 1;\n'));
});
