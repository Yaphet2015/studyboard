import { expect, it } from "vitest";
import { profileClock } from "../src/model/profile-clock";
import { sessionClock } from "../src/model/sessions";

it("formats profile dates without changing sidebar clocks", () => {
  const now = new Date(2026, 9, 26, 22);
  const today = new Date(2026, 9, 26, 21, 53).toISOString();
  expect(profileClock(today, now)).toBe("今天 21:53");
  expect(sessionClock(today, now)).toBe("21:53");
  expect(profileClock(new Date(2026, 9, 25, 21, 53).toISOString(), now)).toBe("昨天 21:53");
  expect(profileClock(new Date(2026, 9, 23).toISOString(), now)).toBe("10月23日");
  expect(profileClock(new Date(2025, 11, 3).toISOString(), now)).toBe("2025年12月3日");
  expect(profileClock("", now)).toBe("");
  expect(profileClock("invalid", now)).toBe("");
});
