import { describe, expect, it } from "vitest";
import { rankMostAvailableAccount } from "../src/accounts/selector.js";
import type { QuotaResult } from "../src/accounts/quota.js";
import type { Account } from "../src/accounts/store.js";

const account = (id: string): Account => ({
  alias: id,
  id,
  accessToken: `access-${id}`,
  refreshToken: `refresh-${id}`,
  accountId: `account-${id}`,
  expiresAt: 1_700_000_000_000,
  enabled: true,
  usageCount: 0,
  lastUsed: null,
  rateLimitedUntil: null,
  authInvalidAt: null,
});

const quota = (
  alias: string,
  fiveHourRemaining: number,
  weeklyRemaining: number,
): QuotaResult => ({
  alias,
  status: "ok",
  quota: {
    fiveHour: {
      usedPercent: 100 - fiveHourRemaining,
      remainingPercent: fiveHourRemaining,
      resetAfterSeconds: 1,
    },
    weekly: {
      usedPercent: 100 - weeklyRemaining,
      remainingPercent: weeklyRemaining,
      resetAfterSeconds: 1,
    },
  },
});

describe("most-available account ranking", () => {
  it("selects the highest minimum remaining percentage", () => {
    const accounts = [account("a"), account("b"), account("c")];
    const observations = new Map<string, QuotaResult>([
      ["a", quota("a", 90, 20)],
      ["b", quota("b", 40, 50)],
      ["c", quota("c", 30, 80)],
    ]);

    expect(rankMostAvailableAccount(accounts, observations)?.id).toBe("b");
  });

  it("keeps the first cursor-ordered account when scores tie", () => {
    const accounts = [account("after-cursor"), account("later")];
    const observations = new Map<string, QuotaResult>([
      ["after-cursor", quota("after-cursor", 40, 70)],
      ["later", quota("later", 80, 40)],
    ]);

    expect(rankMostAvailableAccount(accounts, observations)?.id).toBe(
      "after-cursor",
    );
  });

  it("ranks positive above zero and scored zero above unscored", () => {
    const accounts = [
      account("unscored"),
      account("zero"),
      account("positive"),
    ];
    const observations = new Map<string, QuotaResult>([
      ["zero", quota("zero", 0, 80)],
      ["positive", quota("positive", 1, 1)],
    ]);

    expect(rankMostAvailableAccount(accounts, observations)?.id).toBe(
      "positive",
    );
    expect(
      rankMostAvailableAccount(accounts.slice(0, 2), observations)?.id,
    ).toBe("zero");
  });

  it("keeps all-zero candidates selectable in cursor order", () => {
    const accounts = [account("first"), account("second")];
    const observations = new Map<string, QuotaResult>([
      ["first", quota("first", 0, 0)],
      ["second", quota("second", 0, 0)],
    ]);

    expect(rankMostAvailableAccount(accounts, observations)?.id).toBe("first");
  });

  it("returns no winner when observations are failed, absent, or incomplete", () => {
    const accounts = [
      account("failed"),
      account("missing"),
      account("partial"),
    ];
    const observations = new Map<string, QuotaResult>([
      ["failed", { alias: "failed", status: "failed" }],
      [
        "partial",
        {
          alias: "partial",
          status: "ok",
          quota: {
            fiveHour: {
              usedPercent: 50,
              remainingPercent: 50,
              resetAfterSeconds: 1,
            },
          } as QuotaResult["quota"],
        },
      ],
    ]);

    expect(rankMostAvailableAccount(accounts, observations)).toBeUndefined();
  });
});
