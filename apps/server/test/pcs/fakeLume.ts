/**
 * A fake `lume serve` HTTP API (as `fetch`) over a temp Lume root, for the LumeMacDriver unit tests. It behaves like
 * 0.6.1 did in spike S6: `run` answers 202 at once; a third running VM fails and the reason is only in the serve log;
 * a VM that shut down inside its guest logs "VM lifecycle ended" but stays `running` until a stop (which then answers
 * 400 "not running"); pulls report progress through `GET`; the pulled digest is written to `.manifest-digest`.
 */
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

interface Vm {
  status: 'stopped' | 'running' | 'pulling';
  cpu: number;
  memory: number;
  display: string;
  ip?: string;
  pullAt?: number;
}

const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z');

export class FakeLume {
  readonly root: string;
  readonly vms = new Map<string, Vm>();
  readonly calls: string[] = [];
  /** How many macOS VMs Virtualization allows at once. */
  limit = 2;
  /** Progress values a pull reports, one per GET. */
  pullSteps = [10, 60, 100];
  /** The digest a pull writes. */
  pullDigest = `sha256:${'a'.repeat(64)}`;
  /** Make the next pull fail (GET answers 400). */
  pullFails = false;
  #ip = 2;

  constructor(root: string) {
    this.root = root;
    mkdirSync(join(root, 'vms'), { recursive: true });
    mkdirSync(join(root, 'serve'), { recursive: true });
    writeFileSync(this.logPath, '');
  }

  get logPath(): string {
    return join(this.root, 'serve', 'serve.log');
  }

  #dir(name: string): string {
    return join(this.root, 'vms', name);
  }

  log(line: string, at = Date.now()): void {
    appendFileSync(this.logPath, `[${iso(at)}] ${line}\n`);
  }

  /** A VM on disk (a base image: give it a digest). */
  addVm(name: string, vm: Partial<Vm> & { digest?: string } = {}): void {
    mkdirSync(this.#dir(name), { recursive: true });
    if (vm.digest) writeFileSync(join(this.#dir(name), '.manifest-digest'), `${vm.digest}\n`);
    this.vms.set(name, { status: 'stopped', cpu: 4, memory: 8 * 1024 ** 3, display: '1024x768', ...vm });
  }

  /** The guest shut itself down: logged, but the status stays `running`. */
  guestShutdown(name: string): void {
    this.log(`INFO: VM lifecycle ended name=${name}`);
  }

  #json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }

  #view(name: string, vm: Vm): Record<string, unknown> {
    return {
      name,
      status: vm.status,
      cpuCount: vm.cpu,
      memorySize: vm.memory,
      display: vm.display,
      ipAddress: vm.status === 'running' ? (vm.ip ?? null) : null,
      diskSize: { allocated: 30 * 1024 ** 3, total: 161_061_273_600 },
      locationName: 'minevibe',
      os: 'macOS',
    };
  }

  readonly fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = init.method ?? 'GET';
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    const path = decodeURIComponent(url.pathname);
    this.calls.push(`${method} ${path}`);
    const m = /^\/lume\/vms\/([^/]+)(\/run|\/stop)?$/.exec(path);
    if (method === 'GET' && path === '/lume/vms') {
      // 0.6.1 does not route the list with a query string.
      if (url.search) return new Response('Not found', { status: 404 });
      return this.#json(
        200,
        [...this.vms].filter(([, v]) => v.status !== 'pulling').map(([n, v]) => this.#view(n, v)),
      );
    }
    if (method === 'GET' && path === '/lume/config/locations') {
      return this.#json(200, [{ name: 'minevibe', path: join(this.root, 'vms') }]);
    }
    if (method === 'POST' && path === '/lume/pull/start') {
      const name = String(body.name);
      this.vms.set(name, {
        status: 'pulling',
        cpu: 4,
        memory: 8 * 1024 ** 3,
        display: '1024x768',
        pullAt: 0,
      });
      return this.#json(202, { message: 'Pull started', name });
    }
    if (method === 'POST' && path === '/lume/pull/cancel') return this.#json(200, {});
    if (method === 'POST' && path === '/lume/vms/clone') {
      const src = this.vms.get(String(body.name));
      if (!src) return this.#json(400, { message: 'source not found' });
      const name = String(body.newName);
      mkdirSync(this.#dir(name), { recursive: true });
      this.vms.set(name, { ...src, status: 'stopped' });
      return this.#json(200, { message: 'VM cloned successfully' });
    }
    if (!m) return this.#json(404, { message: 'no route' });
    const name = m[1] as string;
    const vm = this.vms.get(name);
    if (!vm) return this.#json(400, { message: `Virtual machine not found: ${name}` });
    if (method === 'GET') {
      if (vm.status === 'pulling') {
        if (this.pullFails) {
          this.vms.delete(name);
          return this.#json(400, { message: 'Async pull failed: network' });
        }
        const step = vm.pullAt ?? 0;
        const pct = this.pullSteps[Math.min(step, this.pullSteps.length - 1)] as number;
        vm.pullAt = step + 1;
        if (step >= this.pullSteps.length) {
          vm.status = 'stopped';
          mkdirSync(this.#dir(name), { recursive: true });
          writeFileSync(join(this.#dir(name), '.manifest-digest'), `${this.pullDigest}\n`);
          return this.#json(200, this.#view(name, vm));
        }
        return this.#json(200, {
          name,
          status: 'pulling',
          downloadProgress: pct,
          downloadedBytes: pct * 1e8,
          totalBytes: 100e8,
        });
      }
      return this.#json(200, this.#view(name, vm));
    }
    if (method === 'PATCH') {
      if (typeof body.cpu === 'number') vm.cpu = body.cpu;
      if (typeof body.memory === 'string') vm.memory = Number.parseInt(body.memory, 10) * 1024 * 1024;
      if (typeof body.display === 'string') vm.display = body.display;
      return this.#json(200, { message: 'VM settings updated successfully' });
    }
    if (method === 'DELETE') {
      this.vms.delete(name);
      rmSync(this.#dir(name), { recursive: true, force: true });
      return this.#json(200, '');
    }
    if (m[2] === '/run') {
      const running = [...this.vms.values()].filter((v) => v.status === 'running').length;
      if (running >= this.limit) {
        this.log(
          `ERROR: Failed in VM.run name=${name} error=The number of virtual machines exceeds the limit. The maximum supported number of active virtual machines has been reached. errorType=NSError`,
        );
        return this.#json(202, { message: 'VM start initiated', name, status: 'pending' });
      }
      vm.status = 'running';
      vm.ip = `192.168.65.${this.#ip++}`;
      writeFileSync(
        join(this.#dir(name), 'sessions.json'),
        JSON.stringify({
          pid: 1,
          startedAt: Date.now() / 1000,
          sharedDirectories: body.sharedDirectories ?? [],
        }),
      );
      return this.#json(202, { message: 'VM start initiated', name, status: 'pending' });
    }
    if (m[2] === '/stop') {
      if (vm.status !== 'running')
        return this.#json(400, { message: `Virtual machine not running: ${name}` });
      vm.status = 'stopped';
      rmSync(join(this.#dir(name), 'sessions.json'), { force: true });
      this.log(`INFO: VM lifecycle ended name=${name}`);
      return this.#json(200, { message: 'VM stopped successfully' });
    }
    return this.#json(404, { message: 'no route' });
  };
}
