import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { executeEnvironmentQuery } from "../src/environment/executor";
import { sampleEnvironmentSubject } from "../src/environment/sampler";
import { EnvironmentRepository } from "../src/pipeline/environment-repository";
import { environmentSubjectCatalog } from "../src/pipeline/grounding-resolver";

test("every renderable entity is an addressable environment subject", async () => {
  const repository = new EnvironmentRepository(
    path.resolve(__dirname, "../web/public/environments"),
  );
  const environment = await repository.load("example-15-dancer-arc");

  assert.equal(
    environment.semanticAnchors.some(({ entityId }) => entityId === "light-c"),
    false,
  );
  const sample = sampleEnvironmentSubject(environment, "light-c", 0);
  assert.equal(sample.subjectKind, "entity");
  assert.equal(sample.entityId, "light-c");
  assert.deepEqual(sample.center, [0, 4.8, 2.5]);
  assert.deepEqual(sample.box?.size, [0.84, 0.84, 0.84]);

  const dancer = sampleEnvironmentSubject(environment, "dancer-entity", 0);
  assert.deepEqual(dancer.center, [0, 0.93, 0]);

  const catalog = environmentSubjectCatalog(environment);
  assert.equal(catalog.find(({ id }) => id === "light-c")?.kind, "entity");
  assert.equal(catalog.find(({ id }) => id === "dancer_face")?.kind, "semanticAnchor");

  const resolution = executeEnvironmentQuery(environment, {
    type: "resolveSubjectReferences",
    bindings: [{ ref: "orb_ref", status: "resolved", subjectIds: ["light-c"] }],
  });
  assert.equal(resolution.type, "resolveSubjectReferences");
  assert.deepEqual(resolution.bindings[0], {
    ref: "orb_ref",
    status: "resolved",
    subjectIds: ["light-c"],
  });
});

test("semantic anchors expose named sub-entity regions", async () => {
  const repository = new EnvironmentRepository(
    path.resolve(__dirname, "../web/public/environments"),
  );
  const environment = await repository.load("example-15-dancer-arc");

  const sample = sampleEnvironmentSubject(environment, "dancer_face", 0);
  assert.equal(sample.subjectKind, "semanticAnchor");
  assert.equal(sample.entityId, "dancer-entity");
  assert.deepEqual(sample.center, [0, 1.61, 0.16]);
});
