import type { NextFunction, Request, Response } from 'express';

function sanitizeMetricName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_') || 'app';
}

export function serverTiming(metricName: string) {
  const metric = sanitizeMetricName(metricName);
  return (_req: Request, res: Response, next: NextFunction): void => {
    const startedAt = process.hrtime.bigint();
    const originalWriteHead = res.writeHead.bind(res);

    res.writeHead = ((...args: Parameters<Response['writeHead']>) => {
      if (!res.headersSent) {
        const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
        const value = `${metric};dur=${elapsedMs.toFixed(1)}`;
        const existing = res.getHeader('Server-Timing');
        res.setHeader('Server-Timing', existing ? `${existing}, ${value}` : value);
      }
      return originalWriteHead(...args);
    }) as Response['writeHead'];

    next();
  };
}
