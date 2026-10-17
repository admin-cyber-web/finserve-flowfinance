import { describe, expect, test } from "bun:test";
import {
  ValidationError,
  bankAccountValue,
  loanRequestValue,
  nomineeValue,
  referencesValue,
} from "../src/lib/finance/validate";

/**
 * Restored joining-form sections: every sub-object the form submits is
 * parsed by these helpers in BOTH clients.create and clients.update, so a
 * rejection here is exactly what the backend would reject.
 */

describe("references (two character-reference rows)", () => {
  test("keeps two complete rows, trimmed", () => {
    const rows = referencesValue([
      { name: "  Ramesh Kumar ", mobile: " 9876543210 " },
      { name: "Sunita Devi", mobile: "9123456780" },
    ]);
    expect(rows).toEqual([
      { name: "Ramesh Kumar", mobile: "9876543210" },
      { name: "Sunita Devi", mobile: "9123456780" },
    ]);
  });

  test("drops untouched rows and returns undefined when nothing is usable", () => {
    const oneUsed = referencesValue([
      { name: "", mobile: "" },
      { name: "Sunita Devi", mobile: "9123456780" },
    ]);
    expect(oneUsed).toHaveLength(1);

    expect(referencesValue([{ name: "", mobile: "" }, { name: "", mobile: "" }])).toBeUndefined();
    expect(referencesValue(undefined)).toBeUndefined();
    expect(referencesValue([])).toBeUndefined();
  });

  test("rejects a half-filled row (name without mobile, mobile without name)", () => {
    expect(() => referencesValue([{ name: "Ramesh", mobile: "" }])).toThrow(
      ValidationError,
    );
    expect(() => referencesValue([{ name: "", mobile: "9876543210" }])).toThrow(
      ValidationError,
    );
  });

  test("rejects a bad mobile number", () => {
    expect(() =>
      referencesValue([{ name: "Ramesh", mobile: "12345" }]),
    ).toThrow(ValidationError);
    // 6-9 leading digit rule, same as every other mobile field in the app.
    expect(() =>
      referencesValue([{ name: "Ramesh", mobile: "5876543210" }]),
    ).toThrow(ValidationError);
  });

  test("rejects more than two references", () => {
    const row = { name: "Ramesh", mobile: "9876543210" };
    expect(() => referencesValue([row, row, row])).toThrow(ValidationError);
  });
});

describe("loanDetails", () => {
  const valid = {
    amountRequested: 25000,
    purpose: "BUSINESS",
    tenureMonths: 12,
    repaymentFrequency: "MONTHLY",
    estimatedInstallment: 2450,
  };

  test("accepts a complete request", () => {
    expect(loanRequestValue(valid)).toEqual(valid);
  });

  test("rounds money to 2 decimals", () => {
    const parsed = loanRequestValue({
      ...valid,
      amountRequested: 25000.789,
      estimatedInstallment: 100.119,
    });
    expect(parsed.amountRequested).toBe(25000.79);
    expect(parsed.estimatedInstallment).toBe(100.12);
  });

  test("estimated installment is optional and may be zero", () => {
    const rest = { ...valid, estimatedInstallment: undefined };
    expect(loanRequestValue(rest).estimatedInstallment).toBeUndefined();
    expect(
      loanRequestValue({ ...valid, estimatedInstallment: 0 }).estimatedInstallment,
    ).toBe(0);
  });

  test("rejects a zero amount, an unknown purpose/frequency and a bad tenure", () => {
    expect(() => loanRequestValue({ ...valid, amountRequested: 0 })).toThrow(
      ValidationError,
    );
    expect(() => loanRequestValue({ ...valid, purpose: "TRAVEL" })).toThrow(
      ValidationError,
    );
    expect(() =>
      loanRequestValue({ ...valid, repaymentFrequency: "DAILY" }),
    ).toThrow(ValidationError);
    expect(() => loanRequestValue({ ...valid, tenureMonths: 0 })).toThrow(
      ValidationError,
    );
    expect(() => loanRequestValue({ ...valid, tenureMonths: 999 })).toThrow(
      ValidationError,
    );
  });

  test("a missing field of the block is rejected — no implicit defaults", () => {
    expect(() => loanRequestValue({ ...valid, purpose: undefined })).toThrow(
      ValidationError,
    );
    expect(() => loanRequestValue({ ...valid, tenureMonths: undefined })).toThrow(
      ValidationError,
    );
  });
});

describe("bankDetails", () => {
  const valid = {
    accountHolderName: "Sunita Devi",
    bankName: "State Bank of India",
    branch: "Ballia Town",
    accountNumber: " 123456789012 ",
    ifscCode: "sbin0001234",
  };

  test("accepts a complete account, strips spaces and uppercases the IFSC", () => {
    expect(bankAccountValue(valid)).toEqual({
      accountHolderName: "Sunita Devi",
      bankName: "State Bank of India",
      branch: "Ballia Town",
      accountNumber: "123456789012",
      ifscCode: "SBIN0001234",
    });
  });

  test("rejects account numbers outside 6–20 digits", () => {
    expect(() => bankAccountValue({ ...valid, accountNumber: "12345" })).toThrow(
      "Bank account number must be 6-20 digits.",
    );
    expect(() =>
      bankAccountValue({ ...valid, accountNumber: "123456789012345678901" }),
    ).toThrow("Bank account number must be 6-20 digits.");
    expect(() => bankAccountValue({ ...valid, accountNumber: "12345abc" })).toThrow(
      "Bank account number must be 6-20 digits.",
    );
  });

  test("rejects a malformed IFSC (4 letters, then 0, then 6 alphanumerics)", () => {
    expect(() => bankAccountValue({ ...valid, ifscCode: "SBIN1234" })).toThrow(
      "Invalid IFSC code — expected e.g. SBIN0001234.",
    );
    expect(() => bankAccountValue({ ...valid, ifscCode: "SBINX001234" })).toThrow(
      "Invalid IFSC code — expected e.g. SBIN0001234.",
    );
    expect(() => bankAccountValue({ ...valid, ifscCode: "SBIN000123" })).toThrow(
      "Invalid IFSC code — expected e.g. SBIN0001234.",
    );
  });

  test("requires every field of the block", () => {
    expect(() => bankAccountValue({ ...valid, branch: "  " })).toThrow(
      ValidationError,
    );
    expect(() => bankAccountValue({ ...valid, accountHolderName: undefined })).toThrow(
      ValidationError,
    );
  });
});

describe("nomineeDetails", () => {
  test("accepts a complete nominee with optional mobile/address", () => {
    expect(
      nomineeValue({
        name: "Ramesh Kumar",
        relationship: "Husband",
        age: 38,
      }),
    ).toEqual({
      name: "Ramesh Kumar",
      relationship: "Husband",
      age: 38,
      mobile: undefined,
      address: undefined,
    });
  });

  test("accepts the nominee with mobile and address filled", () => {
    const parsed = nomineeValue({
      name: "Ramesh Kumar",
      relationship: "Husband",
      age: 38,
      mobile: "9876543210",
      address: "Ward 4, Ballia",
    });
    expect(parsed.mobile).toBe("9876543210");
    expect(parsed.address).toBe("Ward 4, Ballia");
  });

  test("requires name, relationship and a plausible age", () => {
    expect(() =>
      nomineeValue({ name: "  ", relationship: "Husband", age: 38 }),
    ).toThrow(ValidationError);
    expect(() => nomineeValue({ name: "Ramesh", relationship: "", age: 38 })).toThrow(
      ValidationError,
    );
    expect(() =>
      nomineeValue({ name: "Ramesh", relationship: "Husband", age: 0 }),
    ).toThrow(ValidationError);
    expect(() =>
      nomineeValue({ name: "Ramesh", relationship: "Husband", age: 999 }),
    ).toThrow(ValidationError);
  });

  test("rejects a bad nominee mobile", () => {
    expect(() =>
      nomineeValue({
        name: "Ramesh",
        relationship: "Husband",
        age: 38,
        mobile: "11111",
      }),
    ).toThrow(ValidationError);
  });
});