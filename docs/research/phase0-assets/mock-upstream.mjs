// Phase 0 mock upstream: OpenAI Chat + Anthropic Messages with distinctive usage numbers.
// OpenAI: prompt 111 / completion 22. Anthropic: input 333 (+cache_read 44, cache_write 7) / output 55.
import http from "node:http";

const PORT = Number(process.env.PORT ?? 18080);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data ? JSON.parse(data) : {}));
  });
}

function log(req, body) {
  const h = Object.fromEntries(
    Object.entries(req.headers).filter(([k]) => /request-id|x-omni|user-agent|authorization|x-api-key/i.test(k))
      .map(([k, v]) => [k, /authorization|x-api-key/i.test(k) ? String(v).slice(0, 12) + "…" : v]),
  );
  console.log(JSON.stringify({ t: new Date().toISOString(), method: req.method, url: req.url, model: body.model, stream: body.stream, stream_options: body.stream_options, headers: h }));
}

const sse = (res, obj, event) => res.write((event ? `event: ${event}\n` : "") + `data: ${JSON.stringify(obj)}\n\n`);

async function openaiChat(req, res, body) {
  const usage = { prompt_tokens: 111, completion_tokens: 22, total_tokens: 133 };
  const base = { id: "chatcmpl-mock", object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: body.model };
  if (!body.stream) {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ ...base, object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "hello from mock" }, finish_reason: "stop" }], usage }));
  }
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  for (const piece of ["hello ", "from ", "mock"]) {
    sse(res, { ...base, choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] });
    await sleep(150);
  }
  sse(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
  if (body.stream_options?.include_usage) sse(res, { ...base, choices: [], usage });
  res.end("data: [DONE]\n\n");
}

async function anthropicMessages(req, res, body) {
  const msg = { id: "msg_mock", type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null };
  if (!body.stream) {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ ...msg, content: [{ type: "text", text: "hello from mock" }], stop_reason: "end_turn",
      usage: { input_tokens: 333, output_tokens: 55, cache_read_input_tokens: 44, cache_creation_input_tokens: 7 } }));
  }
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  sse(res, { type: "message_start", message: { ...msg, usage: { input_tokens: 333, output_tokens: 1, cache_read_input_tokens: 44, cache_creation_input_tokens: 7 } } }, "message_start");
  sse(res, { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, "content_block_start");
  for (const piece of ["hello ", "from ", "mock"]) {
    sse(res, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: piece } }, "content_block_delta");
    await sleep(150);
  }
  sse(res, { type: "content_block_stop", index: 0 }, "content_block_stop");
  sse(res, { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 55 } }, "message_delta");
  sse(res, { type: "message_stop" }, "message_stop");
  res.end();
}

http.createServer(async (req, res) => {
  const body = req.method === "POST" ? await readBody(req) : {};
  log(req, body);
  const path = req.url.split("?")[0].replace(/^\/v1/, "");
  if (req.method === "GET" && path === "/models") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ object: "list", data: [{ id: "mock-gpt", object: "model" }, { id: "claude-mock", object: "model" }] }));
  }
  if (req.method === "POST" && path === "/chat/completions") return openaiChat(req, res, body);
  if (req.method === "POST" && path === "/messages") return anthropicMessages(req, res, body);
  res.writeHead(404).end();
}).listen(PORT, () => console.log(`mock upstream on :${PORT}`));
