import assert from "node:assert/strict";
import test from "node:test";

import { groupBy, uniqueBy } from "../dist/index.js";

test("groupBy groups any iterable and preserves order", () => {
  const values = new Set(["ant", "bear", "cat", "dolphin"]);

  const groups = groupBy(values, (value) => value.length);

  assert.deepEqual([...groups], [
    [3, ["ant", "cat"]],
    [4, ["bear"]],
    [7, ["dolphin"]],
  ]);
});

test("groupBy passes a stable iteration index to the selector", () => {
  const groups = groupBy(["a", "b", "c"], (_value, index) => index % 2);

  assert.deepEqual([...groups], [
    [0, ["a", "c"]],
    [1, ["b"]],
  ]);
});

test("uniqueBy keeps the first value for each key", () => {
  const values = [
    { id: 1, name: "first" },
    { id: 2, name: "second" },
    { id: 1, name: "duplicate" },
  ];

  assert.deepEqual(uniqueBy(values, (value) => value.id), values.slice(0, 2));
});

test("uniqueBy accepts non-array iterables", () => {
  function* numbers() {
    yield 1;
    yield 3;
    yield 2;
    yield 4;
  }

  assert.deepEqual(uniqueBy(numbers(), (value) => value % 2), [1, 2]);
});
