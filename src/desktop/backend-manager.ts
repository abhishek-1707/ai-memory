export type BackendStartupFailureCategory =
  | 'backend_process_start_failed'
  | 'backend_process_exited'
  | 'database_initialization_failed'
  | 'port_occupied'
  | 'readiness_handshake_failed'
  | 'startup_timeout';

export class BackendStartupError extends Error {
  public readonly category: BackendStartupFailureCategory;

  public constructor(category: BackendStartupFailureCategory) {
    super(category);
    this.name = 'BackendStartupError';
    this.category = category;
  }
}

export interface BackendChild {
  kill(): boolean;
  readonly stderr?: NodeJS.ReadableStream | null;
  readonly stdout?: NodeJS.ReadableStream | null;
  once(event: 'exit', listener: (code: number | null, signal: string | null) => void): this;
  once(event: 'error', listener: (error: Error) => void): this;
}

export interface BackendForkOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
}

export interface BackendForker {
  fork(modulePath: string, args: readonly string[], options: BackendForkOptions): BackendChild;
}

export interface BackendHealthResponse {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}

export type BackendFetch = (
  input: string,
  init: { readonly headers: Record<string, string> },
) => Promise<BackendHealthResponse>;

export interface BackendExitInfo {
  readonly code: number | null;
  readonly signal: string | null;
  readonly error?: Error;
}

export interface BackendManagerOptions {
  readonly forker: BackendForker;
  readonly modulePath: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly workingDirectory: string;
  readonly healthUrl: string;
  readonly startupToken: string;
  readonly fetchImpl?: BackendFetch;
  readonly startupTimeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly shutdownTimeoutMs?: number;
  readonly onExit?: (info: BackendExitInfo) => void;
}

export class BackendManager {
  private readonly options: Required<
    Pick<BackendManagerOptions, 'startupTimeoutMs' | 'pollIntervalMs' | 'shutdownTimeoutMs'>
  > &
    BackendManagerOptions;

  private child: BackendChild | undefined;
  private exitInfo: BackendExitInfo | undefined;
  private ready = false;
  private exitPromise: Promise<BackendExitInfo> | undefined;
  private resolveExit: ((info: BackendExitInfo) => void) | undefined;

  public constructor(options: BackendManagerOptions) {
    this.options = {
      ...options,
      startupTimeoutMs: options.startupTimeoutMs ?? 10_000,
      pollIntervalMs: options.pollIntervalMs ?? 100,
      shutdownTimeoutMs: options.shutdownTimeoutMs ?? 5_000,
    };
  }

  public get isReady(): boolean {
    return this.ready;
  }

  public async start(): Promise<void> {
    if (this.child !== undefined) {
      throw new Error('OmniMemory backend is already running');
    }

    this.exitInfo = undefined;
    this.exitPromise = new Promise<BackendExitInfo>((resolveExit) => {
      this.resolveExit = resolveExit;
    });

    const child = this.options.forker.fork(this.options.modulePath, [], {
      env: this.options.environment,
      cwd: this.options.workingDirectory,
    });
    this.child = child;
    child.once('exit', (code, signal) => {
      const wasReady = this.ready;
      const info: BackendExitInfo = { code, signal };
      this.exitInfo = info;
      this.child = undefined;
      this.ready = false;
      this.resolveExit?.(info);
      if (wasReady) {
        this.options.onExit?.(info);
      }
    });
    child.once('error', (error) => {
      const info: BackendExitInfo = { code: null, signal: null, error };
      this.exitInfo = info;
      this.resolveExit?.(info);
    });

    const deadline = Date.now() + this.options.startupTimeoutMs;
    while (Date.now() < deadline) {
      if (this.exitInfo !== undefined) {
        await this.stop();
        throw startupFailure(this.exitInfo);
      }

      const health = await this.checkHealth();
      if (health === 'ready') {
        this.ready = true;
        return;
      }
      if (health === 'port_occupied') {
        await this.stop();
        throw new BackendStartupError('port_occupied');
      }
      if (health === 'handshake_failed') {
        await this.stop();
        throw new BackendStartupError('readiness_handshake_failed');
      }

      await delay(this.options.pollIntervalMs);
    }

    await this.stop();
    throw new BackendStartupError('startup_timeout');
  }

  public async stop(): Promise<void> {
    const child = this.child;
    if (child === undefined) {
      return;
    }

    child.kill();
    const exitPromise = this.exitPromise;
    if (exitPromise !== undefined) {
      await Promise.race([exitPromise, delay(this.options.shutdownTimeoutMs)]);
    }
    this.child = undefined;
    this.ready = false;
  }

  private async checkHealth(): Promise<'ready' | 'waiting' | 'port_occupied' | 'handshake_failed'> {
    const fetchImpl = this.options.fetchImpl ?? defaultFetch;
    try {
      const response = await fetchImpl(this.options.healthUrl, {
        headers: { 'x-omnimemory-startup-token': this.options.startupToken },
      });
      if (response.status !== 200) {
        return 'port_occupied';
      }
      const payload = await response.json();
      return isReadyPayload(payload) ? 'ready' : 'handshake_failed';
    } catch {
      return 'waiting';
    }
  }
}

function defaultFetch(
  input: string,
  init: { readonly headers: Record<string, string> },
): Promise<BackendHealthResponse> {
  return fetch(input, init);
}

function isReadyPayload(payload: unknown): boolean {
  if (typeof payload !== 'object' || payload === null || !('data' in payload)) {
    return false;
  }
  const data = payload.data;
  return typeof data === 'object' && data !== null && 'status' in data && data.status === 'ok';
}

function startupFailure(info: BackendExitInfo): BackendStartupError {
  if (info.error !== undefined) {
    return new BackendStartupError('backend_process_start_failed');
  }
  if (info.code !== null) {
    return new BackendStartupError(
      info.code === 2 ? 'database_initialization_failed' : 'backend_process_exited',
    );
  }
  return new BackendStartupError('backend_process_exited');
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => {
    setTimeout(resolveDelay, milliseconds);
  });
}
