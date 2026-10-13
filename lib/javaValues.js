"use strict";

/** Wraps a Java long value while retaining its exact decimal representation. */
class JavaLong {
  /** Stores the untruncated long value as a decimal string. */
  constructor(value) {
    this.longValue = value;
  }

  /** Returns the exact decimal value without converting it to a JavaScript number. */
  toString() {
    return this.longValue;
  }
}

/** Wraps a JMX CompositeData value with the legacy synchronous lookup method. */
class JavaCompositeData {
  /** Stores decoded CompositeData items for callback consumers. */
  constructor(items) {
    this.items = items;
  }

  /** Returns one named CompositeData item, matching the node-java throw-on-missing-key contract. */
  getSync(key) {
    if (!Object.prototype.hasOwnProperty.call(this.items, key)) {
      const error = new Error(`CompositeData has no item named ${JSON.stringify(key)}`);
      error.name = "CompositeDataKeyError";
      throw error;
    }
    return this.items[key];
  }

  /** Reports the available CompositeData key names. */
  keys() {
    return Object.keys(this.items);
  }

  /** Exposes the decoded items when the wrapper is serialized as a plain JSON value. */
  toJSON() {
    return this.items;
  }
}

/** Converts JSON-tagged JMX values into their callback-facing Java-compatible wrappers. */
function fromWire(value) {
  if (Array.isArray(value)) {
    return value.map(fromWire);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  if (value.$jmxType === "Long") {
    return new JavaLong(value.value);
  }
  if (value.$jmxType === "CompositeData") {
    const items = {};
    for (const [key, item] of Object.entries(value.items)) {
      items[key] = fromWire(item);
    }
    return new JavaCompositeData(items);
  }
  if (value.$jmxType === "TabularData") {
    return fromWire(value.rows);
  }
  if (value.$jmxType === "Map") {
    const entries = {};
    for (const [key, item] of Object.entries(value.entries)) {
      entries[key] = fromWire(item);
    }
    return entries;
  }
  if (value.$jmxType === "MapTypedKeys") {
    return value.pairs.map(
      /** Decodes a map entry whose non-string key would otherwise be coerced by JSON. */
      (pair) => [fromWire(pair[0]), fromWire(pair[1])]
    );
  }
  if (value.$jmxType === "Object") {
    return { className: value.className, value: value.value };
  }
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    result[key] = fromWire(item);
  }
  return result;
}

/** Encodes supported Java-compatible wrappers and plain JSON values for IPC requests. */
function toWire(value) {
  if (Array.isArray(value)) {
    return value.map(toWire);
  }
  if (value && typeof value === "object" && typeof value.longValue !== "undefined") {
    return String(value.longValue);
  }
  if (value && typeof value === "object" && typeof value.toJSON === "function") {
    return toWire(value.toJSON());
  }
  if (value && typeof value === "object") {
    const result = {};
    for (const [key, item] of Object.entries(value)) {
      result[key] = toWire(item);
    }
    return result;
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  return value;
}

module.exports = { fromWire, toWire, JavaLong, JavaCompositeData };
