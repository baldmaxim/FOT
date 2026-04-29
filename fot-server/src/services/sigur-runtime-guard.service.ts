import { hostname } from 'node:os';

const DEFAULT_ALLOWED_HOSTS = ['odintsov1.live.fvds.ru'];
const loggedScopes = new Set<string>();

function parseAllowedHosts(raw: string | undefined): string[] {
  const hosts = (raw || '')
    .split(',')
    .map(host => host.trim().toLowerCase())
    .filter(Boolean);

  return hosts.length > 0 ? hosts : DEFAULT_ALLOWED_HOSTS;
}

export function getSigurRuntimeGuardState() {
  const currentHost = hostname().trim().toLowerCase();
  const allowedHosts = parseAllowedHosts(process.env.SIGUR_RUNTIME_ALLOWED_HOSTS);
  const allowed = allowedHosts.includes('*') || allowedHosts.includes(currentHost);

  return {
    allowed,
    currentHost,
    allowedHosts,
    configuredValue: process.env.SIGUR_RUNTIME_ALLOWED_HOSTS || null,
  };
}

function buildGuardMessage(scope: string): string {
  const state = getSigurRuntimeGuardState();
  return `[sigur-guard] ${scope} blocked on host "${state.currentHost}". Allowed hosts: ${state.allowedHosts.join(', ')}`;
}

export class SigurRuntimeNotAllowedError extends Error {
  readonly code = 'SIGUR_RUNTIME_NOT_ALLOWED';
  readonly status = 403;

  constructor(scope: string) {
    super(
      `Sigur runtime disabled on this host for "${scope}". ` +
      `Set SIGUR_RUNTIME_ALLOWED_HOSTS if this machine is allowed to run Sigur background/manual sync.`,
    );
    this.name = 'SigurRuntimeNotAllowedError';
  }
}

export function isSigurRuntimeNotAllowedError(error: unknown): error is SigurRuntimeNotAllowedError {
  return error instanceof SigurRuntimeNotAllowedError;
}

export function isSigurRuntimeAllowed(): boolean {
  return getSigurRuntimeGuardState().allowed;
}

export function logSigurRuntimeGuardSkip(scope: string): void {
  if (loggedScopes.has(scope)) return;
  loggedScopes.add(scope);
  console.warn(buildGuardMessage(scope));
}

export function assertSigurRuntimeAllowed(scope: string): void {
  if (!isSigurRuntimeAllowed()) {
    throw new SigurRuntimeNotAllowedError(scope);
  }
}
