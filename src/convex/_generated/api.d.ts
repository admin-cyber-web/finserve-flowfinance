/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as _inspect from "../_inspect.js";
import type * as _inspect_set_manager from "../_inspect_set_manager.js";
import type * as _inspect_targeted_backfill from "../_inspect_targeted_backfill.js";
import type * as admin from "../admin.js";
import type * as auth from "../auth.js";
import type * as auth_emailOtp from "../auth/emailOtp.js";
import type * as auth_staffCredentials from "../auth/staffCredentials.js";
import type * as cash from "../cash.js";
import type * as cleanup from "../cleanup.js";
import type * as clients from "../clients.js";
import type * as collections from "../collections.js";
import type * as http from "../http.js";
import type * as loanRateMigration from "../loanRateMigration.js";
import type * as loans from "../loans.js";
import type * as profiles from "../profiles.js";
import type * as reports from "../reports.js";
import type * as security from "../security.js";
import type * as securityAdmin from "../securityAdmin.js";
import type * as securityDevice from "../securityDevice.js";
import type * as seed from "../seed.js";
import type * as users from "../users.js";
import type * as wallet from "../wallet.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  _inspect: typeof _inspect;
  _inspect_set_manager: typeof _inspect_set_manager;
  _inspect_targeted_backfill: typeof _inspect_targeted_backfill;
  admin: typeof admin;
  auth: typeof auth;
  "auth/emailOtp": typeof auth_emailOtp;
  "auth/staffCredentials": typeof auth_staffCredentials;
  cash: typeof cash;
  cleanup: typeof cleanup;
  clients: typeof clients;
  collections: typeof collections;
  http: typeof http;
  loanRateMigration: typeof loanRateMigration;
  loans: typeof loans;
  profiles: typeof profiles;
  reports: typeof reports;
  security: typeof security;
  securityAdmin: typeof securityAdmin;
  securityDevice: typeof securityDevice;
  seed: typeof seed;
  users: typeof users;
  wallet: typeof wallet;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
