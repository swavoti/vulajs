import type { Request, Response } from 'express';

/**
 * GET /api/hello
 */
export async function GET(req: Request, res: Response) {
  res.json({
    status: "ok",
    message: "Hello from Vula.js",
    timestamp: new Date().toISOString(),
  });
}

/**
 * POST /api/hello
 */
export async function POST(req: Request, res: Response) {
  const body = req.body;
  res.json({
    status: "ok",
    received: body,
  });
}
