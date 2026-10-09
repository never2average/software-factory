/**
 * A STAND-IN FOR THE `microsandbox` npm package (0.5.10), for tests on a host with no KVM. eve's REAL binding
 * (eve/dist/src/execution/sandbox/bindings/microsandbox-*.js) is loaded and calls this exactly as it calls the real
 * package; scripts/test-sandbox-guard.mjs points eve's `import("microsandbox")` here with a module hook.
 *
 * It keeps what the defect depends on, as the real runtime behaves on the server (sandboxes/<name>/logs/runtime.log):
 *   - a VM is reachable only while it runs: a command sent to a stopped one fails with the runtime's own words,
 *     `runtime error: no agent socket found for sandbox "<name>"` (the relay socket goes when the VM exits);
 *   - `stop()` on a live handle shuts the VM down (`core.shutdown`); `Sandbox.get(name)` reads a stopped one, which can
 *     be snapshotted, started again (`startDetached`) or removed; a snapshot is a copy of the VM's disk;
 *   - a VM boots asynchronously and is handed out only once its agent is ready. With `control.stallAbove = n`, a VM
 *     that starts booting while n or more others are booting never becomes ready (the guest stalls, as "BUG: scheduling
 *     while atomic" did on a 4-vCPU host); the create then fails after `control.relayTimeoutMs`, as microsandbox's own
 *     "timed out waiting for agent relay" does (180 s for real).
 *   - a guest can hang AFTER booting (mold_v1-190, eve-sbx-ses-5256b07f on 2026-10-05: the bash request was taken and
 *     never ran, msb at 100% CPU for 14 minutes): with `control.hangNext = n` the next n commands sent to a running VM
 *     are taken and never answered, and that VM answers nothing after them either, until it is stopped; a command
 *     still waiting then fails as the real package does when the VM goes. `control.stopOfHungHangs` makes the
 *     polite `stop()` of a hung VM never answer (only `kill()` and `stopWithTimeout(0)` end it);
 *   - VMs carry the labels eve gives them, and `Sandbox.listWith({ labels })` finds them, as the real package does.
 * The "shell" understands `echo WORDS`, `echo WORDS >> FILE`, `cat FILE`, `pwd`, `sleep SECONDS` (a long command that
 * is alive: the guest still answers other commands meanwhile); anything else succeeds silently.
 */
const encoder = new TextEncoder();

export const control = {
  /** Every VM by name: { name, status: "booting"|"running"|"stopped", disk: Map<path, string>, boots } */
  vms: new Map(),
  /** Every snapshot by name: Map<path, string> */
  snapshots: new Map(),
  booting: 0,
  peakBooting: 0,
  bootMs: 5,
  stallAbove: Infinity,
  /** The next n boots stall whatever else is booting. */
  stallNext: 0,
  relayTimeoutMs: 2_000,
  /** When true, `stop()` on a VM that is already stopped never answers. */
  stopOfStoppedHangs: false,
  /** Names of VMs whose boot stalled. */
  stalled: [],
  /** Every command a VM ran: { vm, command } */
  ran: [],
  /** The next n commands hang their VM (taken, never answered). */
  hangNext: 0,
  /** When true, the polite `stop()` of a hung VM never answers. */
  stopOfHungHangs: false,
  /** Names of VMs that hung. */
  hung: [],
  /** Most VMs ever running at the same time. */
  peakRunning: 0,
  reset() {
    this.vms.clear();
    this.snapshots.clear();
    this.booting = 0;
    this.peakBooting = 0;
    this.bootMs = 5;
    this.stallAbove = Infinity;
    this.stallNext = 0;
    this.stopOfStoppedHangs = false;
    this.relayTimeoutMs = 2_000;
    this.stalled = [];
    this.ran = [];
    this.hangNext = 0;
    this.stopOfHungHangs = false;
    this.hung = [];
    this.peakRunning = 0;
  },
  running() {
    return [...this.vms.values()].filter((vm) => vm.status === "running").map((vm) => vm.name);
  },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const notFound = (what, name) => new Error(`${what} "${name}" not found`);

export class MicrosandboxError extends Error {}

/** Boot `vm`; resolves when its agent is ready, rejects like microsandbox when the relay never answers. */
async function boot(vm) {
  vm.status = "booting";
  const stalls = control.booting >= control.stallAbove || (control.stallNext > 0 && control.stallNext-- > 0);
  control.booting += 1;
  control.peakBooting = Math.max(control.peakBooting, control.booting);
  try {
    if (stalls) {
      control.stalled.push(vm.name);
      await sleep(control.relayTimeoutMs);
      vm.status = "stopped";
      throw new MicrosandboxError(`timed out waiting for agent relay: ${vm.name}`);
    }
    await sleep(control.bootMs);
    vm.status = "running";
    vm.hung = false;
    vm.boots += 1;
    control.peakRunning = Math.max(control.peakRunning, control.running().length);
  } finally {
    control.booting -= 1;
  }
}

function socketOf(name) {
  const vm = control.vms.get(name);
  if (!vm || vm.status !== "running") throw new MicrosandboxError(`runtime error: no agent socket found for sandbox "${name}"`);
  return vm;
}

/** The VM is no longer running: everything it was asked and never answered fails, as the real package does. */
function halt(vm) {
  vm.status = "stopped";
  for (const fail of vm.waiting ?? []) fail(new MicrosandboxError(`runtime error: sandbox "${vm.name}" stopped while a command was running`));
  vm.waiting = [];
}

/** Wait on a hung VM: settles only by failing when the VM stops. */
function never(vm) {
  return new Promise((_, reject) => (vm.waiting ??= []).push(reject));
}

async function shell(vm, command) {
  if (vm.hung) return await never(vm);
  if (control.hangNext > 0) {
    control.hangNext -= 1;
    vm.hung = true;
    control.hung.push(vm.name);
    control.ran.push({ vm: vm.name, command, hung: true });
    return await never(vm);
  }
  control.ran.push({ vm: vm.name, command });
  let m;
  if ((m = /^sleep ([\d.]+)$/.exec(command))) {
    await Promise.race([sleep(Number(m[1]) * 1000), never(vm)]);
    return { code: 0, stdout: "" };
  }
  if ((m = /^echo (.*?) >> (\S+)$/.exec(command))) {
    vm.disk.set(m[2], (vm.disk.get(m[2]) ?? "") + `${m[1]}\n`);
    return { code: 0, stdout: "" };
  }
  if ((m = /^echo (.*)$/.exec(command))) return { code: 0, stdout: `${m[1]}\n` };
  if ((m = /^cat (\S+)$/.exec(command))) return vm.disk.has(m[1]) ? { code: 0, stdout: vm.disk.get(m[1]) } : { code: 1, stdout: "", stderr: "No such file" };
  if (command === "pwd") return { code: 0, stdout: "/home/vercel-sandbox\n" };
  return { code: 0, stdout: "" };
}

/** A fluent builder that records the calls eve makes and ignores the ones it does not need. */
function recorder(record) {
  const proxy = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "then") return undefined;
        return (...args) => {
          record(prop, args);
          if (prop === "network") args[0]?.(recorder(() => {}));
          return proxy;
        };
      },
    },
  );
  return proxy;
}

function commandOf(fn) {
  let command = "";
  fn(recorder((prop, args) => {
    if (prop === "args") command = String(args[0]?.[1] ?? "");
  }));
  return command;
}

/** What eve holds while a VM runs (`Sandbox` in the real package). */
function liveHandle(name) {
  return {
    name,
    async stop() {
      const vm = control.vms.get(name);
      if (vm && vm.status === "running" && vm.hung && control.stopOfHungHangs) await new Promise(() => {});
      if (vm && vm.status === "running") halt(vm);
      else if (control.stopOfStoppedHangs) await new Promise(() => {});
    },
    async detach() {},
    async kill() {
      const vm = control.vms.get(name);
      if (vm) halt(vm);
    },
    async setNetworkPolicy() {},
    fs() {
      return {
        exists: async (path) => socketOf(name).disk.has(path),
        read: async (path) => encoder.encode(socketOf(name).disk.get(path) ?? ""),
        write: async (path, content) => void socketOf(name).disk.set(path, typeof content === "string" ? content : new TextDecoder().decode(content)),
      };
    },
    async execWith(_cmd, fn) {
      const out = await shell(socketOf(name), commandOf(fn));
      return { code: out.code, stdout: () => out.stdout, stderr: () => out.stderr ?? "" };
    },
    async execStreamWith(_cmd, fn) {
      const out = await shell(socketOf(name), commandOf(fn));
      const events = [];
      if (out.stdout) events.push({ kind: "stdout", data: encoder.encode(out.stdout) });
      if (out.stderr) events.push({ kind: "stderr", data: encoder.encode(out.stderr) });
      events.push({ kind: "exited", code: out.code });
      return {
        async kill() {},
        [Symbol.asyncIterator]() {
          let i = 0;
          return { next: async () => (i < events.length ? { value: events[i++], done: false } : { value: undefined, done: true }), return: async () => ({ done: true }) };
        },
      };
    },
  };
}

/** What `Sandbox.get(name)` returns: the VM's record, running or not. */
function storedHandle(name) {
  const vm = control.vms.get(name);
  return {
    name,
    status: vm.status,
    labels: { ...(vm.labels ?? {}) },
    async connectWithTimeout() {
      socketOf(name);
      return liveHandle(name);
    },
    async startDetached() {
      await boot(vm);
      return liveHandle(name);
    },
    async stopWithTimeout(timeoutMs) {
      if (vm.status === "running" && vm.hung && control.stopOfHungHangs && timeoutMs !== 0) await new Promise(() => {});
      if (vm.status !== "stopped") halt(vm);
    },
    async stop() {
      if (vm.status === "running" && vm.hung && control.stopOfHungHangs) await new Promise(() => {});
      if (vm.status !== "stopped") halt(vm);
    },
    async kill() {
      halt(vm);
    },
    async snapshot(snapshotName) {
      if (vm.status !== "stopped") throw new MicrosandboxError(`snapshot source sandbox ${name} is not stopped`);
      control.snapshots.set(snapshotName, new Map(vm.disk));
    },
    async remove() {
      if (vm.status === "running" || vm.status === "booting") throw new MicrosandboxError(`sandbox ${name} is still running`);
      control.vms.delete(name);
    },
  };
}

export const Sandbox = {
  builder(name) {
    let fromSnapshot;
    let labels = {};
    const create = async () => {
      if (fromSnapshot !== undefined && !control.snapshots.has(fromSnapshot)) throw notFound("snapshot", fromSnapshot);
      const previous = control.vms.get(name);
      if (previous && previous.status !== "stopped") halt(previous); // .replace()
      const vm = { name, status: "booting", disk: new Map(fromSnapshot === undefined ? [] : control.snapshots.get(fromSnapshot)), boots: 0, labels };
      control.vms.set(name, vm);
      const ready = boot(vm);
      ready.catch(() => {});
      return {
        async *[Symbol.asyncIterator]() {
          yield { kind: "complete" };
        },
        async awaitSandbox() {
          await ready;
          return liveHandle(name);
        },
      };
    };
    const builder = new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === "then") return undefined;
          if (prop === "createWithPullProgress") return create;
          return (...args) => {
            if (prop === "fromSnapshot") fromSnapshot = args[0];
            if (prop === "labels") labels = { ...(args[0] ?? {}) };
            if (prop === "network") args[0]?.(recorder(() => {}));
            return builder;
          };
        },
      },
    );
    return builder;
  },
  async get(name) {
    if (!control.vms.has(name)) throw notFound("sandbox", name);
    return storedHandle(name);
  },
  async list() {
    return [...control.vms.keys()].map(storedHandle);
  },
  async listWith(filter) {
    const want = Object.entries(filter?.labels ?? {});
    return [...control.vms.values()].filter((vm) => want.every(([k, v]) => vm.labels?.[k] === v)).map((vm) => storedHandle(vm.name));
  },
};

export const Snapshot = {
  async get(name) {
    if (!control.snapshots.has(name)) throw notFound("snapshot", name);
    return { name };
  },
  async remove(name) {
    if (!control.snapshots.delete(name)) throw notFound("snapshot", name);
  },
};

export function isInstalled() {
  return true;
}

export default { Sandbox, Snapshot, MicrosandboxError, isInstalled, control };
