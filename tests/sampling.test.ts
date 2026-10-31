import { describe, expect, it } from "vitest";
import { modelRef, parseModelRef } from "../electron/ai-runtime";
import {
  isReasoningModel,
  maxOutputTokens,
  modeTemperature,
} from "../electron/prompts";

describe("per-mode sampling", () => {
  it("keeps structure generation cooler than hints and leaves agent modes alone", () => {
    expect(modeTemperature("map")).toBe(0.4);
    expect(modeTemperature("expand")).toBe(0.4);
    expect(modeTemperature("hint")).toBe(0.7);
    expect(modeTemperature("answer")).toBeUndefined();
    expect(modeTemperature("organize")).toBeUndefined();
  });
  it("round-trips a temperature through the configured model id", () => {
    expect(modelRef("gpt-4o-mini")).toBe("gpt-4o-mini");
    expect(parseModelRef(modelRef("gpt-4o-mini", 0.4))).toEqual({
      id: "gpt-4o-mini",
      temperature: 0.4,
    });
    expect(parseModelRef("deepseek-flash")).toEqual({ id: "deepseek-flash" });
  });
  it("gives reasoning models room for reasoning plus the answer", () => {
    for (const m of [
      "deepseek-flash",
      "deepseek/deepseek-v4.1-flash",
      "deepseek/deepseek-v4-flash",
      "deepseek-reasoner",
      "o3-mini",
      "qwq-32b",
      "deepseek-r1",
    ])
      expect(isReasoningModel(m)).toBe(true);
    for (const m of ["gpt-4o-mini", "qwen-plus", "deepseek-chat"])
      expect(isReasoningModel(m)).toBe(false);
    expect(maxOutputTokens("deepseek-flash")).toBe(32_768);
    expect(maxOutputTokens("gpt-4o-mini")).toBe(8_192);
  });
});
