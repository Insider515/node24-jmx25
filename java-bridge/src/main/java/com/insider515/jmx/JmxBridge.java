package com.insider515.jmx;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import javax.management.Attribute;
import javax.management.AttributeList;
import javax.management.MBeanServerConnection;
import javax.management.Notification;
import javax.management.NotificationListener;
import javax.management.ObjectName;
import javax.management.openmbean.CompositeData;
import javax.management.openmbean.TabularData;
import javax.management.remote.JMXConnector;
import javax.management.remote.JMXConnectorFactory;
import javax.management.remote.JMXServiceURL;
import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.io.PrintStream;
import java.io.PrintWriter;
import java.io.StringWriter;
import java.nio.charset.StandardCharsets;
import java.math.BigDecimal;
import java.math.BigInteger;
import java.lang.reflect.Array;
import java.lang.reflect.Constructor;
import java.util.Arrays;
import java.util.Collection;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.SortedMap;
import java.util.SortedSet;
import java.util.Comparator;
import java.util.TreeMap;
import java.util.TreeSet;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;

/** Handles JMX requests received over the Node.js process's standard input and output. */
public final class JmxBridge {
    /** Threshold above which a Java long must be transferred as a tagged decimal string. */
    private static final long JS_SAFE_INTEGER = 9007199254740991L;

    private static final ObjectMapper JSON = new ObjectMapper();
    private final BufferedWriter output;
    private final Map<Integer, Subscription> subscriptions = new ConcurrentHashMap<>();
    private final AtomicInteger subscriptionIds = new AtomicInteger(1);
    private JMXConnector connector;
    private MBeanServerConnection connection;

    /** Stores the protocol output stream before application output is redirected to stderr. */
    private JmxBridge(PrintStream protocolOutput) {
        output = new BufferedWriter(new OutputStreamWriter(protocolOutput, StandardCharsets.UTF_8));
    }

    /** Starts the line-oriented JSON bridge and emits a readiness event. */
    public static void main(String[] args) throws Exception {
        PrintStream protocolOutput = System.out;
        System.setOut(System.err);
        JmxBridge bridge = new JmxBridge(protocolOutput);
        bridge.write(Map.of("event", "ready"));
        bridge.run();
    }

    /** Reads one JSON request per line, returns one response per request, and closes JMX on EOF. */
    private void run() throws Exception {
        try (BufferedReader input = new BufferedReader(
            new InputStreamReader(System.in, StandardCharsets.UTF_8))) {
            String line;
            while ((line = input.readLine()) != null) {
                handle(line);
            }
        } finally {
            closeConnection();
        }
    }

    /** Executes a single request and converts all failures into an explicit JSON error response. */
    private void handle(String line) throws Exception {
        Object id = null;
        try {
            Map<String, Object> request = JSON.readValue(line, new TypeReference<>() {});
            id = request.get("id");
            Object result = execute((String) request.get("method"), map(request.get("params")));
            Map<String, Object> response = new HashMap<>();
            response.put("id", id);
            response.put("result", encode(result));
            write(response);
        } catch (Exception error) {
            String message = error.getMessage() == null ? error.getClass().getName() : error.getMessage();
            Map<String, Object> errorBody = new HashMap<>();
            errorBody.put("name", error.getClass().getName());
            errorBody.put("message", message);
            errorBody.put("stack", stackTraceOf(error));
            Map<String, Object> failure = new HashMap<>();
            failure.put("id", id);
            failure.put("error", errorBody);
            write(failure);
        }
    }

    /** Dispatches the supported client API operations to the JMX connection. */
    private Object execute(String method, Map<String, Object> params) throws Exception {
        return switch (method) {
            case "connect" -> connect(params);
            case "disconnect" -> {
                closeConnection();
                yield null;
            }
            case "getAttribute" -> connection().getAttribute(
                new ObjectName(string(params, "mbean")), string(params, "attribute"));
            case "getAttributes" -> getAttributes(params);
            case "getDefaultDomain" -> connection().getDefaultDomain();
            case "getDomains" -> List.of(connection().getDomains());
            case "getMBeanCount" -> connection().getMBeanCount();
            case "listMBeans" -> listMBeans(params);
            case "setAttribute" -> setAttribute(params);
            case "invoke" -> invoke(params);
            case "addNotificationListener" -> addNotificationListener(params);
            case "removeNotificationListener" -> removeNotificationListener(params);
            default -> throw new IllegalArgumentException("Unsupported bridge method: " + method);
        };
    }

    /** Rejects non-boolean values instead of silently converting them to false. */
    private static Boolean booleanValue(Object value) {
        if (value instanceof Boolean bool) return bool;
        if ("true".equalsIgnoreCase(String.valueOf(value))) return true;
        if ("false".equalsIgnoreCase(String.valueOf(value))) return false;
        throw new IllegalArgumentException("Expected a boolean value");
    }

    /** Opens a JMX connector with optional username and password credentials. */
    private Object connect(Map<String, Object> params) throws Exception {
        closeConnection();
        String serviceUrl = string(params, "service");
        Map<String, Object> environment = new HashMap<>();
        Object username = params.get("username");
        Object password = params.get("password");
        if (username instanceof String user && password instanceof String secret) {
            environment.put(JMXConnector.CREDENTIALS, new String[] { user, secret });
        }
        connector = JMXConnectorFactory.connect(new JMXServiceURL(serviceUrl), environment);
        connection = connector.getMBeanServerConnection();
        return null;
    }

    /** Reads attributes in the requested order and omits attributes the server did not return. */
    private Object getAttributes(Map<String, Object> params) throws Exception {
        String[] names = list(params.get("attributes")).stream().map(String::valueOf).toArray(String[]::new);
        AttributeList values = connection().getAttributes(new ObjectName(string(params, "mbean")), names);
        List<Object> result = new ArrayList<>();
        for (Object item : values) {
            result.add(((Attribute) item).getValue());
        }
        return result;
    }

    /** Returns the canonical names for MBeans matching the optional query pattern. */
    private Object listMBeans(Map<String, Object> params) throws Exception {
        Object query = params.get("mbean");
        ObjectName pattern = query == null ? null : new ObjectName(String.valueOf(query));
        return connection().queryNames(pattern, null).stream()
            .map(ObjectName::getCanonicalName).sorted().toList();
    }

    /** Sets a MBean attribute after converting the JSON value to its requested Java type. */
    private Object setAttribute(Map<String, Object> params) throws Exception {
        String className = string(params, "className");
        Object value = convert(params.get("value"), className);
        connection().setAttribute(new ObjectName(string(params, "mbean")),
            new Attribute(string(params, "attribute"), value));
        return null;
    }

    /** Invokes a MBean operation using its explicit Java signature and converted parameters. */
    private Object invoke(Map<String, Object> params) throws Exception {
        List<Object> values = list(params.get("params"));
        List<Object> signatureValues = list(params.get("signature"));
        if (values.size() != signatureValues.size()) {
            throw new IllegalArgumentException("Parameter count does not match operation signature");
        }
        String[] signature = signatureValues.stream().map(String::valueOf).toArray(String[]::new);
        Object[] arguments = new Object[values.size()];
        for (int i = 0; i < values.size(); i++) {
            arguments[i] = convert(values.get(i), signature[i]);
        }
        return connection().invoke(new ObjectName(string(params, "mbean")),
            string(params, "methodName"), arguments, signature);
    }

    /** Registers a notification listener and reports its subscription id to the Node side. */
    private Object addNotificationListener(Map<String, Object> params) throws Exception {
        ObjectName name = new ObjectName(string(params, "mbean"));
        int subscriptionId = subscriptionIds.getAndIncrement();
        NotificationListener listener = (notification, handback) -> {
            try {
                emitNotification(subscriptionId, name.getCanonicalName(), notification);
            } catch (Exception ignored) {
                // Notification delivery failures must not break the subscription or the sidecar loop.
            }
        };
        connection().addNotificationListener(name, listener, null, null);
        subscriptions.put(subscriptionId, new Subscription(name, listener));
        return subscriptionId;
    }

    /** Removes a previously registered notification listener and clears its subscription state. */
    private Object removeNotificationListener(Map<String, Object> params) throws Exception {
        Object raw = params.get("subscriptionId");
        if (!(raw instanceof Number id)) {
            throw new IllegalArgumentException("subscriptionId must be a number");
        }
        Subscription subscription = subscriptions.remove(id.intValue());
        if (subscription == null) {
            throw new IllegalArgumentException("Unknown notification subscription id: " + id);
        }
        connection().removeNotificationListener(subscription.name, subscription.listener);
        return null;
    }

    /** Sends one notification event line to the Node client. */
    private void emitNotification(int subscriptionId, String mbean, Notification notification) throws Exception {
        Map<String, Object> payload = new HashMap<>();
        payload.put("event", "notification");
        payload.put("subscriptionId", subscriptionId);
        payload.put("mbean", mbean);
        Map<String, Object> body = new HashMap<>();
        body.put("type", notification.getType());
        body.put("source", String.valueOf(notification.getSource()));
        body.put("sequenceNumber", notification.getSequenceNumber());
        body.put("timestamp", notification.getTimeStamp());
        body.put("message", notification.getMessage());
        body.put("userData", encode(notification.getUserData()));
        payload.put("notification", body);
        write(payload);
    }

    /** Converts JSON-compatible values to supported Java primitive and common JMX argument types. */
    private Object convert(Object value, String className) throws Exception {
        if (value == null || className == null) return value;
        String type = className.replace("java.lang.", "");
        return switch (type) {
            case "String" -> String.valueOf(value);
            case "boolean", "Boolean" -> booleanValue(value);
            case "byte", "Byte" -> Byte.valueOf(String.valueOf(value));
            case "short", "Short" -> Short.valueOf(String.valueOf(value));
            case "int", "Integer" -> Integer.valueOf(String.valueOf(value));
            case "long", "Long" -> Long.valueOf(String.valueOf(value));
            case "float", "Float" -> Float.valueOf(String.valueOf(value));
            case "double", "Double" -> Double.valueOf(String.valueOf(value));
            case "char", "Character" -> String.valueOf(value).charAt(0);
            case "BigInteger" -> new BigInteger(String.valueOf(value));
            case "BigDecimal" -> new BigDecimal(String.valueOf(value));
            case "javax.management.ObjectName" -> new ObjectName(String.valueOf(value));
            case "Object" -> value;
            default -> instantiate(className, value);
        };
    }

    /** Creates a typed Java argument with a public constructor matching the supplied JSON value. */
    private Object instantiate(String className, Object value) throws Exception {
        Class<?> target = Class.forName(className);
        if (target.isArray()) return convertToType(value, target);
        if (Collection.class.isAssignableFrom(target) && value instanceof List<?> items) {
            Collection<Object> result = collectionFor(target);
            result.addAll(items);
            return result;
        }
        if (Map.class.isAssignableFrom(target) && value instanceof Map<?, ?> items) {
            Map<Object, Object> result = mapFor(target);
            result.putAll(items);
            return result;
        }
        List<Object> values = value instanceof List<?> items ? new ArrayList<>(items) : List.of(value);
        Constructor<?>[] constructors = target.getConstructors();
        Arrays.sort(constructors, Comparator.comparing(Constructor::toGenericString));
        for (Constructor<?> constructor : constructors) {
            Class<?>[] parameterTypes = constructor.getParameterTypes();
            if (parameterTypes.length != values.size()) continue;
            Object[] arguments = new Object[values.size()];
            try {
                for (int i = 0; i < parameterTypes.length; i++) {
                    arguments[i] = convertToType(values.get(i), parameterTypes[i]);
                }
            } catch (IllegalArgumentException error) {
                continue;
            }
            return constructor.newInstance(arguments);
        }
        throw new IllegalArgumentException("No public constructor for " + className
            + " accepts the supplied argument values");
    }

    /** Creates a collection implementation compatible with a requested Java collection type. */
    private Collection<Object> collectionFor(Class<?> target) throws Exception {
        if (target.isInterface() || java.lang.reflect.Modifier.isAbstract(target.getModifiers())) {
            if (SortedSet.class.isAssignableFrom(target)) return new TreeSet<>();
            if (Set.class.isAssignableFrom(target)) return new LinkedHashSet<>();
            return new ArrayList<>();
        }
        @SuppressWarnings("unchecked")
        Collection<Object> result = (Collection<Object>) target.getConstructor().newInstance();
        return result;
    }

    /** Creates a map implementation compatible with a requested Java map type. */
    private Map<Object, Object> mapFor(Class<?> target) throws Exception {
        if (target.isInterface() || java.lang.reflect.Modifier.isAbstract(target.getModifiers())) {
            if (SortedMap.class.isAssignableFrom(target)) return new TreeMap<>();
            return new LinkedHashMap<>();
        }
        @SuppressWarnings("unchecked")
        Map<Object, Object> result = (Map<Object, Object>) target.getConstructor().newInstance();
        return result;
    }

    /** Converts one JSON value into the declared type of a custom Java constructor parameter. */
    private Object convertToType(Object value, Class<?> target) throws Exception {
        if (value == null) {
            if (target.isPrimitive()) throw new IllegalArgumentException("Cannot pass null to a primitive type");
            return null;
        }
        if (target.isInstance(value)) return value;
        if (target.isArray()) {
            List<Object> items = list(value);
            Object array = Array.newInstance(target.getComponentType(), items.size());
            for (int i = 0; i < items.size(); i++) {
                Array.set(array, i, convertToType(items.get(i), target.getComponentType()));
            }
            return array;
        }
        if (target == Object.class) return value;
        if (Collection.class.isAssignableFrom(target) && value instanceof List<?> items) {
            Collection<Object> result = collectionFor(target);
            result.addAll(items);
            return result;
        }
        if (Map.class.isAssignableFrom(target) && value instanceof Map<?, ?> items) {
            Map<Object, Object> result = mapFor(target);
            result.putAll(items);
            return result;
        }
        if (target.isEnum()) {
            @SuppressWarnings({"unchecked", "rawtypes"})
            Object enumValue = Enum.valueOf((Class<? extends Enum>) target, String.valueOf(value));
            return enumValue;
        }
        return convert(value, target.getName());
    }

    /** Requires an active MBean server connection before an operation can run. */
    private MBeanServerConnection connection() {
        if (connection == null) {
            throw new IllegalStateException("JMX client is not connected");
        }
        return connection;
    }

    /** Closes the connector and clears connection state, including when called during shutdown. */
    private void closeConnection() throws Exception {
        JMXConnector activeConnector = connector;
        connection = null;
        connector = null;
        subscriptions.clear();
        if (activeConnector != null) {
            activeConnector.close();
        }
    }

    /** Converts JMX values into JSON primitives, arrays, or tagged structures for Node.js. */
    private Object encode(Object value) throws Exception {
        if (value == null || value instanceof String || value instanceof Boolean
            || value instanceof Integer || value instanceof Short || value instanceof Byte
            || value instanceof Double || value instanceof Float) {
            return value;
        }
        if (value instanceof Long number) {
            long raw = number;
            if (raw >= -JS_SAFE_INTEGER && raw <= JS_SAFE_INTEGER) {
                return raw;
            }
            return Map.of("$jmxType", "Long", "value", number.toString());
        }
        if (value instanceof ObjectName name) {
            return name.getCanonicalName();
        }
        if (value instanceof CompositeData data) {
            Map<String, Object> items = new HashMap<>();
            for (String key : data.getCompositeType().keySet()) {
                items.put(key, encode(data.get(key)));
            }
            return Map.of("$jmxType", "CompositeData", "items", items);
        }
        if (value instanceof TabularData data) {
            List<Object> rows = new ArrayList<>();
            for (Object row : data.values()) rows.add(encode(row));
            return Map.of("$jmxType", "TabularData", "rows", rows);
        }
        if (value instanceof Map<?, ?> values) {
            return encodeMap(values);
        }
        if (value instanceof Iterable<?> values) {
            List<Object> result = new ArrayList<>();
            for (Object item : values) result.add(encode(item));
            return result;
        }
        if (value.getClass().isArray()) {
            List<Object> result = new ArrayList<>();
            for (int i = 0; i < java.lang.reflect.Array.getLength(value); i++) {
                result.add(encode(java.lang.reflect.Array.get(value, i)));
            }
            return result;
        }
        return Map.of("$jmxType", "Object", "className", value.getClass().getName(),
            "value", String.valueOf(value));
    }

    /** Encodes a map, falling back to a typed-key representation when any key is not a string. */
    private Object encodeMap(Map<?, ?> values) throws Exception {
        boolean allStringKeys = true;
        for (Object key : values.keySet()) {
            if (!(key instanceof String)) { allStringKeys = false; break; }
        }
        if (allStringKeys) {
            Map<String, Object> entries = new HashMap<>();
            for (Map.Entry<?, ?> entry : values.entrySet()) {
                entries.put((String) entry.getKey(), encode(entry.getValue()));
            }
            return Map.of("$jmxType", "Map", "entries", entries);
        }
        List<List<Object>> pairs = new ArrayList<>();
        for (Map.Entry<?, ?> entry : values.entrySet()) {
            pairs.add(List.of(encode(entry.getKey()), encode(entry.getValue())));
        }
        return Map.of("$jmxType", "MapTypedKeys", "pairs", pairs);
    }

    /** Writes a JSON object as a single protocol line and flushes it immediately. */
    private void write(Object value) throws Exception {
        synchronized (output) {
            output.write(JSON.writeValueAsString(value));
            output.newLine();
            output.flush();
        }
    }

    /** Returns a request field as a string and rejects missing required values. */
    private static String string(Map<String, Object> params, String key) {
        Object value = params.get(key);
        if (value == null) throw new IllegalArgumentException("Missing required field: " + key);
        return String.valueOf(value);
    }

    /** Safely converts an untyped request value to a list, using an empty list when absent. */
    private static List<Object> list(Object value) {
        if (value == null) return List.of();
        if (value instanceof List<?> values) return new ArrayList<>(values);
        throw new IllegalArgumentException("Expected an array value");
    }

    /** Safely converts a decoded JSON object to a map. */
    @SuppressWarnings("unchecked")
    private static Map<String, Object> map(Object value) {
        if (value instanceof Map<?, ?> values) return (Map<String, Object>) values;
        throw new IllegalArgumentException("Expected a JSON object");
    }

    /** Returns a UTF-8-safe multiline string containing the full exception stack trace. */
    private static String stackTraceOf(Throwable error) {
        StringWriter buffer = new StringWriter();
        try (PrintWriter printer = new PrintWriter(buffer)) {
            error.printStackTrace(printer);
        }
        return buffer.toString();
    }

    /** Pairs a notification subscription with the ObjectName and listener it was registered under. */
    private record Subscription(ObjectName name, NotificationListener listener) { }
}
