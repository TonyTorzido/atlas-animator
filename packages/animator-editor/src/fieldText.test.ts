import { describe, expect, it } from "vitest";
import { fieldText } from "./setupRigUi.js";

describe("fieldText", () => {
  it("shows px and degrees to 1 decimal, trimmed", () => {
    expect(fieldText(91.543, "1")).toBe("91.5");
    expect(fieldText(-3.9, "0.5")).toBe("-3.9");
    expect(fieldText(12, "1")).toBe("12");
    expect(fieldText(-0.04, "1")).toBe("0");
  });
  it("shows scales and mixes to 2 decimals, trimmed", () => {
    expect(fieldText(1.2499, "0.05")).toBe("1.25");
    expect(fieldText(1, "0.05")).toBe("1");
    expect(fieldText(0.5, "0.05")).toBe("0.5");
  });
});
