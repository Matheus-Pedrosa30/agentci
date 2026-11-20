import { createServer, type IncomingMessage } from "node:http";

import { createWebhookIntake, type IntakeOptions, type RepairAttemptMetadata } from "./intake.ts";

interface StartOptions extends IntakeOptions {
  host: string;
  port: number;
  workerIntervalMs?: number;
}

export interface RunningAgentCiService {
  url: string;
  listAttempts(): RepairAttemptMetadata[];
  close(): Promise<void>;
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1_048_576) throw new Error("Webhook body is too large.");
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function header(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export async function startAgentCiService(options: StartOptions): Promise<RunningAgentCiService> {
  const intake = createWebhookIntake(options);
  const server = createServer(async (request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.method === "GET" && request.url === "/health") {
      response.statusCode = 200;
      response.end(JSON.stringify({ status: "ok" }));
      return;
    }
    if (request.method !== "POST" || request.url !== "/github/webhook") {
      response.statusCode = 404;
      response.end(JSON.stringify({ outcome: "not_found" }));
      return;
    }
    try {
      const result = await intake.receive({
        event: header(request.headers["x-github-event"]),
        deliveryId: header(request.headers["x-github-delivery"]),
        signature: header(request.headers["x-hub-signature-256"]),
        body: await readBody(request),
      });
      response.statusCode = result.status;
      response.end(JSON.stringify({ outcome: result.outcome }));
    } catch {
      response.statusCode = 500;
      response.end(JSON.stringify({ outcome: "error" }));
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  let worker: Promise<void> | undefined;
  const timer = setInterval(() => {
    if (worker) return;
    worker = intake.workOnce().then(
      () => undefined,
      () => undefined,
    );
    void worker.finally(() => {
      worker = undefined;
    });
  }, options.workerIntervalMs ?? 250);
  timer.unref();

  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("AgentCI failed to bind its server.");
  return {
    url: `http://${options.host}:${address.port}`,
    listAttempts: () => intake.listAttempts(),
    async close() {
      clearInterval(timer);
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      await worker;
      intake.close();
    },
  };
}
