import { internalMutation } from "./_generated/server";
import {
  bankAccountValue,
  loanRequestValue,
  nomineeValue,
  referencesValue,
} from "../lib/finance/validate";

/**
 * LIVE round-trip check for the restored New Client form sections.
 *
 * Run with:
 *   bun convex run _tmpClientFormTest:roundTrip
 *
 * It mirrors exactly what `clients.create` persists for sections 1–6 plus the
 * family rows, re-reads the record (== reopening it), then applies the same
 * patch `clients.update` applies for an edit, re-reads again, and finally
 * removes every row it created. Every payload goes through the SAME shared
 * validators the real mutations use, so a value that would be rejected by
 * create/update is rejected here too.
 *
 * It writes nothing of its own: the client row, its family row and the
 * temporary document are always deleted before it returns (all inside one
 * transaction, so a crash rolls everything back).
 */
export const roundTrip = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    type Check = { name: string; expected: string; actual: string; pass: boolean };
    const checks: Check[] = [];
    // Deep, key-order-insensitive comparison (Convex stores object keys
    // alphabetically, so naive JSON.stringify would compare insertion order).
    const stable = (value: unknown): string => {
      if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
      if (value && typeof value === "object") {
        const entries = Object.entries(value as Record<string, unknown>)
          .filter(([, v]) => v !== undefined)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`);
        return `{${entries.join(",")}}`;
      }
      return JSON.stringify(value ?? null);
    };
    const check = (name: string, expected: unknown, actual: unknown) =>
      checks.push({
        name,
        expected: stable(expected),
        actual: stable(actual),
        pass: stable(expected) === stable(actual),
      });

    // Real branch + actor, as `clients.create` resolves them.
    const branches = (await ctx.db.query("branches").collect()).filter(
      (b) => b.status === "ACTIVE",
    );
    const profiles = await ctx.db.query("profiles").collect();
    const branch = branches[0];
    const actor =
      profiles.find((p) => p.role === "SUPER_ADMIN") ?? profiles[0];
    if (!branch || !actor) {
      return {
        ok: false,
        checks,
        note: "Need at least one ACTIVE branch and one profile in this deployment.",
      };
    }

    // ---------------- CREATE: what the form submits ----------------------
    const householdExpenses = 12500.5;
    const loanRequest = loanRequestValue({
      amountRequested: 25000,
      purpose: "BUSINESS",
      tenureMonths: 12,
      repaymentFrequency: "MONTHLY",
      estimatedInstallment: 2450,
    });
    const bankAccount = bankAccountValue({
      accountHolderName: "Round Trip Client",
      bankName: "State Bank of India",
      branch: "Ballia Town",
      accountNumber: " 123456789012 ",
      ifscCode: "sbin0001234",
    });
    const nominee = nomineeValue({
      name: "Round Trip Nominee",
      relationship: "Husband",
      age: 38,
      mobile: "9876543210",
      address: "Ward 4, Ballia",
    });
    const references = referencesValue([
      { name: "Reference One", mobile: "9876543210" },
      { name: "Reference Two", mobile: "9123456780" },
    ]) as NonNullable<ReturnType<typeof referencesValue>>;

    const clientId = await ctx.db.insert("clients", {
      code: `C-TMP${String(now).slice(-6)}`,
      name: "Round Trip Client",
      age: 33,
      gender: "FEMALE",
      mobile: "9876500001",
      address: "Test household, Ballia",
      village: "Test household",
      district: "Ballia",
      state: "Uttar Pradesh",
      pin: "277001",
      // Section 1 — income & business details
      occupation: "Shopkeeper",
      typeOfBusiness: "Kirana store",
      businessAddress: "Ward 4, Ballia",
      monthlyIncome: 18000,
      householdIncome: 24000,
      householdExpenses,
      otherIncome: 3000,
      existingLoanEmi: 1200,
      familyMembers: 1,
      // Sections 2–5
      loanRequest,
      bankAccount,
      nominee,
      references,
      // Declaration + section 6 (created by an authorised actor here)
      declarationAcceptedAt: now,
      officeUse: {
        fieldOfficerName: "Field Officer Test",
        customerVerification: "VERIFIED",
        kycVerification: "COMPLETE",
        creditAssessment: "RECOMMENDED",
        approvedLoanAmount: 20000,
        updatedAt: now,
        updatedBy: actor._id,
      },
      branchId: branch._id,
      assignedTo: actor._id,
      createdBy: actor._id,
      kycStatus: "PENDING",
      status: "ACTIVE",
      searchText: `round trip client 9876500001`,
      createdAt: now,
    });
    const familyRowId = await ctx.db.insert("clientFamilyMembers", {
      clientId,
      name: "Round Trip Member",
      age: 30,
      relationship: "Husband",
      occupation: "Farmer",
      createdAt: now,
    });

    // ---------------- REOPEN: read everything back -----------------------
    const opened = await ctx.db.get(clientId);
    const family = (
      await ctx.db.query("clientFamilyMembers").collect()
    ).filter((r) => r.clientId === clientId);

    check("section1.householdExpenses", householdExpenses, opened?.householdExpenses);
    check("section1.otherIncome", 3000, opened?.otherIncome);
    check("section1.existingLoanEmi", 1200, opened?.existingLoanEmi);
    check("section1.typeOfBusiness", "Kirana store", opened?.typeOfBusiness);
    check("section1.businessAddress", "Ward 4, Ballia", opened?.businessAddress);
    check(
      "section2.loanRequest",
      { amountRequested: 25000, purpose: "BUSINESS", tenureMonths: 12, repaymentFrequency: "MONTHLY", estimatedInstallment: 2450 },
      opened?.loanRequest,
    );
    check(
      "section3.bankAccount",
      { accountHolderName: "Round Trip Client", bankName: "State Bank of India", branch: "Ballia Town", accountNumber: "123456789012", ifscCode: "SBIN0001234" },
      opened?.bankAccount,
    );
    check("section4.nominee.age", 38, opened?.nominee?.age);
    check("section4.nominee.mobile", "9876543210", opened?.nominee?.mobile);
    check(
      "section5.references",
      [
        { name: "Reference One", mobile: "9876543210" },
        { name: "Reference Two", mobile: "9123456780" },
      ],
      opened?.references,
    );
    check("section6.officeUse.creditAssessment", "RECOMMENDED", opened?.officeUse?.creditAssessment);
    check("section6.officeUse.approvedLoanAmount", 20000, opened?.officeUse?.approvedLoanAmount);
    check("family.rows", 1, family.length);
    check("family.rows[0]", { name: "Round Trip Member", relationship: "Husband", occupation: "Farmer" }, { name: family[0]?.name, relationship: family[0]?.relationship, occupation: family[0]?.occupation });

    // ---------------- EDIT: the clients.update-shaped patch --------------
    await ctx.db.patch(clientId, {
      typeOfBusiness: "Kirana store (edited)",
      businessAddress: "Ward 4, Ballia (edited)",
      householdExpenses: 13000,
      otherIncome: undefined, // "" → null → undefined clears the field
      existingLoanEmi: 2500,
      references: referencesValue([
        { name: "Reference Two", mobile: "9123456780" },
        { name: "Reference Renamed", mobile: "9999999999" },
      ]),
      loanRequest: loanRequestValue({
        amountRequested: 30000,
        purpose: "AGRICULTURE",
        tenureMonths: 18,
        repaymentFrequency: "WEEKLY",
        estimatedInstallment: 900,
      }),
      bankAccount: bankAccountValue({
        accountHolderName: "Round Trip Client",
        bankName: "State Bank of India",
        branch: "Ballia Town",
        accountNumber: "123456789012",
        ifscCode: "sbin0001234",
      }),
      nominee: nomineeValue({
        name: "Round Trip Nominee",
        relationship: "Husband",
        age: 39,
        mobile: "9876543210",
        address: "Ward 4, Ballia",
      }),
    });

    // ---------------- REOPEN AFTER EDIT ----------------------------------
    const edited = await ctx.db.get(clientId);
    check("edit.section1.householdExpenses", 13000, edited?.householdExpenses);
    check("edit.section1.typeOfBusiness", "Kirana store (edited)", edited?.typeOfBusiness);
    check("edit.section1.otherIncome cleared", false, edited?.otherIncome !== undefined);
    check("edit.section1.existingLoanEmi", 2500, edited?.existingLoanEmi);
    check("edit.section2.loanRequest.purpose", "AGRICULTURE", edited?.loanRequest?.purpose);
    check("edit.section2.loanRequest.amount", 30000, edited?.loanRequest?.amountRequested);
    check("edit.section3.bankAccount.ifscCode", "SBIN0001234", edited?.bankAccount?.ifscCode);
    check("edit.section4.nominee.age", 39, edited?.nominee?.age);
    check(
      "edit.section5.references",
      [
        { name: "Reference Two", mobile: "9123456780" },
        { name: "Reference Renamed", mobile: "9999999999" },
      ],
      edited?.references,
    );
    check("untouched: officeUse kept", "RECOMMENDED", edited?.officeUse?.creditAssessment);
    check("untouched: loan block fields stay put", 18000, edited?.monthlyIncome);
    check("untouched: family rows", 1, family.length);

    // ---------------- CLEANUP -------------------------------------------
    await ctx.db.delete(familyRowId);
    await ctx.db.delete(clientId);
    const gone = !(await ctx.db.get(clientId));

    const ok = checks.every((c) => c.pass) && gone;
    return { ok, cleanedUp: gone, checks };
  },
});