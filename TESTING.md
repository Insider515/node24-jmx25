# Testing node24-jmx25

Requirements: Node.js 24 or later, Java 25 or later, and Maven with JDK 25 for building the sidecar.

Run unit and local JMX integration tests; the npm test script builds the sidecar first:

```sh
npm test
```

The integration test starts a local Java JMX server and verifies connection, attribute reads and writes, operation invocation (including a class loaded from a user classpath), and MBean listing. Set `JAVA_HOME` if the Java executable is not on `PATH`.
