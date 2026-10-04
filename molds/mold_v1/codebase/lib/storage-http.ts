/**
 * A MISCONFIGURED FILE STORE, AS AN HTTP ANSWER.
 *
 * Two different things used to get the same answer from the web app:
 *
 *   not configured   the default driver (Vercel Blob) with no BLOB_READ_WRITE_TOKEN. The app degrades: GET
 *                    /api/dataroom lists nothing, the write routes say "storage is not configured". UNCHANGED.
 *   misconfigured    STORAGE_DRIVER is not a driver's name, or the selected driver is missing a required setting.
 *                    This used to look identical (an empty data room, "not configured"). It is now a 503 on every
 *                    storage route, with a sentence naming the setting, and one line in the server log.
 *
 * A route asks `storageMisconfigured()` once it knows who is calling, before it asks `storageConfigured()`; and maps
 * an error it caught with `storageErrorResponse()`. The routes that take no sign-in (a signed file link, the artifact
 * proxy) answer with `storageMisconfiguredPublic()`: the same status and code, without the setting's name.
 *
 * With nothing set (the live app) `storageConfigError()` reads two environment values and returns null: every route
 * goes on to exactly the code it ran before.
 */
import "server-only";

import { NextResponse } from "next/server";
import { isStorageConfigError, storageConfigError } from "@/lib/storage/index";

/** The `code` a client can key on, beside the sentence a person reads. */
export const STORAGE_MISCONFIGURED_CODE = "storage_misconfigured";

const HEADERS = { "cache-control": "no-store" };

function answer(detail: string | null): NextResponse {
  const error = detail
    ? `File storage is misconfigured on this server: ${detail} Nothing was read or written. An administrator must correct the setting.`
    : "File storage is misconfigured on this server. Nothing was read or written. An administrator must correct the setting.";
  return NextResponse.json({ error, code: STORAGE_MISCONFIGURED_CODE }, { status: 503, headers: HEADERS });
}

/** 503 naming the setting when the deployment's storage settings are wrong; null (carry on) when they are not. */
export function storageMisconfigured(): NextResponse | null {
  const error = storageConfigError();
  return error ? answer(error.message) : null;
}

/** The same, for a route anyone can call without signing in: the setting's name stays in the log and the health check. */
export function storageMisconfiguredPublic(): NextResponse | null {
  return storageConfigError() ? answer(null) : null;
}

/** A caught error as the 503 above when it is a storage misconfiguration; null for any other error. */
export function storageErrorResponse(error: unknown): NextResponse | null {
  return isStorageConfigError(error) ? answer(error.message) : null;
}
