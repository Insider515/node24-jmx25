"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { EventEmitter } = require("node:events");
const jmx = require("../index");
const Client = require("../lib/client");
const { fromWire, toWire, JavaCompositeData } = require("../lib/javaValues");

/** Builds a minimal child-process stand-in with controllable stdin/write behavior. */
function fakeChild(options = {}) {
  const stdin = new EventEmitter();
  const writes = [];
  let acceptNext = typeof options.initialAccept === "boolean" ? options.initialAccept : true;
  stdin.write = /* Simulates a Node.js writable with explicit buffering. */ function(line) {
    writes.push(line);
    const accepted = acceptNext;
    if (typeof options.onWrite === "function") options.onWrite(line, writes.length);
    acceptNext = true;
    return accepted;
  };
  stdin.end = /* Stub for the pipe-close path. */ function() {};
  const stdout = new EventEmitter();
  stdout.setEncoding = function() {};
  const stderr = new EventEmitter();
  stderr.setEncoding = function() {};
  const child = new EventEmitter();
  child.stdin = stdin;
  child.stdout = stdout;
  child.stderr = stderr;
  child.kill = function() {};
  child.pid = 0;
  child.writes = writes;
  child.setAccept = function(flag) { acceptNext = flag; };
  return child;
}

/** Wires a Client instance to a prebuilt fake child, including the handlers ensureBridge would attach. */
function attachFakeChild(client, child) {
  client.child = child;
  client.readyPromise = Promise.resolve();
  client.exitPromise = new Promise(/* Collects the exit resolver so stopBridge can wait on it. */ (resolve) => {
    client.resolveExit = resolve;
  });
  child.stdout.on("data", client.consumeStdout.bind(client));
  child.stderr.on("data", client.captureStderr.bind(client));
  child.stdin.on("drain", client.handleStdinDrain.bind(client));
}

test("createClient builds a service URL from host and port", /* Verifies the generated default JMX URL. */ function() {
  const client = jmx.createClient({ host: "127.0.0.1", port: 3000 });
  assert.ok(client instanceof Client);
  assert.equal(client.service, "service:jmx:rmi://127.0.0.1:3000/jndi/rmi://127.0.0.1:3000/jmxrmi");
});

test("createClient accepts a numeric port string and validates Java classpaths", /* Checks port compatibility and Java classpath validation. */ function() {
  const client = jmx.createClient({ host: "localhost", port: "3000", classpath: ["./target/classes"] });
  assert.ok(client instanceof Client);
  assert.equal(client.service, "service:jmx:rmi://localhost:3000/jndi/rmi://localhost:3000/jmxrmi");
  assert.throws(/* Rejects an invalid classpath option. */ function() {
    jmx.createClient({ host: "localhost", port: 3000, classpath: "target/classes" });
  }, /classpath must be an array/);
});

test("createClient accepts an explicit JMX service URL", /* Verifies that a full service URL is retained verbatim. */ function() {
  const service = "service:jmx:rmi:///jndi/rmi://localhost:3000/jmxrmi";
  assert.equal(jmx.createClient({ service }).service, service);
});

test("createClient requires options and a valid port when no service URL is given", /* Checks required client configuration. */ function() {
  assert.throws(/* Rejects missing options. */ function() { jmx.createClient(); }, /options is required/);
  assert.throws(/* Rejects a missing port. */ function() { jmx.createClient({ host: "localhost" }); }, /valid port is required/);
  assert.throws(/* Rejects a non-integer port string. */ function() {
    jmx.createClient({ host: "localhost", port: "3000.0" });
  }, /valid port is required/);
});

test("createClient exposes the configurable resilience options", /* Verifies new resilience options are propagated. */ function() {
  const client = jmx.createClient({
    host: "localhost", port: 3000,
    requestTimeoutMs: 500, stderrFailFastBytes: 2048
  });
  assert.equal(client.requestTimeoutMs, 500);
  assert.equal(client.stderrFailFastBytes, 2048);
});

test("safeEmitError does not throw when no error listener is attached", /* Verifies the no-crash guarantee. */ function() {
  const client = jmx.createClient({ host: "localhost", port: 3000, stderrFailFastBytes: 32 });
  client.child = { kill: function() {}, stdin: { end: function() {} } };
  client.closing = false;
  assert.doesNotThrow(/* The flood error must be swallowed when nothing is listening. */ function() {
    client.captureStderr("x".repeat(64));
  });
  client.child = null;
});

test("captureStderr kills the sidecar when stderr exceeds the fail-fast threshold", /* Verifies the stderr flood guard. */ function() {
  const client = jmx.createClient({ host: "localhost", port: 3000, stderrFailFastBytes: 64 });
  const errors = [];
  client.on("error", /* Collects the fail-fast error without crashing the process. */ (err) => errors.push(err));
  let killed = false;
  client.child = {
    kill: /* Records that the sidecar would have been terminated. */ () => { killed = true; },
    stdin: { end: () => {} }
  };
  client.closing = false;
  client.captureStderr("x".repeat(128));
  assert.equal(killed, true);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /exceeded the fail-fast threshold of 64 bytes/);
  client.child = null;
});

test("request serializes writes through the drain-aware queue", /* Verifies that write backpressure defers queued requests until drain fires. */ async function() {
  const client = jmx.createClient({ host: "localhost", port: 3000, requestTimeoutMs: 0 });
  const child = fakeChild({ initialAccept: false });
  attachFakeChild(client, child);
  const firstResponse = client.request("getDefaultDomain", {});
  const secondResponse = client.request("getDomains", {});
  await new Promise(/* Lets the microtask queue drain the first enqueued write. */ (resolve) => setImmediate(resolve));
  assert.equal(child.writes.length, 1, "second write must wait for a drain signal");
  child.stdin.emit("drain");
  await new Promise(/* Lets the drain handler pump the deferred write. */ (resolve) => setImmediate(resolve));
  assert.equal(child.writes.length, 2);
  const parsedFirst = JSON.parse(child.writes[0]);
  const parsedSecond = JSON.parse(child.writes[1]);
  child.stdout.emit("data",
    JSON.stringify({ id: parsedFirst.id, result: "domain-a" }) + "\n" +
    JSON.stringify({ id: parsedSecond.id, result: ["dom"] }) + "\n");
  assert.equal(await firstResponse, "domain-a");
  assert.deepEqual(await secondResponse, ["dom"]);
  client.child = null;
});

test("request clears the pending map and attached timer after a response arrives", /* Verifies cleanup of resolved requests. */ async function() {
  const client = jmx.createClient({ host: "localhost", port: 3000, requestTimeoutMs: 50 });
  const child = fakeChild();
  attachFakeChild(client, child);
  const pending = client.request("getDefaultDomain", {});
  await new Promise(/* Allows the enqueued write to flush before responding. */ (resolve) => setImmediate(resolve));
  const parsed = JSON.parse(child.writes[0]);
  child.stdout.emit("data", JSON.stringify({ id: parsed.id, result: "value" }) + "\n");
  assert.equal(await pending, "value");
  assert.equal(client.pending.size, 0);
  client.child = null;
});

test("request bypasses the readyPromise wait after the sidecar has signalled readiness", /* Verifies the null-safety for post-ready requests. */ async function() {
  const client = jmx.createClient({ host: "localhost", port: 3000, requestTimeoutMs: 0 });
  const child = fakeChild();
  attachFakeChild(client, child);
  client.readyPromise = null;
  const pending = client.request("getDefaultDomain", {});
  await new Promise(/* Yields to the queue before responding to the request. */ (resolve) => setImmediate(resolve));
  const parsed = JSON.parse(child.writes[0]);
  child.stdout.emit("data", JSON.stringify({ id: parsed.id, result: "ok" }) + "\n");
  assert.equal(await pending, "ok");
  client.child = null;
});

test("request throws when the bridge has not been started", /* Verifies the explicit error for disconnected clients. */ async function() {
  const client = jmx.createClient({ host: "localhost", port: 3000 });
  await assert.rejects(client.request("getDefaultDomain", {}), /JMX bridge is not running/);
});

test("debug hook redacts credentials from both send and recv payloads", /* Verifies passwords never reach the debug logger. */ async function() {
  const events = [];
  const client = jmx.createClient({
    host: "localhost", port: 3000, username: "monitor", password: "secret", requestTimeoutMs: 0,
    debug: /* Captures each labelled payload the client emitted. */ (label, payload) => events.push({ label, payload })
  });
  const child = fakeChild();
  attachFakeChild(client, child);
  const pending = client.request("connect", { service: client.service, username: "monitor", password: "secret" });
  await new Promise(/* Lets the serialized send flush to the fake stdin. */ (resolve) => setImmediate(resolve));
  const parsed = JSON.parse(child.writes[0]);
  child.stdout.emit("data", JSON.stringify({
    id: parsed.id, result: { username: "monitor", password: "secret", status: "ok" }
  }) + "\n");
  await pending;
  const serialized = JSON.stringify(events);
  assert.doesNotMatch(serialized, /secret/);
  assert.doesNotMatch(serialized, /"username":"monitor"/);
  assert.match(serialized, /"password":"<redacted>"/);
  assert.match(serialized, /"username":"<redacted>"/);
  client.child = null;
});

test("timed-out requests silently discard a late response for a previously issued id", /* Verifies the monotonic-id cursor guard. */ async function() {
  const client = jmx.createClient({ host: "localhost", port: 3000, requestTimeoutMs: 30 });
  const errors = [];
  client.on("error", /* Collects any error events emitted during the timeout path. */ (err) => errors.push(err));
  const child = fakeChild();
  let killed = false;
  child.kill = /* Records whether the test triggered a sidecar kill. */ function() { killed = true; };
  attachFakeChild(client, child);
  const pending = client.request("getDefaultDomain", {});
  await new Promise(/* Lets the write flush before the timeout fires. */ (resolve) => setImmediate(resolve));
  const parsed = JSON.parse(child.writes[0]);
  await assert.rejects(pending, /timed out/);
  assert.equal(client.pending.size, 0, "the timed-out request must be removed from the pending map");
  assert.ok(parsed.id < client.nextId, "the cancelled id must remain below the monotonic allocation cursor");
  child.stdout.emit("data", JSON.stringify({ id: parsed.id, result: "late" }) + "\n");
  await new Promise(/* Allows consumeStdout to process the orphan response. */ (resolve) => setImmediate(resolve));
  assert.equal(killed, false, "late response must not kill the sidecar");
  const unknownIdEvents = errors.filter(/* Isolates the fatal protocol-error event. */ (err) => /unknown request identifier/i.test(err.message));
  assert.equal(unknownIdEvents.length, 0);
  client.child = null;
});

test("timed-out requests still waiting for drain are removed without leaking state", /* Verifies the queued-cancellation leak guard. */ async function() {
  const client = jmx.createClient({ host: "localhost", port: 3000, requestTimeoutMs: 30 });
  client.on("error", /* Suppresses the timeout error event during the queue-cancellation path. */ () => {});
  const child = fakeChild({ initialAccept: false });
  attachFakeChild(client, child);
  const firstPending = client.request("getDefaultDomain", {});
  const secondPending = client.request("getDomains", {});
  await new Promise(/* Yields so the first request escapes before backpressure. */ (resolve) => setImmediate(resolve));
  assert.equal(client.writeQueue.length, 1, "the second request must stay queued behind the drain signal");
  await assert.rejects(firstPending, /timed out/);
  await assert.rejects(secondPending, /timed out/);
  assert.equal(client.pending.size, 0, "both cancelled requests must be removed from the pending map");
  assert.equal(client.writeQueue.length, 0, "the cancelled queued request must be removed from the write queue");
  client.child = null;
});

test("responses carrying a non-numeric or future id trigger the protocol-error path", /* Verifies that genuine desync still kills the sidecar. */ async function() {
  const client = jmx.createClient({ host: "localhost", port: 3000, requestTimeoutMs: 0 });
  const errors = [];
  client.on("error", /* Captures the protocol error raised by the invalid id. */ (err) => errors.push(err));
  const child = fakeChild();
  let killed = false;
  child.kill = /* Records whether the invalid id caused the sidecar to be terminated. */ function() { killed = true; };
  attachFakeChild(client, child);
  child.stdout.emit("data", JSON.stringify({ id: null, result: "x" }) + "\n");
  assert.equal(killed, true, "a null id response must terminate the sidecar");
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /unknown request identifier/);
  killed = false;
  errors.length = 0;
  const futureId = client.nextId + 10;
  child.stdout.emit("data", JSON.stringify({ id: futureId, result: "y" }) + "\n");
  assert.equal(killed, true, "an id above the allocation cursor must terminate the sidecar");
  assert.match(errors[0].message, /unknown request identifier/);
  client.child = null;
});

test("request ids stop before JavaScript loses integer precision", /* Verifies request IDs remain exactly representable. */ async function() {
  const client = jmx.createClient({ host: "localhost", port: 3000, requestTimeoutMs: 0 });
  const child = fakeChild();
  attachFakeChild(client, child);
  client.nextId = Number.MAX_SAFE_INTEGER + 1;
  await assert.rejects(
    client.request("getDefaultDomain", {}),
    { name: "RangeError", message: /identifier space is exhausted/ }
  );
  assert.equal(child.writes.length, 0, "an unsafe request id must never be sent");
  client.child = null;
});

test("timed-out requests still waiting for drain are removed from the write queue", /* Verifies that cancelled requests do not reach the sidecar. */ async function() {
  const client = jmx.createClient({ host: "localhost", port: 3000, requestTimeoutMs: 30 });
  client.on("error", /* Allows the timeout rejection to be observed without crashing the test. */ () => {});
  const child = fakeChild({ initialAccept: false });
  attachFakeChild(client, child);
  const firstPending = client.request("getDefaultDomain", {});
  const secondPending = client.request("getDomains", {});
  await new Promise(/* Lets the first write flush before backpressure stalls the second one. */ (resolve) => setImmediate(resolve));
  assert.equal(child.writes.length, 1, "exactly one write must escape the backpressured stream");
  assert.equal(client.writeQueue.length, 1, "the second request must remain queued behind the drain signal");
  await assert.rejects(firstPending, /timed out/);
  await assert.rejects(secondPending, /timed out/);
  assert.equal(client.writeQueue.length, 0, "the cancelled second request must be removed from the queue");
  child.stdin.emit("drain");
  await new Promise(/* Allows the drain handler to pump any remaining queued writes. */ (resolve) => setImmediate(resolve));
  assert.equal(child.writes.length, 1, "no additional write may reach the sidecar after cancellation");
  client.child = null;
});

test("debug hook receives both send and recv protocol events", /* Verifies the debug option mirrors protocol activity. */ async function() {
  const events = [];
  const client = jmx.createClient({
    host: "localhost", port: 3000, requestTimeoutMs: 0,
    debug: /* Records each labelled payload the client logged. */ (label, payload) => events.push({ label, payload })
  });
  const child = fakeChild();
  attachFakeChild(client, child);
  const pending = client.request("getDefaultDomain", {});
  await new Promise(/* Awaits the serialized send before injecting a response. */ (resolve) => setImmediate(resolve));
  const parsed = JSON.parse(child.writes[0]);
  child.stdout.emit("data", JSON.stringify({ id: parsed.id, result: "value" }) + "\n");
  await pending;
  assert.ok(events.some(/* Confirms the send event was recorded. */ (event) => event.label === "send" && event.payload.method === "getDefaultDomain"));
  assert.ok(events.some(/* Confirms the recv event was recorded. */ (event) => event.label === "recv" && event.payload.result === "value"));
  client.child = null;
});

test("dispatch invokes the legacy callback with the decoded value and resolves the returned Promise", /* Verifies Promise and callback coexistence. */ async function() {
  const client = jmx.createClient({ host: "localhost", port: 3000, requestTimeoutMs: 0 });
  const child = fakeChild();
  attachFakeChild(client, child);
  const callbackValues = [];
  const promise = client.getAttribute("test:x=y", "Attr", /* Captures the legacy callback value for comparison. */ (value) => callbackValues.push(value));
  await new Promise(/* Yields so the request is flushed to stdin before responding. */ (resolve) => setImmediate(resolve));
  const parsed = JSON.parse(child.writes[0]);
  child.stdout.emit("data", JSON.stringify({
    id: parsed.id,
    result: { $jmxType: "Long", value: "42000000000000000" }
  }) + "\n");
  const resolved = await promise;
  assert.equal(resolved.longValue, "42000000000000000");
  assert.equal(callbackValues.length, 1);
  assert.equal(callbackValues[0].longValue, "42000000000000000");
  client.child = null;
});

test("dispatch rejects with a bridge-named error carrying the Java stack trace and does not duplicate through the error event", /* Verifies Java error metadata survives transport and that per-request errors are not double-delivered. */ async function() {
  const client = jmx.createClient({ host: "localhost", port: 3000, requestTimeoutMs: 0 });
  const errorEvents = [];
  client.on("error", /* Captures any event emission alongside the Promise rejection. */ (err) => errorEvents.push(err));
  const child = fakeChild();
  attachFakeChild(client, child);
  const pending = client.getAttribute("test:x=y", "Attr");
  await new Promise(/* Lets the enqueued write flush before replying. */ (resolve) => setImmediate(resolve));
  const parsed = JSON.parse(child.writes[0]);
  child.stdout.emit("data", JSON.stringify({
    id: parsed.id,
    error: {
      name: "javax.management.InstanceNotFoundException",
      message: "No such bean",
      stack: "javax.management.InstanceNotFoundException: No such bean\n\tat ..."
    }
  }) + "\n");
  await assert.rejects(pending, /No such bean/);
  try { await pending; } catch (error) {
    assert.equal(error.name, "javax.management.InstanceNotFoundException");
    assert.match(error.javaStack, /InstanceNotFoundException/);
  }
  assert.equal(errorEvents.length, 0, "per-request failures must reach only the Promise, not the error event");
  client.child = null;
});

test("setAttribute infers the Java signature when none is provided", /* Verifies the inferred-class-name path. */ async function() {
  const client = jmx.createClient({ host: "localhost", port: 3000, requestTimeoutMs: 0 });
  const child = fakeChild();
  attachFakeChild(client, child);
  const pending = client.setAttribute("test:x=y", "Attr", "value");
  await new Promise(/* Yields so the serialized request reaches the fake stdin. */ (resolve) => setImmediate(resolve));
  const parsed = JSON.parse(child.writes[0]);
  assert.equal(parsed.params.className, "java.lang.String");
  child.stdout.emit("data", JSON.stringify({ id: parsed.id, result: null }) + "\n");
  await pending;
  client.child = null;
});

test("invoke infers Java signatures for primitive-compatible argument values", /* Verifies the primitive-signature inference. */ async function() {
  const client = jmx.createClient({ host: "localhost", port: 3000, requestTimeoutMs: 0 });
  const child = fakeChild();
  attachFakeChild(client, child);
  const pending = client.invoke("test:x=y", "op", [1, true, "s"]);
  await new Promise(/* Yields so the serialized request reaches the fake stdin. */ (resolve) => setImmediate(resolve));
  const parsed = JSON.parse(child.writes[0]);
  assert.deepEqual(parsed.params.signature, ["int", "boolean", "java.lang.String"]);
  child.stdout.emit("data", JSON.stringify({ id: parsed.id, result: null }) + "\n");
  await pending;
  client.child = null;
});

test("JMX long and CompositeData values preserve the common callback access pattern", /* Verifies Java-compatible value wrappers. */ function() {
  const composite = fromWire({
    $jmxType: "CompositeData",
    items: {
      used: { $jmxType: "Long", value: "9007199254740993" }
    }
  });
  assert.ok(composite instanceof JavaCompositeData);
  assert.equal(composite.getSync("used").longValue, "9007199254740993");
  assert.deepEqual(composite.keys(), ["used"]);
  assert.throws(/* CompositeData must signal missing keys instead of returning undefined. */
    function() { composite.getSync("missing"); }, /CompositeDataKeyError/);
});

test("JMX wrappers, bigint values, and tagged-key maps round-trip through the wire codec", /* Checks exact integer transport and tagged-key maps. */ function() {
  assert.equal(toWire({ longValue: "9007199254740993" }), "9007199254740993");
  assert.equal(toWire(9007199254740993n), "9007199254740993");
  const stringKeys = fromWire({ $jmxType: "Map", entries: { a: 1, b: 2 } });
  assert.deepEqual(stringKeys, { a: 1, b: 2 });
  const typedKeys = fromWire({
    $jmxType: "MapTypedKeys",
    pairs: [[1, "one"], [2, "two"]]
  });
  assert.deepEqual(typedKeys, [[1, "one"], [2, "two"]]);
  const table = fromWire({
    $jmxType: "TabularData",
    rows: [{ $jmxType: "CompositeData", items: { k: "v" } }]
  });
  assert.equal(table.length, 1);
  assert.equal(table[0].getSync("k"), "v");
  const taggedObject = fromWire({ $jmxType: "Object", className: "com.example.Thing", value: "repr" });
  assert.deepEqual(taggedObject, { className: "com.example.Thing", value: "repr" });
});
