import { describe, expect, it } from "vitest";
import { rosterOptions } from "../src/model-list.ts";

describe("模型下拉的选项", () => {
  const roster = [{ ref: "a/one" }, { ref: "a/two" }];
  const name = (ref: string) => ref.toUpperCase();

  it("选的模型在可用模型里：只列可用模型", () => {
    expect(rosterOptions(roster, "a/two", name).map((option) => option.value)).toEqual(["a/one", "a/two"]);
  });

  it("选的模型后来从可用模型里去掉了：照实列在最后，不显示成空", () => {
    const options = rosterOptions(roster, "a/old", name);
    expect(options.at(-1)).toEqual({ value: "a/old", label: "A/OLD（不在可用模型里）" });
  });
});
