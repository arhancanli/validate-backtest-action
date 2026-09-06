// action/test/support/stub-server.mjs
//
// A tiny local HTTP stub of the parts of the Canli Capital validation API this action calls:
// POST /api/v1/keys, POST /api/v1/validate/deflated-sharpe and GET /api/v1/receipts/:id. Each
// route is a function the test supplies; the stub only does routing, JSON body parsing and
// request logging, so a test's envelope fixtures are the only place API shape lives.
import http from "node:http";

function matchReceiptId(pathname) {
  const m = pathname.match(/^\/api\/v1\/receipts\/([^/]+)$/);
  return m ? m[1] : null;
}

// `routes.keys(body, req)`, `routes.validate(body, req)` and `routes.receipt(id, req)` each
// return { status, json } (or a Promise of one). Any route left undefined answers 404.
export function createStubServer(routes = {}) {
  const requests = [];

  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const rawBody = Buffer.concat(chunks).toString("utf8");
    let body = {};
    if (rawBody) {
      try {
        body = JSON.parse(rawBody);
      } catch {
        body = null;
      }
    }
    const url = new URL(req.url, "http://localhost");
    requests.push({ method: req.method, pathname: url.pathname, headers: { ...req.headers }, body });

    let result;
    if (req.method === "POST" && url.pathname === "/api/v1/keys" && routes.keys) {
      result = await routes.keys(body, req);
    } else if (req.method === "POST" && url.pathname === "/api/v1/validate/deflated-sharpe" && routes.validate) {
      result = await routes.validate(body, req);
    } else if (req.method === "GET" && matchReceiptId(url.pathname) && routes.receipt) {
      result = await routes.receipt(matchReceiptId(url.pathname), req);
    }

    if (!result) {
      result = { status: 404, json: { schema: "canli.api.v1", error: { code: "not_found", message: "no such stub route" }, limits: ["stub"] } };
    }
    res.statusCode = result.status;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify(result.json));
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        requests,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}
