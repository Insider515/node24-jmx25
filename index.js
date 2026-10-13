"use strict";

const Client = require("./lib/client");

/** Checks whether a classpath entry is empty or has an unsupported non-string value. */
function isInvalidClasspathEntry(entry) {
  return typeof entry !== "string" || entry.length === 0;
}

/** Validates client options and returns a client for the requested JMX service. */
function createClient(options) {
  if (!options || typeof options !== "object") {
    throw new TypeError("options is required");
  }
  if (options.service !== undefined && typeof options.service !== "string") {
    throw new TypeError("service must be a string");
  }
  if (options.classpath !== undefined
      && (!Array.isArray(options.classpath) || options.classpath.some(isInvalidClasspathEntry))) {
    throw new TypeError("classpath must be an array of Java classpath entries");
  }
  if (!options.service) {
    const validPortInput = typeof options.port === "number"
      || (typeof options.port === "string" && /^\d+$/.test(options.port));
    const port = Number(options.port);
    if (!validPortInput || !Number.isInteger(port) || port < 1 || port > 65535) {
      throw new TypeError("a valid port is required when service is not supplied");
    }
  }
  return new Client(options);
}

module.exports = { createClient };
