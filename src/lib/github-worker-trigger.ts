export type WorkerDispatchReason =
  | 'dispatched'
  | 'not_configured'
  | 'http_error'
  | 'network_error';

export type WorkerDispatchResult = {
  dispatched: boolean;
  reason: WorkerDispatchReason;
  status?: number;
};

type DispatchOptions = {
  token?: string;
  owner?: string;
  repo?: string;
  workflow?: string;
  ref?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

/** Dispatches the worker without ever returning or logging the GitHub token. */
export async function dispatchEditorialWorker({
  token,
  owner = 'manasvignesh',
  repo = 'Cie-Daily-Studio',
  workflow = 'editorial-worker.yml',
  ref = 'main',
  timeoutMs = 3_000,
  fetchImpl = fetch,
}: DispatchOptions): Promise<WorkerDispatchResult> {
  if (!token?.trim()) return { dispatched: false, reason: 'not_configured' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`,
      {
        method: 'POST',
        signal: controller.signal,
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token.trim()}`,
          'X-GitHub-Api-Version': '2022-11-28',
          'Content-Type': 'application/json',
          'User-Agent': 'cie-daily-editorial-worker',
        },
        body: JSON.stringify({ ref }),
      },
    );
    if (response.ok) return { dispatched: true, reason: 'dispatched', status: response.status };
    return { dispatched: false, reason: 'http_error', status: response.status };
  } catch {
    return { dispatched: false, reason: 'network_error' };
  } finally {
    clearTimeout(timer);
  }
}
