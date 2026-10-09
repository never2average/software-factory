/**
 * Executes a workflow script.
 *
 * THE SANDBOX IS THE SECURITY BOUNDARY. The script is JavaScript an operator
 * typed into a browser, so it runs inside QuickJS compiled to WebAssembly — a
 * separate interpreter with its own heap. It has no filesystem, no network, no
 * timers, no `process`, and no reference to any Node object: the ONLY things it
 * can reach are the host functions injected below. lib/workflow-validate.ts
 * blacklists too, but only so the operator gets told while typing.
 *
 * Two limits keep a bad script from taking the process with it:
 * - an interrupt handler kills any script still running after `wallClockMs`;
 * - MAX_AGENT_CALLS caps delegation.
 *
 * CONCURRENCY. agent() returns a NATIVE QuickJS promise and the host resolves
 * it when the injected delegate settles, so many delegates run at once and a
 * pump loop advances the script — this is what makes parallel()/pipeline()
 * actually concurrent. (The previous design used Emscripten ASYNCIFY, which can
 * only suspend one call at a time: it silently serialized every fan-out and
 * overflowed its fixed unwind stack after a handful of sequential calls, failing
 * with "memory access out of bounds".)
 *
 * DURABILITY lives OUTSIDE this boundary. The runtime passes each call's ordinal
 * (`callIndex`) to the delegate; the CALLER wraps its delegate
 * (lib/workflow-journal.ts `makeDurableDelegate`) to checkpoint each result and
 * replay completed calls on resume — so this runtime never has to branch or
 * carry the journal. A run that stops at the wall clock reports `timedOut` (not
 * a hard error) so the caller can leave it resumable.
 */
import "server-only";

import { getQuickJS, newAsyncContext, type QuickJSAsyncContext } from "quickjs-emscripten";

/** Default script wall clock — sized under the function's maxDuration so the run
 *  self-stops (its delegate has checkpointed what it finished) before the
 *  platform kills it, and a continuation pass resumes the rest. */
const DEFAULT_WALL_CLOCK_MS = 240_000;

/**
 * What a workflow script may read directly, without going through the model.
 * Every method is workspace-scoped by whoever supplies it.
 */
export interface WorkflowData {
  /** Customers in this workspace: id, name, tier, status, owner. */
  customers?: () => Promise<unknown>;
  /** Data-room paths under a prefix, e.g. "{folder:accounts}/". */
  dataroomList?: (prefix: string) => Promise<string[]>;
  /** One data-room file's text. */
  dataroomRead?: (path: string) => Promise<string | null>;
  /**
   * The rest of the system of record, each taking JSON options.
   *
   * Added because the library asked for them: of thirteen workflows, seven
   * needed tickets and owners, five deployments and interactions, three
   * implementations — and every one of them was reduced to asking the agent in
   * prose for a table it could read directly.
   */
  tickets?: (optionsJson: string) => Promise<unknown>;
  deployments?: (optionsJson: string) => Promise<unknown>;
  implementations?: (optionsJson: string) => Promise<unknown>;
  roster?: (optionsJson: string) => Promise<unknown>;
  interactions?: (optionsJson: string) => Promise<unknown>;
}
/** A runaway loop must not be able to spend the model budget without bound. */
const MAX_AGENT_CALLS = 32;

export interface RunEvent {
  at: number;
  kind: "phase" | "log" | "agent" | "error";
  text: string;
}

export interface RunResult {
  ok: boolean;
  events: RunEvent[];
  result: unknown;
  error: string | null;
  agentCalls: number;
  /** True when the run stopped at the wall clock with work left — resumable. */
  timedOut: boolean;
}

/** Delegate one step to the agent. `callIndex` is the call's ordinal (for the
 *  durable wrapper to key its journal). Injected, so a test can run offline. */
export type Delegate = (
  prompt: string,
  subagent?: string,
  callIndex?: number,
  phase?: string,
) => Promise<string>;

/** A thrown QuickJS value dumps to either an Error-shaped object or a string. */
function extractMessage(message: unknown): string {
  return typeof message === "object" && message && "message" in message
    ? String((message as { message: unknown }).message)
    : String(message);
}

export async function runWorkflowScript(
  source: string,
  opts: {
    delegate: Delegate;
    args?: unknown;
    wallClockMs?: number;
    signal?: AbortSignal;
    /**
     * Read access for the SCRIPT, already scoped to the run's workspace.
     *
     * A workflow should not depend on someone hand-feeding it variables. The
     * app that runs `renewal-risk` has no customer to pass, and asking a person
     * to supply one defeats the point of automation — the script should look up
     * what it needs. Without this, its only route to data was to ask the agent
     * in prose and parse the reply, which is slow, lossy, and a strange way to
     * read a table you already own.
     *
     * The runtime never imports the database itself: the caller passes readers
     * it has already bound to the workspace, so a script cannot widen its own
     * scope by asking differently.
     */
    data?: WorkflowData;
  },
): Promise<RunResult> {
  const events: RunEvent[] = [];
  const started = Date.now();
  let agentCalls = 0;
  /**
   * The phase() most recently declared, handed to every subsequent agent() call
   * so a step can say which part of the run it belongs to.
   *
   * Captured at CALL time, not at settle time. With parallel()/pipeline() a slow
   * step can still be in flight when the script declares the next phase; the
   * label it carries is the one that was current when it was dispatched, which
   * is the honest answer to "what was this dispatched for".
   */
  let currentPhase: string | undefined;
  const say = (kind: RunEvent["kind"], text: string) =>
    events.push({ at: Date.now() - started, kind, text });

  const deadline = Date.now() + (opts.wallClockMs ?? DEFAULT_WALL_CLOCK_MS);
  const timedOut = () => Date.now() > deadline;
  const cancelled = () => opts.signal?.aborted ?? false;
  const stopMessage = () =>
    cancelled()
      ? opts.signal?.reason instanceof Error
        ? opts.signal.reason.message
        : "Workflow run cancelled."
      : "The workflow hit its time budget before finishing.";

  await getQuickJS();
  const vm: QuickJSAsyncContext = await newAsyncContext();
  // Every host delegate still in flight. The pump loop awaits these to advance
  // the script; a settled one removes itself. Real concurrency lives here.
  const outstanding = new Set<Promise<void>>();

  try {
    // Hard stop: QuickJS asks this on every basic block (between host delegates,
    // when the VM is idle waiting on `outstanding`, it can't run — the pump loop
    // enforces the deadline there instead).
    vm.runtime.setInterruptHandler(() => timedOut() || cancelled());
    vm.runtime.setMemoryLimit(64 * 1024 * 1024);

    // ---- host functions: the script's ENTIRE surface -----------------------

    const phaseFn = vm.newFunction("phase", (titleHandle) => {
      currentPhase = vm.getString(titleHandle);
      say("phase", currentPhase);
      return vm.undefined;
    });
    vm.setProp(vm.global, "phase", phaseFn);
    phaseFn.dispose();

    const logFn = vm.newFunction("log", (msgHandle) => {
      say("log", vm.getString(msgHandle));
      return vm.undefined;
    });
    vm.setProp(vm.global, "log", logFn);
    logFn.dispose();

    // agent(prompt, { subagent }) — returns a NATIVE QuickJS promise (NOT an
    // asyncified call). The delegate runs on the host with real JS concurrency;
    // when it settles we resolve the QuickJS promise and pump pending jobs. This
    // is deliberate: Emscripten ASYNCIFY can only suspend ONE call at a time, so
    // the old newAsyncifiedFunction serialized every parallel()/pipeline() fan-
    // out AND overflowed its fixed unwind stack after a few sequential calls
    // ("memory access out of bounds"). Native promises have neither limit — the
    // pump loop below drives many delegates concurrently. Each in-flight
    // delegate is tracked in `outstanding` so the loop knows what to await.
    const agentFn = vm.newFunction("agent", (promptHandle, optsHandle) => {
      const prompt = vm.getString(promptHandle);
      let subagent: string | undefined;
      if (optsHandle && vm.typeof(optsHandle) === "object") {
        // `subagent` is this runtime's name for it. `agentType` is what the
        // wider Claude workflow API calls the same thing, and authors — human
        // and model — reach for it constantly. Reading only `subagent` meant
        // such a script ran END TO END, reported success, and quietly sent
        // every single call to the default agent: the fan-out the author wrote,
        // reviewed and shipped never happened, and nothing anywhere said so.
        // A silent downgrade is worse than a hard error, so accept both.
        for (const key of ["subagent", "agentType"]) {
          const h = vm.getProp(optsHandle, key);
          if (vm.typeof(h) === "string") subagent ??= vm.getString(h);
          h.dispose();
        }
      }
      const callIndex = agentCalls;
      const deferred = vm.newPromise();
      if (++agentCalls > MAX_AGENT_CALLS) {
        const h = vm.newString(`A workflow may delegate at most ${MAX_AGENT_CALLS} times in one run.`);
        deferred.reject(h);
        h.dispose();
        deferred.settled.then(() => vm.runtime.executePendingJobs());
        return deferred.handle;
      }
      say("agent", subagent ? `${subagent} ← ${prompt}` : prompt);
      const work = Promise.resolve(opts.delegate(prompt, subagent, callIndex, currentPhase))
        .then(
          (text) => {
            const h = vm.newString(String(text));
            deferred.resolve(h);
            h.dispose();
          },
          (err) => {
            const h = vm.newString(err instanceof Error ? err.message : String(err));
            deferred.reject(h);
            h.dispose();
          },
        )
        .finally(() => {
          outstanding.delete(work);
          vm.runtime.executePendingJobs();
        });
      outstanding.add(work);
      deferred.settled.then(() => vm.runtime.executePendingJobs());
      return deferred.handle;
    });
    vm.setProp(vm.global, "agent", agentFn);
    agentFn.dispose();

    /**
     * Data readers, bridged the same way agent() is: a QuickJS promise settled
     * from the host, with the value carried across as JSON text.
     */
    const bridge = (name: string, run: (arg: string) => Promise<unknown>) => {
      const fn = vm.newFunction(name, (argHandle) => {
        const arg = argHandle && vm.typeof(argHandle) === "string" ? vm.getString(argHandle) : "";
        const deferred = vm.newPromise();
        const work = Promise.resolve(run(arg))
          .then(
            (value) => {
              const h = vm.newString(JSON.stringify(value ?? null));
              deferred.resolve(h);
              h.dispose();
            },
            (err) => {
              const h = vm.newString(err instanceof Error ? err.message : String(err));
              deferred.reject(h);
              h.dispose();
            },
          )
          .finally(() => {
            outstanding.delete(work);
            vm.runtime.executePendingJobs();
          });
        outstanding.add(work);
        deferred.settled.then(() => vm.runtime.executePendingJobs());
        return deferred.handle;
      });
      vm.setProp(vm.global, name, fn);
      fn.dispose();
    };
    const unavailable = (what: string) => async () => {
      throw new Error(
        `${what} is not available to this run. The caller did not supply data readers.`,
      );
    };
    bridge("__dataCustomers", opts.data?.customers ?? unavailable("data.customers()"));
    bridge("__dataTickets", opts.data?.tickets ?? unavailable("data.tickets()"));
    bridge("__dataDeployments", opts.data?.deployments ?? unavailable("data.deployments()"));
    bridge("__dataImplementations", opts.data?.implementations ?? unavailable("data.implementations()"));
    bridge("__dataRoster", opts.data?.roster ?? unavailable("data.roster()"));
    bridge("__dataInteractions", opts.data?.interactions ?? unavailable("data.interactions()"));
    bridge("__dataList", opts.data?.dataroomList ?? unavailable("data.dataroom.list()"));
    bridge("__dataRead", opts.data?.dataroomRead ?? unavailable("data.dataroom.read()"));

    // args — whatever the caller passed the run, as a plain value.
    const argsHandle = vm.newString(JSON.stringify(opts.args ?? null));
    vm.setProp(vm.global, "__argsJson", argsHandle);
    argsHandle.dispose();

    // parallel() / pipeline() are pure JS over agent(), so they are defined IN
    // the sandbox rather than crossing the boundary for no reason.
    const prelude = `
      globalThis.args = JSON.parse(globalThis.__argsJson);
      // Read your own inputs rather than waiting to be handed them.
      const __opts = (o) => JSON.stringify(o ?? {});
      globalThis.data = {
        customers: async () => JSON.parse(await globalThis.__dataCustomers("")),
        // Each takes { customerId?, status?, limit? } — see lib/workflow-data.ts.
        tickets: async (o) => JSON.parse(await globalThis.__dataTickets(__opts(o))),
        deployments: async (o) => JSON.parse(await globalThis.__dataDeployments(__opts(o))),
        implementations: async (o) => JSON.parse(await globalThis.__dataImplementations(__opts(o))),
        roster: async (o) => JSON.parse(await globalThis.__dataRoster(__opts(o))),
        interactions: async (o) => JSON.parse(await globalThis.__dataInteractions(__opts(o))),
        dataroom: {
          list: async (prefix) => JSON.parse(await globalThis.__dataList(String(prefix ?? ""))),
          read: async (path) => JSON.parse(await globalThis.__dataRead(String(path ?? ""))),
        },
      };
      globalThis.parallel = (thunks) =>
        Promise.all(thunks.map((t) => { try { return t(); } catch (e) { return null; } }));
      globalThis.pipeline = async (items, ...stages) => {
        const one = async (item, i) => {
          let value = item;
          for (const stage of stages) value = await stage(value, item, i);
          return value;
        };
        return Promise.all(items.map((item, i) => one(item, i).catch(() => null)));
      };
    `;
    const pre = vm.evalCode(prelude);
    if (pre.error) {
      pre.error.dispose();
      throw new Error("The workflow runtime failed to initialise.");
    }
    pre.value.dispose();

    // ---- the script itself -------------------------------------------------

    const body = source.replace(/^\s*export\s+/gm, "");
    const wrapped = `(async () => { ${body} })()`;

    // Synchronous eval — the script's top-level `await`s hang on QuickJS
    // promises (our agent() calls), so evalCode returns the pending IIFE promise
    // immediately; the pump loop below drives it to completion. (No asyncify.)
    const evaluated = vm.evalCode(wrapped);
    if (evaluated.error) {
      const message = vm.dump(evaluated.error);
      evaluated.error.dispose();
      const text = extractMessage(message);
      say("error", text);
      return { ok: false, events, result: null, error: text, agentCalls, timedOut: timedOut() };
    }
    const topPromise = evaluated.value;

    // Pump loop: run QuickJS microtasks, then await whichever host delegate
    // settles next (or the wall clock), and repeat until the top-level promise
    // resolves. Because many delegates can be `outstanding` at once, parallel()
    // / pipeline() fan-outs genuinely run concurrently.
    vm.runtime.executePendingJobs();
    while (vm.getPromiseState(topPromise).type === "pending") {
      if (timedOut() || cancelled()) {
        topPromise.dispose();
        const message = stopMessage();
        say("error", message);
        return {
          ok: false,
          events,
          result: null,
          error: message,
          agentCalls,
          timedOut: timedOut() && !cancelled(),
        };
      }
      // Wake on the next delegate to settle, or at the deadline if all in-flight
      // delegates hang — so a stuck run still stops at the wall clock.
      const wake =
        outstanding.size > 0
          ? Promise.race([...outstanding])
          : new Promise((r) => setTimeout(r, 0));
      const abort = opts.signal
        ? new Promise<void>((resolve) => opts.signal!.addEventListener("abort", () => resolve(), { once: true }))
        : new Promise<void>(() => {});
      await Promise.race([
        wake,
        abort,
        new Promise((resolve) => setTimeout(resolve, Math.max(0, deadline - Date.now()))),
      ]);
      vm.runtime.executePendingJobs();
    }

    const state = vm.getPromiseState(topPromise);
    if (state.type === "rejected") {
      const message = vm.dump(state.error);
      state.error.dispose();
      topPromise.dispose();
      const text = extractMessage(message);
      say("error", text);
      return { ok: false, events, result: null, error: text, agentCalls, timedOut: timedOut() };
    }
    if (state.type !== "fulfilled") {
      // Unreachable: the loop only exits once the promise has settled.
      topPromise.dispose();
      return { ok: false, events, result: null, error: "The workflow did not settle.", agentCalls, timedOut: timedOut() };
    }
    const result = vm.dump(state.value);
    state.value.dispose();
    topPromise.dispose();
    return { ok: true, events, result, error: null, agentCalls, timedOut: false };
  } catch (e) {
    const text = cancelled() ? stopMessage() : e instanceof Error ? e.message : String(e);
    say("error", text);
    return { ok: false, events, result: null, error: text, agentCalls, timedOut: timedOut() };
  } finally {
    vm.dispose();
  }
}
