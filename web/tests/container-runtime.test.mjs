import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
+
test('signed stable zlib backport is pinned before build tools and never copied into runtime', async () => {
  for (const file of ['Dockerfile','Dockerfile.azure']) {
    const source = await readFile(new URL('../' + file, import.meta.url), 'utf8').catch(error => {
      if (error.code === 'ENOENT' && file === 'Dockerfile.azure') return null;
      throw error;
    });
    if (!source) continue;
    const stages = source.split(/\n(?=FROM )/);
    const builder = stages[0];
    assert.match(builder, /^FROM node:26\.12\.1-trixie-slim@sha256:[a-f0-9]{64} AS /);
    assert.match(builder, /apt-get update[\s\S]*apt-get install -y --no-install-recommends --only-upgrade zlib1g=1:1\.3\.dfsg\+really1\.3\.1-1\+deb13u1/);
    assert.match(builder, /dpkg-query -W -f='\$\{Version\}' zlib1g/);
    assert.ok(builder.indexOf('apt-get install') < (builder.indexOf('npm ') === -1 ? Infinity : builder.indexOf('npm ')));
    assert.doesNotMatch(source, /(?:sid|forky|bookworm|testing|unstable|allow-unauthenticated|trusted=yes)/);
    for (const stage of stages.filter(value => value.startsWith('FROM runtime'))) assert.doesNotMatch(stage, /apt-get|zlib1g|libz\.so/);
    if (file === 'Dockerfile.azure') {
      for (const name of ['build','geography','backend-dependencies']) assert.ok(stages.some(stage => stage.split(/\r?\n/,1)[0] === 'FROM build-base AS ' + name));
    }
  }
});

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
  assert.doesNotMatch(source, /--mount=type=cache,id=predictir-public-npm/);
});
