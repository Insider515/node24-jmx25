"use strict";

const { spawn } = require("node:child_process");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const { fromWire, toWire } = require("./javaValues");

const DEFAULT_REQUEST_TIMEOUT_MS = 30000;
const STDERR_TAIL_BYTES = 8192;
const DEFAULT_STDERR_FAIL_FAST_BYTES = 1048576;

/** Creates a Node.js client that communicates with the Java JMX bridge over process pipes. */
class Client extends EventEmitter {
  /** Stores connection options and initializes sidecar lifecycle and request state. */
  constructor(options) {
    super();
    this.options = options;
    this.service = buildServiceUrl(options);
    this.requestTimeoutMs = options.requestTimeoutMs !== undefined
      ? Number(options.requestTimeoutMs)
      : DEFAULT_REQUEST_TIMEOUT_MS;
    this.stderrFailFastBytes = typeof options.stderrFailFastBytes === "number"
      ? options.stderrFailFastBytes
      : DEFAULT_STDERR_FAIL_FAST_BYTES;
    this.stderrBytes = 0;
    this.debug = resolveDebug(options.debug);
    this.child = null;
    this.connected = false;
    this.closing = false;
    this.nextId = 1;
    this.pending = new Map();
    this.notificationHandlers = new Map();
    this.writeQueue = [];
    this.pumping = false;
    this.drainPending = false;
    this.stdoutBuffer = "";
    this.stderrBuffer = Buffer.alloc(0);
    this.readyPromise = null;
    this.resolveReady = null;
    this.rejectReady = null;
    this.resolveExit = null;
    this.exitPromise = null;
  }

  /** Starts or reuses the bridge, connects it to JMX, and emits connect on success. */
  async connect() {
    if (this.connected) return;
    try {
      await this.ensureBridge();
      await this.request("connect", {
        service: this.service,
        username: this.options.username,
        password: this.options.password
      });
      this.connected = true;
      this.emit("connect");
    } catch (error) {
      if (this.child && !this.connected) {
        this.closing = true;
        await this.stopBridge();
        this.closing = false;
      }
      throw error;
    }
  }

  /** Disconnects the JMX connector, closes the sidecar, and emits disconnect after shutdown. */
  async disconnect() {
    if (!this.child || this.closing) return;
    this.closing = true;
    const wasConnected = this.connected;
    let failure;
    try {
      if (wasConnected) {
        await this.request("disconnect", {});
      }
    } catch (error) {
      failure = error;
    } finally {
      this.connected = false;
      await this.stopBridge();
      this.closing = false;
    }
    if (failure) this.safeEmitError(failure);
    if (wasConnected) this.emit("disconnect");
  }

  /** Closes the sidecar input, waits for process exit, and clears its pending lifecycle state. */
  async stopBridge() {
    if (!this.child) return;
    const child = this.child;
    try { child.stdin.end(); } catch (_) { /* input already closed */ }
    await this.exitPromise;
    this.child = null;
    this.readyPromise = null;
    this.exitPromise = null;
    this.stdoutBuffer = "";
    this.stderrBuffer = Buffer.alloc(0);
    this.stderrBytes = 0;
    this.writeQueue.length = 0;
    this.pumping = false;
    this.drainPending = false;
  }

  /** Requests one MBean attribute. Returns a Promise and invokes the optional legacy callback. */
  getAttribute(mbean, attribute, callback) {
    return this.dispatch("getAttribute", { mbean, attribute }, callback);
  }

  /** Requests multiple MBean attributes. Returns a Promise and invokes the optional legacy callback. */
  getAttributes(mbean, attributes, callback) {
    return this.dispatch("getAttributes", { mbean, attributes }, callback);
  }

  /** Requests the connected server's default domain. */
  getDefaultDomain(callback) {
    return this.dispatch("getDefaultDomain", {}, callback);
  }

  /** Requests the connected server's domains. */
  getDomains(callback) {
    return this.dispatch("getDomains", {}, callback);
  }

  /** Requests the connected server's MBean count. */
  getMBeanCount(callback) {
    return this.dispatch("getMBeanCount", {}, callback);
  }

  /** Invokes an MBean operation while preserving the optional-signature callback overload. */
  invoke(mbean, methodName, params, signatureOrCallback, callback) {
    let signature = signatureOrCallback;
    if (typeof signatureOrCallback === "function") {
      callback = signatureOrCallback;
      signature = undefined;
    }
    let values;
    let types;
    try {
      values = params || [];
      types = signature || values.map(inferJavaType);
    } catch (error) {
      return this.failPromise(error);
    }
    return this.dispatch("invoke", {
      mbean,
      methodName,
      params: values.map(toWire),
      signature: types
    }, callback);
  }

  /** Lists canonical MBean names, optionally filtered by an ObjectName pattern. */
  listMBeans(mbean, callback) {
    if (typeof mbean === "function") {
      callback = mbean;
      mbean = undefined;
    }
    return this.dispatch("listMBeans", { mbean }, callback);
  }

  /** Sets an attribute and preserves the optional-class-name callback overload. */
  setAttribute(mbean, attribute, value, classNameOrCallback, callback) {
    let className = classNameOrCallback;
    if (typeof classNameOrCallback === "function") {
      callback = classNameOrCallback;
      className = inferJavaType(value);
    }
    let encoded;
    try {
      encoded = toWire(value);
    } catch (error) {
      return this.failPromise(error);
    }
    return this.dispatch("setAttribute", {
      mbean,
      attribute,
      value: encoded,
      className: className || inferJavaType(value)
    }, callback);
  }

  /** Subscribes to JMX notifications from an MBean and returns the subscription identifier. */
  async addNotificationListener(mbean) {
    if (typeof mbean !== "string" || mbean.length === 0) {
      throw new TypeError("mbean must be a non-empty ObjectName string");
    }
    const subscriptionId = await this.request("addNotificationListener", { mbean });
    this.notificationHandlers.set(subscriptionId, { mbean });
    return subscriptionId;
  }

  /** Removes an active JMX notification subscription from both sides of the bridge. */
  async removeNotificationListener(subscriptionId) {
    this.notificationHandlers.delete(subscriptionId);
    await this.request("removeNotificationListener", { subscriptionId });
  }

  /** Routes an operation through the bridge, decodes the result, and signals both API styles. */
  async dispatch(method, params, callback) {
    const result = await this.request(method, params);
    const decoded = fromWire(result);
    if (typeof callback === "function") callback(decoded);
    return decoded;
  }

  /** Starts the packaged Java archive once and waits until its protocol is ready. */
  ensureBridge() {
    if (this.child) return this.readyPromise;
    const jarPath = path.join(__dirname, "..", "java-bridge", "target", "jmx-bridge.jar");
    if (!fs.existsSync(jarPath)) {
      return Promise.reject(new Error("JMX bridge JAR is missing; run `npm run build:bridge` first"));
    }
    const javaCommand = process.env.JAVA_HOME
      ? path.join(process.env.JAVA_HOME, "bin", process.platform === "win32" ? "java.exe" : "java")
      : "java";
    const classpath = [jarPath].concat(this.options.classpath || []).join(path.delimiter);
    this.child = spawn(javaCommand, ["-cp", classpath, "com.insider515.jmx.JmxBridge"], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    this.stdoutBuffer = "";
    this.stderrBuffer = Buffer.alloc(0);
    this.stderrBytes = 0;
    this.writeQueue.length = 0;
    this.pumping = false;
    this.drainPending = false;
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", this.consumeStdout.bind(this));
    this.child.stderr.on("data", this.captureStderr.bind(this));
    this.child.stdin.on("error", this.handleProcessError.bind(this));
    this.child.stdin.on("drain", this.handleStdinDrain.bind(this));
    this.child.on("error", this.handleProcessError.bind(this));
    this.child.on("close", this.handleProcessExit.bind(this));
    this.exitPromise = new Promise(
      /** Stores the process-exit resolver for disconnect cleanup. */
      (resolve) => { this.resolveExit = resolve; }
    );
    this.readyPromise = new Promise(
      /** Stores startup completion handlers until the Java bridge reports readiness. */
      (resolve, reject) => {
        this.resolveReady = resolve;
        this.rejectReady = reject;
      }
    );
    return this.readyPromise;
  }

  /** Parses sidecar output lines, handles readiness, notifications, and routes RPC responses. */
  consumeStdout(chunk) {
    this.stdoutBuffer += chunk;
    let newline;
    while ((newline = this.stdoutBuffer.indexOf("\n")) !== -1) {
      const line = this.stdoutBuffer.slice(0, newline);
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      let message;
      try {
        message = JSON.parse(line);
      } catch (error) {
        const protocolError = new Error("Invalid JSON received from JMX bridge", { cause: error });
        this.rejectPending(protocolError);
        if (this.child) this.child.kill();
        this.safeEmitError(protocolError);
        return;
      }
      if (this.debug) this.debug("recv", redactForDebug(message));
      if (message.event === "ready") {
        if (this.resolveReady) this.resolveReady();
        this.resolveReady = null;
        this.rejectReady = null;
        continue;
      }
      if (message.event === "notification") {
        this.emit("notification", {
          subscriptionId: message.subscriptionId,
          mbean: message.mbean,
          notification: fromWire(message.notification)
        });
        continue;
      }
      const id = message.id;
      const pending = this.pending.get(id);
      if (!pending) {
        if (Number.isSafeInteger(id) && id > 0 && id < this.nextId) {
          continue;
        }
        const protocolError = new Error("JMX bridge returned an unknown request identifier");
        this.rejectPending(protocolError);
        if (this.child) this.child.kill();
        this.safeEmitError(protocolError);
        return;
      }
      this.pending.delete(id);
      if (message.error) {
        const error = new Error(message.error.message);
        error.name = message.error.name || "JmxBridgeError";
        if (typeof message.error.stack === "string") error.javaStack = message.error.stack;
        pending.reject(error);
      } else {
        pending.resolve(message.result);
      }
    }
  }

  /** Rejects process startup and outstanding requests when the Java process cannot start. */
  handleProcessError(error) {
    if (this.rejectReady) this.rejectReady(error);
    this.rejectReady = null;
    this.resolveReady = null;
    this.rejectPending(error);
  }

  /** Rejects every unresolved bridge request after the process transport becomes unusable. */
  rejectPending(error) {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    for (const queued of this.writeQueue) queued.reject(error);
    this.writeQueue.length = 0;
    this.pumping = false;
    this.drainPending = false;
  }

  /** Retains a bounded byte tail of JVM diagnostics and kills the sidecar when stderr flood exceeds the fail-fast cap. */
  captureStderr(chunk) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    const combined = Buffer.concat([this.stderrBuffer, buffer]);
    this.stderrBuffer = combined.length > STDERR_TAIL_BYTES
      ? combined.subarray(combined.length - STDERR_TAIL_BYTES)
      : combined;
    this.stderrBytes += buffer.length;
    if (this.stderrFailFastBytes > 0 && this.stderrBytes > this.stderrFailFastBytes && this.child && !this.closing) {
      const limit = this.stderrFailFastBytes;
      const details = this.stderrBuffer.toString("utf8").trim();
      const suffix = details ? `: ${details}` : "";
      const floodError = new Error(
        `JMX bridge stderr exceeded the fail-fast threshold of ${limit} bytes${suffix}`);
      this.stderrBytes = 0;
      this.rejectPending(floodError);
      try { this.child.kill("SIGKILL"); } catch (_) { /* process already exiting */ }
      this.safeEmitError(floodError);
    }
  }

  /** Handles sidecar termination and reports unexpected exits to the public error event. */
  handleProcessExit(code, signal) {
    const details = this.stderrBuffer.toString("utf8").trim();
    const suffix = details ? `: ${details}` : "";
    const error = new Error(`JMX bridge exited unexpectedly (code ${code}, signal ${signal})${suffix}`);
    if (this.rejectReady) this.rejectReady(error);
    this.rejectReady = null;
    this.resolveReady = null;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    for (const queued of this.writeQueue) queued.reject(error);
    this.writeQueue.length = 0;
    this.pumping = false;
    if (this.resolveExit) this.resolveExit();
    this.resolveExit = null;
    const wasUnexpected = !this.closing;
    if (wasUnexpected) {
      this.child = null;
      this.readyPromise = null;
      this.exitPromise = null;
      this.stderrBuffer = Buffer.alloc(0);
      this.stderrBytes = 0;
      this.notificationHandlers.clear();
    }
    if (wasUnexpected && this.connected) {
      this.connected = false;
      this.safeEmitError(error);
      this.emit("disconnect");
    }
  }

  /** Sends one JSON-RPC request, enforces its optional timeout, and resolves the matching response. */
  async request(method, params) {
    if (!this.child) throw new Error("JMX bridge is not running");
    if (this.readyPromise) await this.readyPromise;
    if (!Number.isSafeInteger(this.nextId)) {
      throw new RangeError("JMX bridge request identifier space is exhausted");
    }
    const id = this.nextId++;
    const line = JSON.stringify({ id, method, params }) + "\n";
    if (this.debug) this.debug("send", { id, method, params: redactForDebug(params) });
    return new Promise(
      /** Registers the response handlers and request timeout for one bridge call. */
      (resolve, reject) => {
        const entry = { settled: false, resolve: null, reject: null };
        const timer = this.requestTimeoutMs > 0
          ? setTimeout(
              /** Rejects the pending request and removes it from the queue if it was still waiting to be sent. */
              () => {
                if (entry.settled) return;
                entry.settled = true;
                this.pending.delete(id);
                this.removeQueuedWrite(id);
                reject(new Error(`JMX bridge request timed out after ${this.requestTimeoutMs}ms (${method})`));
              }, this.requestTimeoutMs)
          : null;
        entry.resolve = /* Resolves one bridge response and cancels its pending timeout. */ (value) => {
          if (entry.settled) return;
          entry.settled = true;
          if (timer) clearTimeout(timer);
          resolve(value);
        };
        entry.reject = /* Rejects one bridge response and cancels its pending timeout. */ (error) => {
          if (entry.settled) return;
          entry.settled = true;
          if (timer) clearTimeout(timer);
          reject(error);
        };
        this.pending.set(id, entry);
        this.enqueueWrite(id, line).catch(/** Fails the pending request when the pipe write cannot be enqueued. */ (error) => {
          if (entry.settled) return;
          entry.settled = true;
          this.pending.delete(id);
          if (timer) clearTimeout(timer);
          reject(error);
        });
      }
    );
  }

  /** Removes a queued write by request id when the caller cancels before the sidecar reads it. */
  removeQueuedWrite(id) {
    const index = this.writeQueue.findIndex(
      /** Finds the queued write matching the cancelled request id. */
      (entry) => entry.id === id
    );
    if (index === -1) return false;
    this.writeQueue.splice(index, 1);
    return true;
  }

  /** Serializes writes to the sidecar through a drain-aware queue to prevent runaway buffering. */
  enqueueWrite(id, line) {
    return new Promise(
      /** Adds the write to the serialized queue and starts the pump if idle. */
      (resolve, reject) => {
        this.writeQueue.push({ id, line, resolve, reject });
        this.pumpWriteQueue();
      }
    );
  }

  /** Flushes queued writes to stdin while honoring the stream's drain backpressure signal. */
  pumpWriteQueue() {
    if (this.pumping || this.drainPending || this.writeQueue.length === 0 || !this.child) return;
    this.pumping = true;
    while (this.writeQueue.length > 0) {
      const entry = this.writeQueue[0];
      let canContinue;
      try {
        canContinue = this.child.stdin.write(entry.line);
      } catch (error) {
        this.writeQueue.shift();
        entry.reject(error);
        continue;
      }
      this.writeQueue.shift();
      entry.resolve();
      if (!canContinue) {
        this.drainPending = true;
        this.pumping = false;
        return;
      }
    }
    this.pumping = false;
  }

  /** Clears the drain-pending gate so queued writes can resume after the stream drains. */
  handleStdinDrain() {
    this.drainPending = false;
    this.pumpWriteQueue();
  }

  /** Emits a bridge error only when a listener is attached so Node does not crash the process. */
  safeEmitError(error) {
    if (this.listenerCount("error") > 0) this.emit("error", error);
  }

  /** Produces a rejected Promise for synchronous validation failures in public methods. */
  failPromise(error) {
    return Promise.reject(error);
  }
}

/** Infers the Java signature for values supported by the legacy API. */
function inferJavaType(value) {
  if (value && typeof value.longValue !== "undefined") return "long";
  if (typeof value === "string") return "java.lang.String";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") {
    return Number.isInteger(value) && value >= -2147483648 && value <= 2147483647 ? "int" : "double";
  }
  if (Array.isArray(value)) return "[Ljava.lang.String;";
  throw new TypeError(`Cannot infer Java type for ${typeof value}; provide an explicit signature`);
}

/** Creates the service URL format produced by the original Java JMXServiceURL constructor. */
function buildServiceUrl(options) {
  if (typeof options.service === "string" && options.service.startsWith("service:jmx:")) {
    return options.service;
  }
  if (typeof options.service === "string") {
    throw new TypeError("service must be a JMX service URL");
  }
  const protocol = options.protocol || "rmi";
  const host = options.host || "localhost";
  const port = Number(options.port);
  const pathName = options.urlPath || `/jndi/${protocol}://${host}:${port}/jmx${protocol}`;
  return `service:jmx:${protocol}://${host}:${port}${pathName}`;
}

const SENSITIVE_KEYS = new Set(["password", "username", "credentials", "secret", "token"]);

/** Returns a shallow copy of a protocol payload with credential-like fields replaced by a placeholder. */
function redactForDebug(payload) {
  if (!payload || typeof payload !== "object") return payload;
  if (Array.isArray(payload)) return payload.map(redactForDebug);
  const result = {};
  for (const [key, value] of Object.entries(payload)) {
    if (SENSITIVE_KEYS.has(key.toLowerCase())) {
      result[key] = typeof value === "undefined" ? value : "<redacted>";
    } else {
      result[key] = redactForDebug(value);
    }
  }
  return result;
}

/** Resolves the debug logger from a user hook or the DEBUG environment flag. */
function resolveDebug(hook) {
  if (typeof hook === "function") return hook;
  if (hook === true) return console.error.bind(console, "[node24-jmx25]");
  const flag = process.env.DEBUG;
  if (typeof flag === "string" && /(^|,)\s*node24-jmx25(\s*,|$)|^\*$/.test(flag)) {
    return console.error.bind(console, "[node24-jmx25]");
  }
  return null;
}

module.exports = Client;
