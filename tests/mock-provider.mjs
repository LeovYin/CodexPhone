import http from "node:http";

export async function startMockProvider() {
  const state = { requests: [], hold: false, streams: new Set(), nextFunction: null };
  const server = http.createServer(async (request, response) => {
    if (!request.url?.endsWith("/responses")) { response.writeHead(404).end(); return; }
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()); state.requests.push(body);
    response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    const id = `resp_${state.requests.length}`, itemId = `msg_${state.requests.length}`;
    const text = `Local fixture response ${state.requests.length}`;
    const emit = (type, data) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    const base = { id, object: "response", created_at: Math.floor(Date.now() / 1000), model: body.model, status: "in_progress", output: [] };
    emit("response.created", { response: base });
    if (state.hold) { state.streams.add(response); response.on("close", () => state.streams.delete(response)); return; }
    if (state.nextFunction) {
      const call = state.nextFunction; state.nextFunction = null;
      const item = { id: itemId, type: "function_call", call_id: `call_${id}`, name: call.name, arguments: JSON.stringify(call.arguments), status: "completed" };
      emit("response.output_item.added", { output_index: 0, item: { ...item, arguments: "", status: "in_progress" } });
      emit("response.function_call_arguments.delta", { item_id: itemId, output_index: 0, delta: item.arguments });
      emit("response.function_call_arguments.done", { item_id: itemId, output_index: 0, arguments: item.arguments });
      emit("response.output_item.done", { output_index: 0, item });
      emit("response.completed", { response: { ...base, status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }); response.end(); return;
    }
    const item = { type: "message", id: itemId, role: "assistant", status: "in_progress", content: [] };
    emit("response.output_item.added", { output_index: 0, item });
    emit("response.content_part.added", { item_id: itemId, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
    emit("response.output_text.delta", { item_id: itemId, output_index: 0, content_index: 0, delta: text });
    emit("response.output_text.done", { item_id: itemId, output_index: 0, content_index: 0, text });
    const completeItem = { ...item, status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
    emit("response.output_item.done", { output_index: 0, item: completeItem });
    emit("response.completed", { response: { ...base, status: "completed", output: [completeItem], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } });
    response.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { state, url: `http://127.0.0.1:${server.address().port}/v1`, close: async () => { for (const stream of state.streams) stream.end(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); } };
}
