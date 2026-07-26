import { describe, it, expect } from "vitest";
import {
  resolveAccount,
  isAllowedSender,
  assertAllowedTarget,
} from "./channel.js";

const cfg = {
  channels: {
    superchat: {
      apiKey: "test-key",
      channelId: "mc_test",
      contactId: "ct_allowed",
      contactIdentifier: "+491701234567",
    },
  },
} as any;

describe("superchat plugin", () => {
  it("resolves account from config", () => {
    const account = resolveAccount(cfg);
    expect(account.apiKey).toBe("test-key");
    expect(account.channelId).toBe("mc_test");
    expect(account.contactId).toBe("ct_allowed");
  });

  it("throws when the single-contact lock is not configured", () => {
    const bad = {
      channels: { superchat: { apiKey: "k", channelId: "mc_x" } },
    } as any;
    expect(() => resolveAccount(bad)).toThrow(/single contact/);
  });

  it("allows only the configured contact", () => {
    const account = resolveAccount(cfg);
    expect(isAllowedSender(account, "ct_allowed", null)).toBe(true);
    expect(isAllowedSender(account, null, "+491701234567")).toBe(true);
    expect(isAllowedSender(account, "ct_other", "+490000000000")).toBe(false);
    expect(isAllowedSender(account, null, null)).toBe(false);
  });

  it("refuses outbound targets other than the configured contact", () => {
    const account = resolveAccount(cfg);
    expect(() => assertAllowedTarget(account, "ct_allowed")).not.toThrow();
    expect(() => assertAllowedTarget(account, "+491701234567")).not.toThrow();
    expect(() => assertAllowedTarget(account, undefined)).not.toThrow();
    expect(() => assertAllowedTarget(account, "ct_other")).toThrow(/locked/);
  });
});
