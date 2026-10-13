"use strict";

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const net = require("node:net");
const path = require("node:path");
const test = require("node:test");
const jmx = require("../index");

const testClasspath = path.join(__dirname, "..", "java-bridge", "target", "test-classes");

/** Reserves an available TCP port for the local JMX test server. */
function availablePort() {
  return new Promise(/* Resolves a free loopback port or reports the listener error. */ (resolve, reject) => {
    const listener = net.createServer();
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", /* Reads and releases the temporary listening port. */ function() {
      const port = listener.address().port;
      listener.close(/* Reports release errors before returning the selected port. */ function(error) {
        if (error) reject(error);
        else resolve(port);
      });
    });
  });
}

/** Starts the Java source-file test server and resolves once its connector is ready. */
function startJmxServer(port) {
  const javaCommand = process.env.JAVA_HOME
    ? path.join(process.env.JAVA_HOME, "bin", process.platform === "win32" ? "java.exe" : "java")
    : "java";
  const server = spawn(javaCommand, [
    "--class-path", testClasspath,
    "test/fixtures/JmxTestServer.java", String(port)
  ], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true
  });
  let output = "";
  let errorOutput = "";
  let resolveReady;
  let rejectReady;
  const ready = new Promise(/* Stores startup handlers until the fixture prints READY. */ (resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const exited = new Promise(/* Resolves when the Java test-server process exits. */ (resolve) => {
    server.once("exit", resolve);
  });
  server.stdout.setEncoding("utf8");
  server.stderr.setEncoding("utf8");
  server.stdout.on("data", /* Detects the fixture readiness message. */ function(chunk) {
    output += chunk;
    if (output.includes("READY")) resolveReady();
  });
  server.stderr.on("data", /* Retains diagnostics to explain startup failures. */ function(chunk) {
    errorOutput += chunk;
  });
  server.once("error", rejectReady);
  server.once("exit", /* Rejects startup if the fixture exits before readiness. */ function(code) {
    if (!output.includes("READY")) {
      rejectReady(new Error(`JMX test server exited before readiness (${code}): ${errorOutput}`));
    }
  });
  return { server, ready, exited };
}

/** Waits for one client event and rejects when a JMX error arrives first. */
function waitForClientEvent(client, eventName) {
  return new Promise(/* Waits for the requested event and rejects on an earlier JMX error. */ (resolve, reject) => {
    client.once(eventName, resolve);
    client.once("error", reject);
  });
}

/** Wraps the callback-only API in a promise for backward-compat regression checks. */
function callClient(client, method, ...args) {
  return new Promise(/* Resolves with the value passed to the callback API. */ (resolve) => client[method](...args, resolve));
}

test("connects to a real JMX server and reads, updates, and invokes MBean operations", /* Exercises the complete local JMX client flow. */ async function(t) {
  const port = await availablePort();
  const { server, ready, exited } = startJmxServer(port);
  const client = jmx.createClient({ host: "127.0.0.1", port, classpath: [testClasspath] });
  const errors = [];
  client.on("error", /* Records client errors for diagnostics without crashing the test. */ (err) => errors.push(err));
  t.after(/* Releases both child processes after the integration assertions. */ async function() {
    await client.disconnect();
    server.stdin.end();
    await exited;
  });

  await ready;
  await client.connect();

  const count = await client.getAttribute("test.jmx:type=Counter", "Count");
  assert.equal(count, 1);

  await client.setAttribute("test.jmx:type=Counter", "Count", "40", "long");
  const result = await client.invoke("test.jmx:type=Counter", "increment", [2], ["int"]);
  assert.equal(result, 42);
  const address = await client.invoke("test.jmx:type=Counter", "describe",
    [["127.0.0.1", 8123]], ["java.net.InetSocketAddress"]);
  assert.equal(address, "127.0.0.1:8123");
  const label = await client.invoke("test.jmx:type=Counter", "describeLabel",
    [["custom"]], ["test.fixture.CustomLabel"]);
  assert.equal(label, "label=custom");

  const attributes = await callClient(client, "getAttributes", "test.jmx:type=Counter", ["Count"]);
  assert.equal(attributes[0], 42);

  const names = await client.listMBeans();
  assert.ok(names.includes("test.jmx:type=Counter"));

  const domain = await client.getDefaultDomain();
  assert.equal(typeof domain, "string");
  const domains = await client.getDomains();
  assert.ok(domains.includes("test.jmx"));
  const countValue = await client.getMBeanCount();
  assert.ok(countValue > 0);

  const memory = await client.getAttribute("java.lang:type=Memory", "HeapMemoryUsage");
  const used = memory.getSync("used");
  const usedIsPlain = typeof used === "number";
  const usedIsWrapped = typeof used === "object" && typeof used.longValue === "string";
  assert.ok(usedIsPlain || usedIsWrapped, "heap used must be a plain number or a Long wrapper");

  const bigCount = await client.getAttribute("test.jmx:type=Counter", "BigCount");
  assert.equal(bigCount.longValue, "9007199254740993");

  const integerKeyed = await client.getAttribute("test.jmx:type=Counter", "IntegerKeyedMap");
  assert.ok(Array.isArray(integerKeyed));
  const sorted = [...integerKeyed].sort(/* Ensures deterministic ordering for the typed-key map comparison. */ (a, b) => a[0] - b[0]);
  assert.deepEqual(sorted, [[1, "one"], [2, "two"]]);

  const values = await client.invoke("test.jmx:type=Counter", "values", []);
  assert.equal(values.$jmxType, "ordinary-value");

  assert.deepEqual(errors, []);
});

test("delivers JMX notifications through the sidecar after a subscription is added", /* Verifies notification subscription support. */ async function(t) {
  const port = await availablePort();
  const { server, ready, exited } = startJmxServer(port);
  const client = jmx.createClient({ host: "127.0.0.1", port, classpath: [testClasspath] });
  const errors = [];
  client.on("error", /* Captures client errors raised during the notification test. */ (err) => errors.push(err));
  t.after(/* Releases the sidecar and the JMX fixture after the subscription test. */ async function() {
    await client.disconnect();
    server.stdin.end();
    await exited;
  });

  await ready;
  await client.connect();

  const received = new Promise(/* Resolves with the first notification observed by the client. */ (resolve) => {
    client.once("notification", resolve);
  });
  const subscriptionId = await client.addNotificationListener("test.jmx:type=Counter");
  assert.equal(typeof subscriptionId, "number");

  await client.invoke("test.jmx:type=Counter", "publishNotification", ["hello"]);
  const event = await received;
  assert.equal(event.subscriptionId, subscriptionId);
  assert.equal(event.mbean, "test.jmx:type=Counter");
  assert.equal(event.notification.type, "test.jmx.counter");
  assert.equal(event.notification.message, "hello");

  await client.removeNotificationListener(subscriptionId);
  assert.deepEqual(errors, []);
});

test("surfaces the Java error class name and stack trace through the sidecar", /* Verifies that Java diagnostics are preserved on error. */ async function(t) {
  const port = await availablePort();
  const { server, ready, exited } = startJmxServer(port);
  const client = jmx.createClient({ host: "127.0.0.1", port, classpath: [testClasspath] });
  client.on("error", /* Prevents the propagated bridge error from crashing the test. */ () => {});
  t.after(/* Shuts the sidecar and the JMX fixture down after the error-path test. */ async function() {
    await client.disconnect();
    server.stdin.end();
    await exited;
  });
  await ready;
  await client.connect();
  try {
    await client.getAttribute("test.jmx:type=DoesNotExist", "Count");
    assert.fail("expected a bridge error for the missing MBean");
  } catch (error) {
    assert.match(error.name, /InstanceNotFoundException/);
    assert.ok(typeof error.javaStack === "string" && error.javaStack.length > 0);
    assert.match(error.javaStack, /InstanceNotFoundException/);
  }
});

test("stops the Java sidecar after a failed JMX connection", /* Verifies failed connections do not leak a sidecar process. */ async function() {
  const port = await availablePort();
  const client = jmx.createClient({ host: "127.0.0.1", port });
  client.on("error", /* Prevents the error event from crashing the test process. */ () => {});
  await assert.rejects(client.connect());
  assert.equal(client.child, null);
});

test("rejects a bridge request after the configurable timeout elapses", /* Verifies requestTimeoutMs enforcement. */ async function() {
  const client = jmx.createClient({ host: "127.0.0.1", port: 1, requestTimeoutMs: 50 });
  client.on("error", /* Suppresses the unhandled-error emission during the timeout path. */ () => {});
  const pending = Promise.resolve({ resolve: null });
  const request = new Promise(
    /** Produces a synthetic request that never resolves to measure the timeout. */
    (resolve, reject) => {
      client.child = {
        stdin: {
          write: /* Pretends to accept the write so the timeout alone decides the outcome. */ () => true,
          on: /* Ignores stdin events for the synthetic child used in this test. */ () => {},
          once: /* Ignores one-shot stdin events for the synthetic child used in this test. */ () => {},
          end: /* Allows cleanup paths to call end() without a real stream. */ () => {}
        },
        stdout: { on: () => {}, setEncoding: () => {} },
        stderr: { on: () => {}, setEncoding: () => {} },
        on: () => {},
        kill: () => {}
      };
      client.readyPromise = Promise.resolve();
      client.request("getDefaultDomain", {}).then(resolve, reject);
    }
  );
  await assert.rejects(request, /timed out after 50ms/);
  // Prevent accidental teardown using the synthetic child.
  client.child = null;
  await pending;
});
