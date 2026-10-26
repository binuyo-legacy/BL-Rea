import type { Page, Request, Route } from "playwright-core";

import {
  HEADER_FIELD_VALUE,
  SAVED_PLACEHOLDER,
  type BrowserScenarioAction,
  type BrowserScenarioCredentialPart,
  type BrowserScenarioRequestHeader,
  type BrowserScenarioSaveEntry,
  type BrowserScenarioSaveResponse,
} from "../domain/browserScenarioValues.js";
import type { BrowserScenarioSecrets } from "./BrowserScenarioSecrets.js";

type RequestAction = Extract<BrowserScenarioAction, { action: "request" }>;

/** What the page's fetch returned; a redirect is not followed, so its status is unknown. */
type PageResponse =
  | { readonly status: number; readonly body?: string }
  | { readonly redirected: true }
  | { readonly left: string }
  | { readonly error: string };

/** A request step that could not be sent or did not answer as expected. */
export class ScenarioRequestError extends Error {
  override readonly name = "ScenarioRequestError";
}

const originOf = (url: string): string | undefined => {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
};

/** The string or number at a JSON pointer, as text. */
const pointerText = (value: unknown, pointer: string): string | undefined => {
  const found = pointerValue(value, pointer);
  return found === undefined ? undefined : String(found);
};

/** The string or number at a JSON pointer. */
const pointerValue = (
  value: unknown,
  pointer: string,
): string | number | undefined => {
  let current = value;
  if (pointer !== "")
    for (const token of pointer.slice(1).split("/")) {
      const key = token.replaceAll("~1", "/").replaceAll("~0", "~");
      if (Array.isArray(current) && /^(?:0|[1-9][0-9]*)$/u.test(key))
        current = current[Number(key)];
      else if (
        typeof current === "object" &&
        current !== null &&
        Object.hasOwn(current, key)
      )
        current = (current as Record<string, unknown>)[key];
      else return undefined;
    }
  return typeof current === "string" || typeof current === "number"
    ? current
    : undefined;
};

interface PageValueStep {
  readonly page: Page;
  readonly url: URL;
  readonly stepId: string;
  readonly secrets: BrowserScenarioSecrets;
}

/** Read a value from the page, a cookie or a local storage entry, and redact it from later records under a label. */
const readPageValue = async (
  step: PageValueStep,
  value: Extract<
    BrowserScenarioCredentialPart,
    { source: "cookie" | "local_storage" }
  >,
  label: string,
): Promise<string> => {
  const { page, url, stepId, secrets } = step;
  let read: string | undefined;
  if (value.source === "cookie") {
    const cookies = await page.context().cookies(url.href);
    read = cookies.find((cookie) => cookie.name === value.name)?.value;
    if (read === undefined)
      throw new ScenarioRequestError(
        `Request step ${stepId}: cookie ${value.name} is not set for ${url.origin}.`,
      );
  } else {
    const stored = await page.evaluate(
      ({ key, origin }) => {
        if (
          (globalThis as { readonly location?: { origin: string } }).location
            ?.origin !== origin
        )
          throw new Error(
            "The page moved off the start origin before its local storage was read.",
          );
        return (
          (
            globalThis as {
              readonly localStorage?: { getItem(key: string): string | null };
            }
          ).localStorage?.getItem(key) ?? null
        );
      },
      { key: value.key, origin: url.origin },
    );
    if (stored === null)
      throw new ScenarioRequestError(
        `Request step ${stepId}: local storage has no ${value.key} on ${url.origin}.`,
      );
    if (value.json_pointer === undefined) read = stored;
    else {
      let parsed: unknown;
      try {
        parsed = JSON.parse(stored);
      } catch {
        throw new ScenarioRequestError(
          `Request step ${stepId}: local storage ${value.key} is not JSON.`,
        );
      }
      read = pointerText(parsed, value.json_pointer);
      if (read === undefined)
        throw new ScenarioRequestError(
          `Request step ${stepId}: local storage ${value.key} has no string or number at ${value.json_pointer}.`,
        );
    }
  }
  secrets.admitPageValue(label, read);
  return read;
};

/** One part of Basic credentials: a literal, secret or saved value, or a value read from the page. */
const credentialPart = (
  step: PageValueStep,
  part: BrowserScenarioCredentialPart,
  label: string,
): Promise<string> | string =>
  part.source === "cookie" || part.source === "local_storage"
    ? readPageValue(step, part, label)
    : step.secrets.value(part);

/** Resolve one header value; values read from the page, and credentials built from them, are redacted from later records. */
const headerValue = async (
  step: PageValueStep,
  header: BrowserScenarioRequestHeader,
): Promise<string> => {
  const { stepId, secrets } = step;
  const { value } = header;
  const label = `${stepId}.${header.name}`;
  if (
    value.source === "literal" ||
    value.source === "secret" ||
    value.source === "saved"
  )
    return secrets.value(value);
  if (value.source === "basic_credentials") {
    const [username, password] = value.parts;
    const user = await credentialPart(step, username!, `${label}.username`);
    if (user.includes(":"))
      throw new ScenarioRequestError(
        `Request step ${stepId} has a Basic username with a colon, which the server would read as the end of the username.`,
      );
    const pass = await credentialPart(step, password!, `${label}.password`);
    const encoded = Buffer.from(`${user}:${pass}`).toString("base64");
    secrets.admitCredential(label, encoded);
    return encoded;
  }
  return readPageValue(step, value, label);
};

/** Append declared query entries after any literal query the path carries, leaving that query as written. */
const withQuery = (
  url: URL,
  entries: readonly (readonly [string, string])[],
): string => {
  if (entries.length === 0) return url.href;
  const added = entries
    .map(
      ([name, value]) =>
        `${encodeURIComponent(name)}=${encodeURIComponent(value)}`,
    )
    .join("&");
  // fetch drops the fragment; cut it at its "#" even when nothing follows it.
  const hash = url.href.indexOf("#");
  const base = hash < 0 ? url.href : url.href.slice(0, hash);
  const separator = !base.includes("?")
    ? "?"
    : base.endsWith("?") || base.endsWith("&")
      ? ""
      : "&";
  return `${base}${separator}${added}`;
};

/** What a request step sends: the URL, the origin it must be sent from, and the call. */
interface PageRequest {
  readonly url: string;
  readonly origin: string;
  readonly method: string;
  readonly headers: [string, string][];
  readonly body: string | undefined;
  readonly deadline: number | undefined;
  /** Return the response text up to this many characters, for a step that saves values from it. */
  readonly readLimit: number | undefined;
}

/** The largest response text a request step saves values from. */
const MAX_SAVED_RESPONSE_CHARACTERS = 4_000_000;

/** The most UTF-8 bytes text within that limit can take: three per UTF-16 code unit. */
const MAX_SAVED_RESPONSE_BYTES = 3 * MAX_SAVED_RESPONSE_CHARACTERS;

/** Send the request with the page's own fetch, from the page's main world, and read the whole answer. */
const sendFromPage = (
  page: Page,
  request: PageRequest,
): Promise<PageResponse> =>
  page.evaluate(async (request): Promise<PageResponse> => {
    // The page may have navigated since the origin check; never send from another origin.
    const here = (globalThis as { readonly location?: { origin: string } })
      .location?.origin;
    if (here !== request.origin) return { left: String(here) };
    if (
      (
        globalThis as {
          readonly navigator?: { serviceWorker?: { controller?: unknown } };
        }
      ).navigator?.serviceWorker?.controller
    )
      return {
        error:
          "Request steps require a page without a controlling service worker so cancellation can guard dispatch.",
      };
    const remaining =
      request.deadline === undefined
        ? undefined
        : request.deadline - Date.now();
    if (remaining !== undefined && remaining <= 0)
      return { error: "The request ran out of time before it was sent." };
    const controller = new AbortController();
    const timer =
      remaining === undefined
        ? undefined
        : setTimeout(() => controller.abort(), remaining);
    try {
      const answer = await fetch(request.url, {
        method: request.method,
        headers: request.headers,
        credentials: "same-origin",
        redirect: "manual",
        signal: controller.signal,
        ...(request.body === undefined ? {} : { body: request.body }),
      });
      if (answer.type === "opaqueredirect") return { redirected: true };
      if (request.readLimit !== undefined) {
        // Keep the text only up to the limit, so a large answer is never held whole.
        const reader = answer.body?.getReader();
        if (reader === undefined) return { status: answer.status, body: "" };
        const decoder = new TextDecoder();
        let text = "";
        try {
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            text += decoder.decode(chunk.value, { stream: true });
            if (text.length > request.readLimit) {
              await reader.cancel();
              return { status: answer.status };
            }
          }
        } finally {
          reader.releaseLock();
        }
        return { status: answer.status, body: text + decoder.decode() };
      }
      const reader = answer.body?.getReader();
      if (reader !== undefined)
        try {
          while (!(await reader.read()).done) {
            // Wait for completion without retaining a second response body.
          }
        } finally {
          reader.releaseLock();
        }
      return { status: answer.status };
    } catch (cause: unknown) {
      return {
        error: cause instanceof Error ? cause.message : String(cause),
      };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }, request);

/**
 * Send one request from the page with its own fetch, cookies and session, as
 * the application's frontend would, and read the whole response so the
 * capture can record it. The page must be on the scenario's start origin.
 */
export const performScenarioRequest = async (input: {
  readonly page: Page;
  readonly action: RequestAction;
  readonly secrets: BrowserScenarioSecrets;
  readonly startOrigin: string;
  readonly signal?: AbortSignal | undefined;
}): Promise<void> => {
  const { page, action, secrets, startOrigin, signal } = input;
  const deadline =
    action.timeout_ms === undefined
      ? undefined
      : Date.now() + action.timeout_ms;
  const pageOrigin = originOf(page.url());
  if (pageOrigin !== startOrigin)
    throw new ScenarioRequestError(
      `Request step ${action.step_id} runs from a page on the start origin ${startOrigin}; navigate back to it with a goto step first.`,
    );
  const url = new URL(withSavedPlaceholders(action.path, secrets), startOrigin);
  if (url.origin !== startOrigin)
    throw new ScenarioRequestError(
      `Request step ${action.step_id} must stay on the start origin ${startOrigin}.`,
    );
  const target = withQuery(
    url,
    action.query.map(({ name, value }) => [name, secrets.value(value)]),
  );
  const step = { page, url, stepId: action.step_id, secrets };
  const headers: [string, string][] = [];
  for (const header of action.headers) {
    const value = `${header.prefix ?? ""}${await headerValue(step, header)}`;
    if (!HEADER_FIELD_VALUE.test(value))
      throw new ScenarioRequestError(
        `Request step ${action.step_id}: the ${header.name} value holds characters a header cannot carry, such as a line break.`,
      );
    headers.push([header.name, value]);
  }
  const hasContentType = headers.some(
    ([name]) => name.toLowerCase() === "content-type",
  );
  if (action.json !== undefined && !hasContentType)
    headers.push(["content-type", "application/json"]);
  // A step the boundary abandoned, or whose time ran out while values were read, sends nothing.
  const remaining = deadline === undefined ? undefined : deadline - Date.now();
  if (signal?.aborted === true || (remaining !== undefined && remaining <= 0))
    throw new ScenarioRequestError(
      `Request step ${action.step_id} ran out of time before its request was sent.`,
    );
  const json =
    action.json === undefined ? undefined : withSavedJson(action.json, secrets);
  const request = {
    url: target,
    origin: startOrigin,
    method: action.method,
    headers,
    body: json === undefined ? undefined : JSON.stringify(json),
    deadline,
    readLimit:
      action.save.length > 0 ? MAX_SAVED_RESPONSE_CHARACTERS : undefined,
  };
  // The browser can queue evaluate behind a busy page. Keep a host-side gate
  // until that evaluation settles, including after the step boundary stops
  // waiting. A queued fetch then observes live cancellation at dispatch.
  const dispatchUrl = new URL(target);
  dispatchUrl.hash = "";
  const matches = (url: URL): boolean => url.href === dispatchUrl.href;
  const gate = async (route: Route): Promise<void> => {
    const sent = route.request();
    if (
      sent.method() !== request.method ||
      sent.postData() !== (request.body ?? null)
    ) {
      await route.fallback();
      return;
    }
    if (
      signal?.aborted === true ||
      (deadline !== undefined && Date.now() >= deadline)
    )
      await route.abort("aborted");
    else await route.fallback();
  };
  await page.route(matches, gate);
  let response: PageResponse;
  try {
    response = await sendFromPage(page, request);
  } finally {
    await page.unroute(matches, gate);
  }
  if ("error" in response)
    throw new ScenarioRequestError(
      `Request step ${action.step_id} failed in the page: ${response.error}`,
    );
  if ("left" in response)
    throw new ScenarioRequestError(
      `Request step ${action.step_id} runs from a page on the start origin ${startOrigin}; the page moved before the request was sent.`,
    );
  if ("redirected" in response)
    throw new ScenarioRequestError(
      `Request step ${action.step_id} was answered with a redirect, which request steps do not follow; a write may already have been applied. The capture records the redirect and, with header values selected, its Location.`,
    );
  if (
    action.expected_status !== undefined &&
    !action.expected_status.includes(response.status)
  )
    throw new ScenarioRequestError(
      `Request step ${action.step_id} answered ${String(response.status)}; expected ${action.expected_status.join(" or ")}.`,
    );
  if (action.save.length > 0)
    saveValues(action.step_id, response.body, action.save, secrets);
};

/** A path or URL with its `placeholder`s filled, each value percent-encoded; a request path's are spelled as written. A value a URL path would drop as a dot segment fails the step. */
export const withSavedPlaceholders = (
  text: string,
  secrets: BrowserScenarioSecrets,
  placeholder: RegExp = SAVED_PLACEHOLDER,
): string => {
  const pathEnd = text.search(/[?#]/u);
  return text.replace(
    placeholder,
    (match: string, name: string, offset: number) => {
      const encoded = encodeURIComponent(String(secrets.savedValue(name)));
      const end = offset + match.length;
      const segment =
        (pathEnd < 0 || end <= pathEnd) &&
        (offset === 0 || text[offset - 1] === "/") &&
        (end === text.length || "/?#".includes(text[end]!));
      if (segment && (encoded === "." || encoded === ".."))
        throw new Error(
          `Saved value ${name} is a dot segment, which a URL path drops, so the step cannot send it.`,
        );
      return encoded;
    },
  );
};

/** Whether a request a UI step triggered is the one its `save_response` names: method, start origin, and path with `{*}` matching one segment. */
/** A `save_response` path's segments as a browser spells a URL path, percent-encoded as its URL parser would, `{*}` kept. */
const pathPattern = (path: string): readonly string[] =>
  path
    .split("?")[0]!
    .split("/")
    .map((segment) =>
      segment === "{*}"
        ? segment
        : new URL(`http://path.invalid/${segment}`).pathname.slice(1),
    );

const namesResponse = (
  spec: BrowserScenarioSaveResponse,
  pattern: readonly string[],
  startOrigin: string,
  request: { readonly method: string; readonly url: string },
): boolean => {
  if (request.method !== spec.method) return false;
  const url = URL.parse(request.url);
  if (url === null || url.origin !== startOrigin) return false;
  const segments = url.pathname.split("/");
  return (
    segments.length === pattern.length &&
    pattern.every((part, index) => part === "{*}" || part === segments[index])
  );
};

/** Settle as the work does, or fail the step once its deadline passes or it is cancelled, so late work saves nothing. */
const beforeStepEnds = <T>(
  work: Promise<T>,
  stepId: string,
  deadline: number | undefined,
  signal: AbortSignal | undefined,
): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", end);
    };
    const end = (): void => {
      settle();
      reject(
        new ScenarioRequestError(
          `Step ${stepId} ended before its saved response was read, so nothing was saved.`,
        ),
      );
    };
    work.catch(() => undefined);
    const remaining =
      deadline === undefined ? undefined : deadline - Date.now();
    if (
      signal?.aborted === true ||
      (remaining !== undefined && remaining <= 0)
    ) {
      end();
      return;
    }
    if (remaining !== undefined) timer = setTimeout(end, remaining);
    signal?.addEventListener("abort", end, { once: true });
    work.then(
      (value) => {
        settle();
        resolve(value);
      },
      (cause: unknown) => {
        settle();
        reject(cause);
      },
    );
  });

/** A UI step's wait for the response its `save_response` names: `saved` waits and saves, `stop` stops watching requests. */
export interface SavedResponseWait {
  readonly saved: () => Promise<void>;
  readonly stop: () => void;
}

/**
 * Start waiting, before a UI step acts, for the response its `save_response` names to a request the step starts; one
 * already running when the step began, such as an earlier autosave, cannot answer it. The step fails unless a 2xx JSON
 * response arrives before its timeout, or the page's default timeout when it sets none.
 */
export const awaitSavedResponse = (
  page: Page,
  step: {
    readonly stepId: string;
    readonly spec: BrowserScenarioSaveResponse;
    readonly startOrigin: string;
    readonly timeout: number | undefined;
    readonly secrets: BrowserScenarioSecrets;
    readonly signal?: AbortSignal | undefined;
  },
): SavedResponseWait => {
  const { stepId, spec, startOrigin, timeout, secrets, signal } = step;
  const deadline = timeout === undefined ? undefined : Date.now() + timeout;
  const pattern = pathPattern(spec.path);
  const started = new Set<Request>();
  const watch = (request: Request): void => {
    if (
      namesResponse(spec, pattern, startOrigin, {
        method: request.method(),
        url: request.url(),
      })
    )
      started.add(request);
  };
  page.on("request", watch);
  const waiting = page.waitForResponse(
    (response) => started.has(response.request()),
    timeout === undefined ? {} : { timeout },
  );
  // The step may fail before it waits; the rejection is reported by the wait, or not at all.
  waiting.catch(() => undefined);
  const saved = async (): Promise<void> => {
    let response: Awaited<typeof waiting>;
    try {
      response = await beforeStepEnds(waiting, stepId, deadline, signal);
    } catch {
      throw new ScenarioRequestError(
        `Step ${stepId}: no ${spec.method} ${spec.path} response arrived before the step's timeout, so nothing was saved.`,
      );
    }
    if (response.status() < 200 || response.status() > 299)
      throw new ScenarioRequestError(
        `Step ${stepId}: the ${spec.method} ${spec.path} response answered ${String(response.status())}; values are saved only from a 2xx response.`,
      );
    // Playwright reads a body whole, so the size the browser received decides before it is read; its text is then held to the character limit.
    const { responseBodySize } = await beforeStepEnds(
      response.request().sizes(),
      stepId,
      deadline,
      signal,
    );
    if (responseBodySize > MAX_SAVED_RESPONSE_BYTES)
      throw new ScenarioRequestError(
        `Step ${stepId}: the response is too large to save values from.`,
      );
    const body = await beforeStepEnds(
      response.text(),
      stepId,
      deadline,
      signal,
    );
    saveValues(stepId, body, spec.save, secrets);
  };
  return { saved, stop: () => page.off("request", watch) };
};

/**
 * The step's JSON body with its `{saved:name}` placeholders filled: a string that is only a placeholder becomes the
 * saved value, keeping its JSON type, and a placeholder inside a longer string is filled as text.
 */
const withSavedJson = (
  value: unknown,
  secrets: BrowserScenarioSecrets,
): unknown => {
  if (typeof value === "string") {
    const [whole] = [...value.matchAll(SAVED_PLACEHOLDER)];
    if (whole !== undefined && whole[0] === value)
      return secrets.savedValue(whole[1]!);
    return value.replace(SAVED_PLACEHOLDER, (_placeholder, name: string) =>
      String(secrets.savedValue(name)),
    );
  }
  if (Array.isArray(value))
    return value.map((item) => withSavedJson(item, secrets));
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        withSavedJson(item, secrets),
      ]),
    );
  return value;
};

/** Save the values a step names from a JSON response, for later steps. */
const saveValues = (
  stepId: string,
  body: string | undefined,
  entries: readonly BrowserScenarioSaveEntry[],
  secrets: BrowserScenarioSecrets,
): void => {
  if (body === undefined || body.length > MAX_SAVED_RESPONSE_CHARACTERS)
    throw new ScenarioRequestError(
      `Step ${stepId}: the response is too large to save values from.`,
    );
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new ScenarioRequestError(
      `Step ${stepId}: the response is not JSON, so no value can be saved from it.`,
    );
  }
  for (const { name, json_pointer, secret } of entries) {
    const value = pointerValue(parsed, json_pointer);
    if (value === undefined)
      throw new ScenarioRequestError(
        `Step ${stepId}: the response has no string or number at ${json_pointer} to save as ${name}.`,
      );
    // JSON parsing rounds an integer past 2^53, so a later step would name another object.
    if (Number.isInteger(value) && !Number.isSafeInteger(value))
      throw new ScenarioRequestError(
        `Step ${stepId}: the number at ${json_pointer} is too large to keep exactly, so ${name} cannot be saved from it.`,
      );
    secrets.save(`${stepId}.${name}`, name, value, secret);
  }
};
