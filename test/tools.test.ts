import test from "node:test";
import assert from "node:assert/strict";
import { rankSymbolMatches } from "../src/tools.ts";

test("exact case-sensitive match is ranked first", () => {
  const ranked = rankSymbolMatches("WellModel", [
    { name: "wellmodel_migration_0001", file: "db/migrations/0001.sql" },
    { name: "wellmodelHelper", file: "src/helpers.ts" },
    { name: "WellModel", file: "core/models/well_model.py" },
  ]);

  assert.equal(ranked[0].name, "WellModel");
  assert.equal(ranked[0].rank, "exact-case-sensitive");
});

test("exact case-sensitive beats exact case-insensitive", () => {
  const ranked = rankSymbolMatches("WellModel", [
    { name: "wellmodel" },
    { name: "WellModel" },
  ]);

  assert.deepEqual(
    ranked.map((m) => m.name),
    ["WellModel", "wellmodel"],
  );
  assert.equal(ranked[0].rank, "exact-case-sensitive");
  assert.equal(ranked[1].rank, "exact-case-insensitive");
});

test("exact symbol match beats prefix and partial matches", () => {
  const ranked = rankSymbolMatches("WellModel", [
    { name: "WellModelSerializer" },
    { name: "AbstractWellModelMixin" },
    { name: "WellModel" },
  ]);

  assert.equal(ranked[0].name, "WellModel");
  assert.equal(ranked[0].rank, "exact-case-sensitive");
  assert.equal(ranked[1].rank, "prefix");
  assert.equal(ranked[2].rank, "partial");
});

test("qualified-name exact match is recognized when bare name differs", () => {
  const ranked = rankSymbolMatches("WellModel", [
    { name: "SomethingElse", qualified_name: "pkg.mod.WellModel" },
  ]);
  assert.equal(ranked[0].rank, "qualified-exact");
});

test("symbol-kind priority: a definition kind outranks a same-named reference kind", () => {
  const cases: Array<[string, string]> = [
    ["data_class", "field"],
    ["type_alias", "field"],
    ["class", "field"],
    ["function", "property"],
  ];
  for (const [definitionKind, referenceKind] of cases) {
    const ranked = rankSymbolMatches("Thing", [
      { name: "Thing", kind: referenceKind, file: "src/reference.ts" },
      { name: "Thing", kind: definitionKind, file: "src/definition.ts" },
    ]);
    assert.equal(ranked[0].kind, definitionKind, `${definitionKind} should outrank ${referenceKind}`);
  }
});

test("WellModel resolves to the real class definition even with many similarly named references", () => {
  const matches = [
    { name: "wellmodel_0001_initial", kind: "migration", file: "db/migrations/0001_initial.py" },
    { name: "wellmodel_0002_add_index", kind: "migration", file: "db/migrations/0002_add_index.py" },
    { name: "WellModelSerializer", kind: "class", file: "api/serializers.py" },
    { name: "WellModelAdmin", kind: "class", file: "admin.py" },
    { name: "WellModel", kind: "class", file: "core/models/well_model.py", signature: "class WellModel(models.Model)" },
  ];

  const ranked = rankSymbolMatches("WellModel", matches);
  assert.equal(ranked[0].name, "WellModel");
  assert.equal(ranked[0].file, "core/models/well_model.py");
  assert.equal(ranked[0].rank, "exact-case-sensitive");
});
