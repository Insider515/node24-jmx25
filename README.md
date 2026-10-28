# node24-jmx25

Node.js client for reading and managing Java applications through JMX, targeting Node.js 24+ and the Java 25 toolchain. The package runs a small Java sidecar and exchanges newline-delimited JSON messages with it over the child process's standard input and output.

## When to use this package instead of Jolokia

Both tools let Node.js read and manage a JVM through JMX, but they attach to the target from opposite sides.

- `node24-jmx25` runs on the Node.js host and speaks the standard JMX remote protocol (JSR-160, RMI by default) through a Java sidecar. The target JVM needs nothing beyond an enabled JMX remote connector; no code is deployed into it. The Node.js host needs Java 25 or later.
- [Jolokia](https://jolokia.org/) is "a JMX-HTTP bridge giving an alternative to JSR-160 connectors" and follows "an agent based approach": its agent is deployed inside the target JVM as a WAR, OSGi bundle, or JVM agent and answers JSON over HTTP. The Node.js host then needs only an HTTP client and no JVM. Jolokia adds "bulk requests and fine grained security policies" on top of plain JMX.

Pick `node24-jmx25` when you cannot or do not want to change the target deployment and a JMX remote port is already exposed. Pick Jolokia when you control the target deployment and can add its agent, when installing a JDK next to Node.js is not an option, or when HTTP is the only transport available between the two hosts.

## Requirements

- Node.js 24 LTS or later.
- Java 25 or later at runtime.
- Maven and JDK 25 to build the Java sidecar from a source checkout. Published npm packages include the built sidecar JAR.

## Installation

```sh
npm install node24-jmx25
```

## Usage

The public API exposes both an `async`/`await` surface and the historical callback form. Every operation returns a `Promise` and still invokes the optional trailing callback with the decoded value when the request succeeds.

```js
const jmx = require("node24-jmx25");

async function main() {
  const client = jmx.createClient({ host: "localhost", port: 3000 });
  client.on("error", (error) => console.error(error));

  await client.connect();
  const memory = await client.getAttribute("java.lang:type=Memory", "HeapMemoryUsage");
  console.log(memory.getSync("used"));
  await client.disconnect();
}

main();
```

An explicit JMX service URL and credentials may be passed instead:

```js
const client = jmx.createClient({
  service: "service:jmx:rmi://localhost:3000/jndi/rmi://localhost:3000/jmxrmi",
  username: "monitor",
  password: "secret"
});
```

## Client API

`createClient(options)` accepts:

- `service`: full JMX service URL. If provided, `host` and `port` are ignored.
- `host`: hostname (defaults to `localhost`).
- `port`: JMX port (required when `service` is not provided).
- `protocol`: JMX protocol (defaults to `rmi`).
- `urlPath`: optional JMX URL path.
- `username` and `password`: optional JMX credentials.
- `classpath`: optional array of local Java classpath entries, needed when operation signatures use application-specific classes.
- `requestTimeoutMs`: per-request timeout in milliseconds (default `30000`; `0` disables).
- `stderrFailFastBytes`: cumulative size of JVM stderr output after which the sidecar is terminated and all pending requests reject with a flood error (default `1048576`; `0` disables the guard).
- `debug`: a function `(label, payload) => void` that receives every protocol send and receive. Pass `true` or set `DEBUG=node24-jmx25` to log through `console.error` instead.

The returned EventEmitter exposes:

- `connect()` and `disconnect()` manage the sidecar and the JMX connection. Both return a `Promise`. `connect()` additionally emits the `connect` event on success.
- `getAttribute(mbean, attribute, [callback])`
- `getAttributes(mbean, attributes, [callback])`
- `getDefaultDomain([callback])`
- `getDomains([callback])`
- `getMBeanCount([callback])`
- `listMBeans([pattern,] [callback])`
- `invoke(mbean, methodName, params, [signature,] [callback])`
- `setAttribute(mbean, attribute, value, [className,] [callback])`
- `addNotificationListener(mbean)` and `removeNotificationListener(subscriptionId)`
- Events: `connect`, `disconnect`, `error`, `notification`.

Promises reject with the Java error class name in `error.name`; the Java stack trace is attached as `error.javaStack` when the sidecar supplied one. If a callback is provided and the request succeeds, the callback receives the decoded value as its only argument.

### Value decoding

- Java `long` values that fit into `Number.MAX_SAFE_INTEGER` are returned as plain JavaScript numbers. Values outside that range are wrapped as `{ longValue: "<decimal>" }` to preserve exactness. The legacy pattern `value.longValue` keeps working for the wrapped form, and plain-number comparisons work for the common case.
- `CompositeData` values are returned as a wrapper with `getSync(key)`, which throws when `key` is unknown. The wrapper also exposes `keys()` and serializes to its items on `JSON.stringify`.
- `TabularData` collapses to an array of `CompositeData` rows.
- Java `Map` values whose keys are all strings are returned as plain objects. Maps with non-string keys are returned as arrays of `[key, value]` pairs to avoid lossy key coercion.
- Other Java objects are returned as `{ className, value }` where `value` is the result of `toString()`.
- Java arrays and `Iterable` values are returned as JavaScript arrays.

### Notifications

```js
const subscriptionId = await client.addNotificationListener("test.jmx:type=Counter");
client.on("notification", (event) => {
  console.log(event.notification.type, event.notification.message);
});
```

Each `notification` payload includes `subscriptionId`, `mbean`, and `notification` with the decoded JMX `Notification` fields.

## Building and testing from source

```sh
npm test
```

`npm test` builds the sidecar before running the tests. `npm pack` and `npm publish` also build it automatically through the `prepack` script. Maven downloads the pinned Jackson dependency during the build.

Continuous integration is defined in [.github/workflows/ci.yml](.github/workflows/ci.yml) and runs the same build/test pipeline on every push and pull request.

## Reference benchmark

Measured with a small harness that spawns a Java JMX target in the same host, connects the client, warms up, then runs parallel workers against `getAttribute` on a `long` MBean attribute.

- Host: macOS, Apple Silicon
- Container: `linux/arm64`, Node.js v24.21.0, Temurin JDK 25
- Parameters: `WORKERS=4 DURATION_SEC=15 WARMUP_SEC=3 OPERATION=getAttribute`

| Metric | Value |
|---|---|
| Total requests | 215 837 |
| Errors | 0 |
| Throughput | 14 389 req/s |
| Latency p50 | 0.273 ms |
| Latency p95 | 0.296 ms |
| Latency p99 | 0.353 ms |
| Latency max | 9.856 ms |
| Node RSS delta | ~93 MB |

For comparison, the same harness invoked directly on the host (no containerization) reaches ~23 000 req/s with p99 ≈ 0.13 ms on the same machine. Containerized numbers are capped by the macOS virtualization overhead; Linux hosts and bare-metal runs are expected to track the native figures more closely.

## Debug logging

Set the environment variable `DEBUG=node24-jmx25` or pass `debug: true` to `createClient` to log each JSON-RPC request and response to `stderr`. For custom routing supply `debug: (label, payload) => void`.

## Sidecar stdout and stderr

The sidecar's standard output is reserved for the protocol: one JSON object per line and nothing else. Any other text on that stream makes the client reject every pending request with `Invalid JSON received from JMX bridge`, kill the sidecar, and emit the `error` event.

To keep the stream clean, the sidecar redirects `System.out` to `System.err` before it writes its first protocol line (`System.setOut(System.err)` in `JmxBridge.main`). Java code that prints or logs through `System.out`, including console appenders that resolve `System.out` at runtime, therefore ends up on stderr. If you add application classes through the `classpath` option, point their logging to stderr or to a file all the same.

The redirect cannot catch output that bypasses `System.out` and is written to file descriptor 1 directly:

- JVM unified logging such as `-Xlog:gc` or `-verbose:gc`. The sidecar inherits the environment of the Node.js process, so these flags reach it through `JAVA_TOOL_OPTIONS`, `JDK_JAVA_OPTIONS`, or `_JAVA_OPTIONS`. Route such logging to stderr explicitly, for example `-Xlog:gc:stderr`.
- Code that writes to `java.io.FileDescriptor.out` directly.

Stderr is safe for diagnostics but not unbounded: the client keeps the last 8 KiB and appends it to the error raised when the sidecar exits unexpectedly, and it terminates the sidecar once the cumulative stderr volume exceeds `stderrFailFastBytes` (1 MiB by default). Raise or disable that option if the sidecar is expected to log heavily.

## Security

JMX credentials are sent only through the sidecar's local process pipe and are not written to logs. The pipe content is visible to the user who owns the Node.js process, which includes core dumps and process-memory snapshots of either side; prefer short-lived credentials and restrict access to the host accordingly. Use authenticated, TLS-protected JMX connections when the JMX endpoint is reachable over a network, and restrict network access to JMX ports independently of this client.

## License

MIT. See [LICENSE](LICENSE).
