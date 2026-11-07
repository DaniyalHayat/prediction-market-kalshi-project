import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const runtime = 'gcr.io/distroless/base-nossl-debian13@sha256:e6b0f82595aa1edde72c8054de7a9dca30f0f8f54820c37a167c0ddfc21c5c67';

function assertMinimalRuntime(source, stage) {
  assert.ok(stage.startsWith('FROM runtime'));
  assert.match(stage, /USER 65532:65532/);
  assert.match(stage, /ENTRYPOINT \["\/nodejs\/bin\/node"\]/);
  assert.doesNotMatch(stage, /(?:^|\n)RUN /);
  assert.doesNotMatch(stage, /COPY[^\n]*\s\/(?:usr\/local|lib\/|etc\/ssl)/);
  assert.match(stage, /--chown=65532:65532/);
  assert.ok(!source.includes('VOLUME '));
  const runtimeStage = source.split(/\n(?=FROM )/).find(value => value.startsWith('FROM ' + runtime + ' AS runtime'));
  assert.ok(runtimeStage);
  assert.doesNotMatch(runtimeStage, /(?:^|\n)RUN |libz\.so|libssl\.so|libcrypto\.so/);
  assert.match(runtimeStage, /COPY --from=node-runtime \/nodejs \/nodejs/);
  assert.match(runtimeStage, /\/var\/lib\/dpkg\/status\.d\/libstdc\+\+6/);
}

test('Railway runtime keeps dependencies in its builder and runs without OS package tooling', async () => {
  const source = await readFile(new URL('../Dockerfile', import.meta.url), 'utf8');
  const stage = source.slice(source.lastIndexOf('\nFROM ') + 1);
  assertMinimalRuntime(source, stage);
  assert.match(stage, /CMD \["--max-old-space-size=384", "cloud\/railway\.mjs"\]/);
  assert.match(stage, /COPY --from=dependencies.*node_modules/);
  assert.match(stage, /COPY --from=dependencies.*\/tmp\/market-lab-models/);
});
